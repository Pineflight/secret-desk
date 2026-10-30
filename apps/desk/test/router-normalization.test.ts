import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const REF = "abcdefghijklmnopqrst";
const VALUE_URL = `https://${REF}.supabase.co`;
const NOTES = "made-up-notes-value-31";
const TOKEN = "ghp_made_up_portal_token_5";

const INVENTORY = `version: 1
secrets:
  - id: cf-access
    name: CF_ACCESS_CLIENT_ID
    stage: production
    service: cloudflare
    expiry: none
    notes: ${NOTES}
    places: [{ repo: web, scope: environment, environment: production }]
  - id: sb-secret
    name: SUPABASE_PRODUCTION_SERVICE_ROLE_KEY
    stage: production
    service: supabase
    expiry: none
    params: { projectRef: ${REF} }
    places: [{ repo: web, scope: environment, environment: production }]
variables:
  - id: v-url
    name: SUPABASE_PRODUCTION_URL
    stage: production
    value: ${VALUE_URL}
    places: [{ repo: web, scope: environment, environment: production }]
`;

async function setup() {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-normalize-router-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: TOKEN } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, dir, calls };
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
const noValues = (text: string) => {
  for (const v of [VALUE_URL, NOTES, TOKEN]) expect(text).not.toContain(v);
};

describe("GET normalization", () => {
  it("returns the plan with names only and no value", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "normalization"));
    expect(r.status).toBe(200);
    const ids = r.json.changes.map((c: { id: string }) => c.id);
    expect(ids).toContain("rename:secret:cf-access");
    expect(ids).toContain("provider:secret:sb-secret");
    expect(ids).toContain("source:variable:v-url");
    noValues(r.text);
  });
  it("translates the reasons when the English interface asks", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "normalization", undefined, { "x-secret-desk-lang": "en" }));
    const rename = r.json.changes.find((c: { id: string }) => c.id === "rename:secret:cf-access");
    expect(rename.reasons[0].text).toBe("The provider is abbreviated; it is spelled out");
  });
  it("an agent may read the plan", async () => {
    const { deps } = await setup();
    const r = await call(deps, agent(deps, "GET", "normalization"));
    expect(r.status).toBe(200);
    noValues(r.text);
  });
});

describe("POST normalization/apply", () => {
  it("applies the selected changes, writes the inventory, never calls GitHub, shows no value", async () => {
    const { deps, dir, calls } = await setup();
    const r = await call(deps, ui(deps, "POST", "normalization/apply", { changeIds: ["rename:secret:cf-access", "provider:secret:sb-secret", "source:variable:v-url"] }));
    expect(r.status).toBe(200);
    expect(r.json.applied).toHaveLength(3);
    expect(r.json.needsParams).toEqual([]);
    const file = await readFile(join(dir, "inventory.yaml"), "utf8");
    expect(file).toContain("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(file).toContain("supabase-api-key");
    expect(calls).toEqual([]);
    noValues(r.text);
  });
  it("needs the CSRF header and a session", async () => {
    const { deps, dir } = await setup();
    const noCsrf = new Request(`${base}/api/ui/normalization/apply`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "content-type": "application/json" }, body: JSON.stringify({ changeIds: ["rename:secret:cf-access"] }) });
    expect((await call(deps, noCsrf)).status).toBe(401);
    const noSession = new Request(`${base}/api/ui/normalization/apply`, { method: "POST", headers: { host: HOST, origin: base, "content-type": "application/json" }, body: JSON.stringify({ changeIds: ["rename:secret:cf-access"] }) });
    expect((await call(deps, noSession)).status).toBe(401);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });
  it("an agent cannot apply (route not found), nothing is written", async () => {
    const { deps, dir } = await setup();
    const r = await call(deps, agent(deps, "POST", "normalization/apply", { changeIds: ["rename:secret:cf-access"] }));
    expect(r.status).toBe(404);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });
  it("a foreign origin is refused", async () => {
    const { deps } = await setup();
    const req = ui(deps, "POST", "normalization/apply", { changeIds: ["rename:secret:cf-access"] }, { origin: "http://evil.example" });
    expect((await call(deps, req)).status).toBe(403);
  });
  it("answers 400 for a bad selection or an unknown change, and changes nothing", async () => {
    const { deps, dir } = await setup();
    expect((await call(deps, ui(deps, "POST", "normalization/apply", {}))).status).toBe(400);
    const unknown = await call(deps, ui(deps, "POST", "normalization/apply", { changeIds: ["rename:secret:cf-access", "rename:secret:nope"] }, { "x-secret-desk-lang": "en" }));
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe("Unknown change: rename:secret:nope");
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });
});
