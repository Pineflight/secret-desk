import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyError, createLocalRuntime, type AuthorizationRequest } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: stage-secret
    name: STAGE_SECRET
    stage: staging
    service: x
    provider: manual
    expiry: none
    places: [{ repo: acme-docs, scope: environment, environment: staging }]
`;
const REFUSAL = "refused by route test hook";

async function setup() {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-authz-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  const seen: AuthorizationRequest[] = [];
  rt.authorize = (request) => {
    seen.push(request);
    throw new PolicyError(REFUSAL);
  };
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, seen, calls, inventoryBefore: JSON.stringify(rt.inventory.data) };
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

type Case = { name: string; method: string; path: string; body?: unknown; action: string; subject?: Record<string, unknown> };
const CASES: Case[] = [
  { name: "team sync apply", method: "POST", path: "team-sync/apply", body: { expectSha: "abc", resolution: "replace" }, action: "team.sync.apply", subject: { mode: "replace" } },
  { name: "team sync push", method: "POST", path: "team-sync/push", body: { confirm: true, expectLocalHash: "h" }, action: "team.sync.push" },
  { name: "team sync config", method: "PUT", path: "team-sync/config", body: { teamSync: {} }, action: "team.sync.configure" },
  { name: "team sync dismiss setup", method: "POST", path: "team-sync/dismiss-setup", body: {}, action: "team.sync.configure" },
  { name: "team token start", method: "POST", path: "team-sync/token", body: {}, action: "automation.run" },
  { name: "team token credentials", method: "POST", path: "team-sync/token/credentials", body: {}, action: "integration.connect", subject: { connectionId: "team-sync" } },
  { name: "team token code", method: "POST", path: "team-sync/token/code", body: {}, action: "integration.connect", subject: { connectionId: "team-sync" } },
  { name: "team token confirm", method: "POST", path: "team-sync/token/confirm", body: {}, action: "integration.connect", subject: { connectionId: "team-sync" } },
  { name: "team token access", method: "POST", path: "team-sync/token/access", body: {}, action: "integration.connect", subject: { connectionId: "team-sync" } },
  { name: "team token check", method: "POST", path: "team-sync/token/check", body: {}, action: "automation.run" },
  { name: "team token revocation done", method: "POST", path: "team-sync/token/revocation-done", body: {}, action: "team.sync.configure" },
  { name: "stages", method: "PUT", path: "stages", body: { stages: [] }, action: "settings.edit" },
  { name: "live check", method: "POST", path: "live-check", body: {}, action: "automation.run" },
  { name: "facade sign-in", method: "POST", path: "facades/vendor-a/sign-in", body: {}, action: "integration.connect", subject: { connectionId: "vendor-a" } },
  { name: "facade code", method: "POST", path: "facades/vendor-a/code", body: {}, action: "integration.connect", subject: { connectionId: "vendor-a" } },
  { name: "facade access", method: "POST", path: "facades/vendor-a/access", body: {}, action: "integration.connect", subject: { connectionId: "vendor-a" } },
  { name: "facade confirm", method: "POST", path: "facades/vendor-a/confirm", body: {}, action: "integration.connect", subject: { connectionId: "vendor-a" } },
  { name: "facade connect", method: "POST", path: "facades/vendor-a/connect", body: {}, action: "integration.connect", subject: { connectionId: "vendor-a" } },
  { name: "facade check", method: "POST", path: "facades/vendor-a/check", body: {}, action: "automation.run", subject: { connectionId: "vendor-a" } },
  { name: "recipe check", method: "POST", path: "recipes/vendor-b/check", body: {}, action: "automation.run", subject: { connectionId: "vendor-b" } },
  { name: "recipe sign-in", method: "POST", path: "recipes/vendor-b/sign-in", body: {}, action: "integration.connect", subject: { connectionId: "vendor-b" } },
  { name: "recipe code", method: "POST", path: "recipes/vendor-b/sign-in/code", body: {}, action: "integration.connect", subject: { connectionId: "vendor-b" } },
  { name: "recipe confirm", method: "POST", path: "recipes/vendor-b/sign-in/confirm", body: {}, action: "integration.connect", subject: { connectionId: "vendor-b" } },
  { name: "deep connection check", method: "POST", path: "connections/github/check", body: { deep: true }, action: "connection.check", subject: { connectionId: "github" } },
  { name: "repository link", method: "PUT", path: "repos/acme-docs/link", body: { path: "/tmp/nowhere" }, action: "repo.link", subject: { repo: "acme-docs" } },
  { name: "repository rename", method: "POST", path: "repos/acme-docs/rename", body: { to: "acme-web" }, action: "repo.link", subject: { repo: "acme-docs" } },
  { name: "repository unlink", method: "DELETE", path: "repos/acme-docs/link", action: "repo.link", subject: { repo: "acme-docs" } },
  { name: "team import (merge)", method: "POST", path: "team-import", body: { text: "version: 1\n" }, action: "team.import", subject: { mode: "merge" } },
  { name: "team import (replace)", method: "POST", path: "team-import", body: { text: "version: 1\n", replace: true, confirmReplace: true }, action: "team.import", subject: { mode: "replace" } },
  { name: "env content export", method: "POST", path: "env/export", body: { repo: "acme-docs", stage: "dev" }, action: "env.export", subject: { repo: "acme-docs", stage: "dev" } },
];

describe("routes that change state or move values ask the authorisation hook first", () => {
  for (const c of CASES) {
    it(`${c.name}: the hook is asked as ${c.action} and a refusal is a 403 before anything happens`, async () => {
      const { deps, seen, calls, inventoryBefore } = await setup();
      const res = await route(ui(deps, c.method, c.path, c.body), deps);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(REFUSAL);
      expect(seen).toEqual([{ actor: { kind: "human", name: expect.any(String) }, action: c.action, ...(c.subject ? { subject: c.subject } : {}) }]);
      expect(calls).toEqual([]);
      expect(JSON.stringify(deps.rt.inventory.data)).toBe(inventoryBefore);
    });
  }

  it("env export to a file (human) is asked as env.export; an agent is refused by the built-in rule first", async () => {
    const { deps, seen } = await setup();
    const res = await route(ui(deps, "POST", "env-export", { repo: "acme-docs", stage: "dev" }), deps);
    // No template for the repository: the built-in check answers before the hook is asked.
    expect(res.status).not.toBe(200);
    expect(seen).toEqual([]);
    const agentContent = await route(agent(deps, "POST", "env/export", { repo: "acme-docs", stage: "staging" }), deps);
    expect(agentContent.status).toBe(403);
    expect(await agentContent.text()).not.toContain(REFUSAL);
    expect(seen).toEqual([]);
  });

  it("agents never reach the human-only routes, and the hook is not asked", async () => {
    const { deps, seen } = await setup();
    expect((await route(agent(deps, "POST", "team-sync/apply", { expectSha: "x", resolution: "merge" }), deps)).status).toBe(404);
    expect((await route(agent(deps, "PUT", "stages", { stages: [] }), deps)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("the routes that only read or only close a run stay unhooked: plain connection check, repository scan, cancel, push plan", async () => {
    const { deps, seen } = await setup();
    for (const [method, path, body] of [
      ["POST", "connections/github/check", {}],
      ["POST", "repos/scan", {}],
      ["POST", "facades/vendor-a/cancel", {}],
      ["POST", "recipes/vendor-b/sign-in/cancel", {}],
      ["POST", "team-sync/token/cancel", {}],
      ["POST", "team-sync/push-plan", {}],
      ["POST", "team-sync/check", {}],
    ] as const) await route(ui(deps, method, path, body), deps);
    expect(seen).toEqual([]);
  });

  it("an id longer than 256 characters is not found, and the hook is not asked; 256 still reaches it", async () => {
    const { deps, seen } = await setup();
    const tooLong = await route(ui(deps, "PUT", `repos/${"a".repeat(257)}/link`, { path: "/tmp/nowhere" }), deps);
    expect(tooLong.status).toBe(404);
    expect(seen).toEqual([]);
    expect((await route(ui(deps, "PUT", `repos/${"a".repeat(256)}/link`, { path: "/tmp/nowhere" }), deps)).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("team import: a replace without confirmation is refused before the hook is asked", async () => {
    const { deps, seen } = await setup();
    expect((await route(ui(deps, "POST", "team-import", { text: "version: 1\n", replace: true }), deps)).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
