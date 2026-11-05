import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const NEW_TOKEN = "github_" + "pat_made_up_router_team_token";
const FIELD = 'Feld "Token name"';
const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;

async function setup() {
  const calls: string[] = [];
  const drivers: FakeDriver[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/repos/acme-org/team-config") return j({ private: true, default_branch: "main", permissions: { push: true } });
    if (u.pathname.includes("/git/ref/heads/")) return j({ object: { sha: "head1" } });
    if (u.pathname.includes("/git/trees/")) return j({ tree: [] });
    return j({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-tt-router-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme-org\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "gh_main_made_up" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => {
      const d: FakeDriver = new FakeDriver({
        pollMs: 2,
        visible: [FIELD, 'radio "Only select repositories"', "css #repository-menu-list-button", 'button "Generate token"'],
        on: (e, drv) => {
          if (e.action === "goto") drv.url = e.key;
          if (e.action === "click" && e.key === "css #repository-menu-list-button") drv.visible.add('css [role=option]:has(.ActionListItem-label:text-is("acme-org/team-config"))');
          if (e.action === "click" && e.key === 'button "Generate token"') { drv.visible.add("css #fgpat-confirmation-dialog"); drv.visible.add("css #fgpat-confirmation-dialog button[type=submit]"); }
          if (e.action === "click" && e.key === "css #fgpat-confirmation-dialog button[type=submit]") {
            drv.visible.add("css #new-access-token");
            drv.visible.add(`css #new-access-token, #new-oauth-token, clipboard-copy[value^="github_pat_"], input[value^="github_pat_"]`);
            drv.texts.set("css #new-access-token", NEW_TOKEN);
          }
        },
      });
      drivers.push(d);
      return d;
    },
  });
  const deps: RouterDeps = { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, calls, drivers };
}

const ui = (deps: RouterDeps, method: string, path: string, body?: unknown, csrf: string | null = deps.session.csrf): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, ...(csrf ? { "x-secret-desk-csrf": csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const until = async (fn: () => Promise<boolean>, ms = 4000) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("team token routes", () => {
  it("agents get 404 on every route and nothing is opened or sent", async () => {
    const { deps, calls, drivers } = await setup();
    const attempts: [string, string, unknown][] = [
      ["GET", "team-sync/token", undefined],
      ["POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull" }],
      ["POST", "team-sync/token/cancel", {}],
      ["POST", "team-sync/token/check", {}],
      ["POST", "team-sync/token/revocation-done", {}],
    ];
    for (const [m, p, b] of attempts) expect((await route(agent(deps, m, p, b), deps)).status, `${m} ${p}`).toBe(404);
    expect(drivers).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("a request without the CSRF header or the session cookie is refused", async () => {
    const { deps, drivers } = await setup();
    const noCsrf = await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull" }, null), deps);
    expect(noCsrf.status).toBe(401);
    const wrong = await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull" }, "not-the-csrf-value"), deps);
    expect(wrong.status).toBe(401);
    const noCookie = await route(new Request(`${base}/api/ui/team-sync/token`, { method: "POST", headers: { host: HOST, origin: base, "content-type": "application/json", "x-secret-desk-csrf": deps.session.csrf }, body: JSON.stringify({ repo: "acme-org/team-config", mode: "pull" }) }), deps);
    expect(noCookie.status).toBe(401);
    expect(drivers).toHaveLength(0);
  });

  it("a human starts the run, follows it and finds the team token without any value in the answers", async () => {
    const { deps } = await setup();
    const started = await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull", branch: "main" }), deps);
    expect(started.status).toBe(200);
    const startedText = await started.text();
    expect(JSON.parse(startedText)).toMatchObject({ status: "running", kind: "connect" });
    await until(async () => ((await (await route(ui(deps, "GET", "team-sync/token"), deps)).json()) as { run: { status: string } }).run.status === "done");
    const infoText = await (await route(ui(deps, "GET", "team-sync/token"), deps)).text();
    const info = JSON.parse(infoText) as { active: { repo: string; valid: boolean; mode: string }; available: boolean };
    expect(info).toMatchObject({ available: true, active: { repo: "acme-org/team-config", mode: "pull", valid: true } });
    const connections = await (await route(ui(deps, "GET", "connections"), deps)).text();
    expect([startedText, infoText, connections].join("\n")).not.toContain(NEW_TOKEN);
  });

  it("a bad request is a 400 and a second run while one goes is a 409", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "team-sync/token", { repo: "nope", mode: "pull" }), deps)).status).toBe(400);
    expect((await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull", branch: "main" }), deps)).status).toBe(200);
    expect((await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull", branch: "main" }), deps)).status).toBe(409);
  });

  it("typing a token for team-sync retires the portal's token and lists it for deletion", async () => {
    const { deps } = await setup();
    await route(ui(deps, "POST", "team-sync/token", { repo: "acme-org/team-config", mode: "pull", branch: "main" }), deps);
    await until(async () => ((await (await route(ui(deps, "GET", "team-sync/token"), deps)).json()) as { run: { status: string } }).run.status === "done");
    const typed = await route(ui(deps, "POST", "connections/team-sync/token", { token: "typed_made_up_team_token", neverExpires: true }), deps);
    expect(typed.status).toBe(200);
    const info = (await (await route(ui(deps, "GET", "team-sync/token"), deps)).json()) as { active: unknown; pendingRevocation: { repo: string; url: string } | null };
    expect(info.active).toBeNull();
    expect(info.pendingRevocation).toMatchObject({ repo: "acme-org/team-config", url: "https://github.com/settings/personal-access-tokens" });
    const done = (await (await route(ui(deps, "POST", "team-sync/token/revocation-done", {}), deps)).json()) as { pendingRevocation: unknown };
    expect(done.pendingRevocation).toBeNull();
  });
});
