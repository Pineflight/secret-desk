import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { buildEnvFile, EnvExportError } from "../src/env-export.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, discardIssuance, IssuanceError, prepareIssuance } from "../src/issuance.js";
import { ProviderRegistry, type IssuedSecret, type Provider } from "../src/provider.js";
import { rotateSecret } from "../src/rotate.js";
import { SecretValue } from "../src/secret.js";
import { computeStatus, findings } from "../src/status.js";
import { INVENTORY_YAML } from "./fixtures.js";

interface Opts {
  failRepos?: string[];
  issued?: Partial<IssuedSecret>;
  revokeImpl?: () => Promise<void>;
  yaml?: string;
  noRevoke?: boolean;
}

async function make(o: Opts = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const puts: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/actions/secrets")) {
      return new Response(JSON.stringify({ secrets: [{ name: "CLOUDFLARE_API_TOKEN", created_at: "x", updated_at: "2026-11-01T10:00:01Z" }] }), { status: 200 });
    }
    if (o.failRepos?.some((r) => u.includes(`/${r}/`))) return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
    puts.push(`${init?.method} ${u}`);
    return new Response(null, { status: 204 });
  });
  const revoke = vi.fn(o.revokeImpl ?? (async () => undefined));
  const issue = vi.fn(async (): Promise<IssuedSecret> => ({ value: new SecretValue("NEUER-TOKEN-WERT-123"), externalId: "new-id", expiresAt: "2027-02-01T00:00:00Z", ...o.issued }));
  const provider: Provider = { id: "cloudflare-token", label: "Cloudflare", kind: "automatic", issue, ...(o.noRevoke ? {} : { revoke }), reviewChecklist: () => ["c"] };
  const inventory = InventoryStore.fromText(o.yaml ?? INVENTORY_YAML);
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
  };
  return { deps, inventory, issue, revoke, puts };
}

