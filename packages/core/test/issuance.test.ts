import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { EvidenceStore } from "../src/evidence.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, discardIssuance, prepareIssuance, IssuanceError } from "../src/issuance.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";
import { renderEvidenceSvg } from "../src/verification.js";
import { INVENTORY_YAML } from "./fixtures.js";

async function setup(options: { failVerify?: boolean } = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const writes: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/actions/secrets")) {
      return new Response(JSON.stringify({ secrets: [{ name: "CLOUDFLARE_API_TOKEN", created_at: "x", updated_at: "2026-11-01T10:00:01Z" }] }), { status: 200 });
    }
    writes.push(`${init?.method} ${u}`);
    return new Response(null, { status: 204 });
  });
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = {
    id: "cloudflare-token",
    label: "Cloudflare",
    kind: "automatic",
    issue: async () => ({ value: new SecretValue("NEUER-TOKEN-WERT-123"), externalId: "new-id", expiresAt: "2027-02-01T00:00:00Z" }),
    revoke,
    verify: async () => [options.failVerify ? { id: "active", label: "Token ist aktiv", status: "fail" as const } : { id: "active", label: "Token ist aktiv", status: "pass" as const }],
    reviewChecklist: () => ["Rechte exakt Workers Scripts Write", "Nur Konto Pineflight"],
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const evidence = new EvidenceStore(await mkdtemp(join(tmpdir(), "sd-ev-")));
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "Pineflight",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence,
  };
  return { deps, inventory, evidence, revoke, writes };
}

describe("Stufe 1: prepareIssuance", () => {
  it("erzeugt und prueft, schreibt aber nichts und widerruft nichts", async () => {
    const { deps, writes, revoke, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect(revoke).not.toHaveBeenCalled();
    expect(p.report.checks.map((c) => c.id)).toContain("active");
    expect(p.report.checklist.map((c) => c.text)).toEqual(["Rechte exakt Workers Scripts Write", "Nur Konto Pineflight"]);
    expect(p.report.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(p.report)).not.toContain("NEUER-TOKEN-WERT");
    expect(JSON.stringify(await evidence.list("cf-deploy-wakemiles"))).not.toContain("NEUER-TOKEN-WERT");
  });
  it("laesst manuelle Werte pruefen, ohne sie im Bericht zu zeigen", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("stripe-webhook-leitfaden-staging", deps, { manualValue: new SecretValue("whsec_handeingabe_123456") });
    expect(p.report.kind).toBe("manual");
    expect(JSON.stringify(p.report)).not.toContain("handeingabe");
  });
});

describe("Stufe 2: commitIssuance", () => {
  it("braucht alle Haken, schreibt, widerruft den alten Wert und traegt Bestaetigung ein", async () => {
    const { deps, inventory, revoke, writes, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    await expect(commitIssuance(p, deps, { by: "niklas", ticks: ["c1"] })).rejects.toThrow(/Pruefpunkte/);
    const r = await commitIssuance(p, deps, { by: "niklas", ticks: ["c1", "c2"], note: "Screenshot geprueft" });
    expect(r.ok).toBe(true);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(2);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "old-token-id" }));
    const s = inventory.getSecret("cf-deploy-wakemiles")!;
    expect(s).toMatchObject({ externalId: "new-id", expires: "2027-02-01", verifiedBy: "niklas", verifiedAt: "2026-11-01" });
    const saved = (await evidence.list("cf-deploy-wakemiles"))[0]!;
    expect(saved.confirmation).toMatchObject({ decision: "confirmed", by: "niklas" });
    expect(saved.checks.some((c) => c.id.startsWith("written:") && c.status === "pass")).toBe(true);
  });
  it("verweigert bei fehlgeschlagener Pruefung und nach Ablauf", async () => {
    const { deps } = await setup({ failVerify: true });
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    await expect(commitIssuance(p, deps, { by: "n", ticks: ["c1", "c2"] })).rejects.toThrow(IssuanceError);
    const later = { ...deps, now: () => new Date("2026-11-01T11:00:00Z") };
    await expect(commitIssuance(p, later, { by: "n", ticks: ["c1", "c2"] }, { force: true })).rejects.toThrow(/abgelaufen/);
  });
});

describe("discardIssuance", () => {
  it("loescht den neuen Wert beim Anbieter und schreibt nichts", async () => {
    const { deps, revoke, writes, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    const r = await discardIssuance(p, deps, { by: "niklas", why: "rejected", note: "falsche Rechte" });
    expect(r.revokedNew).toBe(true);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id" }));
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect((await evidence.list("cf-deploy-wakemiles"))[0]!.confirmation).toMatchObject({ decision: "rejected" });
  });
});

describe("Beleg und Anlagen", () => {
  it("rendert ein SVG ohne Wert und maskiert Sonderzeichen", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    p.report.label = '<script>alert("x")</script>';
    const svg = renderEvidenceSvg(p.report);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("NEUER-TOKEN-WERT");
    expect(svg).toContain(p.report.fingerprint);
  });
  it("nimmt nur Bilder bis 5 MB an", async () => {
    const { deps, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-wakemiles", deps);
    const att = await evidence.attach("cf-deploy-wakemiles", p.report.id, new Uint8Array([137, 80, 78, 71]), "image/png", "Dashboard");
    expect(att.file).toBe("anlage-1.png");
    expect((await evidence.readAttachment("cf-deploy-wakemiles", p.report.id, "anlage-1.png"))!.mime).toBe("image/png");
    await expect(evidence.attach("cf-deploy-wakemiles", p.report.id, new Uint8Array([1]), "text/html")).rejects.toThrow(/PNG/);
    await expect(evidence.attach("cf-deploy-wakemiles", p.report.id, new Uint8Array(5 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(/5 MB/);
    await expect(evidence.get("../etc", "x")).rejects.toThrow(/Ungueltige/);
    expect(await readFile(join(evidence.dir, "cf-deploy-wakemiles", p.report.id, "anlage-1.png"))).toHaveLength(4);
  });
});
