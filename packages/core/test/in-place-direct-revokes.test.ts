import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { IssuanceError, commitIssuance, prepareIssuance } from "../src/issuance.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { rotateSecret, type RotateDeps } from "../src/rotate.js";
import { SecretValue } from "../src/secret.js";
import { INVENTORY_YAML } from "./fixtures.js";

// A value the provider says it replaced in place is never sent to the provider's delete, whatever its identifier looks like: what the
// identifier names is the live object. This covers the places that call a provider's revoke outside the gate (the undo inside
// prepareIssuance, the old-value revoke after a commit and after a renewal).

async function issuanceWorld(over: Partial<Provider> & { replacedInPlace?: boolean } = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/actions/secrets")) return new Response(JSON.stringify({ secrets: [{ name: "CLOUDFLARE_API_TOKEN", created_at: "x", updated_at: "2026-11-01T10:00:01Z" }] }), { status: 200 });
    return new Response(null, { status: 204 });
  });
  const revoke = vi.fn(async () => undefined);
  const { replacedInPlace, ...providerOver } = over;
  const provider: Provider = {
    id: "cloudflare-token",
    label: "Cloudflare",
    kind: "automatic",
    issue: async () => ({ value: new SecretValue("made-up-in-place-value-1"), externalId: "new-id", ...(replacedInPlace ? { replacedInPlace: true } : {}) }),
    revoke,
    reviewChecklist: () => ["only"],
    ...providerOver,
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  inventory.patchSecret("cf-deploy-acme-app", { externalId: "old-id" });
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
  };
  return { deps, revoke };
}

describe("prepareIssuance: the undo for a companion nobody named", () => {
  const stray = { companions: [{ entryId: "lead-token-dev", value: new SecretValue("made-up-stray-value-1") }] };

  it("deletes a newly created value, as before", async () => {
    const { deps, revoke } = await issuanceWorld({ issue: async () => ({ value: new SecretValue("made-up-value-0123456789"), externalId: "new-id", ...stray }) });
    await expect(prepareIssuance("cf-deploy-acme-app", deps)).rejects.toBeInstanceOf(IssuanceError);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("does not delete a value the provider replaced in place", async () => {
    const { deps, revoke } = await issuanceWorld({ issue: async () => ({ value: new SecretValue("made-up-value-0123456789"), externalId: "new-id", replacedInPlace: true, ...stray }) });
    await expect(prepareIssuance("cf-deploy-acme-app", deps)).rejects.toBeInstanceOf(IssuanceError);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("commitIssuance: the old value after a confirmed commit", () => {
  const confirm = { by: "alice", ticks: ["c1", "c2"] };

  it("is deleted when the provider created a new object, as before", async () => {
    const { deps, revoke } = await issuanceWorld();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect((await commitIssuance(p, deps, confirm)).revokedOld).toBe(true);
    expect(revoke.mock.calls[0]).toMatchObject([{ externalId: "old-id" }]);
  });

  it("is not deleted when the provider says it replaced the value in place, and the report says nothing about it", async () => {
    const { deps, revoke } = await issuanceWorld({ replacedInPlace: true });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const result = await commitIssuance(p, deps, confirm);
    expect(result).toMatchObject({ ok: true, revokedOld: false });
    expect(revoke).not.toHaveBeenCalled();
    expect(p.report.checks.some((c) => c.id === "revoke-old")).toBe(false);
  });
});

describe("rotateSecret: the old value after a renewal", () => {
  async function rotateWorld(replacedInPlace: boolean) {
    const revoke = vi.fn(async () => undefined);
    const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue: async () => ({ value: new SecretValue("made-up-new-value"), externalId: "new-id", ...(replacedInPlace ? { replacedInPlace: true } : {}) }), revoke };
    const inventory = InventoryStore.fromText("version: 1\nsecrets:\n  - { id: s1, name: API_KEY, stage: dev, service: x, provider: acme, expiry: none, externalId: old-id, places: [{ repo: web, scope: repository }] }\n");
    const deps = { inventory, github: { putSecret: async () => "updated" as const } as never, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore(), owner: "acme", now: () => new Date("2026-03-01T10:00:00Z") } as RotateDeps;
    return { deps, revoke };
  }

  it("is deleted when the provider created a new object, as before", async () => {
    const { deps, revoke } = await rotateWorld(false);
    expect((await rotateSecret("s1", deps)).revoked).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("is not deleted when the provider says it replaced the value in place, whatever the identifier is", async () => {
    const { deps, revoke } = await rotateWorld(true);
    expect((await rotateSecret("s1", deps)).revoked).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });
});
