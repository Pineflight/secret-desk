import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, FileInventoryBackend, InventoryStore, ProviderRegistry, entryHoldingId, revokeNewValue } from "../src/index.js";
import type { InventoryBackend, Provider } from "../src/index.js";

// Two processes (the desk app and the CLI) work on one inventory file. The gate decides to revoke on the inventory as it is stored now,
// not on the copy its process read earlier: an identifier another process gave to an entry between the issue and the revoke is seen.

const TEXT = (holderId: string): string => `version: 1
secrets:
  - { id: cf-token, name: CF_TOKEN, stage: dev, service: x, provider: acme, expiry: none, externalId: old-id }
  - { id: holder, name: HOLDER, stage: dev, service: x, provider: acme, expiry: none, externalId: ${holderId} }
`;

/** The file backend with a change stamp that never changes: a file system with a coarse modification time, or a copy that keeps it. */
class CoarseStampBackend extends FileInventoryBackend implements InventoryBackend {
  override stamp(): string | null {
    return "coarse";
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-fresh-"));
  const path = join(dir, "inventory.yaml");
  await writeFile(path, TEXT("AAAAAAAA"));
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue: async () => { throw new Error("unused"); }, revoke };
  // This process reads through the coarse stamp, the other one (the second store) writes the file.
  const first = InventoryStore.withBackend(new CoarseStampBackend(path));
  const second = await InventoryStore.open(path);
  const deps = { inventory: first, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() };
  const target = { secretId: "cf-token", provider: "acme", externalId: "BBBBBBBB" };
  return { path, first, second, deps, target, revoke };
}

describe("the revoke gate reads the inventory fresh", () => {
  it("another store saved the identifier to an entry: the gate sees it and revokes nothing", async () => {
    const { first, second, deps, target, revoke } = await setup();
    second.patchSecret("holder", { externalId: "BBBBBBBB" });
    await second.save();
    // An ordinary read trusts the unchanged stamp: this process still holds the old copy.
    expect(first.getSecret("holder")?.externalId).toBe("AAAAAAAA");
    expect(await revokeNewValue(target, deps)).toEqual({ status: "refused", reason: "value-in-use" });
    expect(first.getSecret("holder")?.externalId).toBe("BBBBBBBB");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("with an ordinary file store the other store's save is seen as well", async () => {
    const { path, second, target, revoke } = await setup();
    const reader = await InventoryStore.open(path);
    const deps = { inventory: reader, providers: new ProviderRegistry().register({ id: "acme", label: "Acme", kind: "automatic", revoke }), connections: new ConnectionStore() };
    second.patchSecret("holder", { externalId: "BBBBBBBB" });
    await second.save();
    expect(await revokeNewValue(target, deps)).toEqual({ status: "refused", reason: "value-in-use" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("when nothing else changed, the gate revokes as before", async () => {
    const { deps, target, revoke } = await setup();
    expect(await revokeNewValue(target, deps)).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("when the stored document cannot be read right now, the copy may be stale: nothing is revoked", async () => {
    const { path, first, deps, target, revoke } = await setup();
    await writeFile(path, "secrets: [\n  - {");
    expect(await revokeNewValue(target, deps)).toEqual({ status: "refused", reason: "value-in-use" });
    expect(revoke).not.toHaveBeenCalled();
    expect(first.problem).not.toBeNull();
  });
});

describe("entryHoldingId reads the inventory fresh", () => {
  it("sees an identifier another store saved while the stamp looked unchanged", async () => {
    const { first, second } = await setup();
    second.patchSecret("holder", { externalId: "BBBBBBBB" });
    await second.save();
    expect(entryHoldingId(first, "BBBBBBBB", ["cf-token"])).toBe("holder");
  });

  it("a store without a refresh method (an embedder's stand-in) is read as it is", () => {
    const standIn = { data: { secrets: [{ id: "holder", externalId: "X" }] } } as never;
    expect(entryHoldingId(standIn, "X", [])).toBe("holder");
  });
});
