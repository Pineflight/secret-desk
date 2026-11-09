import { describe, expect, it, vi } from "vitest";
import {
  ConnectionStore,
  InventoryStore,
  NotConnectedError,
  ParamsInvalidError,
  PreflightError,
  ProviderRegistry,
  UnknownDiscoverKindError,
  assertEntryParams,
  assertPreflight,
  discoverResources,
  entryParamsState,
  hintFor,
  markSuggestions,
  paramsMessage,
  preflightEntry,
  validateEntryParams,
} from "../src/index.js";
import type { ParamSpec, Provider, SecretEntry } from "../src/index.js";

const spec = (over: Partial<ParamSpec> & { key: string; type: ParamSpec["type"] }): ParamSpec => ({ label: over.key, labelEn: over.key, required: true, help: "", helpEn: "", ...over });

describe("parameter validation", () => {
  const entry = (params: Record<string, unknown>) => ({ params });
  const check = (s: ParamSpec, v: unknown) => validateEntryParams({ params: [s] }, entry({ [s.key]: v }));

  it("url: only a valid https address is accepted", () => {
    const s = spec({ key: "site", type: "url" });
    expect(check(s, "https://example.com")).toEqual([]);
    expect(check(s, "http://example.com")[0]).toMatchObject({ code: "wrong_type", message: "Parameter site muss eine gueltige https-Adresse sein" });
    expect(check(s, "not a url")[0]).toMatchObject({ code: "wrong_type" });
    expect(check(s, 5)[0]).toMatchObject({ code: "wrong_type" });
  });

  it("enum: needs text (or a boolean an option spells) and says so", () => {
    const s = spec({ key: "mode", type: "enum", options: [{ value: "true", label: "yes", labelEn: "yes" }, { value: "a", label: "A", labelEn: "A" }] });
    expect(check(s, "a")).toEqual([]);
    expect(check(s, true)).toEqual([]);
    expect(check(s, false)[0]).toMatchObject({ code: "wrong_type", message: "Parameter mode muss Text sein" });
    expect(check(s, 5)[0]).toMatchObject({ code: "wrong_type" });
    expect(check(s, "b")[0]).toMatchObject({ code: "not_in_options" });
    const noOptions = spec({ key: "free", type: "enum" });
    expect(check(noOptions, true)[0]).toMatchObject({ code: "wrong_type" });
    expect(check(noOptions, "anything")).toEqual([]);
  });

  it("integer: whole numbers within min (default 1) and max (optional)", () => {
    const plain = spec({ key: "days", type: "integer" });
    expect(check(plain, 5)).toEqual([]);
    expect(check(plain, 0)).toHaveLength(1);
    expect(check(plain, 1.5)).toHaveLength(1);
    expect(check(plain, "5")).toHaveLength(1);
    const bounded = spec({ key: "days", type: "integer", min: 3, max: 10 });
    expect(check(bounded, 3)).toEqual([]);
    expect(check(bounded, 10)).toEqual([]);
    expect(check(bounded, 2)).toHaveLength(1);
    expect(check(bounded, 11)).toHaveLength(1);
  });

  it("paramsMessage lists missing parameters first, then other problems; assertEntryParams throws them", () => {
    const specs = [spec({ key: "a", type: "string", label: "Alpha" }), spec({ key: "n", type: "integer" })];
    const problems = validateEntryParams({ params: specs }, entry({ n: "x" }));
    expect(paramsMessage(problems)).toBe("Pflichtparameter fehlen: a (Alpha); Parameter n muss eine ganze Zahl sein");
    expect(() => assertEntryParams({ params: specs }, entry({ n: "x" }))).toThrow(ParamsInvalidError);
    expect(() => assertEntryParams({ params: specs }, entry({ a: "x", n: 2 }))).not.toThrow();
    expect(paramsMessage([problems[1]!])).toBe("Parameter n muss eine ganze Zahl sein");
  });

  it("ParamsInvalidError takes an explicit message", () => {
    expect(new ParamsInvalidError([], "custom").message).toBe("custom");
  });

  it("PreflightError names the failing findings, with details where there are some", () => {
    const err = new PreflightError([{ id: "a", level: "fail", label: "A broke", detail: "why" }, { id: "b", level: "ok", label: "B fine" }, { id: "c", level: "fail", label: "C broke" }]);
    expect(err.message).toBe("Vorabpruefung fehlgeschlagen: A broke (why); C broke");
    expect(err).toMatchObject({ code: "preflight_failed", name: "PreflightError" });
    expect(new UnknownDiscoverKindError("x.y")).toMatchObject({ message: "Unbekannte Entdeckungsart: x.y", kind: "x.y", name: "UnknownDiscoverKindError" });
  });
});

