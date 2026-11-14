import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - { id: api-key-dev, name: API_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: token-staging, name: TOKEN, stage: staging, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: environment, environment: staging }] }
variables:
  - { id: v-site, name: SITE_URL, stage: dev, value: "http://localhost:3000", places: [{ repo: acme-app, scope: repository }] }
  - { id: v-staging, name: STAGING_URL, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-app, scope: environment, environment: staging }] }
envTemplates:
  - { id: t, repo: acme-app, stage: dev, entries: [{ key: API_KEY, from: { type: generate, kind: hex, bytes: 16 } }] }
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-envx-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "x" } as unknown as NodeJS.ProcessEnv, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return deps;
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, path: string, body: unknown): Request =>
  new Request(`${base}/api/ui/${path}`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
const agent = (deps: RouterDeps, path: string, body: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, { method: "POST", headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST env/export", () => {
  it("agent: dev returns the content; staging is 403", async () => {
    const deps = await setup();
    const ok = await route(agent(deps, "env/export", { repo: "acme-app", stage: "dev", include: "all" }), deps);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { content: string; keys: string[]; filename: string };
    expect(body.content).toContain("SITE_URL=http://localhost:3000");
    expect(body.content).toMatch(/\nAPI_KEY=[0-9a-f]{32}\n/);
    expect(body.keys).toEqual(["API_KEY", "SITE_URL"]);
    const denied = await route(agent(deps, "env/export", { repo: "acme-app", stage: "staging" }), deps);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("staging.example.com");
  });

  it("human: variables of staging, secret of staging omitted", async () => {
    const deps = await setup();
    const r = await route(ui(deps, "env/export", { repo: "acme-app", stage: "staging", include: "all" }), deps);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string; missing: { name: string }[] };
    expect(body.content).toContain("STAGING_URL=https://staging.example.com");
    expect(body.missing).toEqual([{ name: "TOKEN", reason: "secret values of stage staging are never exported" }]);
  });

  it("validates the parameters", async () => {
    const deps = await setup();
    expect((await route(ui(deps, "env/export", { repo: "acme-app" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "env/export", { repo: "acme-app", stage: "dev", format: "yaml" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "env/export", { repo: "acme-app", stage: "dev", include: "x" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "env/export", { repo: "acme-app", stage: "nope" }), deps)).status).toBe(400);
  });
});
