import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

// Git ohne Benutzer-/Systemkonfiguration (url.insteadOf, init.templateDir, Hooks ...): gilt auch fuer die Aufrufe der Runtime.
const GIT_ENV_SAVED = { GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"], GIT_CONFIG_NOSYSTEM: process.env["GIT_CONFIG_NOSYSTEM"] };
beforeAll(() => {
  process.env["GIT_CONFIG_GLOBAL"] = devNull;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV_SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

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
variables: []
envTemplates:
  - id: ws-dev
    repo: acme-web
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost" } }
`;

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-desk-repos-")));
  const projects = join(dir, "projekte");
  await mkdir(join(projects, "acme-app"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: join(projects, "acme-app") });
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, repo: join(projects, "acme-app") };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("Repositories", () => {
  it("list contains inventory repos from secrets and templates", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "repos"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: { name: string }[]; github: string };
    expect(body.repos.map((r) => r.name)).toEqual(["acme-app", "acme-web"]);
    expect(body.github).toBe("off");
  });

  it("live=1 without reachable GitHub does not block", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "repos?live=1"), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { github: string }).github).toBe("unavailable");
  });

  it("UI sets and removes links", async () => {
    const { deps, repo } = await setup();
    const put = await route(ui(deps, "PUT", "repos/acme-app/link", { path: repo }), deps);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { path: string }).path).toBe(repo);
    const list = (await (await route(ui(deps, "GET", "repos"), deps)).json()) as { repos: { name: string; link: { path: string } | null }[] };
    expect(list.repos.find((r) => r.name === "acme-app")?.link?.path).toBe(repo);
    const del = await route(ui(deps, "DELETE", "repos/acme-app/link"), deps);
    expect(del.status).toBe(200);
    const bad = await route(ui(deps, "PUT", "repos/acme-app/link", { path: join(repo, "nope") }), deps);
    expect(bad.status).toBe(400);
  });

  it("UI can search locally", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "POST", "repos/scan"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("agents read the list without paths but set nothing", async () => {
    const { deps, repo } = await setup();
    await route(ui(deps, "PUT", "repos/acme-app/link", { path: repo }), deps);
    const list = await route(agent(deps, "GET", "repos"), deps);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain("acme-app");
    expect(text).not.toContain(repo);
    expect((await route(agent(deps, "PUT", "repos/acme-app/link", { path: repo }), deps)).status).toBe(404);
    expect((await route(agent(deps, "DELETE", "repos/acme-app/link"), deps)).status).toBe(404);
    expect((await route(agent(deps, "POST", "repos/scan", {}), deps)).status).toBe(404);
  });

  it("rename in inventory: portal only, agents get 404", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "POST", "repos/acme-app/rename", { to: "acme-app2" }), deps)).status).toBe(404);
    const res = await route(ui(deps, "POST", "repos/acme-app/rename", { to: "acme-app2" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "acme-app", to: "acme-app2", changed: 1 });
    const list = (await (await route(ui(deps, "GET", "repos"), deps)).json()) as { repos: { name: string }[] };
    expect(list.repos.map((r) => r.name)).toEqual(["acme-app2", "acme-web"]);
    // unbekannt, gleicher Name, fehlendes Feld, ungueltiger Name
    expect((await route(ui(deps, "POST", "repos/nope/rename", { to: "x" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "POST", "repos/acme-web/rename", { to: "ACME-WEB" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "POST", "repos/acme-web/rename", {}), deps)).status).toBe(400);
    expect((await route(ui(deps, "POST", "repos/acme-web/rename", { to: "a/b" }), deps)).status).toBe(400);
  });

  it("compare accepts all and workflows; without live no network", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "compare?all=1&workflows=1"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: boolean; repos: { name: string; inInventory: boolean }[] };
    expect(body.live).toBe(false);
    expect(body.repos.map((r) => r.name)).toEqual(["acme-app"]);
  });
});
