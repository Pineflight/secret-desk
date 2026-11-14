import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, InventoryStore, ProviderRegistry, RotationError, SecretValue, describePlace, planRotation, rotateSecret, uploadEncrypted } from "../src/index.js";
import type { Provider, RotationEvent } from "../src/index.js";

const SECRET = (extra = "") => `  - { id: s1, name: API_KEY, stage: staging, service: x, provider: acme, expiry: possible${extra}, places: [{ repo: web, scope: environment, environment: staging }, { repo: api, scope: repository }] }\n`;
const inventory = (secret = SECRET()) => InventoryStore.fromText(`version: 1\nsecrets:\n${secret}`);

function setup(over: { provider?: Partial<Provider> | null; secret?: string; putSecret?: (target: { repo: string }) => Promise<"created" | "updated">; now?: boolean; providerConfig?: boolean } = {}) {
  const events: RotationEvent[] = [];
  const issue = vi.fn(async () => ({ value: new SecretValue("made-up-new-value"), externalId: "new-id", expiresAt: null as string | null }));
  const revoke = vi.fn(async () => undefined);
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue, revoke, ...over.provider };
  const github = { putSecret: vi.fn(over.putSecret ?? (async () => "created" as const)), putEncrypted: vi.fn(async () => "updated" as const) };
  const store = inventory(over.secret);
  const deps = {
    inventory: store,
    github: github as never,
    providers: over.provider === null ? new ProviderRegistry() : new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    fetch: vi.fn() as never,
    ...(over.now === false ? {} : { now: () => new Date("2026-03-01T10:00:00Z") }),
    ...(over.providerConfig ? { providerConfig: { grafana: { allowedHosts: [] } } } : {}),
    onEvent: (e: RotationEvent) => events.push(e),
  };
  return { deps, store, issue, revoke, github, events };
}
const failAll = async (): Promise<never> => {
  throw new Error("forbidden");
};

describe("planRotation", () => {
  it("names unknown secrets, handles an unknown provider, and shows the time to live", () => {
    expect(() => planRotation("nope", setup().deps)).toThrow(new RotationError("Secret nicht gefunden: nope"));
    const plan = planRotation("s1", setup({ provider: null, secret: SECRET(", ttlDays: 30") }).deps);
    expect(plan).toMatchObject({ automatic: false, readOnly: false, ttlDays: 30, revokesOld: false, params: { ok: true, missing: [], problems: [] } });
    expect(plan.places).toEqual(["web/env:staging", "api/repo"]);
  });
  it("describes organization and Worker places", () => {
    expect(describePlace({ repo: "acme", scope: "organization" })).toBe("acme/org");
    expect(describePlace({ scope: "cloudflare-worker", accountId: "a", script: "portal" })).toBe("Cloudflare Worker portal (a)");
  });
  it("reports missing parameters", () => {
    const { deps } = setup({ provider: { params: [{ key: "project", label: "Project", labelEn: "Project", type: "string", required: true, help: "", helpEn: "" }] } });
    expect(planRotation("s1", deps).params).toMatchObject({ ok: false, missing: ["project"] });
  });
});

