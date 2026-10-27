import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: hmac-wakemiles
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: wake-miles, scope: repository }
variables: []
envTemplates:
  - id: ws-dev
    repo: web-studio
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost" } }
`;

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-desk-repos-")));
  const projects = join(dir, "projekte");
  await mkdir(join(projects, "wake-miles"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: join(projects, "wake-miles") });
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: Pineflight\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, repo: join(projects, "wake-miles") };
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
  it("Liste enthaelt Inventar-Repos aus Secrets und Vorlagen", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "repos"), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: { name: string }[]; github: string };
    expect(body.repos.map((r) => r.name)).toEqual(["wake-miles", "web-studio"]);
    expect(body.github).toBe("off");
  });

  it("live=1 ohne erreichbares GitHub blockiert nicht", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "repos?live=1"), deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { github: string }).github).toBe("unavailable");
  });

  it("UI setzt und entfernt Verknuepfungen", async () => {
    const { deps, repo } = await setup();
    const put = await route(ui(deps, "PUT", "repos/wake-miles/link", { path: repo }), deps);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { path: string }).path).toBe(repo);
    const list = (await (await route(ui(deps, "GET", "repos"), deps)).json()) as { repos: { name: string; link: { path: string } | null }[] };
    expect(list.repos.find((r) => r.name === "wake-miles")?.link?.path).toBe(repo);
    const del = await route(ui(deps, "DELETE", "repos/wake-miles/link"), deps);
    expect(del.status).toBe(200);
    const bad = await route(ui(deps, "PUT", "repos/wake-miles/link", { path: join(repo, "nope") }), deps);
    expect(bad.status).toBe(400);
  });

  it("UI kann lokal suchen", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "POST", "repos/scan"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("Agenten lesen die Liste ohne Pfade, setzen aber nichts", async () => {
    const { deps, repo } = await setup();
    await route(ui(deps, "PUT", "repos/wake-miles/link", { path: repo }), deps);
    const list = await route(agent(deps, "GET", "repos"), deps);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain("wake-miles");
    expect(text).not.toContain(repo);
    expect((await route(agent(deps, "PUT", "repos/wake-miles/link", { path: repo }), deps)).status).toBe(404);
    expect((await route(agent(deps, "DELETE", "repos/wake-miles/link"), deps)).status).toBe(404);
    expect((await route(agent(deps, "POST", "repos/scan", {}), deps)).status).toBe(404);
  });
});
