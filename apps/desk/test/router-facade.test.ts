import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it, vi } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const EMAIL = "niklas.typed@example.test";
const SIGN_IN_PW = "typed-value-for-this-run-only";
const CODE = "135790";
const KEY = "sk_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
const PROJECT = "proj1a2b3c";
const HOME = `https://app.revenuecat.com/projects/${PROJECT}/overview`;
const MFA_FIELD = 'css input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]';

type Outcome = "ok" | "wrong" | "mfa";

/** A fake RevenueCat reduced to what the flow touches. */
function fakeSite(outcome: Outcome) {
  const site = { signedIn: false, key: "" };
  const factory = (): FakeDriver =>
    new FakeDriver({
      pollMs: 2,
      visible: ['button "Log in"'],
      on: (e, d) => {
        if (e.action === "goto") {
          d.url = e.key;
          if (e.key.endsWith("/login") && !site.signedIn) d.visible.add('css input[name="email"]');
          if (e.key.endsWith("/login") && site.signedIn) d.url = HOME;
          if (e.key.includes("/api-keys/new")) {
            if (!site.signedIn) d.url = "https://app.revenuecat.com/login";
            else for (const v of ['css input[name="label"]', "css main [role=combobox] >> nth=0", 'option "V2"', 'button "Generate"', ...["No access", "Read only", "Read & write"].map((o) => `option "${o}"`), ...["Project configuration", "Customer information", "Charts metrics", "Audiences", "Iam"].map((s) => `combobox "${s} permissions"`)]) d.visible.add(v);
          }
          return;
        }
        if (e.action === "click" && e.key === 'button "Log in"') {
          d.visible.add('css input[type="password"]');
          d.visible.add('css button[type="submit"]');
        }
        if (e.action === "click" && e.key === 'css button[type="submit"]') {
          if (d.visible.has(MFA_FIELD)) {
            d.visible.delete(MFA_FIELD);
            site.signedIn = true;
            d.url = HOME;
          } else if (outcome === "ok") {
            site.signedIn = true;
            d.url = HOME;
          } else if (outcome === "wrong") d.pageText.add("Invalid email or password");
          else d.visible.add(MFA_FIELD);
        }
        if (e.action === "click" && e.key === 'button "Generate"') {
          site.key = d.filled.get('css input[name="label"]') ?? "";
          d.url = `https://app.revenuecat.com/projects/${PROJECT}/api-keys`;
          d.visible.add(`css [role=row]:has-text("${site.key}") button[aria-label="Show key"]`);
        }
        if (e.action === "click" && e.key.endsWith('button[aria-label="Show key"]')) {
          const display = `css [role=row]:has-text("${site.key}") [data-testid=api-key-display]`;
          d.visible.add(display);
          d.texts.set(display, KEY);
        }
      },
    });
  return { site, factory };
}

async function setup(outcome: Outcome) {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-facade-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.includes("/apps")) return json({ items: [{ id: "a1", name: "iOS", type: "app_store" }] });
    if (u.includes("/v2/projects")) return json({ items: [{ id: PROJECT, name: "Main" }] });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const { site, factory } = fakeSite(outcome);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock, automationDriver: factory });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, site };
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
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const until = async (fn: () => Promise<boolean>) => {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > 4000) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const signIn = { username: EMAIL, password: SIGN_IN_PW };

/** Collects every response body so the leak check covers all of them. */
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
  for (const secret of [EMAIL, SIGN_IN_PW, CODE, KEY]) for (const t of texts) expect(t, `${label} leaks ${secret.slice(0, 6)}...`).not.toContain(secret);
}

describe("facade routes: access", () => {
  it("agents get 404 on every facade route, even with a valid agent token", async () => {
    const { deps } = await setup("ok");
    for (const [method, path, body] of [
      ["GET", "facades"],
      ["GET", "facades/revenuecat/state"],
      ["POST", "facades/revenuecat/sign-in", signIn],
      ["POST", "facades/revenuecat/code", { code: CODE }],
      ["POST", "facades/revenuecat/connect", {}],
      ["POST", "facades/revenuecat/cancel"],
      ["POST", "facades/revenuecat/check"],
    ] as [string, string, unknown?][]) {
      const res = await route(agent(deps, method, path, body), deps);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Nothing was started by those calls.
    expect(deps.rt.automation.state("facade:revenuecat").status).toBe("idle");
  });

  it("the portal needs the session cookie and the CSRF header", async () => {
    const { deps } = await setup("ok");
    const noCsrf = new Request(`${base}/api/ui/facades/revenuecat/sign-in`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "content-type": "application/json" }, body: JSON.stringify(signIn) });
    expect((await route(noCsrf, deps)).status).toBe(401);
    const foreign = new Request(`${base}/api/ui/facades/revenuecat/sign-in`, { method: "POST", headers: { host: HOST, origin: "http://evil.example", cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, "content-type": "application/json" }, body: JSON.stringify(signIn) });
    expect((await route(foreign, deps)).status).toBe(403);
    expect(deps.rt.automation.state("facade:revenuecat").status).toBe("idle");
  });
});

