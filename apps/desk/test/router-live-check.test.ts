import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const RECIPE = `id: sample-token
label: Sample
host: example.test
login:
  expect: { url: "^https://example\\\\.test/tokens" }
steps:
  - goto: "https://example.test/tokens/new?name={{name}}"
  - click: { role: button, name: Create, createsToken: true }
capture:
  token: { find: { css: "#tok" } }
`;

async function setup(opts: { recipe?: boolean; gate?: Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-live-check-"));
  await mkdir(join(dir, "recipes"));
  if (opts.recipe) await writeFile(join(dir, "recipes", "sample.yaml"), RECIPE);
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const drivers: FakeDriver[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: {} as unknown as NodeJS.ProcessEnv,
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    bundledRecipes: null,
    automationDriver: async () => {
      await opts.gate;
      const d = new FakeDriver({ visible: ['button "Create"'], pollMs: 2, on: (e, drv) => void (e.action === "goto" && (drv.url = "https://example.test/tokens/new")) });
      drivers.push(d);
      return d;
    },
  });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, rt, drivers };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${base}/api/ui/${path}`, { method, headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...headers } });
const agent = (deps: RouterDeps, method: string, path: string): Request => new Request(`${base}/api/agent/${path}`, { method, headers: { host: HOST, authorization: `Bearer ${deps.agentToken}` } });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe("live check via the API", () => {
  it("GET shows no report yet, the interval and that the check is overdue", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "live-check"), deps);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ reports: [], running: false, intervalDays: 7, stale: true });
  });

  it("POST starts a manual run in the background and GET then shows the stored report", async () => {
    const { deps } = await setup();
    const started = await route(ui(deps, "POST", "live-check"), deps);
    expect(started.status).toBe(200);
    expect((await json(started)).running).toBe(true);
    await expect.poll(async () => (await json(await route(ui(deps, "GET", "live-check"), deps))).running).toBe(false);
    const body = await json(await route(ui(deps, "GET", "live-check"), deps));
    expect(body.stale).toBe(false);
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({ trigger: "manual", ok: true, recipes: [] });
    expect(body.reports[0].connections.some((c: { id: string; result: string }) => c.id === "github" && c.result === "not-connected")).toBe(true);
  });

  it("POST answers 409 while a run is going or the browser is busy, and starts nothing then", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, rt, drivers } = await setup({ recipe: true, gate });
    expect((await route(ui(deps, "POST", "live-check"), deps)).status).toBe(200);
    const again = await route(ui(deps, "POST", "live-check"), deps);
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatch(/already running/);
    expect((await json(await route(ui(deps, "GET", "live-check"), deps))).running).toBe(true);
    release();
    await expect.poll(async () => (await json(await route(ui(deps, "GET", "live-check"), deps))).running).toBe(false);
    expect(drivers).toHaveLength(1);
    // The browser is taken by something else.
    rt.automation.begin("someone-else", "x", { text: "busy" });
    const busy = await route(ui(deps, "POST", "live-check"), deps);
    expect(busy.status).toBe(409);
    expect((await json(busy)).error).toMatch(/browser run is in progress/);
    expect(drivers).toHaveLength(1);
  });

  it("is for a human in the portal only: agents get 404, a missing CSRF header is refused", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "GET", "live-check"), deps)).status).toBe(404);
    expect((await route(agent(deps, "POST", "live-check"), deps)).status).toBe(404);
    const noCsrf = await route(ui(deps, "POST", "live-check", { "x-secret-desk-csrf": "wrong" }), deps);
    expect(noCsrf.status).toBe(401);
    expect((await json(await route(ui(deps, "GET", "live-check"), deps))).reports).toEqual([]);
  });
});