describe("resource suggestions", () => {
  const opt = (value: string, label: string, detail?: string) => ({ value, label, ...(detail ? { detail } : {}) });

  it("keeps the detail of an option and never marks one for an unknown kind", () => {
    expect(markSuggestions("unknown.kind", [opt("1", "One", "d")], { repos: [] })).toEqual({ options: [{ value: "1", label: "One", detail: "d" }], suggested: null });
  });

  it("an empty list gives no suggestion", () => {
    expect(markSuggestions("supabase.project", [], { repos: ["web"] })).toEqual({ options: [], suggested: null });
  });

  it("the sole option is suggested for a sole kind; two options are not", () => {
    expect(markSuggestions("cloudflare.account", [opt("a", "Account")], { repos: [] }).suggested).toBe("a");
    expect(markSuggestions("cloudflare.account", [opt("a", "A"), opt("b", "B")], { repos: [] }).suggested).toBeNull();
  });

  it("a repo-mode kind suggests the one name that contains the repository", () => {
    const r = markSuggestions("cloudflare.zone", [opt("z1", "web.example.com"), opt("z2", "other.example.com")], { repos: ["web"] });
    expect(r.suggested).toBe("z1");
    expect(r.options[0]).toMatchObject({ suggestedFor: { score: 2, reason: "Name enthaelt das Repository" } });
  });

  it("a name-mode kind needs repository and stage word; without any stage hint the repository is enough", () => {
    const withStage = markSuggestions("supabase.project", [opt("p1", "web-staging"), opt("p2", "web-production")], { repos: ["web"], stage: "staging", stageKind: "test" });
    expect(withStage.suggested).toBe("p1");
    expect(withStage.options[0]).toMatchObject({ suggestedFor: { score: 3 } });
    const noStage = markSuggestions("supabase.project", [opt("p1", "web-main"), opt("p2", "other")], { repos: ["web"] });
    expect(noStage.suggested).toBe("p1");
    expect(noStage.options[0]).toMatchObject({ suggestedFor: { score: 2 } });
    const sharedKind = markSuggestions("supabase.project", [opt("p1", "web-main")], { repos: ["web"], stageKind: "shared" });
    expect(sharedKind.suggested).toBe("p1");
    const onlyKind = markSuggestions("supabase.project", [opt("p1", "web-staging"), opt("p2", "web-production")], { repos: ["web"], stageKind: "test" });
    expect(onlyKind.suggested).toBe("p1");
    const weak = markSuggestions("supabase.project", [opt("p1", "web-main")], { repos: ["web"], stage: "staging", stageKind: "test" });
    expect(weak.suggested).toBeNull();
  });

  it("an explicit mapping wins; a mapping to an unknown resource gives a hint instead", () => {
    const hint = { repos: ["web"], stage: "staging", resourceMap: [{ kind: "supabase.project", repo: "web", value: "p2", label: "Mapped" }] };
    const ok = markSuggestions("supabase.project", [opt("p1", "web-staging"), opt("p2", "other")], hint);
    expect(ok.suggested).toBe("p2");
    expect(ok.options[1]).toMatchObject({ suggestedFor: { score: 4, reason: "Zuordnung" } });
    const missing = markSuggestions("supabase.project", [opt("p1", "web-staging")], hint);
    expect(missing).toMatchObject({ suggested: null, mapMismatch: { value: "p2", label: "Mapped" } });
    const noLabel = markSuggestions("supabase.project", [], { ...hint, resourceMap: [{ kind: "supabase.project", repo: "web", value: "p9" }] });
    expect(noLabel.mapMismatch).toEqual({ value: "p9" });
  });
});