describe("rotateSecret", () => {
  it("refuses unknown secrets and secrets without places", async () => {
    await expect(rotateSecret("nope", setup().deps)).rejects.toThrow("Secret nicht gefunden: nope");
    const noPlaces = inventory("  - { id: s1, name: API_KEY, stage: dev, service: x, provider: acme, expiry: none }\n");
    await expect(rotateSecret("s1", { ...setup().deps, inventory: noPlaces })).rejects.toThrow("kein Ziel");
  });

  it("uses the real clock and the global fetch by default and passes the provider configuration on", async () => {
    const { deps, issue, revoke } = setup({ now: false, providerConfig: true, secret: SECRET(", externalId: old-id") });
    const { fetch: _fetch, ...withoutFetch } = deps;
    void _fetch;
    const result = await rotateSecret("s1", withoutFetch);
    expect(result.ok).toBe(true);
    expect((issue.mock.calls[0] as unknown as [{ fetch: unknown; providerConfig: unknown; now: Date }])[0]).toMatchObject({ fetch, providerConfig: { grafana: { allowedHosts: [] } } });
    expect(revoke.mock.calls[0]![0]).toMatchObject({ providerConfig: { grafana: { allowedHosts: [] } } });
  });

  it("an unknown expiry is warned about; a revoke that fails is reported but does not fail the rotation", async () => {
    const { deps, events } = setup({ secret: SECRET(", externalId: old-id"), provider: { revoke: async () => { throw new Error("revoke refused"); } } });
    const result = await rotateSecret("s1", deps);
    expect(result).toMatchObject({ ok: true, revoked: false, expires: null });
    expect(result.warnings).toEqual(["Das Ablaufdatum des neuen Tokens ist unbekannt (kein ttlDays, keine Angabe des Anbieters). Datum von Hand eintragen."]);
    expect(events).toContainEqual({ type: "revoke-failed", secretId: "s1", message: "revoke refused" });
  });

  it("a rotation that cannot be recorded still succeeds and says what to do", async () => {
    const withOld = setup({ secret: SECRET(", externalId: old-id, ttlDays: 10") });
    vi.spyOn(withOld.store, "save").mockRejectedValue(new Error("disk full"));
    const revoked = await rotateSecret("s1", withOld.deps);
    expect(revoked).toMatchObject({ ok: true, revoked: true, orphanExternalId: "new-id" });
    expect(revoked.warnings).toEqual(["Der alte Token ist bereits widerrufen, aber das Inventar wurde nicht gespeichert.", "Neue Kennung: new-id", "Grund: disk full"]);

    const withoutOld = setup({ provider: { issue: async () => ({ value: new SecretValue("v") }) } });
    vi.spyOn(withoutOld.store, "save").mockRejectedValue(new Error("disk full"));
    const unrecorded = await rotateSecret("s1", withoutOld.deps);
    expect(unrecorded.warnings).toContain("Der neue Token ist in allen Zielen geschrieben, aber das Inventar wurde nicht gespeichert.");
    expect(unrecorded.warnings).toContain("Neue Kennung: unbekannt");
    expect(unrecorded).not.toHaveProperty("orphanExternalId");
  });

  describe("when no target takes the new value", () => {
    // A write that reported failure may have been applied, so only a person who acknowledged that has the new token revoked.
    it("the new token is revoked at the provider again, for a person who acknowledged the written places", async () => {
      const { deps, revoke } = setup({ putSecret: failAll, provider: {} });
      const result = await rotateSecret("s1", { ...deps, providerConfig: { grafana: { allowedHosts: [] } } }, { acknowledgeWritten: true });
      expect(result).toMatchObject({ ok: false, partial: false, newTokenRevoked: true });
      expect(revoke.mock.calls[0]![0]).toMatchObject({ externalId: "new-id", providerConfig: { grafana: { allowedHosts: [] } } });
    });
    it("a token that cannot be revoked stays and is named", async () => {
      const { deps } = setup({ putSecret: failAll, provider: { revoke: async () => { throw new Error("no"); } } });
      const result = await rotateSecret("s1", deps, { acknowledgeWritten: true });
      expect(result.orphanExternalId).toBe("new-id");
      expect(result.warnings![0]).toContain("konnte beim Anbieter nicht widerrufen werden");
    });
    it("a provider that cannot revoke leaves the token and names it", async () => {
      const { deps } = setup({ putSecret: failAll, provider: { revoke: undefined } });
      const result = await rotateSecret("s1", deps, { acknowledgeWritten: true });
      expect(result.orphanExternalId).toBe("new-id");
      expect(result.warnings![0]).toContain("bleibt beim Anbieter bestehen");
    });
    it("a provider that names no id gives a hint", async () => {
      const { deps } = setup({ putSecret: failAll, provider: { issue: async () => ({ value: new SecretValue("v") }) } });
      const result = await rotateSecret("s1", deps);
      expect(result.warnings).toEqual(["Der Anbieter nennt keine Kennung fuer den neuen Token: ihn beim Anbieter pruefen und von Hand widerrufen."]);
    });
  });

  describe("when only some targets take the new value", () => {
    const partial = (target: { repo: string }) => (target.repo === "web" ? Promise.resolve("created" as const) : Promise.reject(new Error("forbidden")));
    it("the token is kept and named", async () => {
      const result = await rotateSecret("s1", setup({ putSecret: partial }).deps);
      expect(result).toMatchObject({ ok: false, partial: true, orphanExternalId: "new-id" });
      expect(result.warnings![0]).toContain("nur in einem Teil der Ziele geschrieben");
    });
    it("without an id the hint stays general", async () => {
      const result = await rotateSecret("s1", setup({ putSecret: partial, provider: { issue: async () => ({ value: new SecretValue("v") }) } }).deps);
      expect(result.warnings).toEqual(["Der neue Token ist nur in einem Teil der Ziele geschrieben: Ziele erneut schreiben oder ihn beim Anbieter von Hand widerrufen."]);
    });
  });
});

describe("uploadEncrypted", () => {
  const ACC = "0123456789abcdef0123456789abcdef";
  const item = (place: object) => ({ place: place as never, keyId: "k", encryptedValue: "YWJj" });

  it("refuses unknown secrets", async () => {
    await expect(uploadEncrypted("nope", [], setup().deps)).rejects.toThrow("Secret nicht gefunden: nope");
  });

  it("refuses Worker places and reports a failing upload", async () => {
    const { deps, github } = setup();
    github.putEncrypted.mockRejectedValueOnce(new Error("forbidden"));
    const store = inventory(`  - { id: s1, name: API_KEY, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }, { scope: cloudflare-worker, accountId: "${ACC}", script: portal }] }\n`);
    const res = await uploadEncrypted("s1", [item({ repo: "web", scope: "repository" }), item({ scope: "cloudflare-worker", accountId: ACC, script: "portal" })], { ...deps, inventory: store });
    expect(res.places).toEqual([
      { place: "web/repo", outcome: "failed", error: "forbidden" },
      { place: `Cloudflare Worker portal (${ACC})`, outcome: "failed", error: expect.stringContaining("Browser-Upload") },
    ]);
    expect(res.ok).toBe(false);
  });

  it("a successful upload without expiry or external id only stamps the rotation day", async () => {
    const { deps, store } = setup();
    const before = store.getSecret("s1")!.expires;
    const res = await uploadEncrypted("s1", [item({ repo: "api", scope: "repository" })], deps);
    expect(res).toMatchObject({ ok: true, expires: before ?? null });
    expect(store.getSecret("s1")!.rotatedAt).toBe("2026-03-01");
    expect(store.getSecret("s1")!.externalId).toBeUndefined();
  });

  it("records an expiry and an external id from the browser, and the real clock by default", async () => {
    const { deps, store } = setup();
    const { now: _now, ...withoutClock } = deps;
    void _now;
    const res = await uploadEncrypted("s1", [item({ repo: "api", scope: "repository" })], withoutClock, { expires: "2027-01-01", externalId: "ext-1" });
    expect(res).toMatchObject({ ok: true, expires: "2027-01-01" });
    expect(store.getSecret("s1")).toMatchObject({ expires: "2027-01-01", externalId: "ext-1" });
    expect(store.getSecret("s1")!.rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
