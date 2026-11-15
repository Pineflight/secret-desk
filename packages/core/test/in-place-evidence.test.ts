import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { MemoryEvidenceStore } from "../src/evidence.js";
import { revokeIssuedTokens } from "../src/env-export.js";
import { commitIssuance, discardIssuance, prepareIssuance } from "../src/issuance.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";
import { INVENTORY_YAML } from "./fixtures.js";

// A value of a provider that replaced the value in place and that is discarded unconfirmed: the gate revokes nothing, and the report says
// the old value is gone and the new one is known to nobody. Not when a write was started: the places may hold the new value then.

const WARNING = "in-place-value-lost";

async function setup() {
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
  const provider: Provider = {
    id: "cloudflare-token",
    label: "Cloudflare",
    kind: "automatic",
    issue: async () => ({ value: new SecretValue("made-up-in-place-value-1"), externalId: "new-id", replacedInPlace: true }),
    revoke,
    reviewChecklist: () => ["only"],
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const evidence = new MemoryEvidenceStore();
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence,
  };
  return { deps, evidence, revoke };
}

describe("discardIssuance of a value the provider replaced in place", () => {
  it("warns that the new value was not kept", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect(p.replacedInPlace).toBe(true);
    await discardIssuance(p, deps, { by: "system", why: "expired" });
    expect(p.report.checks.find((c) => c.id === WARNING)).toMatchObject({ status: "warn", label: expect.stringContaining("an Ort und Stelle ersetzt") });
  });

  it("does not say the value was not kept when a write was started", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const failing = {
      ...deps,
      github: Object.assign(Object.create(deps.github) as typeof deps.github, {
        putSecret: async () => {
          throw new Error("socket timed out");
        },
      }),
    } as typeof deps;
    await commitIssuance(p, failing, { by: "alice", ticks: ["c1", "c2"] });
    await discardIssuance(p, deps, { by: "alice", why: "rejected", acknowledgeWritten: true });
    expect(p.report.checks.some((c) => c.id === WARNING)).toBe(false);
  });

  it("a provider that did not replace in place has no warning", async () => {
    const { deps } = await setup();
    const plain = new ProviderRegistry().register({ id: "cloudflare-token", label: "Cloudflare", kind: "automatic", issue: async () => ({ value: new SecretValue("made-up-plain-value-12"), externalId: "plain-id" }), revoke: async () => undefined, reviewChecklist: () => ["only"] });
    const own = { ...deps, providers: plain };
    const p = await prepareIssuance("cf-deploy-acme-app", own);
    expect(p.replacedInPlace).toBeUndefined();
    await discardIssuance(p, own, { by: "system", why: "expired" });
    expect(p.report.checks.some((c) => c.id === WARNING)).toBe(false);
  });
});

describe("revokeIssuedTokens: evidence for an in-place token", () => {
  const token = { secretId: "cf-deploy-acme-app", provider: "cloudflare-token", externalId: "new-id", replacedInPlace: true as const };

  it("saves one report for the secret, with the warning, no value and the identifier", async () => {
    const { deps, evidence } = await setup();
    const outcomes = await revokeIssuedTokens([token], deps, { evidence, now: () => new Date("2026-11-01T10:00:00Z") });
    expect(outcomes[0]).toMatchObject({ secretId: "cf-deploy-acme-app", inPlace: true });
    const reports = await evidence.list("cf-deploy-acme-app");
    expect(reports).toHaveLength(1);
    const report = await evidence.get("cf-deploy-acme-app", reports[0]!.id);
    expect(report?.checks.map((c) => c.id)).toEqual([WARNING]);
    expect(report?.externalId).toBe("new-id");
    expect(JSON.stringify(report)).not.toContain("made-up-in-place-value");
  });

  it("uses the clock when none is given, saves nothing without a store or for an unknown secret, and swallows a failing store", async () => {
    const { deps, evidence } = await setup();
    await revokeIssuedTokens([token], deps, { evidence });
    expect(await evidence.list("cf-deploy-acme-app")).toHaveLength(1);
    await revokeIssuedTokens([token], deps);
    await revokeIssuedTokens([{ ...token, secretId: "no-such-secret" }], deps, { evidence });
    expect(await evidence.list("no-such-secret")).toEqual([]);
    const broken = { save: async () => { throw new Error("disk full"); } } as unknown as MemoryEvidenceStore;
    await expect(revokeIssuedTokens([token], deps, { evidence: broken })).resolves.toHaveLength(1);
  });

  it("saves nothing when the file write had started", async () => {
    const { deps, evidence } = await setup();
    await revokeIssuedTokens([token], deps, { evidence, writeStarted: true });
    expect(await evidence.list("cf-deploy-acme-app")).toEqual([]);
  });
});
