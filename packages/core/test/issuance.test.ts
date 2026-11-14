import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { FileEvidenceStore } from "../src/evidence-file-store.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { commitIssuance, discardIssuance, hasWriteStarted, issuanceStateOf, prepareIssuance, revokeNewValue, writtenPlacesOf, IssuanceError, StaleIssuanceError, type RevokeTarget } from "../src/issuance.js";
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
    reviewChecklist: () => ["Rechte exakt Workers Scripts Write", "Nur Konto acme"],
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const evidence = new FileEvidenceStore(await mkdtemp(join(tmpdir(), "sd-ev-")));
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence,
  };
  return { deps, inventory, evidence, revoke, writes };
}

describe("stage 1: prepareIssuance", () => {
  it("creates and checks, but writes nothing and revokes nothing", async () => {
    const { deps, writes, revoke, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect(revoke).not.toHaveBeenCalled();
    expect(p.report.checks.map((c) => c.id)).toContain("active");
    expect(p.report.checklist.map((c) => c.text)).toEqual(["Rechte exakt Workers Scripts Write", "Nur Konto acme"]);
    expect(p.report.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(p.report)).not.toContain("NEUER-TOKEN-WERT");
    expect(JSON.stringify(await evidence.list("cf-deploy-acme-app"))).not.toContain("NEUER-TOKEN-WERT");
  });
  it("has manual values reviewed without showing them in the report", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("stripe-webhook-acme-docs-staging", deps, { manualValue: new SecretValue("whsec_handeingabe_123456") });
    expect(p.report.kind).toBe("manual");
    expect(JSON.stringify(p.report)).not.toContain("handeingabe");
  });
});

