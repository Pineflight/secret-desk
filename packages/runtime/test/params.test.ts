import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotConnectedError, ParamsInvalidError, UnknownDiscoverKindError, type DiscoveredOption, type Provider } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { PolicyError, type AuthorizationRequest, type Authorize } from "../src/agent-api.js";
import {
  deleteResourceMap,
  getConnectionResources,
  getProviderParams,
  getProviderResources,
  getResourceMap,
  getSecretParams,
  listVariableSources,
  loadVariableFromSource,
  paramStatus,
  previewVariableSource,
  putConnectionDefaults,
  putResourceMap,
  putSecretParams,
  suggestAllParams,
  suggestAllVariables,
} from "../src/params.js";
import { createLocalRuntime } from "../src/runtime.js";

const human = { kind: "human", name: "tester" } as const;
const agent = { kind: "agent", name: "bot" } as const;

const INVENTORY = `version: 1
secrets:
  - id: svc-acme-app-staging
    name: SVC_TOKEN
    stage: staging
    service: fake
    provider: fake-svc
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: svc-acme-app-shared
    name: SVC_TOKEN_SHARED
    stage: shared
    service: fake
    provider: fake-svc
    expiry: none
    params: { project: fixed-project, scope: read, zone: z-1, other: one }
    places:
      - { repo: acme-app, scope: repository }
  - id: plain-manual
    name: PLAIN
    stage: shared
    service: fake
    provider: my-manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
  - id: svc-bad-type
    name: SVC_BAD
    stage: shared
    service: fake
    provider: fake-svc
    expiry: none
    params: { project: p, scope: read, base: "http://not-https.example" }
    places:
      - { repo: acme-app, scope: repository }
providers:
  - { id: my-manual, label: My manual, url: "https://example.com/manual", steps: [Open it] }
variables:
  - id: with-source
    name: SUPA_REF
    stage: shared
    value: old-ref
    from: { connection: supabase, kind: supabase.project, resource: proj-1, field: ref }
    places:
      - { repo: acme-app, scope: repository }
  - id: broken-source
    name: SUPA_GONE
    stage: shared
    from: { connection: supabase, kind: supabase.project, resource: missing-proj, field: ref }
    places:
      - { repo: acme-app, scope: repository }
  - id: no-source
    name: NO_SRC
    stage: shared
    value: x
    places:
      - { repo: acme-app, scope: repository }
  - id: key-var
    name: SUPA_KEY
    stage: shared
    from: { connection: supabase, kind: supabase.project, resource: proj-1, field: ref }
    places:
      - { repo: acme-app, scope: repository }
`;

interface Ctl {
  calls: string[];
  options: Record<string, DiscoveredOption[]>;
  failWith: Error | null;
  discoverParams: Record<string, unknown>[];
}

function fakeProvider(ctl: Ctl): Provider {
  const spec = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key, labelEn: key, type: "string" as const, required: false, help: "", helpEn: "", ...extra });
  return {
    id: "fake-svc",
    label: "Fake service",
    kind: "automatic",
    connection: "fakeconn",
    params: [
      spec("project", { required: true, discover: "supabase.project" }),
      spec("project2", { discover: "supabase.project" }),
      spec("zone", { discover: "cloudflare.zone" }),
      spec("account", { discover: "cloudflare.account", integrationDefault: true }),
      spec("scope", { type: "enum", required: true, options: [{ value: "read", label: "Read", labelEn: "Read" }, { value: "write", label: "Write", labelEn: "Write" }], presets: [{ id: "rw", label: "RW", labelEn: "RW", values: { scope: "write" } }] }),
      spec("perm", { discover: "fake.permission" }),
      spec("base", { type: "url", integrationDefault: true }),
      spec("other"),
    ],
    discoverKinds: ["supabase.project", "cloudflare.zone", "cloudflare.workerScript"],
    discover: async (kind, ctx) => {
      ctl.calls.push(kind);
      ctl.discoverParams.push(ctx.params);
      if (ctl.failWith) throw ctl.failWith;
      const list = ctl.options[kind];
      if (!list) throw new UnknownDiscoverKindError(kind);
      return list;
    },
    preflight: async () => ({ resource: "Fake resource", findings: [{ id: "x", level: "ok", label: "fine" }] }),
  };
}

