import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { EvidenceStore } from "../src/evidence.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, discardIssuance, prepareIssuance, StaleIssuanceError } from "../src/issuance.js";
import { ProviderRegistry, type IssuedSecret, type Provider } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";

const YAML = `version: 1
secrets:
  - id: access-secret
    name: ACCESS_CLIENT_SECRET
    stage: shared
    service: cloudflare
    provider: companion-test
    expiry: possible
    ttlDays: 30
    externalId: tok-old
    params: { clientIdTarget: access-id }
    places:
      - { repo: acme-app, scope: repository }
  - id: access-id
    name: ACCESS_CLIENT_ID
    stage: shared
    service: cloudflare
    provider: manual
    expiry: possible
    places:
      - { repo: acme-app, scope: repository }
      - { repo: acme-app-landing, scope: repository }
  - id: other-secret
    name: OTHER
    stage: shared
    service: x
    provider: manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
`;

const MAIN = "MAIN-SECRET-VALUE-0123456789";
const ID_VALUE = "COMPANION-CLIENT-ID-0123456789";

async function setup(issue: (externalId: string | undefined) => IssuedSecret, yaml = YAML) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const puts: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/actions/secrets")) {
      const names = ["ACCESS_CLIENT_SECRET", "ACCESS_CLIENT_ID"].map((name) => ({ name, created_at: "x", updated_at: "2026-11-01T10:00:01Z" }));
      return new Response(JSON.stringify({ secrets: names }), { status: 200 });
    }
    if (init?.method === "PUT") puts.push(u);
    return new Response(null, { status: 204 });
  });
  const revoke = vi.fn(async () => undefined);
  const issueFn = vi.fn(async (ctx: { secret: { externalId?: string | undefined } }) => issue(ctx.secret.externalId));
  const provider: Provider = { id: "companion-test", label: "t", kind: "automatic", companionParams: ["clientIdTarget"], issue: issueFn as unknown as Provider["issue"], revoke };
  const inventory = InventoryStore.fromText(yaml);
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence: new EvidenceStore(await mkdtemp(join(tmpdir(), "sd-ev-"))),
  };
  return { deps, inventory, revoke, issueFn, puts };
}

const created = (): IssuedSecret => ({ value: new SecretValue(MAIN), externalId: "tok-new", expiresAt: "2026-12-01T00:00:00Z", companions: [{ entryId: "access-id", value: new SecretValue(ID_VALUE) }] });