describe("M1: commitIssuance is single-use and concurrency-safe", () => {
  it("Promise.all([confirm, confirm]) writes once, the second throws", async () => {
    const { deps, puts } = await make();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const res = await Promise.allSettled([commitIssuance(p, deps, { by: "a", ticks: ["c1"] }), commitIssuance(p, deps, { by: "a", ticks: ["c1"] })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(IssuanceError);
    expect(puts.filter((w) => w.startsWith("PUT"))).toHaveLength(2); // zwei Ziele, einmal geschrieben
  });
  it("later second commit throws too, reject afterwards as well", async () => {
    const { deps, puts } = await make();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    await commitIssuance(p, deps, { by: "a", ticks: ["c1"] });
    await expect(commitIssuance(p, deps, { by: "a", ticks: ["c1"] })).rejects.toThrow(/erledigt/);
    await expect(discardIssuance(p, deps, { by: "a", why: "rejected" })).rejects.toThrow(/erledigt/);
    expect(puts.filter((w) => w.startsWith("PUT"))).toHaveLength(2);
  });
  it("after a target error the request stays open and can be retried", async () => {
    const ctx = await make({ failRepos: ["acme-app-landing"] });
    const p = await prepareIssuance("cf-deploy-acme-app", ctx.deps);
    const first = await commitIssuance(p, ctx.deps, { by: "a", ticks: ["c1"] });
    expect(first.ok).toBe(false);
    expect(first.partial).toBe(true);
    const second = await commitIssuance(p, ctx.deps, { by: "a", ticks: ["c1"] });
    expect(second.ok).toBe(false);
  });
  it("inventory not savable after successful revoke: result warns clearly", async () => {
    const { deps, inventory, revoke } = await make();
    vi.spyOn(inventory, "save").mockRejectedValue(new Error("ENOSPC"));
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await commitIssuance(p, deps, { by: "a", ticks: ["c1"] });
    expect(revoke).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    expect(r.revokedOld).toBe(true);
    expect(r.warnings?.join(" ")).toMatch(/bereits widerrufen.*nicht gespeichert.*new-id/);
  });
});

describe("M2: edge cases of issuance", () => {
  it("expiry boundary: now == expiresAt still valid, one millisecond later not", async () => {
    const { deps } = await make();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const at = (iso: number) => ({ ...deps, now: () => new Date(iso) });
    await expect(commitIssuance(p, at(Date.parse(p.expiresAt) + 1), { by: "a", ticks: ["c1"] })).rejects.toThrow(/abgelaufen/);
    const r = await commitIssuance(p, at(Date.parse(p.expiresAt)), { by: "a", ticks: ["c1"] });
    expect(r.ok).toBe(true);
  });
  it("putSecret partial failure: old value stays, nothing revoked, inventory unchanged", async () => {
    const { deps, inventory, revoke } = await make({ failRepos: ["acme-app-landing"] });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await commitIssuance(p, deps, { by: "a", ticks: ["c1"] });
    expect(r).toMatchObject({ ok: false, partial: true, revokedOld: false });
    expect(revoke).not.toHaveBeenCalled();
    expect(inventory.getSecret("cf-deploy-acme-app")!.externalId).toBe("old-token-id");
  });
  it("revoke of the old value throws: commit succeeds, report warns", async () => {
    const { deps, inventory } = await make({ revokeImpl: async () => { throw new Error("401"); } });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await commitIssuance(p, deps, { by: "a", ticks: ["c1"] });
    expect(r.ok).toBe(true);
    expect(r.revokedOld).toBe(false);
    expect(p.report.checks.find((c) => c.id === "revoke-old")).toMatchObject({ status: "warn" });
    expect(inventory.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-id");
  });
  it("discard with throwing revoke: not revoked is in the note", async () => {
    const { deps } = await make({ revokeImpl: async () => { throw new Error("boom"); } });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await discardIssuance(p, deps, { by: "a", why: "rejected" });
    expect(r.revokedNew).toBe(false);
    expect(p.report.confirmation?.note).toContain("NICHT widerrufen");
  });
  it("expiry unknown (possible, no ttl, no provider hint): no old date, status unknown", async () => {
    const yaml = INVENTORY_YAML.replace("    ttlDays: 90\n", "");
    const { deps, inventory } = await make({ yaml, issued: { expiresAt: null } });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect(p.newExpires).toBeNull();
    expect(p.report.checks.some((c) => c.id === "expiry-unknown")).toBe(true);
    const r = await commitIssuance(p, deps, { by: "a", ticks: ["c1"] });
    expect(r.expires).toBeNull();
    const s = inventory.getSecret("cf-deploy-acme-app")!;
    expect(s.expires).toBeNull();
    expect(s.expiry).toBe("unknown");
    expect(computeStatus(s, new Date("2027-03-01T00:00:00Z")).status).toBe("unknown");
    expect(r.warnings?.join(" ")).toMatch(/unbekannt/);
  });
});

describe("M4/H8: rotation error paths", () => {
  it("issue throws: error passes through, nothing written, nothing revoked", async () => {
    const { deps, issue, revoke, puts } = await make();
    issue.mockRejectedValueOnce(new Error("Anbieter 500"));
    await expect(rotateSecret("cf-deploy-acme-app", deps)).rejects.toThrow("Anbieter 500");
    expect(puts).toHaveLength(0);
    expect(revoke).not.toHaveBeenCalled();
  });
  it("all targets fail: freshly issued token is revoked", async () => {
    const { deps, revoke } = await make({ failRepos: ["acme-app", "acme-app-landing"] });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.ok).toBe(false);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id" }));
    expect(r.newTokenRevoked).toBe(true);
    expect(r.orphanExternalId).toBeUndefined();
  });
  it("all targets fail and revoke fails: externalId in the result and in the warning", async () => {
    const { deps } = await make({ failRepos: ["acme-app", "acme-app-landing"], revokeImpl: async () => { throw new Error("nope"); } });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.orphanExternalId).toBe("new-id");
    expect(r.warnings?.join(" ")).toContain("new-id");
  });
  it("provider without revoke: externalId in the warning", async () => {
    const { deps } = await make({ failRepos: ["acme-app", "acme-app-landing"], noRevoke: true });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.orphanExternalId).toBe("new-id");
  });
  it("partial failure: new token stays (in use), result names the identifier", async () => {
    const { deps, revoke } = await make({ failRepos: ["acme-app-landing"] });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.partial).toBe(true);
    expect(r.orphanExternalId).toBe("new-id");
    expect(revoke).not.toHaveBeenCalled();
  });
  it("revoke of the old one throws: rotation succeeds anyway, revoked false", async () => {
    const { deps, inventory } = await make({ revokeImpl: async () => { throw new Error("401"); } });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r).toMatchObject({ ok: true, revoked: false });
    expect(inventory.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-id");
  });
  it("expiry none: expires stays null", async () => {
    const yaml = INVENTORY_YAML.replace('expiry: possible\n    expires: "2027-01-21"', "expiry: none");
    const { deps, inventory } = await make({ yaml, issued: { expiresAt: null } });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.expires).toBeNull();
    expect(inventory.getSecret("cf-deploy-acme-app")!.expires).toBeNull();
  });
  it("possible without ttl and without provider expiry: old date dropped, hint", async () => {
    const yaml = INVENTORY_YAML.replace("    ttlDays: 90\n", "");
    const { deps, inventory } = await make({ yaml, issued: { expiresAt: null } });
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.expires).toBeNull();
    expect(inventory.getSecret("cf-deploy-acme-app")!.expires).toBeNull();
    expect(r.warnings?.join(" ")).toMatch(/Ablaufdatum.*unbekannt/);
  });
  it("inventory not savable: warning with new identifier instead of silence", async () => {
    const { deps, inventory } = await make();
    vi.spyOn(inventory, "save").mockRejectedValue(new Error("EIO"));
    const r = await rotateSecret("cf-deploy-acme-app", deps);
    expect(r.ok).toBe(true);
    expect(r.warnings?.join(" ")).toMatch(/nicht gespeichert.*new-id/);
  });
});