async function setup(inventory = INVENTORY, extraConfig = "") {
  const dir = await mkdtemp(join(tmpdir(), "sd-params-"));
  await writeFile(join(dir, "inventory.yaml"), inventory);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nautomation:\n  enabled: false\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nconnections:\n  fakeconn: { type: env, name: FAKE_CONN }\n  supabase: { type: env, name: SUPA_CONN }\n${extraConfig}`);
  const ctl: Ctl = { calls: [], options: {}, failWith: null, discoverParams: [] };
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1", FAKE_CONN: "fake_conn_made_up_2" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null, fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch });
  rt.providers.register(fakeProvider(ctl));
  // Real providers answer discover with network calls; the variable sources use a stub for the supabase kinds instead.
  for (const p of rt.providers.list().filter((p) => p.connection === "supabase")) rt.providers.register({ ...p, discover: async (kind, ctx) => { ctl.calls.push(`supabase:${kind}`); ctl.discoverParams.push(ctx.params); if (ctl.failWith) throw ctl.failWith; return ctl.options[kind] ?? []; } });
  return { rt, ctl };
}

const opt = (value: string, label = value): DiscoveredOption => ({ value, label });

describe("actor policy", () => {
  it("rejects agents on every entry point", async () => {
    const { rt } = await setup();
    const rejects = async (p: Promise<unknown> | (() => unknown)) => {
      await expect(typeof p === "function" ? (async () => p())() : p).rejects.toThrow(PolicyError);
    };
    await rejects(getSecretParams(rt, agent, "svc-acme-app-staging"));
    await rejects(putSecretParams(rt, agent, "svc-acme-app-staging", {}));
    await rejects(getProviderParams(rt, agent, "fake-svc"));
    await rejects(getProviderResources(rt, agent, "fake-svc", "supabase.project"));
    await rejects(putConnectionDefaults(rt, agent, "fakeconn", { values: {} }));
    await rejects(() => getResourceMap(rt, agent));
    await rejects(putResourceMap(rt, agent, {}));
    await rejects(deleteResourceMap(rt, agent, {}));
    await rejects(suggestAllParams(rt, agent));
    await rejects(listVariableSources(rt, agent));
    await rejects(previewVariableSource(rt, agent, {}));
    await rejects(loadVariableFromSource(rt, agent, "with-source", {}));
    await rejects(suggestAllVariables(rt, agent));
  });
});

describe("getSecretParams", () => {
  it("live: reports values, unknown keys, defaults, discovery and preflight", async () => {
    const { rt, ctl } = await setup(INVENTORY.replace("params: { project: fixed-project, scope: read, zone: z-1, other: one }", "params: { project: fixed-project, scope: read, zone: z-1, other: one, legacy: keep }"));
    ctl.options["supabase.project"] = [opt("p1", "acme-app staging")];
    ctl.options["cloudflare.zone"] = [opt("z-1", "acme-app.example")];
    ctl.options["cloudflare.account"] = [];
    const view = await getSecretParams(rt, human, "svc-acme-app-shared");
    expect(view.provider).toBe("fake-svc");
    expect(view.connection).toBe("fakeconn");
    expect(view.connected).toBe(true);
    expect(view.values).toMatchObject({ project: "fixed-project", scope: "read" });
    expect(view.values).not.toHaveProperty("legacy");
    expect(view.unknown).toEqual({ legacy: "keep" });
    expect(view.complete).toBe(true);
    expect(view.preflight).toMatchObject({ status: "ok", resource: "Fake resource" });
    // project and project2 share the discovery kind: one call, the second parameter reuses the cached state.
    expect(ctl.calls.filter((c) => c === "supabase.project")).toHaveLength(1);
    expect(view.resources["project"]).toBe(view.resources["project2"]);
    expect(view.resources["zone"]?.status).toBe("ok");
    expect(view.resources["other"]).toBeUndefined();
  });

  it("live=false: no discovery and no preflight", async () => {
    const { rt, ctl } = await setup();
    const view = await getSecretParams(rt, human, "svc-acme-app-shared", { live: false });
    expect(view.resources).toEqual({});
    expect(view.preflight).toBeNull();
    expect(ctl.calls).toEqual([]);
  });

  it("a provider without a connection reports connection null and connected null", async () => {
    const { rt } = await setup();
    const view = await getSecretParams(rt, human, "plain-manual", { live: false });
    expect(view.connection).toBeNull();
    expect(view.connected).toBeNull();
    expect(view.specs).toEqual([]);
  });

  it("not connected: discovery result carries connection, hint and error", async () => {
    const { rt, ctl } = await setup();
    ctl.failWith = new NotConnectedError("fakeconn", "Connect it first");
    const view = await getSecretParams(rt, human, "svc-acme-app-staging");
    expect(view.resources["project"]).toMatchObject({ status: "not-connected", connection: "fakeconn", hint: "Connect it first" });
    expect(view.resources["project"]?.error).toBeTruthy();
  });

  it("a map mismatch is passed through", async () => {
    const { rt, ctl } = await setup(INVENTORY + "resourceMap:\n  - { kind: supabase.project, repo: acme-app, value: gone-project, label: Gone }\n");
    ctl.options["supabase.project"] = [opt("p1", "other")];
    const view = await getSecretParams(rt, human, "svc-acme-app-shared");
    expect(view.resources["project"]?.mapMismatch).toEqual({ value: "gone-project", label: "Gone" });
  });

  it("unknown secret and unknown provider are rejected", async () => {
    const { rt } = await setup();
    await expect(getSecretParams(rt, human, "nope")).rejects.toThrow(/nicht gefunden/);
    const inv = INVENTORY.replace("provider: my-manual", "provider: vanished");
    const { rt: rt2 } = await setup(inv);
    await expect(getSecretParams(rt2, human, "plain-manual")).rejects.toThrow(/Unbekannter Anbieter: vanished/);
  });
});

describe("putSecretParams", () => {
  it("sets params, applies a preset, removes keys and keeps unknown ones", async () => {
    const { rt } = await setup();
    const view = await putSecretParams(rt, human, "svc-acme-app-shared", { preset: "rw", params: { project: "p-9" }, remove: ["other", 5] });
    expect(view.values).toMatchObject({ scope: "write", project: "p-9" });
    expect(view.resources).toEqual({});
    expect(rt.inventory.getSecret("svc-acme-app-shared")?.params).toMatchObject({ scope: "write", project: "p-9" });
    expect(rt.inventory.getSecret("svc-acme-app-shared")?.params).not.toHaveProperty("other");
  });

  it("null in params removes the key", async () => {
    const { rt } = await setup();
    const view = await putSecretParams(rt, human, "svc-acme-app-shared", { params: { other: null } });
    expect(view.values).not.toHaveProperty("other");
  });

  it("rejects an unknown preset, a non-object params, unknown keys and wrong types", async () => {
    const { rt } = await setup();
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { preset: "nope" })).rejects.toThrow(/Unbekanntes Preset: nope/);
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { params: ["x"] })).rejects.toThrow(/muss ein Objekt/);
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { params: { bogus: 1 } })).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { params: { scope: "admin" } })).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { remove: ["bogus"] })).rejects.toThrow(/nicht vorgesehen: bogus/);
    await expect(putSecretParams(rt, human, "ghost", {})).rejects.toThrow(/nicht gefunden/);
  });

  it("a preset on a provider without params is unknown", async () => {
    const { rt } = await setup();
    await expect(putSecretParams(rt, human, "plain-manual", { preset: "rw" })).rejects.toThrow(/Unbekanntes Preset/);
    expect((await putSecretParams(rt, human, "plain-manual", {})).specs).toEqual([]);
  });
});

describe("paramStatus", () => {
  it("none, ok, missing and invalid", async () => {
    const { rt } = await setup();
    const pick = (id: string) => rt.inventory.getSecret(id)!;
    expect(paramStatus(rt, pick("plain-manual"))).toEqual({ status: "none", missing: [] });
    expect(paramStatus(rt, { provider: "unregistered", params: {} })).toEqual({ status: "none", missing: [] });
    expect(paramStatus(rt, pick("svc-acme-app-shared"))).toEqual({ status: "ok", missing: [] });
    expect(paramStatus(rt, pick("svc-acme-app-staging"))).toEqual({ status: "missing", missing: ["project", "scope"] });
    expect(paramStatus(rt, pick("svc-bad-type"))).toEqual({ status: "invalid", missing: [] });
  });
});

describe("provider drafts", () => {
  it("getProviderParams: draft with repo, stage and params, live and not live", async () => {
    const { rt, ctl } = await setup(INVENTORY + "resourceMap:\n  - { kind: supabase.project, repo: acme-app, stage: staging, value: p1 }\n");
    ctl.options["supabase.project"] = [opt("p1", "acme-app staging"), opt("p2", "acme-app prod")];
    const live = await getProviderParams(rt, human, "fake-svc", { repo: "acme-app", stage: "staging", params: { scope: "read" } });
    expect(live.secretId).toBeUndefined();
    expect(live.values).toEqual({ scope: "read" });
    expect(live.complete).toBe(false);
    expect(live.resources["project"]?.suggested).toBe("p1");
    expect(live.preflight).toBeNull();
    const offline = await getProviderParams(rt, human, "fake-svc", { live: false });
    expect(offline.values).toEqual({});
    expect(offline.resources).toEqual({});
    const noHint = await getProviderParams(rt, human, "fake-svc");
    expect(Object.keys(noHint.resources)).toContain("project");
    const manualLive = await getProviderParams(rt, human, "my-manual");
    expect(manualLive.resources).toEqual({});
    const manual = await getProviderParams(rt, human, "my-manual", { live: false });
    expect(manual.connection).toBeNull();
    await expect(getProviderParams(rt, human, "nope")).rejects.toThrow(/Unbekannter Anbieter: nope/);
  });

  it("getProviderResources: one kind, params feed the discovery", async () => {
    const { rt, ctl } = await setup();
    ctl.options["cloudflare.zone"] = [opt("z1", "acme-app.example")];
    const r = await getProviderResources(rt, human, "fake-svc", "cloudflare.zone", { repo: "acme-app", params: { account: "acc-1" } });
    expect(r).toMatchObject({ provider: "fake-svc", kind: "cloudflare.zone", status: "ok", suggested: "z1" });
    expect(ctl.discoverParams.at(-1)).toMatchObject({ account: "acc-1" });
    const plain = await getProviderResources(rt, human, "fake-svc", "cloudflare.zone");
    expect(plain.status).toBe("ok");
  });
});

describe("connection resources and defaults", () => {
  it("lists kinds without on-demand ones, uses defaults and query params, skips unknown kinds", async () => {
    const { rt, ctl } = await setup(INVENTORY + "integrationDefaults:\n  fakeconn:\n    account: acc-default\n");
    ctl.options["supabase.project"] = [opt("p1")];
    ctl.options["cloudflare.zone"] = [];
    const r = await getConnectionResources(rt, human, "fakeconn", { params: { zone: "z" } });
    expect(Object.keys(r.resources).sort()).toEqual(["cloudflare.account", "cloudflare.zone", "fake.permission", "supabase.project"]);
    expect(ctl.discoverParams[0]).toMatchObject({ account: "acc-default", zone: "z" });
    expect(r.defaults).toEqual({ account: "acc-default" });
    expect(r.defaultSpecs.map((s) => s.key)).toEqual(["account", "base"]);
    const one = await getConnectionResources(rt, human, "fakeconn", { kind: "cloudflare.workerScript", repo: "acme-app", stage: "staging" });
    expect(Object.keys(one.resources)).toEqual(["cloudflare.workerScript"]);
    const unknown = await getConnectionResources(rt, human, "fakeconn", { kind: "nope.kind" });
    expect(unknown.resources["nope.kind"]).toMatchObject({ status: "unsupported", error: "Unbekannte Entdeckungsart: nope.kind" });
  });

  it("putConnectionDefaults: sets, removes and validates", async () => {
    const { rt } = await setup(INVENTORY + "integrationDefaults:\n  fakeconn:\n    account: old\n    base: https://old.example\n");
    const r = await putConnectionDefaults(rt, human, "fakeconn", { values: { account: "", base: "https://new.example" } });
    expect(r.defaults).toEqual({ base: "https://new.example" });
    expect(rt.inventory.data.integrationDefaults?.["fakeconn"]).toMatchObject({ base: "https://new.example" });
    expect(rt.inventory.data.integrationDefaults?.["fakeconn"]).not.toHaveProperty("account");
    await expect(putConnectionDefaults(rt, human, "fakeconn", { values: { base: "http://insecure.example" } })).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(putConnectionDefaults(rt, human, "fakeconn", { values: null })).rejects.toThrow(/Feld fehlt: values/);
    const fresh = await setup();
    const created = await putConnectionDefaults(fresh.rt, human, "fakeconn", { values: { account: "acc-2", base: null } });
    expect(created.defaults).toEqual({ account: "acc-2" });
  });
});

describe("connection resources edge cases", () => {
  it("without saved defaults or query params: empty defaults, discovery gets no params", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [];
    ctl.options["cloudflare.zone"] = [];
    ctl.options["cloudflare.account"] = [];
    ctl.options["fake.permission"] = [];
    const r = await getConnectionResources(rt, human, "fakeconn");
    expect(r.defaults).toEqual({});
    expect(ctl.discoverParams[0]).toEqual({});
  });

  it("unknown connections are rejected, also for the sync of defaults", async () => {
    const { rt } = await setup();
    await expect(getConnectionResources(rt, human, "no-such-connection")).rejects.toThrow(/Unbekannte Verbindung: no-such-connection/);
    await expect(putConnectionDefaults(rt, human, "no-such-connection", { values: {} })).rejects.toThrow(/Unbekannte Verbindung/);
  });

  it("several providers on one connection: shared default keys are listed once, kinds come from the first provider, providers without params still count", async () => {
    const { rt, ctl } = await setup();
    const spec = { key: "account", label: "account", labelEn: "account", type: "string" as const, required: false, help: "", helpEn: "", integrationDefault: true, discover: "cloudflare.account" };
    rt.providers.register({ id: "fake-two", label: "Fake two", kind: "automatic", connection: "fakeconn", params: [spec], discover: async (kind) => { ctl.calls.push(`two:${kind}`); return []; } });
    // Has a parameter with discovery but no discover function itself: it cannot answer the kind.
    rt.providers.register({ id: "fake-three", label: "Fake three", kind: "automatic", connection: "fakeconn", params: [{ ...spec, key: "elsewhere", discover: "elsewhere.kind" }] });
    // No params at all, only extra kinds.
    rt.providers.register({ id: "fake-four", label: "Fake four", kind: "automatic", connection: "fakeconn", discoverKinds: ["extra.kind"], discover: async (kind) => { ctl.calls.push(`four:${kind}`); return []; } });
    ctl.options["supabase.project"] = [];
    ctl.options["cloudflare.zone"] = [];
    ctl.options["cloudflare.account"] = [];
    ctl.options["fake.permission"] = [];
    const r = await getConnectionResources(rt, human, "fakeconn");
    expect(r.defaultSpecs.filter((s) => s.key === "account")).toHaveLength(1);
    expect(Object.keys(r.resources)).toContain("extra.kind");
    expect(Object.keys(r.resources)).not.toContain("elsewhere.kind");
    expect(ctl.calls).toContain("four:extra.kind");
    expect(ctl.calls).not.toContain("two:cloudflare.account");
  });
});

describe("resource map", () => {
  it("put, view, replace and delete an entry", async () => {
    const { rt } = await setup();
    expect(getResourceMap(rt, human)).toMatchObject({ entries: [] });
    expect(getResourceMap(rt, human).kinds).toContain("supabase.project");
    const put = await putResourceMap(rt, human, { kind: "supabase.project", repo: " acme-app ", stage: "staging", value: " p1 ", label: " Main " });
    expect(put.entry).toMatchObject({ kind: "supabase.project", repo: "acme-app", stage: "staging", value: "p1", label: "Main" });
    const numeric = await putResourceMap(rt, human, { kind: "supabase.project", repo: "acme-app", value: 42 });
    expect(numeric.entry.value).toBe("42");
    expect(numeric.entry.label).toBeUndefined();
    expect(numeric.entries).toHaveLength(2);
    const removed = await deleteResourceMap(rt, human, { kind: "supabase.project", repo: "acme-app", stage: "staging" });
    expect(removed.removed).toBe(true);
    const again = await deleteResourceMap(rt, human, { kind: "supabase.project", repo: "acme-app", stage: "staging" });
    expect(again.removed).toBe(false);
  });

  it("rejects missing or invalid fields", async () => {
    const { rt } = await setup();
    await expect(putResourceMap(rt, human, {})).rejects.toThrow(/Feld fehlt: kind/);
    await expect(putResourceMap(rt, human, { kind: "nope" })).rejects.toThrow(/Unbekannte Entdeckungsart/);
    await expect(putResourceMap(rt, human, { kind: "supabase.project", repo: "  " })).rejects.toThrow(/Feld fehlt: repo/);
    await expect(putResourceMap(rt, human, { kind: "supabase.project", repo: "r", stage: "nowhere", value: "v" })).rejects.toThrow(/Unbekannte Stage: nowhere/);
    await expect(putResourceMap(rt, human, { kind: "supabase.project", repo: "r" })).rejects.toThrow(/Feld fehlt: value/);
    await expect(putResourceMap(rt, human, { kind: "supabase.project", repo: "r", value: true })).rejects.toThrow(/Feld fehlt: value/);
  });
});

describe("suggestAllParams", () => {
  const INV = `version: 1
secrets:
  - { id: a-one, name: A_ONE, stage: shared, service: fake, provider: fake-svc, expiry: none, params: { scope: read }, places: [{ repo: acme-app, scope: repository }] }
  - { id: a-two, name: A_TWO, stage: shared, service: fake, provider: fake-svc, expiry: none, params: { scope: read }, places: [{ repo: acme-app, scope: repository }] }
  - { id: manual-one, name: M_ONE, stage: shared, service: fake, provider: my-manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: complete-one, name: C_ONE, stage: shared, service: fake, provider: fake-svc, expiry: none, params: { scope: read, project: p }, places: [{ repo: acme-app, scope: repository }] }
variables: []
`;

  it("suggests a unique project and caches discovery between entries", async () => {
    const { rt, ctl } = await setup(INV);
    ctl.options["supabase.project"] = [opt("p1", "acme-app shared")];
    const r = await suggestAllParams(rt, human);
    expect(r.suggestions.map((s) => s.secretId)).toEqual(["a-one", "a-two"]);
    expect(r.suggestions[0]).toMatchObject({ status: "suggested", missing: ["project"] });
    expect(r.suggestions[0]?.suggestions["project"]).toMatchObject({ value: "p1", label: "acme-app shared" });
    expect(ctl.calls.filter((c) => c === "supabase.project")).toHaveLength(1);
  });

  it("not connected, none (ambiguous) and a failing discovery", async () => {
    const { rt, ctl } = await setup(INV);
    ctl.failWith = new NotConnectedError("fakeconn", "Connect it");
    const nc = await suggestAllParams(rt, human);
    expect(nc.suggestions[0]).toMatchObject({ status: "not-connected" });
    ctl.failWith = null;
    ctl.options["supabase.project"] = [opt("p1", "acme-app a"), opt("p2", "acme-app b")];
    const { rt: rt2, ctl: ctl2 } = await setup(INV);
    ctl2.options["supabase.project"] = [opt("p1", "acme-app a"), opt("p2", "acme-app b")];
    const none = await suggestAllParams(rt2, human);
    expect(none.suggestions[0]).toMatchObject({ status: "none", suggestions: { project: null } });
  });

  it("partial: some missing parameters get a suggestion, others do not", async () => {
    const inv = INV.replace("params: { scope: read }, places: [{ repo: acme-app, scope: repository }] }\n  - { id: a-two", "params: { scope: read, project: p-set }, places: [{ repo: acme-app, scope: repository }] }\n  - { id: a-two");
    const { rt, ctl } = await setup(inv);
    ctl.options["cloudflare.zone"] = [opt("z1", "acme-app.example")];
    const r = await suggestAllParams(rt, human);
    // a-one has project set; nothing missing there, so it is skipped. a-two misses project (not suggestible: no options).
    expect(r.suggestions.map((s) => s.secretId)).toEqual(["a-two"]);
  });

  it("a missing parameter without discovery, or without a suggestion rule, never gets a suggestion", async () => {
    const dir = INV;
    const { rt, ctl } = await setup(dir);
    // Make "perm" required so it is reported missing while its kind has no suggestion rule.
    const p = rt.providers.get("fake-svc")!;
    rt.providers.register({ ...p, params: [...p.params!.map((s) => (s.key === "perm" ? { ...s, required: true } : s.key === "other" ? { ...s, required: true } : s))] });
    ctl.options["supabase.project"] = [opt("p1", "acme-app shared")];
    const r = await suggestAllParams(rt, human);
    const first = r.suggestions[0]!;
    expect(first.missing).toEqual(["project", "perm", "other"]);
    expect(first.suggestions).toEqual({ project: expect.anything(), perm: null });
    expect(first.status).toBe("partial");
    expect(ctl.calls).not.toContain("fake.permission");
  });

  it("an error status (discovery answered with a provider error) yields no suggestion", async () => {
    const { rt, ctl } = await setup(INV);
    const err = new Error("boom");
    err.name = "ProviderError";
    ctl.failWith = err;
    const r = await suggestAllParams(rt, human);
    expect(r.suggestions[0]).toMatchObject({ status: "none" });
  });
});

describe("variables from sources", () => {
  it("listVariableSources reports the connection state", async () => {
    const { rt } = await setup();
    const r = await listVariableSources(rt, human);
    const supa = r.sources.find((s) => s.kind === "supabase.project");
    expect(supa).toMatchObject({ connection: "supabase", connected: false });
  });

  it("previewVariableSource reads a field without writing", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const r = await previewVariableSource(rt, human, { kind: "supabase.project", resource: "proj-1", field: "url", repo: "acme-app", stage: "shared", params: { x: 1 } });
    expect(r).toMatchObject({ value: "https://proj-1.supabase.co", resourceLabel: "Project One", from: { connection: "supabase", kind: "supabase.project", resource: "proj-1", field: "url" } });
    const noHint = await previewVariableSource(rt, human, { connection: "supabase", kind: "supabase.project", resource: "proj-1", field: "ref", params: "ignored" });
    expect(noHint.value).toBe("proj-1");
    await expect(previewVariableSource(rt, human, { kind: 5, resource: "r", field: "ref" })).rejects.toThrow();
    await expect(previewVariableSource(rt, human, { kind: "supabase.project", resource: "other", field: "ref" })).rejects.toThrow(/gibt es in der Verbindung supabase nicht/);
    // No registered provider can list this kind: the source is unknown.
    for (const p of rt.providers.list().filter((p) => p.connection === "cloudflare")) rt.providers.register({ ...p, discover: undefined as never });
    await expect(previewVariableSource(rt, human, { kind: "cloudflare.account", resource: "r", field: "accountId" })).rejects.toThrow(/Unbekannte Quelle: cloudflare.account/);
  });

  it("loadVariableFromSource: proposal only, then apply", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const proposal = await loadVariableFromSource(rt, human, "with-source", {});
    expect(proposal).toMatchObject({ variableId: "with-source", current: "old-ref", proposed: "proj-1", changed: true, applied: false });
    expect(rt.inventory.getVariable("with-source")?.value).toBe("old-ref");
    const applied = await loadVariableFromSource(rt, human, "with-source", { apply: true });
    expect(applied.applied).toBe(true);
    expect(rt.inventory.getVariable("with-source")?.value).toBe("proj-1");
    const again = await loadVariableFromSource(rt, human, "with-source", { params: { a: 1 } });
    expect(again.changed).toBe(false);
  });

  it("loadVariableFromSource: explicit source overrides, missing source and unknown variable fail", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const given = await loadVariableFromSource(rt, human, "no-source", { kind: "supabase.project", resource: "proj-1", field: "url" });
    expect(given.proposed).toBe("https://proj-1.supabase.co");
    expect(given.from.connection).toBe("supabase");
    const partial = await loadVariableFromSource(rt, human, "with-source", { field: "url" });
    expect(partial.from).toMatchObject({ kind: "supabase.project", resource: "proj-1", field: "url", connection: "supabase" });
    await expect(loadVariableFromSource(rt, human, "no-source", {})).rejects.toThrow(/keine Quelle/);
    await expect(loadVariableFromSource(rt, human, "ghost", {})).rejects.toThrow(/Variable nicht gefunden/);
  });

  it("loadVariableFromSource: a secret-looking value needs acknowledgement", async () => {
    const { rt, ctl } = await setup();
    const hex = "0123456789abcdef".repeat(4);
    ctl.options["supabase.project"] = [opt(hex, "Hex project")];
    await expect(loadVariableFromSource(rt, human, "key-var", { resource: hex, apply: true })).rejects.toThrow(/acknowledgedPublic/);
    const ok = await loadVariableFromSource(rt, human, "key-var", { resource: hex, apply: true, acknowledgedPublic: true });
    expect(ok.proposed).toBe(hex);
  });

  it("suggestAllVariables: ok entries and per-variable errors", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const r = await suggestAllVariables(rt, human);
    expect(r.suggestions.map((s) => [s.variableId, s.status])).toEqual([["with-source", "ok"], ["broken-source", "error"], ["key-var", "ok"]]);
    expect(r.suggestions[0]).toMatchObject({ proposed: "proj-1", changed: true });
    expect(r.suggestions[1]).toMatchObject({ error: expect.stringContaining("missing-proj") });
  });

  it("suggestAllVariables: a non-Error failure gets a generic message", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    rt.providers.register({ ...rt.providers.list().find((p) => p.connection === "supabase")!, discover: async () => Promise.reject("plain string") });
    const r = await suggestAllVariables(rt, human);
    expect(r.suggestions[0]).toMatchObject({ status: "error", error: "Fehler" });
  });
});

describe("authorization hook", () => {
  const refuseAll = (seen: AuthorizationRequest[]): Authorize => (request) => {
    seen.push(request);
    throw new PolicyError("refused by test hook");
  };

  it("is consulted by every edit of the inventory made here, after the human-only check, and a refusal changes nothing", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const seen: AuthorizationRequest[] = [];
    rt.authorize = refuseAll(seen);
    const before = JSON.stringify(rt.inventory.data);
    // Built-in rule first: an agent is refused without the hook being asked.
    await expect(putSecretParams(rt, agent, "svc-acme-app-staging", {})).rejects.toThrow(/nur ein Mensch/);
    expect(seen).toEqual([]);
    await expect(putSecretParams(rt, human, "svc-acme-app-staging", { params: { project: "p" } })).rejects.toThrow("refused by test hook");
    await expect(putConnectionDefaults(rt, human, "fakeconn", { values: { a: "b" } })).rejects.toThrow("refused by test hook");
    await expect(putResourceMap(rt, human, { kind: "x", value: "v" })).rejects.toThrow("refused by test hook");
    await expect(deleteResourceMap(rt, human, { kind: "x" })).rejects.toThrow("refused by test hook");
    // A proposal only reads; applying it edits the inventory and asks the hook.
    await loadVariableFromSource(rt, human, "with-source", {});
    expect(seen).toHaveLength(4);
    await expect(loadVariableFromSource(rt, human, "with-source", { apply: true })).rejects.toThrow("refused by test hook");
    expect(seen.map((r) => r.action)).toEqual(["inventory.edit", "inventory.edit", "inventory.edit", "inventory.edit", "inventory.edit"]);
    expect(seen[0]).toEqual({ actor: human, action: "inventory.edit", subject: { secretId: "svc-acme-app-staging", stage: "staging" } });
    expect(seen[4]).toEqual({ actor: human, action: "inventory.edit", subject: { variableId: "with-source", stage: "shared" } });
    expect(JSON.stringify(rt.inventory.data)).toBe(before);
    expect(JSON.stringify(seen)).not.toContain("proj-1");
  });

  it("an allowing hook changes nothing about the outcome", async () => {
    const { rt, ctl } = await setup();
    ctl.options["supabase.project"] = [opt("proj-1", "Project One")];
    const seen: AuthorizationRequest[] = [];
    rt.authorize = (request) => {
      seen.push(request);
    };
    const applied = await loadVariableFromSource(rt, human, "with-source", { apply: true });
    expect(applied).toMatchObject({ applied: true, proposed: "proj-1" });
    expect(rt.inventory.getVariable("with-source")?.value).toBe("proj-1");
    expect(seen).toHaveLength(1);
  });
});
