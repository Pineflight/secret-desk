import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, FileInventoryBackend, InventoryStore, ProviderRegistry, SecretValue, revokeIssuedTokens, revokeNewValue, rotateSecret, unrevokedNotices } from "../src/index.js";
import type { PendingIssuance, Provider, RotateDeps } from "../src/index.js";

// Defence in depth: the gate itself refuses to delete a value that was replaced in place, whatever identifier a caller hands it, and a
// stored inventory that cannot be read is its own refusal, not "used by another entry".

const YAML = "version: 1\nsecrets:\n  - { id: s1, name: API_KEY, stage: dev, service: x, provider: acme, expiry: none, places: [{ repo: web, scope: repository }] }\n";

function world() {
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", revoke, issue: async () => ({ value: new SecretValue("made-up-new-value"), externalId: "new-id" }) };
  const inventory = InventoryStore.fromText(YAML);
  return { revoke, deps: { inventory, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() } };
}

describe("revokeNewValue and a value replaced in place", () => {
  const target = { secretId: "s1", provider: "acme", externalId: "new-id" };

  it("deletes a value that was not replaced in place, as before", async () => {
    const { deps, revoke } = world();
    expect(await revokeNewValue(target, deps)).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("refuses with no-id when the caller says it was replaced in place", async () => {
    const { deps, revoke } = world();
    expect(await revokeNewValue({ ...target, replacedInPlace: true }, deps)).toEqual({ status: "refused", reason: "no-id" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("refuses with no-id when the pending item says so", async () => {
    const { deps, revoke } = world();
    const pending = { replacedInPlace: true } as PendingIssuance;
    expect(await revokeNewValue({ ...target, pending }, deps)).toEqual({ status: "refused", reason: "no-id" });
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("rotateSecret and an inventory that cannot be read", () => {
  it("does not claim another entry uses the token: it names the unreadable inventory and leaves the token valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-unreadable-"));
    const path = join(dir, "inventory.yaml");
    await writeFile(path, YAML);
    let readable = true;
    class Flaky extends FileInventoryBackend {
      override stamp(): string | null {
        return readable ? super.stamp() : null;
      }
    }
    const revoke = vi.fn(async () => undefined);
    const inventory = InventoryStore.withBackend(new Flaky(path));
    const provider: Provider = {
      id: "acme",
      label: "Acme",
      kind: "automatic",
      revoke,
      issue: async () => {
        // The stored file becomes unreadable while the value is issued.
        readable = false;
        return { value: new SecretValue("made-up-new-value"), externalId: "new-id" };
      },
    };
    const deps = { inventory, github: { putSecret: async () => Promise.reject(new Error("socket timed out")) } as never, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore(), owner: "acme", now: () => new Date("2026-03-01T10:00:00Z") } as RotateDeps;
    const result = await rotateSecret("s1", deps);
    expect(revoke).not.toHaveBeenCalled();
    expect(result.orphanExternalId).toBe("new-id");
    expect(result.warnings).toEqual(["Der neue Token (Kennung new-id) wurde nicht widerrufen: das Inventar liess sich gerade nicht lesen, ob er in Gebrauch ist, ist unbekannt. Er bleibt beim Anbieter gueltig: spaeter pruefen und von Hand widerrufen."]);
  });
});

describe("a failed export and an inventory that cannot be read", () => {
  it("tells the person to check the token first, not to delete it by hand, and leaves it valid", async () => {
    const { deps, revoke } = world();
    // A stand-in for a store whose stored document cannot be read right now.
    const inventory = { refreshNow: () => false, data: { secrets: [] }, getSecret: () => ({ id: "s1", provider: "acme" }) } as never;
    const outcomes = await revokeIssuedTokens([{ secretId: "s1", provider: "acme", externalId: "new-id" }], { ...deps, inventory });
    expect(outcomes).toEqual([{ secretId: "s1", externalId: "new-id", result: "inventory-unreadable" }]);
    expect(revoke).not.toHaveBeenCalled();
    expect(unrevokedNotices(outcomes)).toEqual(["Nicht widerrufen, weil das Inventar nicht gelesen werden konnte: der Token kann in Gebrauch sein und bleibt beim Anbieter gueltig; erst pruefen, dann von Hand entfernen, falls er nicht gebraucht wird: s1 (new-id)."]);
  });
});
