import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: cf-deploy-wake-miles-staging
    name: CLOUDFLARE_API_TOKEN
    stage: staging
    service: cloudflare
    provider: cloudflare-token
    expiry: required
    ttlDays: 30
    params: { custom: keep-me }
    places:
      - { repo: wake-miles, scope: environment, environment: staging }
  - id: supabase-wake-miles-staging
    name: SUPABASE_SECRET_KEY
    stage: staging
    service: supabase
    provider: supabase-api-key
    expiry: none
    places:
      - { repo: wake-miles, scope: environment, environment: staging }
  - id: supabase-ambiguous-staging
    name: SUPABASE_SECRET_KEY
    stage: staging
    service: supabase
    provider: supabase-api-key
    expiry: none
    places:
      - { repo: twin, scope: environment, environment: staging }
  - id: supabase-unknown-staging
    name: SUPABASE_SECRET_KEY
    stage: staging
    service: supabase
    provider: supabase-api-key
    expiry: none
    places:
      - { repo: nothing-matches, scope: environment, environment: staging }
  - id: hmac-wake-miles
    name: HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: wake-miles, scope: repository }
variables:
  - id: supabase-ref
    name: SUPABASE_PROJECT_REF
    stage: staging
    value: null
    from: { connection: supabase, kind: supabase.project, resource: abc, field: ref }
    places:
      - { repo: wake-miles, scope: environment, environment: staging }
  - id: supabase-anon
    name: NEXT_PUBLIC_SUPABASE_ANON_KEY
    stage: staging
    value: null
    places:
      - { repo: wake-miles, scope: environment, environment: staging }
