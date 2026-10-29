import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const TOKEN = "team_token_made_up_1";
const TEAM_FILE = "version: 1\nsecrets:\n  - id: api-key\n    name: API_KEY\n    stage: shared\n    service: intern\n    provider: random-hex\n    expiry: none\n    places:\n      - { repo: app, scope: repository }\nvariables: []\n";

async function setup(status = 200) {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (status !== 200) return new Response(JSON.stringify({ message: "denied" }), { status });
    if (u.pathname.includes("/contents/")) return new Response(JSON.stringify({ type: "file", sha: "sha1", content: Buffer.from(TEAM_FILE).toString("base64") }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-ts-router-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nteamSync:\n  repo: acme/team-config\n  mode: pull-push\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "gh_main_made_up", SECRET_DESK_TEAM_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  const deps: RouterDeps = { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
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
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("team sync: agent policy", () => {
  it("agents read the status", async () => {
    const { deps, calls } = await setup();
    const r = await route(agent(deps, "GET", "team-sync/status"), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ configured: true, repo: "acme/team-config" });
    expect(calls).toEqual([]);
  });

  it("agents can neither check, apply, push, configure nor preview (404, no GitHub call)", async () => {
    const { deps, calls } = await setup();
    const attempts: [string, string, unknown][] = [
      ["POST", "team-sync/check", {}],
      ["POST", "team-sync/apply", { expectSha: "sha1", resolution: "replace", confirmReplace: true }],
      ["POST", "team-sync/push-plan", {}],
      ["POST", "team-sync/push", { confirm: true, expectLocalHash: "x", expectRemoteSha: null }],
      ["PUT", "team-sync/config", { teamSync: { repo: "evil/other" } }],
      ["POST", "team-sync/dismiss-setup", {}],
      ["POST", "team-sync/preview-text", { text: TEAM_FILE }],
    ];
    for (const [m, p, b] of attempts) expect((await route(agent(deps, m, p, b), deps)).status, `${m} ${p}`).toBe(404);
    expect(calls).toEqual([]);
    expect(deps.rt.config.teamSync?.repo).toBe("acme/team-config");
  });
});

describe("team sync: portal API", () => {
  it("check, apply with the expected sha, and no token in any response", async () => {
    const { deps } = await setup();
    const checkRes = await route(ui(deps, "POST", "team-sync/check", {}), deps);
    const check = (await checkRes.json()) as { state: string; remoteSha: string };
    expect(check.state).toBe("remote-new");
    const applyRes = await route(ui(deps, "POST", "team-sync/apply", { expectSha: check.remoteSha, resolution: "merge" }), deps);
    expect(applyRes.status).toBe(200);
    expect(deps.rt.inventory.getSecret("api-key")).toBeDefined();
    const all = [JSON.stringify(check), await applyRes.text(), await (await route(ui(deps, "GET", "team-sync/status"), deps)).text(), await (await route(ui(deps, "GET", "connections"), deps)).text()].join("\n");
    expect(all).not.toContain(TOKEN);
  });

  it("replace without confirmReplace is a 400", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "POST", "team-sync/apply", { expectSha: "sha1", resolution: "replace" }), deps);
    expect(r.status).toBe(400);
  });

  it("push without confirm is a 400 and nothing is sent", async () => {
    const { deps, calls } = await setup();
    const r = await route(ui(deps, "POST", "team-sync/push", { expectLocalHash: "x", expectRemoteSha: null }), deps);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a denied token gives a clear 502 error without the token", async () => {
    const { deps } = await setup(403);
    const r = await route(ui(deps, "POST", "team-sync/check", {}), deps);
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).toContain("denied");
    expect(text).not.toContain(TOKEN);
  });

  it("English portal texts: error is translated", async () => {
    const { deps } = await setup(403);
    const req = new Request(`${base}/api/ui/team-sync/check`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, "x-secret-desk-lang": "en", "content-type": "application/json" }, body: "{}" });
    const body = (await (await route(req, deps)).json()) as { error: string };
    expect(body.error).toMatch(/lacks the required rights/);
  });

  it("preview-text shows ids without changing the inventory; config is validated", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "POST", "team-sync/preview-text", { text: TEAM_FILE }), deps);
    expect(((await r.json()) as { sections: { secrets: { added: string[] } } }).sections.secrets.added).toEqual(["api-key"]);
    expect(deps.rt.inventory.data.secrets).toHaveLength(0);
    expect((await route(ui(deps, "PUT", "team-sync/config", { teamSync: { repo: "nonsense" } }), deps)).status).toBe(400);
  });
});
