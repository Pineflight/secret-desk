import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const PAT = "gh_main_made_up_discovery";

async function setup(withToken = true) {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.pathname === "/user/repos") return j([{ name: "team-config", owner: { login: "acme" }, private: true, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" }, { name: "site", owner: { login: "acme" }, private: false, default_branch: "main" }]);
    if (u.pathname === "/repos/acme/team-config/branches") return j([{ name: "main" }]);
    if (u.pathname === "/repos/acme/team-config") return j({ private: true, default_branch: "main", permissions: { push: true } });
    if (u.pathname === "/repos/acme/team-config/git/ref/heads/main") return j({ object: { sha: "head1" } });
    if (u.pathname === "/repos/acme/team-config/git/trees/head1") return j({ tree: [{ path: "secret-desk.team.yaml", type: "blob" }] });
    if (u.pathname.includes("/contents/")) return j({ type: "file", sha: "s1", content: Buffer.from("version: 1\nsecrets: []\nvariables: []\n").toString("base64") });
    return j({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-disc-router-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: (withToken ? { GH_TEST: PAT } : {}) as unknown as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  const deps: RouterDeps = { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, calls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, path: string, extra: Record<string, string> = {}): Request =>
  new Request(`${base}/api/ui/${path}`, { method: "GET", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...extra } });
const agent = (deps: RouterDeps, path: string): Request => new Request(`${base}/api/agent/${path}`, { method: "GET", headers: { host: HOST, authorization: `Bearer ${deps.agentToken}` } });

const PATHS = [
  "team-sync/discovery/repos",
  "team-sync/discovery/branches?repo=acme/team-config",
  "team-sync/discovery/files?repo=acme/team-config&branch=main",
  "team-sync/discovery/access?repo=acme/team-config&branch=main&path=secret-desk.team.yaml&mode=pull",
];

describe("team sync discovery routes", () => {
  it("agents get 404 on every route and GitHub is never called", async () => {
    const { deps, calls } = await setup();
    for (const p of PATHS) expect((await route(agent(deps, p), deps)).status, p).toBe(404);
    expect(calls).toEqual([]);
  });

  it("without the portal session (cookie and CSRF header) the routes answer 401", async () => {
    const { deps, calls } = await setup();
    for (const p of PATHS) {
      const noSession = new Request(`${base}/api/ui/${p}`, { method: "GET", headers: { host: HOST, origin: base } });
      expect((await route(noSession, deps)).status, p).toBe(401);
      const noCsrf = new Request(`${base}/api/ui/${p}`, { method: "GET", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}` } });
      expect((await route(noCsrf, deps)).status, `${p} (no CSRF)`).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it("a foreign host or origin is refused", async () => {
    const { deps } = await setup();
    const bad = new Request(`${base}/api/ui/team-sync/discovery/repos`, { method: "GET", headers: { host: "evil.example", origin: "http://evil.example", cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf } });
    expect((await route(bad, deps)).status).toBe(403);
  });

  it("the portal reads repositories, branches, files and the mode check, without a token in any answer", async () => {
    const { deps } = await setup();
    const texts: string[] = [];
    const repos = await route(ui(deps, PATHS[0]!), deps);
    texts.push(await repos.clone().text());
    expect(await repos.json()).toMatchObject({ source: "github-pat", preselected: "acme/team-config", repos: [{ fullName: "acme/team-config", selectable: true }, { fullName: "acme/site", selectable: false, reason: "public" }] });
    const branches = await route(ui(deps, PATHS[1]!), deps);
    texts.push(await branches.clone().text());
    expect(await branches.json()).toMatchObject({ branches: ["main"], defaultBranch: "main" });
    const files = await route(ui(deps, PATHS[2]!), deps);
    texts.push(await files.clone().text());
    expect(await files.json()).toMatchObject({ files: ["secret-desk.team.yaml"], preselected: "secret-desk.team.yaml", canCreate: false });
    const access = await route(ui(deps, PATHS[3]!), deps);
    texts.push(await access.clone().text());
    expect(await access.json()).toMatchObject({ mode: "pull", ok: true, neededRights: ["Contents: Read", "Metadata: Read"] });
    expect(texts.join("\n")).not.toContain(PAT);
  });

  it("without the GitHub integration the answer explains what is missing (200, no token field needed)", async () => {
    const { deps, calls } = await setup(false);
    const r = await route(ui(deps, PATHS[0]!), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ source: "none", repos: [], problem: { code: "no-integration" } });
    expect(calls).toEqual([]);
  });

  it("missing or malformed query values are a 400 before any GitHub call", async () => {
    const { deps, calls } = await setup();
    for (const p of ["team-sync/discovery/branches", "team-sync/discovery/branches?repo=../x", "team-sync/discovery/files?repo=acme/team-config", "team-sync/discovery/access?repo=acme/team-config"]) {
      expect((await route(ui(deps, p), deps)).status, p).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("English portal texts: a validation message is translated", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "team-sync/discovery/files?repo=acme/team-config&branch=a..b", { "x-secret-desk-lang": "en" }), deps);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/invalid branch name/);
  });
});