`;

const CF_TOKEN = "CF-CONNECTION-TOKEN-0001";
const SB_TOKEN = "SB-CONNECTION-TOKEN-0002";
const RS_TOKEN = "RS-CONNECTION-TOKEN-0003";
const SERVICE_ROLE = "SERVICE-ROLE-VALUE-NEVER-SHOWN";
const ANON = "PUBLIC-ANON-VALUE";

const GROUPS = { result: [{ id: "g1", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] }, { id: "g2", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] }, { id: "g3", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] }] };

async function setup() {
  const urls: string[] = [];
  const providerCalls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("api.cloudflare.com")) {
      providerCalls.push(u);
      if (u.includes("/accounts?")) return json({ result: [{ id: "acc1", name: "Pineflight" }] });
      if (u.includes("/zones?")) return json({ result: [{ id: "z1", name: "wake-miles.com", account: { name: "Pineflight" } }] });
      if (u.includes("/permission_groups")) return json(GROUPS);
    }
    if (u.includes("api.supabase.com")) {
      providerCalls.push(u);
      if (u.endsWith("/v1/projects")) return json([{ id: "abc", name: "wake-miles-staging" }, { id: "def", name: "wake-miles-production" }, { id: "t1", name: "twin-staging" }, { id: "t2", name: "twin-staging-old" }]);
      if (u.includes("/api-keys")) return json([{ name: "service_role", type: "secret", api_key: SERVICE_ROLE }, { name: "anon", type: "publishable", api_key: ANON }]);
    }
    if (u.includes("api.resend.com/domains")) {
      providerCalls.push(u);
      return json({ data: [{ id: "d1", name: "wakemiles.com", status: "verified" }, { id: "d2", name: "pineflight.com", status: "pending" }] });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-params-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  rt.connections.session.set("cloudflare", CF_TOKEN);
  rt.connections.session.set("supabase", SB_TOKEN);
  rt.connections.session.set("resend", RS_TOKEN);
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, dir, urls, providerCalls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const call = async (deps: RouterDeps, req: Request) => {
  const res = await route(req, deps);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
};
const noTokens = (text: string) => {
  for (const t of [CF_TOKEN, SB_TOKEN, RS_TOKEN, SERVICE_ROLE]) expect(text).not.toContain(t);
};

describe("GET secrets/:id/params", () => {
  it("returns specification, values, problems, suggestions and preflight status; never tokens", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "secrets/cf-deploy-wake-miles-staging/params"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ secretId: "cf-deploy-wake-miles-staging", provider: "cloudflare-token", connection: "cloudflare", connected: true, complete: false, unknown: { custom: "keep-me" } });
    expect(r.json.specs.map((s: { key: string }) => s.key)).toEqual(["accountId", "permissions", "zoneId"]);
    expect(r.json.problems.map((p: { key: string; code: string }) => [p.key, p.code])).toEqual([["accountId", "missing"], ["permissions", "missing"]]);
    expect(r.json.resources.accountId).toMatchObject({ status: "ok", suggested: "acc1" });
    expect(r.json.resources.zoneId.options[0]).toMatchObject({ value: "z1", suggestedFor: { score: 2 } });
    expect(r.json.preflight).toMatchObject({ status: "skipped", skippedReason: "params" });
    noTokens(r.text);
  });
  it("live=0 does no provider call", async () => {
    const { deps, providerCalls } = await setup();
    const r = await call(deps, ui(deps, "GET", "secrets/cf-deploy-wake-miles-staging/params?live=0"));
    expect(r.json.resources).toEqual({});
    expect(r.json.preflight).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });
  it("an unconnected integration is a status, not an error", async () => {
    const { deps } = await setup();
    deps.rt.connections.session.delete("supabase");
    const r = await call(deps, ui(deps, "GET", "secrets/supabase-wake-miles-staging/params"));
    expect(r.status).toBe(200);
    expect(r.json.connected).toBe(false);
    expect(r.json.resources.projectRef.status).toBe("not-connected");
  });
  it("suggests the project for repository and stage only when unambiguous", async () => {
    const { deps } = await setup();
    const one = await call(deps, ui(deps, "GET", "secrets/supabase-wake-miles-staging/params"));
    expect(one.json.resources.projectRef.suggested).toBe("abc");
    const twin = await call(deps, ui(deps, "GET", "secrets/supabase-ambiguous-staging/params"));
    expect(twin.json.resources.projectRef.suggested).toBeNull();
    const none = await call(deps, ui(deps, "GET", "secrets/supabase-unknown-staging/params"));
    expect(none.json.resources.projectRef.suggested).toBeNull();
    expect(none.json.resources.projectRef.options.length).toBe(4);
  });
});

describe("PUT secrets/:id/params", () => {
  it("saves parameters via preset, keeps unknown ones, reports what is still missing", async () => {
    const { deps, dir } = await setup();
    const r = await call(deps, ui(deps, "PUT", "secrets/cf-deploy-wake-miles-staging/params", { preset: "worker-deploy" }));
    expect(r.status).toBe(200);
    expect(r.json.values.permissions).toEqual(["Workers Scripts Write", "Account Settings Read"]);
    expect(r.json.complete).toBe(false);
    expect(r.json.problems.map((p: { key: string }) => p.key)).toEqual(["accountId"]);
    expect(r.json.unknown).toEqual({ custom: "keep-me" });
    const saved = await readFile(join(dir, "inventory.yaml"), "utf8");
    expect(saved).toContain("custom: keep-me");
    expect(saved).toContain("Workers Scripts Write");
    const done = await call(deps, ui(deps, "PUT", "secrets/cf-deploy-wake-miles-staging/params", { params: { accountId: "acc1" } }));
    expect(done.json.complete).toBe(true);
  });
  it("rejects wrong types, unknown keys and values outside the options with params_invalid and saves nothing", async () => {
    const { deps, dir } = await setup();
    const before = await readFile(join(dir, "inventory.yaml"), "utf8");
    const bad = await call(deps, ui(deps, "PUT", "secrets/supabase-wake-miles-staging/params", { params: { projectRef: 5, type: "root", nonsense: 1 } }));
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("params_invalid");
    expect(bad.json.problems.map((p: { key: string; code: string }) => [p.key, p.code])).toEqual([["projectRef", "wrong_type"], ["type", "not_in_options"], ["nonsense", "unknown_key"]]);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(before);
    expect((await call(deps, ui(deps, "PUT", "secrets/supabase-wake-miles-staging/params", { preset: "nope" }))).status).toBe(400);
  });
  it("needs the CSRF header and a session", async () => {
    const { deps } = await setup();
    const noCsrf = new Request(`${base}/api/ui/secrets/hmac-wake-miles/params`, { method: "PUT", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "content-type": "application/json" }, body: "{}" });
    expect((await route(noCsrf, deps)).status).toBe(401);
  });
});

describe("renewal without parameters", () => {
  it("answers 400 params_invalid with the missing keys and makes no provider call", async () => {
    const { deps, providerCalls } = await setup();
    const r = await call(deps, ui(deps, "POST", "renewal-requests", { secretId: "cf-deploy-wake-miles-staging" }));
    // staging needs approval for agents only; a human prepares directly.
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: "params_invalid", error: "Pflichtparameter fehlen: accountId (Cloudflare-Konto), permissions (Berechtigungen)" });
    expect(r.json.problems).toHaveLength(2);
    expect(providerCalls).toHaveLength(0);
    const en = await call(deps, ui(deps, "POST", "renewal-requests", { secretId: "cf-deploy-wake-miles-staging" }, { "x-secret-desk-lang": "en" }));
    expect(en.json.error).toBe("Required parameters missing: accountId (Cloudflare account), permissions (Permissions)");
  });
  it("dry run shows the parameter status and, for humans, the live preflight with a readable resource", async () => {
    const { deps } = await setup();
    await call(deps, ui(deps, "PUT", "secrets/supabase-wake-miles-staging/params", { params: { projectRef: "abc" } }));
    const human = await call(deps, ui(deps, "POST", "renewal-requests", { secretId: "supabase-wake-miles-staging", dryRun: true }));
    expect(human.json.plan.params).toMatchObject({ ok: true, missing: [] });
    expect(human.json.preflight).toMatchObject({ status: "ok", resource: "Supabase-Projekt wake-miles-staging (ref abc)" });
    const incomplete = await call(deps, ui(deps, "POST", "renewal-requests", { secretId: "supabase-unknown-staging", dryRun: true }));
    expect(incomplete.json.plan.params).toMatchObject({ ok: false, missing: ["projectRef"] });
    expect(incomplete.json.preflight.status).toBe("skipped");
    const asAgent = await call(deps, agent(deps, "POST", "renewal-requests", { secretId: "supabase-wake-miles-staging", dryRun: true }));
    expect(asAgent.json.preflight).toBeUndefined();
    expect(asAgent.json.plan.params.ok).toBe(true);
  });
  it("a wrong project stops the issue before it happens (preflight_failed)", async () => {
    const { deps } = await setup();
    await call(deps, ui(deps, "PUT", "secrets/supabase-wake-miles-staging/params", { params: { projectRef: "does-not-exist" } }));
    const r = await call(deps, ui(deps, "POST", "renewal-requests", { secretId: "supabase-wake-miles-staging" }));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("preflight_failed");
    expect(r.json.findings.some((f: { level: string }) => f.level === "fail")).toBe(true);
  });
});

describe("integration defaults and resources", () => {
  it("GET connections/:id/resources lists accounts, zones and the defaults that are needed", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "connections/cloudflare/resources?repo=wake-miles&stage=staging"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ connection: "cloudflare", connected: true, defaults: {} });
    expect(r.json.defaultSpecs.map((s: { key: string }) => s.key)).toEqual(["accountId"]);
    expect(Object.keys(r.json.resources)).toEqual(["cloudflare.account", "cloudflare.permissionGroups", "cloudflare.zone"]);
    expect(r.json.resources["cloudflare.account"]).toMatchObject({ status: "ok", suggested: "acc1" });
    expect(r.json.resources["cloudflare.zone"].suggested).toBe("z1");
    expect(r.json.resources["cloudflare.permissionGroups"].suggested).toBeNull();
    noTokens(r.text);
    const one = await call(deps, ui(deps, "GET", "connections/supabase/resources?kind=supabase.project&repo=wake-miles&stage=staging"));
    expect(Object.keys(one.json.resources)).toEqual(["supabase.project"]);
    expect(one.json.resources["supabase.project"].suggested).toBe("abc");
    expect((await call(deps, ui(deps, "GET", "connections/supabase/resources?kind=bogus"))).json.resources.bogus.status).toBe("unsupported");
    expect((await call(deps, ui(deps, "GET", "connections/github/resources"))).status).toBe(400);
  });
  it("PUT connections/:id/defaults stores non-secret defaults that fill missing parameters", async () => {
    const { deps, dir } = await setup();
    await call(deps, ui(deps, "PUT", "secrets/cf-deploy-wake-miles-staging/params", { preset: "worker-deploy" }));
    const put = await call(deps, ui(deps, "PUT", "connections/cloudflare/defaults", { values: { accountId: "acc1" } }));
    expect(put.status).toBe(200);
    expect(put.json.defaults).toEqual({ accountId: "acc1" });
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("integrationDefaults");
    const state = await call(deps, ui(deps, "GET", "secrets/cf-deploy-wake-miles-staging/params"));
    expect(state.json).toMatchObject({ complete: true, defaults: { accountId: "acc1" }, values: { permissions: ["Workers Scripts Write", "Account Settings Read"] } });
    expect(state.json.values.accountId).toBeUndefined();
    expect(state.json.preflight).toMatchObject({ status: "ok", resource: "Cloudflare-Konto Pineflight (acc1)" });
    const list = await call(deps, agent(deps, "GET", "secrets/cf-deploy-wake-miles-staging"));
    expect(list.json.params).toEqual({ status: "ok", missing: [] });
    expect((await call(deps, ui(deps, "PUT", "connections/cloudflare/defaults", { values: { permissions: ["x"] } }))).json.code).toBe("params_invalid");
    expect((await call(deps, ui(deps, "PUT", "connections/cloudflare/defaults", { values: { accountId: null } }))).json.defaults).toEqual({});
  });
});

describe("draft routes and creating secrets", () => {
  const entry = (extra: Record<string, unknown>) => ({ name: "RESEND_API_KEY", service: "resend", stage: "staging", places: [{ repo: "wake-miles", scope: "environment", environment: "staging" }], ...extra });
  it("GET providers/:id/params and /resources work without an entry, with repo and stage as context", async () => {
    const { deps } = await setup();
    const p = await call(deps, ui(deps, "GET", "providers/supabase-api-key/params?repo=wake-miles&stage=staging"));
    expect(p.json).toMatchObject({ provider: "supabase-api-key", complete: false });
    expect(p.json.secretId).toBeUndefined();
    expect(p.json.resources.projectRef.suggested).toBe("abc");
    const res = await call(deps, ui(deps, "GET", "providers/resend-api-key/resources?kind=resend.domain&repo=wake-miles&stage=staging"));
    expect(res.json).toMatchObject({ provider: "resend-api-key", kind: "resend.domain", status: "ok", suggested: "d1" });
    expect(res.json.options.map((o: { label: string }) => o.label)).toEqual(["wakemiles.com", "pineflight.com"]);
    expect((await call(deps, ui(deps, "GET", "providers/resend-api-key/resources"))).status).toBe(400);
    expect((await call(deps, ui(deps, "GET", "providers/nope/params"))).status).toBe(400);
    const zones = await call(deps, ui(deps, "GET", "providers/cloudflare-token/resources?kind=cloudflare.zone&param.accountId=acc1"));
    expect(zones.json.options[0].value).toBe("z1");
  });
  it("resend sending_access needs a domain; full_access does not", async () => {
    const { deps } = await setup();
    const missing = await call(deps, ui(deps, "POST", "secrets", entry({ id: "resend-a", provider: "resend-api-key" })));
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ code: "params_invalid", error: "Pflichtparameter fehlen: domainId (Domain)" });
    expect((await call(deps, ui(deps, "POST", "secrets", entry({ id: "resend-b", provider: "resend-api-key", params: { permission: "sending_access" } })))).status).toBe(400);
    const ok = await call(deps, ui(deps, "POST", "secrets?preflight=1", entry({ id: "resend-c", provider: "resend-api-key", params: { domainId: "d2" } })));
    expect(ok.status).toBe(200);
    expect(ok.json.params).toEqual({ status: "ok", missing: [] });
    expect(ok.json.preflight).toMatchObject({ status: "warn", resource: "Key nur fuer Domain pineflight.com" });
    expect(ok.json.preflight.findings.find((f: { id: string }) => f.id === "verified").level).toBe("warn");
    const full = await call(deps, ui(deps, "POST", "secrets", entry({ id: "resend-d", provider: "resend-api-key", params: { permission: "full_access" } })));
    expect(full.status).toBe(200);
    const bad = await call(deps, ui(deps, "POST", "secrets", entry({ id: "resend-e", provider: "resend-api-key", params: { domainId: "d1", permission: "root" } })));
    expect(bad.json.problems[0]).toMatchObject({ key: "permission", code: "not_in_options" });
  });
  it("cloudflare-token without account is params_invalid, with the account from the integration default it is created; manual and random stay untouched", async () => {
    const { deps } = await setup();
    const cf = { service: "cloudflare", provider: "cloudflare-token", params: { permissions: ["Workers Scripts Write"] } };
    const without = await call(deps, ui(deps, "POST", "secrets", entry({ ...cf, id: "cf-a" })));
    expect(without.status).toBe(400);
    expect(without.json.error).toBe("Pflichtparameter fehlen: accountId (Cloudflare-Konto)");
    await call(deps, ui(deps, "PUT", "connections/cloudflare/defaults", { values: { accountId: "acc1" } }));
    expect((await call(deps, ui(deps, "POST", "secrets", entry({ ...cf, id: "cf-b" })))).status).toBe(200);
    expect((await call(deps, ui(deps, "POST", "secrets", entry({ id: "rnd-a", provider: "random-hex", expiry: "none" })))).status).toBe(200);
    expect((await call(deps, ui(deps, "POST", "secrets", entry({ id: "man-a", provider: "manual" })))).status).toBe(200);
  });
});

describe("suggest-all", () => {
  it("proposes for every entry with missing parameters and writes nothing", async () => {
    const { deps, dir } = await setup();
    const before = await readFile(join(dir, "inventory.yaml"), "utf8");
    const r = await call(deps, ui(deps, "POST", "params/suggest-all", {}));
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.json.suggestions.map((s: { secretId: string }) => [s.secretId, s]));
    expect(by["supabase-wake-miles-staging"]).toMatchObject({ status: "suggested", suggestions: { projectRef: { value: "abc" } } });
    expect(by["supabase-ambiguous-staging"]).toMatchObject({ status: "none", suggestions: { projectRef: null } });
    expect(by["supabase-unknown-staging"].suggestions.projectRef).toBeNull();
    expect(by["cf-deploy-wake-miles-staging"]).toMatchObject({ status: "partial", missing: ["accountId", "permissions"] });
    expect(by["hmac-wake-miles"]).toBeUndefined();
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(before);
    noTokens(r.text);
  });
});

describe("agents get read-only parameter status", () => {
  it("secret views carry the status; discovery, resources and writes are not available", async () => {
    const { deps, providerCalls } = await setup();
    const v = await call(deps, agent(deps, "GET", "secrets/supabase-unknown-staging"));
    expect(v.json.params).toEqual({ status: "missing", missing: ["projectRef"] });
    expect((await call(deps, agent(deps, "GET", "secrets/hmac-wake-miles"))).json.params).toEqual({ status: "ok", missing: [] });
    for (const [m, p, b] of [["GET", "secrets/supabase-unknown-staging/params"], ["PUT", "secrets/supabase-unknown-staging/params", { params: {} }], ["GET", "connections/supabase/resources"], ["PUT", "connections/supabase/defaults", { values: {} }], ["POST", "params/suggest-all", {}], ["GET", "providers/supabase-api-key/params"], ["POST", "variables/suggest-all", {}]] as const) {
      expect((await call(deps, agent(deps, m, p, b))).status, `${m} ${p}`).toBe(404);
    }
    expect(providerCalls).toHaveLength(0);
  });
});

describe("variables from sources", () => {
  it("lists sources with allowed fields only", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "variable-sources"));
    const fields = r.json.sources.flatMap((s: { fields: { field: string }[] }) => s.fields.map((f) => f.field));
    expect(fields).toEqual(["ref", "url", "publishableKey", "accountId", "zoneId", "name", "sitekey", "domainId", "name"]);
    expect(r.json.sources[0]).toMatchObject({ kind: "supabase.project", connected: true });
  });
  it("load-from-source proposes first and writes only on apply; no secret field ever shows up", async () => {
    const { deps, dir } = await setup();
    const proposal = await call(deps, ui(deps, "POST", "variables/supabase-ref/load-from-source", {}));
    expect(proposal.json).toMatchObject({ variableId: "supabase-ref", current: null, proposed: "abc", changed: true, applied: false, resourceLabel: "wake-miles-staging" });
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).not.toContain("value: abc");
    const applied = await call(deps, ui(deps, "POST", "variables/supabase-ref/load-from-source", { apply: true }));
    expect(applied.json.applied).toBe(true);
    expect((await call(deps, ui(deps, "GET", "variables/supabase-ref"))).json.value).toBe("abc");
    const anon = await call(deps, ui(deps, "POST", "variables/supabase-anon/load-from-source", { kind: "supabase.project", resource: "abc", field: "publishableKey", apply: true, acknowledgedPublic: true }));
    expect(anon.json).toMatchObject({ proposed: ANON, applied: true, from: { field: "publishableKey" } });
    noTokens(anon.text);
    for (const field of ["serviceRole", "service_role", "secret", "apiKey"]) {
      const bad = await call(deps, ui(deps, "POST", "variables/supabase-anon/load-from-source", { kind: "supabase.project", resource: "abc", field }));
      expect(bad.status).toBe(400);
      noTokens(bad.text);
    }
    expect((await call(deps, ui(deps, "POST", "variables/supabase-anon/load-from-source", { kind: "supabase.project", resource: "missing", field: "ref" }))).status).toBe(400);
  });
  it("suggest-all covers variables with a source only and the preview works without a variable", async () => {
    const { deps, dir } = await setup();
    const before = await readFile(join(dir, "inventory.yaml"), "utf8");
    const r = await call(deps, ui(deps, "POST", "variables/suggest-all", {}));
    expect(r.json.suggestions).toHaveLength(1);
    expect(r.json.suggestions[0]).toMatchObject({ variableId: "supabase-ref", proposed: "abc", status: "ok" });
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(before);
    const preview = await call(deps, ui(deps, "POST", "variable-sources/value", { kind: "supabase.project", resource: "abc", field: "url", repo: "wake-miles", stage: "staging" }));
    expect(preview.json).toMatchObject({ value: "https://abc.supabase.co", resourceLabel: "wake-miles-staging", from: { connection: "supabase", field: "url" } });
    noTokens(preview.text);
  });
  it("a variable can be created with a source", async () => {
    const { deps } = await setup();
    const c = await call(deps, ui(deps, "POST", "variables", { id: "cf-account", name: "CF_ACCOUNT_ID", stage: "staging", value: "acc1", from: { connection: "cloudflare", kind: "cloudflare.account", resource: "acc1", field: "accountId" }, places: [{ repo: "wake-miles", scope: "environment", environment: "staging" }] }));
    expect(c.status).toBe(200);
    expect(c.json.from).toMatchObject({ kind: "cloudflare.account" });
    const bad = await call(deps, ui(deps, "POST", "variables", { id: "cf-bad", name: "CF_BAD", stage: "staging", from: { connection: "cloudflare", kind: "cloudflare.account", resource: "acc1", field: "apiToken" }, places: [{ repo: "wake-miles", scope: "environment", environment: "staging" }] }));
    expect(bad.status).toBe(400);
  });
});