describe("facade routes: flow", () => {
  it("lists the provider, signs in, connects, and no response or log carries a typed value or the key", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const { deps } = await setup("ok");
    const { call, bodies } = recorder(deps);
    const list = await call(ui(deps, "GET", "facades"));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject([{ id: "revenuecat", available: true, connected: false }, { id: "stripe", available: true, connected: false }]);
    const start = await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }));
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ status: "running", kind: "signin" });
    await until(async () => ["done", "failed"].includes((await call(ui(deps, "GET", "facades/revenuecat/state"))).body["status"]));
    const end = await call(ui(deps, "GET", "facades/revenuecat/state", undefined, { "x-secret-desk-lang": "en" }));
    expect(end.body).toMatchObject({ status: "done", phase: "connected", result: { connected: true, counts: { projects: 1, apps: 1 } } });
    expect((await call(ui(deps, "GET", "facades"))).body).toMatchObject([{ connected: true }, { connected: false }]);
    expectNoLeak("responses", bodies);
    expectNoLeak("logs", spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))));
    spies.forEach((s) => s.mockRestore());
  });

  it("takes the one-time code through its own route", async () => {
    const { deps } = await setup("mfa");
    const { call, bodies } = recorder(deps);
    await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }));
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["needs"] === "mfa-code");
    expect((await call(ui(deps, "POST", "facades/revenuecat/code", { code: "1" }))).status).toBe(400);
    const sent = await call(ui(deps, "POST", "facades/revenuecat/code", { code: CODE }));
    expect(sent.status).toBe(200);
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["status"] === "done");
    expect((await call(ui(deps, "POST", "facades/revenuecat/code", { code: CODE }))).status).toBe(409);
    expectNoLeak("responses", bodies);
  });

  it("shows a refused sign-in in both languages and keeps the values out", async () => {
    const { deps } = await setup("wrong");
    const { call, bodies } = recorder(deps);
    await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }));
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["status"] === "failed");
    const state = await call(ui(deps, "GET", "facades/revenuecat/state"));
    expect(state.body["failure"]).toEqual({ code: "rejected", message: "RevenueCat hat E-Mail oder Passwort abgelehnt.", messageEn: "RevenueCat rejected the email or password." });
    expectNoLeak("responses", bodies);
  });

  it("cancels a running sign-in and checks the browser session", async () => {
    const { deps } = await setup("mfa");
    const { call } = recorder(deps);
    await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }));
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["needs"] === "mfa-code");
    expect((await call(ui(deps, "POST", "facades/revenuecat/cancel"))).status).toBe(200);
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["status"] === "cancelled");
    expect((await call(ui(deps, "POST", "facades/revenuecat/cancel"))).status).toBe(409);
  });

  it("answers bad input with 400 and without echoing it", async () => {
    const { deps } = await setup("ok");
    const { call, bodies } = recorder(deps);
    expect((await call(ui(deps, "POST", "facades/revenuecat/sign-in", { password: SIGN_IN_PW }))).status).toBe(400);
    expect((await call(ui(deps, "POST", "facades/revenuecat/sign-in", { username: EMAIL }))).status).toBe(400);
    expect((await call(ui(deps, "POST", "facades/nope/sign-in", signIn))).status).toBe(400);
    expectNoLeak("responses", bodies);
    expect(deps.rt.automation.state("facade:revenuecat").status).toBe("idle");
  });

  it("answers 409 while another sign-in runs", async () => {
    const { deps } = await setup("mfa");
    const { call } = recorder(deps);
    await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }));
    expect((await call(ui(deps, "POST", "facades/revenuecat/sign-in", { ...signIn }))).status).toBe(409);
    await call(ui(deps, "POST", "facades/revenuecat/cancel"));
    await until(async () => (await call(ui(deps, "GET", "facades/revenuecat/state"))).body["status"] === "cancelled");
  });
});