describe("stage 2: commitIssuance", () => {
  it("needs all checkmarks, writes, revokes the old value and records the confirmation", async () => {
    const { deps, inventory, revoke, writes, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    await expect(commitIssuance(p, deps, { by: "alice", ticks: ["c1"] })).rejects.toThrow(/Pruefpunkte/);
    const r = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"], note: "Screenshot geprueft" });
    expect(r.ok).toBe(true);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(2);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "old-token-id" }));
    const s = inventory.getSecret("cf-deploy-acme-app")!;
    expect(s).toMatchObject({ externalId: "new-id", expires: "2027-02-01", verifiedBy: "alice", verifiedAt: "2026-11-01" });
    const saved = (await evidence.list("cf-deploy-acme-app"))[0]!;
    expect(saved.confirmation).toMatchObject({ decision: "confirmed", by: "alice" });
    expect(saved.checks.some((c) => c.id.startsWith("written:") && c.status === "pass")).toBe(true);
  });
  it("refuses on failed check and after expiry", async () => {
    const { deps } = await setup({ failVerify: true });
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    await expect(commitIssuance(p, deps, { by: "n", ticks: ["c1", "c2"] })).rejects.toThrow(IssuanceError);
    const later = { ...deps, now: () => new Date("2026-11-01T11:00:00Z") };
    await expect(commitIssuance(p, later, { by: "n", ticks: ["c1", "c2"] }, { force: true })).rejects.toThrow(/abgelaufen/);
  });
  it("writes nothing once the caller has given up (abort signal), and reports the places as failed", async () => {
    const { deps, writes } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const gaveUp = new AbortController();
    gaveUp.abort();
    const r = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }, { signal: gaveUp.signal });
    expect(r.ok).toBe(false);
    expect(r.places.length).toBeGreaterThan(0);
    for (const place of r.places) expect(place).toMatchObject({ outcome: "failed", error: expect.stringMatching(/Abgebrochen/) });
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    // Nothing was written, so nothing is in use: the item stays open and may be discarded.
    expect(issuanceStateOf(p)).toBe("open");
  });
  it("checks the hard bound against the clock before each write, with no signal and no sweep in between", async () => {
    const { deps, writes } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }, { hardBound: new Date("2026-11-01T10:00:00Z").getTime() });
    expect(r.ok).toBe(false);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    const ok = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }, { hardBound: new Date("2026-11-01T10:00:01Z").getTime() });
    expect(ok.ok).toBe(true);
  });
  it("the hard bound is read from the system clock when no clock is injected", async () => {
    const { deps } = await setup();
    const { now: _clock, ...noClock } = deps;
    const p = await prepareIssuance("cf-deploy-acme-app", noClock);
    const r = await commitIssuance(p, noClock, { by: "alice", ticks: ["c1", "c2"] }, { hardBound: Date.now() + 3_600_000 });
    expect(r.ok).toBe(true);
  });
  it("states: committing while a commit writes, committed after, discarded after a discard", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const seen: string[] = [];
    const real = deps.github.putSecret.bind(deps.github);
    const github = Object.assign(Object.create(deps.github) as typeof deps.github, {
      putSecret: async (...args: Parameters<typeof real>) => {
        seen.push(issuanceStateOf(p));
        return real(...args);
      },
    });
    await commitIssuance(p, { ...deps, github }, { by: "alice", ticks: ["c1", "c2"] });
    expect(seen).toEqual(["committing", "committing"]);
    expect(issuanceStateOf(p)).toBe("committed");
    const q = await prepareIssuance("cf-deploy-acme-app", deps);
    await discardIssuance(q, deps, { by: "system", why: "expired" });
    expect(issuanceStateOf(q)).toBe("discarded");
  });
  it("a commit that stopped after writing some places is partial: the new value is in use, a note names the places, and it is no longer open", async () => {
    const { deps, writes, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const stop = new AbortController();
    const real = deps.github.putSecret.bind(deps.github);
    const github = Object.assign(Object.create(deps.github) as typeof deps.github, {
      putSecret: async (...args: Parameters<typeof real>) => {
        const out = await real(...args);
        stop.abort();
        return out;
      },
    });
    const r = await commitIssuance(p, { ...deps, github }, { by: "alice", ticks: ["c1", "c2"] }, { signal: stop.signal });
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(1);
    expect(issuanceStateOf(p)).toBe("partial");
    const note = p.report.checks.find((c) => c.id === "partial-write")!;
    expect(note.label).toContain("acme-app");
    expect((await evidence.list("cf-deploy-acme-app")).some((rep) => rep.checks.some((c) => c.id === "partial-write"))).toBe(true);
    // A person can still reject it (that revokes), and a second confirm that works makes it committed.
    const again = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] });
    expect(again.ok).toBe(true);
    expect(issuanceStateOf(p)).toBe("committed");
  });
  it("a partial commit is reported as partial even when the note cannot be saved", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const stop = new AbortController();
    const real = deps.github.putSecret.bind(deps.github);
    const github = Object.assign(Object.create(deps.github) as typeof deps.github, {
      putSecret: async (...args: Parameters<typeof real>) => {
        const out = await real(...args);
        stop.abort();
        return out;
      },
    });
    const evidence = {
      ...deps.evidence,
      save: async () => {
        throw new Error("disk full");
      },
    } as never;
    const r = await commitIssuance(p, { ...deps, github, evidence }, { by: "alice", ticks: ["c1", "c2"] }, { signal: stop.signal });
    expect(r.partial).toBe(true);
    expect(issuanceStateOf(p)).toBe("partial");
  });
  it("a report that cannot be saved after the places were written is a warning: the item counts as committed and cannot be revoked", async () => {
    const { deps, revoke } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect(issuanceStateOf(p)).toBe("open");
    const failing = {
      ...deps,
      evidence: {
        ...deps.evidence,
        save: async () => {
          throw new Error("disk full");
        },
      } as never,
    };
    const r = await commitIssuance(p, failing, { by: "alice", ticks: ["c1", "c2"] });
    expect(r.ok).toBe(true);
    expect(r.warnings?.join(" ")).toMatch(/Pruefbericht/);
    expect(issuanceStateOf(p)).toBe("committed");
    revoke.mockClear();
    await expect(discardIssuance(p, deps, { by: "system", why: "expired" })).rejects.toThrow(IssuanceError);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("revokeNewValue: the one gate for revoking a newly issued value", () => {
  const target = (over: Partial<RevokeTarget> = {}): RevokeTarget => ({ secretId: "cf-deploy-acme-app", provider: "cloudflare-token", externalId: "new-id", ...over });

  it("calls the provider from metadata alone when nothing speaks against it, and says whether the provider confirmed", async () => {
    const { deps, revoke } = await setup();
    expect(await revokeNewValue(target(), deps)).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id" }));
    revoke.mockRejectedValueOnce(new Error("provider down"));
    expect(await revokeNewValue(target(), deps)).toEqual({ status: "failed" });
  });

  it("refuses without calling the provider, with a typed reason", async () => {
    const { deps, inventory, revoke } = await setup();
    const refused = async (t: RevokeTarget, o?: { acknowledgeWritten?: boolean }) => revokeNewValue(t, deps, o);
    expect(await refused(target({ externalId: undefined }))).toEqual({ status: "refused", reason: "no-id" });
    // The identifier the entry holds now: the value was rolled out (also when another review of the same identifier was confirmed).
    expect(await refused(target({ externalId: "old-token-id" }))).toEqual({ status: "refused", reason: "value-in-use" });
    inventory.patchSecret("stripe-webhook-acme-docs-staging", { externalId: "companion-id" });
    expect(await refused(target({ externalId: "companion-id", companionIds: ["stripe-webhook-acme-docs-staging"] }))).toEqual({ status: "refused", reason: "value-in-use" });
    expect(await refused(target({ writeStarted: true }))).toEqual({ status: "refused", reason: "write-started" });
    expect(await refused(target({ secretId: "no-such-secret" }))).toEqual({ status: "refused", reason: "secret-gone" });
    expect(await refused(target({ provider: "some-other-provider" }))).toEqual({ status: "refused", reason: "provider-changed" });
    expect(await refused(target({ secretId: "stripe-webhook-acme-docs-staging", provider: "manual" }))).toEqual({ status: "refused", reason: "no-revoke" });
    expect(revoke).not.toHaveBeenCalled();
    // The acknowledgement a person's reject (or an explicit orphan revoke) supplies lifts exactly the write-started refusal.
    expect(await refused(target({ writeStarted: true }), { acknowledgeWritten: true })).toEqual({ status: "revoked" });
    expect(await refused(target({ externalId: "old-token-id", writeStarted: true }), { acknowledgeWritten: true })).toEqual({ status: "refused", reason: "value-in-use" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("with the entry as it was issued, the provider and parameters of back then are used and the record checks are not needed", async () => {
    const { deps, inventory, revoke } = await setup();
    const issued = { ...inventory.getSecret("cf-deploy-acme-app")!, params: { zone: "old" } };
    expect(await revokeNewValue(target({ secretId: "no-such-secret", provider: "whatever", issuedSecret: issued }), deps)).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id", params: expect.objectContaining({ zone: "old" }) }));
  });

  it("is the only caller of a provider's revoke for a new value: a failing report store does not turn a delete that happened into a failed one", async () => {
    const { deps, revoke } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const failing = { ...deps, evidence: { ...deps.evidence, save: async () => { throw new Error("disk full"); } } as never };
    expect(await discardIssuance(p, failing, { by: "system", why: "expired" })).toEqual({ revokedNew: true });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("commit, write started and the gate", () => {
  const failingPuts = (deps: Awaited<ReturnType<typeof setup>>["deps"]) =>
    ({
      ...deps,
      github: Object.assign(Object.create(deps.github) as typeof deps.github, {
        putSecret: async () => {
          throw new Error("socket timed out");
        },
      }),
    }) as typeof deps;

  it("calls beforeWrite once, before the first write, and a beforeWrite that throws means nothing is written", async () => {
    const { deps, writes } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const before = vi.fn(() => {
      throw new Error("store down");
    });
    await expect(commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }, { beforeWrite: before })).rejects.toThrow("store down");
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect(hasWriteStarted(p)).toBe(false);
    expect(writtenPlacesOf(p)).toEqual([]);
    expect(issuanceStateOf(p)).toBe("open");
    const seen: number[] = [];
    const ok = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }, { beforeWrite: () => void seen.push(writes.filter((w) => w.startsWith("PUT")).length) });
    expect(ok.ok).toBe(true);
    expect(seen).toEqual([0]);
    expect(hasWriteStarted(p)).toBe(true);
    expect(writtenPlacesOf(p)).toHaveLength(2);
  });

  it("a write that throws counts as started: the item is partial, the note names the places, nothing was applied for sure", async () => {
    const { deps, revoke } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await commitIssuance(p, failingPuts(deps), { by: "alice", ticks: ["c1", "c2"] });
    expect(r.ok).toBe(false);
    expect(issuanceStateOf(p)).toBe("partial");
    expect(writtenPlacesOf(p)).toHaveLength(2);
    expect(p.report.checks.find((c) => c.id === "partial-write")?.label).toContain("moeglicherweise");
    // Everything that would revoke it now refuses.
    expect(await discardIssuance(p, deps, { by: "system", why: "expired" })).toEqual({ revokedNew: false, refused: "write-started" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("a stale entry after a write was started: the gate refuses, the error says so, nothing is revoked", async () => {
    const { deps, inventory, revoke } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    await commitIssuance(p, failingPuts(deps), { by: "alice", ticks: ["c1", "c2"] });
    inventory.setSecretParams("cf-deploy-acme-app", { extra: 1 }, []);
    const err = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleIssuanceError);
    expect(err).toMatchObject({ revokedNew: false, revokeRefused: "write-started" });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("a stale entry before any write: revoked as before, and the error reports it", async () => {
    const { deps, inventory, revoke } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    inventory.setSecretParams("cf-deploy-acme-app", { extra: 1 }, []);
    const err = await commitIssuance(p, deps, { by: "alice", ticks: ["c1", "c2"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ revokedNew: true });
    expect((err as StaleIssuanceError).revokeRefused).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("when the provider names no identifier for the new value, a successful commit clears the identifier of the value it just revoked", async () => {
    const { deps, inventory } = await setup();
    const providers = new ProviderRegistry().register({ id: "cloudflare-token", label: "Cloudflare", kind: "automatic", issue: async () => ({ value: new SecretValue("NEUER-TOKEN-WERT-123") }), revoke: vi.fn(async () => undefined), reviewChecklist: () => ["only"] });
    const own = { ...deps, providers };
    const p = await prepareIssuance("cf-deploy-acme-app", own);
    expect(inventory.getSecret("cf-deploy-acme-app")!.externalId).toBe("old-token-id");
    const r = await commitIssuance(p, own, { by: "alice", ticks: ["c1"] });
    expect(r.ok).toBe(true);
    expect(inventory.getSecret("cf-deploy-acme-app")!.externalId).toBeUndefined();
  });
});

describe("discardIssuance", () => {
  it("deletes the new value at the provider and writes nothing", async () => {
    const { deps, revoke, writes, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const r = await discardIssuance(p, deps, { by: "alice", why: "rejected", note: "falsche Rechte" });
    expect(r.revokedNew).toBe(true);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id" }));
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect((await evidence.list("cf-deploy-acme-app"))[0]!.confirmation).toMatchObject({ decision: "rejected" });
  });
});

describe("receipt and attachments", () => {
  it("renders an SVG without the value and escapes special characters", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    p.report.label = '<script>alert("x")</script>';
    const svg = renderEvidenceSvg(p.report);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("NEUER-TOKEN-WERT");
    expect(svg).toContain(p.report.fingerprint);
  });
  it("accepts images up to 5 MB only", async () => {
    const { deps, evidence } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    const att = await evidence.attach("cf-deploy-acme-app", p.report.id, new Uint8Array([137, 80, 78, 71]), "image/png", "Dashboard");
    expect(att.file).toBe("anlage-1.png");
    expect((await evidence.readAttachment("cf-deploy-acme-app", p.report.id, "anlage-1.png"))!.mime).toBe("image/png");
    await expect(evidence.attach("cf-deploy-acme-app", p.report.id, new Uint8Array([1]), "text/html")).rejects.toThrow(/PNG/);
    await expect(evidence.attach("cf-deploy-acme-app", p.report.id, new Uint8Array(5 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(/5 MB/);
    await expect(evidence.get("../etc", "x")).rejects.toThrow(/Ungueltige/);
    expect(await readFile(join(evidence.dir, "cf-deploy-acme-app", p.report.id, "anlage-1.png"))).toHaveLength(4);
  });
});

describe("binding to the state of the review (finding F2b)", () => {
  const ticks = ["c1", "c2"];
  it("retargeted targets after the review: nothing is written, the new value is revoked", async () => {
    const { deps, inventory, revoke, writes } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    // Angriff: zwischen Pruefung und Bestaetigung zeigt das Secret auf ein fremdes Repository.
    inventory.data.secrets.find((s) => s.id === "cf-deploy-acme-app")!.places = [{ repo: "attacker-repo", scope: "repository" }];
    const err = await commitIssuance(p, deps, { by: "alice", ticks }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleIssuanceError);
    expect((err as Error).message).toBe("Eintrag wurde seit der Pruefung geaendert, bitte neu erzeugen");
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "new-id" }));
    expect(revoke).not.toHaveBeenCalledWith(expect.objectContaining({ externalId: "old-token-id" }));
  });
  it("changed parameters or provider: also discarded; revoke uses the parameters of back then", async () => {
    const { deps, inventory, revoke, writes } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    inventory.data.secrets.find((s) => s.id === "cf-deploy-acme-app")!.params = { baseUrl: "https://evil.example" };
    await expect(commitIssuance(p, deps, { by: "alice", ticks })).rejects.toThrow(StaleIssuanceError);
    expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    const call = revoke.mock.calls[0] as unknown as [{ params: Record<string, unknown> }];
    expect(call[0].params).toEqual({});
  });
  it("changed stage and old identifier count too", async () => {
    for (const change of [(s: { stage: string }) => (s.stage = "production"), (s: { externalId?: string }) => (s.externalId = "anderer")]) {
      const { deps, inventory, writes } = await setup();
      const p = await prepareIssuance("cf-deploy-acme-app", deps);
      change(inventory.data.secrets.find((s) => s.id === "cf-deploy-acme-app")! as never);
      await expect(commitIssuance(p, deps, { by: "alice", ticks })).rejects.toThrow(StaleIssuanceError);
      expect(writes.filter((w) => w.startsWith("PUT"))).toHaveLength(0);
    }
  });
  it("unchanged: as before", async () => {
    const { deps } = await setup();
    const p = await prepareIssuance("cf-deploy-acme-app", deps);
    expect((await commitIssuance(p, deps, { by: "alice", ticks })).ok).toBe(true);
  });
});
