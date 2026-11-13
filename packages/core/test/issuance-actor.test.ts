import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { FileEvidenceStore } from "../src/evidence-file-store.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, discardIssuance, prepareIssuance, StaleIssuanceError } from "../src/issuance.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";
import type { ActorRef } from "../src/verification.js";
import { INVENTORY_YAML } from "./fixtures.js";

const VALUE = "ACTOR-TEST-VALUE-987654";
const ticks = ["c1", "c2"];

async function setup() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/actions/secrets")) {
      return new Response(JSON.stringify({ secrets: [{ name: "CLOUDFLARE_API_TOKEN", created_at: "x", updated_at: "2026-11-01T10:00:01Z" }] }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  const provider: Provider = {
    id: "cloudflare-token",
    label: "Cloudflare",
    kind: "automatic",
    issue: async () => ({ value: new SecretValue(VALUE), externalId: "new-id", expiresAt: "2027-02-01T00:00:00Z" }),
    revoke: async () => undefined,
    verify: async () => [{ id: "active", label: "Token ist aktiv", status: "pass" as const }],
    reviewChecklist: () => ["Rechte exakt Workers Scripts Write", "Nur Konto acme"],
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const evidence = new FileEvidenceStore(await mkdtemp(join(tmpdir(), "sd-actor-")));
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence,
  };
  return { deps, inventory, evidence };
}

describe("who prepared and who decided", () => {
  it("records the preparing actor on the pending issuance as a copy, without any value", async () => {
    const { deps } = await setup();
    const preparedBy: ActorRef = { name: "alice", kind: "human", principalId: "principal-a1" };
    const p = await prepareIssuance("cf-deploy-acme-app", deps, { preparedBy });
    expect(p.preparedBy).toEqual({ name: "alice", kind: "human", principalId: "principal-a1" });
    expect(p.preparedBy).not.toBe(preparedBy);
    expect(JSON.stringify(p.preparedBy)).not.toContain(VALUE);
  });
  it("leaves preparedBy out when the caller names nobody", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect("preparedBy" in p).toBe(false);
  });
  it("puts the principal id next to the name in the confirmation, and only when there is one", async () => {
    const withId = await setup();
    const p1 = await prepareIssuance("cf-deploy-acme-app", withId.deps);
    await commitIssuance(p1, withId.deps, { by: "bob", principalId: "principal-b2", ticks });
    const saved1 = (await withId.evidence.list("cf-deploy-acme-app"))[0]!;
    expect(saved1.confirmation).toMatchObject({ decision: "confirmed", by: "bob", principalId: "principal-b2" });
    expect(JSON.stringify(saved1)).not.toContain(VALUE);

    const without = await setup();
    const p2 = await prepareIssuance("cf-deploy-acme-app", without.deps);
    await commitIssuance(p2, without.deps, { by: "bob", ticks });
    const saved2 = (await without.evidence.list("cf-deploy-acme-app"))[0]!;
    expect(saved2.confirmation).toMatchObject({ decision: "confirmed", by: "bob" });
    expect("principalId" in saved2.confirmation!).toBe(false);
    // The inventory keeps the display name only.
    expect(without.inventory.getSecret("cf-deploy-acme-app")!.verifiedBy).toBe("bob");
    expect(withId.inventory.getSecret("cf-deploy-acme-app")!.verifiedBy).toBe("bob");
  });
  it("records the principal id when a review is rejected, and when it is dropped as stale", async () => {
    const rejected = await setup();
    const p1 = await prepareIssuance("cf-deploy-acme-app", rejected.deps);
    await discardIssuance(p1, rejected.deps, { by: "bob", principalId: "principal-b2", why: "rejected" });
    expect((await rejected.evidence.list("cf-deploy-acme-app"))[0]!.confirmation).toMatchObject({ decision: "rejected", by: "bob", principalId: "principal-b2" });

    const plain = await setup();
    const p2 = await prepareIssuance("cf-deploy-acme-app", plain.deps);
    await discardIssuance(p2, plain.deps, { by: "bob", why: "rejected" });
    expect("principalId" in (await plain.evidence.list("cf-deploy-acme-app"))[0]!.confirmation!).toBe(false);

    const stale = await setup();
    const p3 = await prepareIssuance("cf-deploy-acme-app", stale.deps);
    stale.inventory.data.secrets.find((s) => s.id === "cf-deploy-acme-app")!.places = [{ repo: "other-repo", scope: "repository" }];
    await expect(commitIssuance(p3, stale.deps, { by: "bob", principalId: "principal-b2", ticks })).rejects.toThrow(StaleIssuanceError);
    expect((await stale.evidence.list("cf-deploy-acme-app"))[0]!.confirmation).toMatchObject({ decision: "rejected", by: "bob", principalId: "principal-b2" });
  });
  it("records who asked and which approval it belongs to, as copies, and leaves both out otherwise", async () => {
    const { deps } = await setup();
    const requestedBy: ActorRef = { name: "claude", kind: "agent" };
    const p = await prepareIssuance("cf-deploy-acme-app", deps, { preparedBy: { name: "alice", kind: "human" }, requestedBy, approvalId: "approval-1" });
    expect(p.requestedBy).toEqual(requestedBy);
    expect(p.requestedBy).not.toBe(requestedBy);
    expect(p.approvalId).toBe("approval-1");
    const plain = await prepareIssuance("cf-deploy-acme-app", deps);
    expect("requestedBy" in plain).toBe(false);
    expect("approvalId" in plain).toBe(false);
  });
  it("refuses a second discard and a commit after a discard: the provider is touched once", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const first = await discardIssuance(p, deps, { by: "alice", why: "rejected" });
    expect(first.revokedNew).toBe(true);
    await expect(discardIssuance(p, deps, { by: "bob", why: "rejected" })).rejects.toThrow(/schon erledigt/);
    await expect(commitIssuance(p, deps, { by: "bob", ticks })).rejects.toThrow(/schon erledigt/);
    const parallel = await prepareIssuance("cf-deploy-acme-app", deps);
    const results = await Promise.allSettled([discardIssuance(parallel, deps, { by: "a", why: "rejected" }), discardIssuance(parallel, deps, { by: "b", why: "rejected" })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});
