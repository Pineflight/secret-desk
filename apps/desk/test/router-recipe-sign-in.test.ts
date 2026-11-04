import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it, vi } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const EMAIL = "alice.typed@example.test";
const PW = "typed-value-for-this-run-only";
const CODE = "135790";
const MFA_FIELD = 'css input[autocomplete="one-time-code"]';
const HOME = "https://supabase.com/dashboard/account/tokens";

type Outcome = "ok" | "wrong" | "mfa";

/** A fake sign-in page of the Supabase recipe: email and password, a refusal text, a one-time code. */
function fakeSite(outcome: Outcome) {
  const site = { signedIn: false };
  const factory = (): FakeDriver =>
    new FakeDriver({
      pollMs: 2,
      on: (e, d) => {
        if (e.action === "goto") {
          d.url = site.signedIn ? HOME : e.key;
          if (!site.signedIn) for (const v of ['css input[type="email"]', 'css input[type="password"]', 'button "Sign In"']) d.visible.add(v);
          return;
        }
        if (e.action === "click" && e.key === 'button "Sign In"') {
          if (outcome === "ok") {
            site.signedIn = true;
            d.url = HOME;
          } else if (outcome === "wrong") d.pageText.add("Invalid login credentials");
          else {
            d.visible.add(MFA_FIELD);
            d.visible.add('css button[type="submit"]');
          }
        }
        if (e.action === "click" && e.key === 'css button[type="submit"]') {
          site.signedIn = true;
          d.visible.delete(MFA_FIELD);
          d.url = HOME;
        }
      },
    });
  return { site, factory };
}

async function setup(outcome: Outcome) {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-recipe-signin-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const { site, factory } = fakeSite(outcome);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, persistSignIn: false, automationDriver: factory });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, site };
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
const until = async (fn: () => Promise<boolean>) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > 4000) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const signIn = { username: EMAIL, password: PW };
const ID = "supabase-access-token";

function recorder(deps: RouterDeps) {
  const bodies: string[] = [];
  const call = async (req: Request): Promise<{ status: number; body: Record<string, any> }> => {
    const res = await route(req, deps);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, any> };
  };
  return { call, bodies };
}

function expectNoLeak(label: string, texts: string[]): void {
  for (const secret of [EMAIL, PW, CODE]) for (const t of texts) expect(t, `${label} leaks ${secret.slice(0, 6)}...`).not.toContain(secret);
}

describe("recipe sign-in routes: access", () => {
  it("agents get 404 on every recipe sign-in route, even with a valid agent token", async () => {
    const { deps } = await setup("ok");
    for (const [method, path, body] of [
      ["GET", `recipes/${ID}/sign-in/state`],
      ["POST", `recipes/${ID}/sign-in`, signIn],
      ["POST", `recipes/${ID}/sign-in/code`, { code: CODE }],
      ["POST", `recipes/${ID}/sign-in/confirm`, { accept: true }],
      ["POST", `recipes/${ID}/sign-in/cancel`],
    ] as [string, string, unknown?][]) {
      expect((await route(agent(deps, method, path, body), deps)).status, `${method} ${path}`).toBe(404);
    }
    expect(deps.rt.automation.state(`recipe-signin:${ID}`).status).toBe("idle");
    expect(deps.rt.automation.isBusy()).toBe(false);
  });

  it("the portal needs the session cookie and the CSRF header", async () => {
    const { deps } = await setup("ok");
    const noCsrf = new Request(`${base}/api/ui/recipes/${ID}/sign-in`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "content-type": "application/json" }, body: JSON.stringify(signIn) });
    expect((await route(noCsrf, deps)).status).toBe(401);
    const foreign = new Request(`${base}/api/ui/recipes/${ID}/sign-in`, { method: "POST", headers: { host: HOST, origin: "http://evil.example", cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, "content-type": "application/json" }, body: JSON.stringify(signIn) });
    expect((await route(foreign, deps)).status).toBe(403);
    expect(deps.rt.automation.isBusy()).toBe(false);
  });
});

describe("recipe sign-in routes: flow", () => {
  it("signs in, remembers the sign-in, and no response or log carries a typed value", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const { deps } = await setup("ok");
    const { call, bodies } = recorder(deps);
    const start = await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn }));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ status: "running", kind: "signin" });
    await until(async () => ["done", "failed"].includes((await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["status"]));
    expect((await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body).toMatchObject({ status: "done", text: "Signed in.", phase: "signed-in" });
    const info = await call(ui(deps, "GET", "automation"));
    expect(info.body["signInChecks"]).toMatchObject([{ host: "supabase.com", signedIn: true, source: "connect" }]);
    expect(info.body["recipes"].find((r: { id: string }) => r.id === ID)).toMatchObject({ signInMethods: [{ id: "email" }, { id: "github" }], signInPasswordless: false });
    expectNoLeak("responses", bodies);
    expectNoLeak("logs", spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))));
    spies.forEach((s) => s.mockRestore());
  });

  it("takes the one-time code through its own route and cancels", async () => {
    const { deps } = await setup("mfa");
    const { call, bodies } = recorder(deps);
    await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn }));
    await until(async () => (await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["needs"] === "mfa-code");
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in/code`, { code: "1" }))).status).toBe(400);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in/code`, { code: CODE }))).status).toBe(200);
    await until(async () => (await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["status"] === "done");
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in/code`, { code: CODE }))).status).toBe(409);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in/cancel`))).status).toBe(409);
    expectNoLeak("responses", bodies);
  });

  it("shows a refused sign-in in both languages and keeps the values out", async () => {
    const { deps } = await setup("wrong");
    const { call, bodies } = recorder(deps);
    await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn }));
    await until(async () => (await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["status"] === "failed");
    expect((await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["failure"]).toEqual({ code: "rejected", message: "Supabase hat E-Mail oder Passwort abgelehnt.", messageEn: "Supabase rejected the email or password." });
    expectNoLeak("responses", bodies);
  });

  it("answers 409 while the browser is busy and cancels a waiting sign-in", async () => {
    const { deps } = await setup("mfa");
    const { call } = recorder(deps);
    await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn }));
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn }))).status).toBe(409);
    expect((await call(ui(deps, "POST", `recipes/github-fine-grained-token/sign-in`, { ...signIn }))).status).toBe(409);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in/cancel`))).status).toBe(200);
    await until(async () => (await call(ui(deps, "GET", `recipes/${ID}/sign-in/state`))).body["status"] === "cancelled");
  });

  it("answers bad input with 400 and without echoing it", async () => {
    const { deps } = await setup("ok");
    const { call, bodies } = recorder(deps);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { password: PW }))).status).toBe(400);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { username: EMAIL }))).status).toBe(400);
    expect((await call(ui(deps, "POST", `recipes/${ID}/sign-in`, { ...signIn, method: "apple" }))).status).toBe(400);
    expect((await call(ui(deps, "POST", "recipes/nope/sign-in", signIn))).status).toBe(400);
    expect((await call(ui(deps, "POST", "recipes/openai-api-key/sign-in", signIn))).status).toBe(400);
    expect((await call(ui(deps, "POST", "recipes/peecho-api-keys/sign-in", signIn))).status).toBe(400);
    expect((await call(ui(deps, "POST", "recipes/peecho-api-keys/sign-in", { ...signIn, host: "evil.example.com" }))).status).toBe(400);
    expectNoLeak("responses", bodies);
    expect(deps.rt.automation.isBusy()).toBe(false);
  });
});