describe("preflight and discovery", () => {
  const inventory = (extra = "") => InventoryStore.fromText(`version: 1\n${extra}`);
  const secret = (over: Partial<SecretEntry> = {}) => ({ id: "s1", name: "S_ONE", stage: "staging", service: "x", provider: "acme", expiry: "none", params: { project: "p1" }, places: [{ repo: "web", scope: "environment", environment: "staging" }, { repo: "api", scope: "repository" }, { repo: "web", scope: "repository" }, { scope: "cloudflare-worker", accountId: "a", script: "w" }], ...over }) as unknown as SecretEntry;
  const provider = (over: Partial<Provider> = {}): Provider => ({ id: "acme", label: "Acme", kind: "automatic", connection: "acme", params: [spec({ key: "project", type: "string", integrationDefault: true })], ...over });
  const deps = (p: Provider, inv = inventory(), extra: object = {}) => ({ inventory: inv, providers: new ProviderRegistry().register(p), connections: new ConnectionStore(), fetch: vi.fn() as never, ...extra });

  it("skips providers without a preflight and entries whose parameters are incomplete", async () => {
    expect(await preflightEntry(secret(), deps(provider()))).toEqual({ status: "skipped", skippedReason: "none", resource: null, findings: [] });
    expect(await preflightEntry(secret({ provider: "unknown" }), deps(provider({ preflight: async () => ({ resource: null, findings: [] }) })))).toMatchObject({ skippedReason: "none" });
    const preflight = vi.fn();
    expect(await preflightEntry(secret({ params: {} }), deps(provider({ preflight })))).toEqual({ status: "skipped", skippedReason: "params", resource: null, findings: [] });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("runs the check with the effective parameters (integration defaults included) and rates the findings", async () => {
    const preflight = vi.fn(async () => ({ resource: "Project p1", findings: [{ id: "a", level: "ok" as const, label: "ok" }] }));
    const inv = inventory("integrationDefaults:\n  acme: { project: from-default }\n");
    const r = await preflightEntry(secret({ params: {} }), deps(provider({ preflight }), inv, { providerConfig: { grafana: { allowedHosts: [] } } }));
    expect(r).toEqual({ status: "ok", resource: "Project p1", findings: [{ id: "a", level: "ok", label: "ok" }] });
    expect(preflight.mock.calls[0]![0]).toMatchObject({ params: { project: "from-default" }, stage: "staging", stageKind: "test", providerConfig: { grafana: { allowedHosts: [] } } });
  });

  it("rates warn and fail findings; assertPreflight throws only for fail", async () => {
    const rate = async (level: "ok" | "warn" | "fail", more: ("ok" | "warn" | "fail")[] = []) =>
      preflightEntry(secret(), deps(provider({ preflight: async () => ({ resource: null, findings: [level, ...more].map((l, i) => ({ id: String(i), level: l, label: l })) }) })));
    expect((await rate("warn")).status).toBe("warn");
    expect((await rate("ok", ["warn", "fail"])).status).toBe("fail");
    expect(() => assertPreflight({ status: "warn", resource: null, findings: [{ id: "a", level: "warn", label: "w" }] })).not.toThrow();
    expect(() => assertPreflight({ status: "fail", resource: null, findings: [{ id: "a", level: "fail", label: "f" }] })).toThrow(PreflightError);
  });

  it("a missing connection becomes a status, or is rethrown on request; other errors pass through; the global fetch is the default", async () => {
    const notConnected = provider({ preflight: async () => { throw new NotConnectedError("acme", "Token eingeben"); } });
    expect(await preflightEntry(secret(), deps(notConnected))).toEqual({ status: "not-connected", skippedReason: "not-connected", resource: null, findings: [], connection: "acme", hint: "Token eingeben" });
    await expect(preflightEntry(secret(), deps(notConnected), { rethrowNotConnected: true })).rejects.toBeInstanceOf(NotConnectedError);
    const broken = provider({ preflight: async () => { throw new Error("boom"); } });
    await expect(preflightEntry(secret(), deps(broken))).rejects.toThrow("boom");
    const seen: unknown[] = [];
    const spy = provider({ preflight: async (ctx) => { seen.push(ctx.fetch); return { resource: null, findings: [] }; } });
    const { fetch: _omit, ...withoutFetch } = deps(spy);
    void _omit;
    await preflightEntry(secret(), withoutFetch);
    expect(seen[0]).toBe(fetch);
  });

  it("entryParamsState without a provider returns the entry parameters unchecked", () => {
    expect(entryParamsState(inventory(), undefined, { params: { a: 1 } })).toEqual({ effective: { a: 1 }, defaults: {}, problems: [] });
  });

  it("hintFor lists the repositories of the GitHub places once, with the stage and its kind", () => {
    expect(hintFor(inventory(), secret())).toEqual({ repos: ["web", "api"], stage: "staging", stageKind: "test" });
    const inv = inventory("resourceMap:\n  - { kind: supabase.project, repo: web, value: p1 }\n");
    expect(hintFor(inv, secret()).resourceMap).toEqual([{ kind: "supabase.project", repo: "web", value: "p1" }]);
  });

  describe("discoverResources", () => {
    const hint = { repos: ["web"], stage: "staging", stageKind: "test" as const };
    const discovering = (discover: Provider["discover"]) => provider({ discover });
    const run = (p: Provider, extra: object = {}) => discoverResources(p, "supabase.project", { connections: new ConnectionStore(), fetch: vi.fn() as never, ...extra }, hint);

    it("is unsupported for a provider that cannot discover", async () => {
      expect(await run(provider())).toEqual({ status: "unsupported", options: [], suggested: null });
    });

    it("returns the options with a suggestion", async () => {
      const r = await run(discovering(async () => [{ value: "p1", label: "web-staging" }]), { providerConfig: { grafana: { allowedHosts: [] } } });
      expect(r).toMatchObject({ status: "ok", suggested: "p1" });
    });

    it("uses the global fetch by default", async () => {
      const seen: unknown[] = [];
      await discoverResources(discovering(async (_k, ctx) => { seen.push(ctx.fetch); return []; }), "x", { connections: new ConnectionStore() }, hint);
      expect(seen[0]).toBe(fetch);
    });

    it("turns the known failures into a status", async () => {
      const failing = (err: Error) => run(discovering(async () => { throw err; }));
      expect(await failing(new NotConnectedError("acme", "Token eingeben"))).toMatchObject({ status: "not-connected", connection: "acme", hint: "Token eingeben" });
      expect(await failing(new UnknownDiscoverKindError("x"))).toMatchObject({ status: "unsupported", error: "Unbekannte Entdeckungsart: x" });
      expect(await failing(Object.assign(new Error("account missing"), { name: "ParamsInvalidError" }))).toMatchObject({ status: "needs-params", error: "account missing" });
      expect(await failing(Object.assign(new Error("HTTP 500"), { name: "ProviderError" }))).toMatchObject({ status: "error", error: "HTTP 500" });
    });

    it("passes programming errors on", async () => {
      await expect(run(discovering(async () => { throw new Error("bug"); }))).rejects.toThrow("bug");
      await expect(run(discovering(async () => { throw "plain"; }))).rejects.toBe("plain");
    });
  });
});
