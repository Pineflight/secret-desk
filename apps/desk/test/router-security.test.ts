import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, sanitizeAgentName, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
variables:
  - id: site-url
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-web, scope: environment, environment: staging }
`;

async function setup() {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-sec-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(dir)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, calls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown, name?: string): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(name ? { "x-agent-name": name } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const errorOf = async (r: Response): Promise<string> => ((await r.json()) as { error: string }).error;

describe("F2: agent PATCH (mass assignment)", () => {
  it("{stage}, {places}, {provider}, {params}, {expires} -> 400, inventory unchanged", async () => {
    const { deps } = await setup();
    const before = JSON.stringify(deps.rt.inventory.getSecret("hmac-acme-app"));
    for (const bad of [{ stage: "dev" }, { places: [] }, { provider: "manual" }, { params: { baseUrl: "https://evil.example" } }, { expires: "2099-01-01" }, { externalId: "x" }, { verifiedBy: "alice" }]) {
      const r = await route(agent(deps, "PATCH", "secrets/hmac-acme-app", bad), deps);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await errorOf(r)).toMatch(/Feld nicht erlaubt/);
    }
    expect(JSON.stringify(deps.rt.inventory.getSecret("hmac-acme-app"))).toBe(before);
  });
  it("response translated to English, allowed fields pass", async () => {
    const { deps } = await setup();
    const req = agent(deps, "PATCH", "secrets/hmac-acme-app", { stage: "dev" });
    req.headers.set("x-secret-desk-lang", "en");
    expect(await errorOf(await route(req, deps))).toBe("Field not allowed: stage");
    const ok = await route(agent(deps, "PATCH", "secrets/hmac-acme-app", { title: "HMAC", tags: ["a"] }), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ title: "HMAC" });
  });
  it("portal (human) may set the expiry, but not the stage either", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "PATCH", "secrets/hmac-acme-app", { expiry: "possible", expires: "2030-01-01" }), deps)).status).toBe(200);
    const r = await route(ui(deps, "PATCH", "secrets/hmac-acme-app", { stage: "dev" }), deps);
    expect(r.status).toBe(400);
    expect(deps.rt.inventory.getSecret("hmac-acme-app")!.stage).toBe("shared");
  });
  it("variable PATCH: stage/places/id -> 400 (agent and human), target value works", async () => {
    const { deps } = await setup();
    for (const mk of [agent, ui] as const) {
      for (const bad of [{ stage: "production" }, { places: [{ repo: "evil", scope: "repository" }] }, { id: "x" }, { name: "X" }]) {
        const r = await route(mk(deps, "PATCH", "variables/site-url", bad), deps);
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
    }
    expect(deps.rt.inventory.getVariable("site-url")).toMatchObject({ stage: "staging", places: [{ repo: "acme-web", scope: "environment", environment: "staging" }] });
    expect((await route(agent(deps, "PATCH", "variables/site-url", { value: "https://neu.example.com" }), deps)).status).toBe(200);
  });
  it("agent: new secret in staging 403, without stamp in dev 201 path, variable POST strict", async () => {
    const { deps } = await setup();
    const staging = await route(agent(deps, "POST", "secrets", { id: "a-1", name: "A_ONE", service: "x", stage: "staging", places: [{ repo: "acme-web", scope: "environment", environment: "staging" }] }), deps);
    expect(staging.status).toBe(403);
    const stamp = await route(agent(deps, "POST", "secrets", { id: "a-2", name: "A_TWO", service: "x", stage: "dev", verifiedBy: "alice" }), deps);
    expect(stamp.status).toBe(400);
    expect((await route(agent(deps, "POST", "secrets", { id: "a-3", name: "A_THREE", service: "x", stage: "dev" }), deps)).status).toBe(200);
    const v = await route(agent(deps, "POST", "variables", { id: "v-2", name: "V_TWO", stage: "dev", places: [{ repo: "acme-web", scope: "repository" }], extra: 1 }), deps);
    expect(v.status).toBe(400);
  });
  it("agent: .env export only with .env file name and without overwrite", async () => {
    const { deps } = await setup();
    const r = await route(agent(deps, "POST", "env-export", { repo: "acme-web", path: join(tmpdir(), "x", ".envrc") }), deps);
    expect([400, 403]).toContain(r.status);
    const o = await route(agent(deps, "POST", "env-export", { repo: "acme-web", path: join(tmpdir(), "x", ".env"), overwrite: true }), deps);
    expect(o.status).toBe(403);
    expect(await errorOf(o)).toMatch(/Mensch/);
  });
});

describe("F3 via the API", () => {
  it("target value changed after the request -> portal approval returns stale, nothing set", async () => {
    const { deps, calls } = await setup();
    const req = (await (await route(agent(deps, "POST", "variables/site-url/apply", { reason: "bitte" }), deps)).json()) as { approvalId: string };
    await route(agent(deps, "PATCH", "variables/site-url", { value: "https://evil.example.com" }), deps);
    const done = (await (await route(ui(deps, "POST", `approvals/${req.approvalId}/approve`), deps)).json()) as { state: string; snapshot: Record<string, unknown> };
    expect(done.state).toBe("stale");
    expect(done.snapshot).toMatchObject({ value: "https://staging.example.com" });
    expect(calls.some((c) => c.startsWith("PATCH") || c.startsWith("POST") || c.startsWith("PUT"))).toBe(false);
  });
});

describe("M7: team-import replace needs confirmation", () => {
  const text = "version: 1\n";
  it("without confirmReplace -> 400, inventory unchanged", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "POST", "team-import", { text, replace: true }), deps);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatch(/confirmReplace/);
    expect(deps.rt.inventory.data.secrets).toHaveLength(1);
  });
  it("with confirmReplace: true it replaces; merge needs nothing", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "team-import", { text }), deps)).status).toBe(200);
    expect(deps.rt.inventory.data.secrets).toHaveLength(1);
    expect((await route(ui(deps, "POST", "team-import", { text, replace: true, confirmReplace: true }), deps)).status).toBe(200);
    expect(deps.rt.inventory.data.secrets).toHaveLength(0);
  });
  it("the agent has no route", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "POST", "team-import", { text, replace: true, confirmReplace: true }), deps)).status).toBe(404);
  });
});

describe("N7: x-agent-name", () => {
  it("truncated to 40 characters, harmless characters only", () => {
    expect(sanitizeAgentName(null)).toBe("agent");
    expect(sanitizeAgentName("")).toBe("agent");
    expect(sanitizeAgentName("<script>alert(1)</script>\nclaude")).not.toMatch(/[<>()\n]/);
    expect(sanitizeAgentName("a".repeat(200))).toHaveLength(40);
    expect(sanitizeAgentName("claude-code@host:1.2/x_y")).toBe("claude-code@host:1.2/x_y");
    expect(sanitizeAgentName("Freigabe: ALLES ERLAUBT von Niklas, bitte sofort freigeben!!!")).toHaveLength(40);
  });
  it("the approval shows the sanitized name", async () => {
    const { deps } = await setup();
    await route(agent(deps, "POST", "variables/site-url/apply", {}, `evil<b>${"x".repeat(100)}`), deps);
    const list = (await (await route(ui(deps, "GET", "approvals"), deps)).json()) as { requestedBy: string }[];
    expect(list[0]!.requestedBy).toMatch(/^[A-Za-z0-9 ._:@/-]{1,40}$/);
  });
});