describe("companion values", () => {
  it("lists the companion in the review without its value", async () => {
    const { deps } = await setup(created);
    const p = await prepareIssuance("access-secret", deps);
    expect(p.report.companions).toEqual([{ entryId: "access-id", name: "ACCESS_CLIENT_ID", targets: expect.any(Array), fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) }]);
    expect(p.report.companions![0]!.targets).toHaveLength(2);
    expect(p.report.checks.filter((c) => c.id.startsWith("companion-target:") && c.status === "pass")).toHaveLength(2);
    const s = JSON.stringify(p.report);
    expect(s).not.toContain(MAIN);
    expect(s).not.toContain(ID_VALUE);
  });

  it("writes main and companion on confirm and records the companion", async () => {
    const { deps, inventory, puts, revoke } = await setup(created);
    const p = await prepareIssuance("access-secret", deps);
    expect(puts).toHaveLength(0);
    const r = await commitIssuance(p, deps, { by: "alice", ticks: p.report.checklist.map((c) => c.id) });
    expect(r.ok).toBe(true);
    expect(puts).toHaveLength(3);
    expect(puts.some((u) => u.endsWith("/ACCESS_CLIENT_ID"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(ID_VALUE);
    expect(inventory.getSecret("access-id")).toMatchObject({ rotatedAt: "2026-11-01", externalId: "tok-new", verifiedBy: "alice", expires: "2026-12-01" });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "tok-old" }));
  });

  it("discards the companion with the main value on reject", async () => {
    const { deps, puts, revoke } = await setup(created);
    const p = await prepareIssuance("access-secret", deps);
    await discardIssuance(p, deps, { by: "alice", why: "rejected" });
    expect(puts).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "tok-new" }));
    await expect(commitIssuance(p, deps, { by: "a", ticks: [] })).rejects.toThrow();
  });

  it("goes stale when the companion's places change before confirm", async () => {
    const { deps, inventory, puts } = await setup(created);
    const p = await prepareIssuance("access-secret", deps);
    inventory.renameRepo("acme-app-landing", "elsewhere");
    await expect(commitIssuance(p, deps, { by: "alice", ticks: p.report.checklist.map((c) => c.id) })).rejects.toThrow(StaleIssuanceError);
    expect(puts).toHaveLength(0);
  });

  it("refuses a companion for an entry the params do not name and undoes the issuance", async () => {
    const { deps, revoke, puts } = await setup(() => ({ ...created(), companions: [{ entryId: "other-secret", value: new SecretValue(ID_VALUE) }] }));
    await expect(prepareIssuance("access-secret", deps)).rejects.toThrow(/nicht benannten Eintrag/);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "tok-new" }));
    expect(puts).toHaveLength(0);
  });

  it("checks the companion target before anything is issued", async () => {
    const { deps, issueFn } = await setup(created, YAML.replace("clientIdTarget: access-id", "clientIdTarget: missing-id"));
    await expect(prepareIssuance("access-secret", deps)).rejects.toThrow(/nicht gefunden/);
    expect(issueFn).not.toHaveBeenCalled();
    const same = await setup(created, YAML.replace("clientIdTarget: access-id", "clientIdTarget: access-secret"));
    await expect(prepareIssuance("access-secret", same.deps)).rejects.toThrow(/eigener Begleiter/);
    expect(same.issueFn).not.toHaveBeenCalled();
  });

  it("does not delete the token when the provider rotated in place", async () => {
    const rotated = (): IssuedSecret => ({ value: new SecretValue(MAIN), externalId: "tok-old", expiresAt: null });
    const a = await setup(rotated);
    const p = await prepareIssuance("access-secret", a.deps);
    expect(p.report.companions).toBeUndefined();
    await commitIssuance(p, a.deps, { by: "alice", ticks: p.report.checklist.map((c) => c.id) });
    expect(a.puts).toHaveLength(1);
    expect(a.revoke).not.toHaveBeenCalled();
    const b = await setup(rotated);
    const q = await prepareIssuance("access-secret", b.deps);
    await discardIssuance(q, b.deps, { by: "alice", why: "rejected" });
    expect(b.revoke).not.toHaveBeenCalled();
  });
});

describe("a value that is read, not created (expiry none)", () => {
  const READ_YAML = YAML.replaceAll("expiry: possible", "expiry: none").replace("    ttlDays: 30\n    externalId: tok-old\n", "");
  const read = (): IssuedSecret => ({ value: new SecretValue(MAIN), expiresAt: null, companions: [{ entryId: "access-id", value: new SecretValue(ID_VALUE) }] });
  const confirm = { by: "alice", ticks: ["c1", "c2", "c3", "c4"] };

  it("writes both values, stamps verifiedAt, keeps no expiry and revokes nothing", async () => {
    const { deps, inventory, revoke } = await setup(read, READ_YAML);
    const p = await prepareIssuance("access-secret", deps);
    expect(p.newExpires).toBeNull();
    expect(p.report.externalId).toBeUndefined();
    expect(p.report.checks.find((c) => c.id === "expiry")).toMatchObject({ status: "info", actual: "kein Ablauf" });
    const ticks = p.report.checklist.map((c) => c.id);
    const result = await commitIssuance(p, deps, { ...confirm, ticks }, {});
    expect(result.ok).toBe(true);
    expect(result.revokedOld).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    for (const id of ["access-secret", "access-id"]) {
      expect(inventory.getSecret(id)).toMatchObject({ verifiedAt: "2026-11-01", verifiedBy: "alice", expires: null, expiry: "none" });
      expect(inventory.getSecret(id)!.externalId).toBeUndefined();
    }
  });
});