describe("H8: buildEnvFile checks before the first issue", () => {
  const yaml = INVENTORY_YAML.replace(
    "      - { key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }\n      - { key: STRIPE_SECRET_KEY, from: { type: prompt, hint: Sandbox-Key } }",
    "      - { key: CF_DEV_TOKEN, from: { type: issue, secret: cf-deploy-acme-app } }\n      - { key: LATER, from: { type: issue, secret: lead-token-dev } }",
  );
  it("variable without target value: no issue before", async () => {
    const y = yaml.replace("envTemplates:", "variables:\n  - { id: v1, name: V_ONE, stage: dev, places: [ { repo: r, scope: repository } ] }\nenvTemplates:").replace("{ key: LATER, from: { type: issue, secret: lead-token-dev } }", "{ key: LATER, from: { type: variable, variable: v1 } }");
    const { deps, issue } = await make({ yaml: y });
    await expect(buildEnvFile(deps.inventory.data.envTemplates[0]!, deps)).rejects.toThrow(/keinen Sollwert/);
    expect(issue).not.toHaveBeenCalled();
  });
  it("later source without provider that can issue: no issue before", async () => {
    const { deps, issue } = await make({ yaml });
    await expect(buildEnvFile(deps.inventory.data.envTemplates[0]!, deps)).rejects.toThrow(EnvExportError);
    expect(issue).not.toHaveBeenCalled();
  });
  it("if a later issue fails, the earlier issued one is revoked", async () => {
    const { deps, issue, revoke } = await make({ yaml });
    // Zweites Secret nutzt denselben Anbieter, der beim zweiten Aufruf scheitert.
    deps.inventory.patchSecret("lead-token-dev", {});
    const y2 = yaml.replace("provider: random-hex", "provider: cloudflare-token");
    const ctx = await make({ yaml: y2 });
    ctx.issue.mockResolvedValueOnce({ value: new SecretValue("A-WERT"), externalId: "ext-1" });
    ctx.issue.mockRejectedValueOnce(new Error("zweiter Aufruf kaputt"));
    await expect(buildEnvFile(ctx.deps.inventory.data.envTemplates[0]!, ctx.deps)).rejects.toThrow(/zweiter Aufruf kaputt/);
    expect(ctx.revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "ext-1" }));
    void issue; void revoke; void deps;
  });
});

describe("M3: computeStatus and findings", () => {
  const secret = InventoryStore.fromText(INVENTORY_YAML).getSecret("cf-deploy-acme-app")!; // expires 2027-01-21
  const table: [number, string][] = [[31, "ok"], [30, "soon"], [15, "soon"], [14, "soon"], [8, "soon"], [7, "due"], [1, "due"], [0, "due"], [-1, "expired"]];
  for (const [daysLeft, status] of table) {
    it(`daysLeft ${daysLeft} -> ${status}`, () => {
      const today = new Date(Date.parse("2027-01-21T12:00:00Z") - daysLeft * 86_400_000);
      const r = computeStatus(secret, today, { thresholds: [30, 14, 7] });
      expect(r.daysLeft).toBe(daysLeft);
      expect(r.status).toBe(status);
    });
  }
  it("findings: level, key and text per threshold", () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML).data;
    const at = (daysLeft: number) => findings(inv, new Date(Date.parse("2027-01-21T12:00:00Z") - daysLeft * 86_400_000))[0];
    expect(at(31)).toBeUndefined();
    expect(at(30)).toMatchObject({ level: "soon", key: "cf-deploy-acme-app:30" });
    expect(at(14)).toMatchObject({ level: "soon", key: "cf-deploy-acme-app:14" });
    expect(at(7)).toMatchObject({ level: "due", key: "cf-deploy-acme-app:7" });
    expect(at(7)!.text).toContain("laeuft in 7 Tagen ab (2027-01-21)");
    expect(at(7)!.text).toContain("acme-app/repo");
    expect(at(-2)).toMatchObject({ level: "expired", key: "cf-deploy-acme-app:expired" });
    expect(at(-2)!.text).toContain("seit 2 Tagen abgelaufen");
  });
});
