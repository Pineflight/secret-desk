import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { createRuntime } from "@secret-desk/runtime";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const TOKEN = "tok_s3cr3tvalue99xyz";
const RECIPE = `# STATUS: nicht gegen die echte Seite geprueft
id: sample-token
label: Beispiel
host: example.test
login:
  expect: { url: "^https://example\\\\.test/tokens" }
steps:
  - goto: "https://example.test/tokens/new?name={{name}}"
  - click: { role: button, name: Create, createsToken: true }
capture:
  token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }
  externalId: { from: name }
`;
const INVENTORY = `version: 1
secrets:
  - id: sample-dev
    name: SAMPLE_DEV
    stage: dev
    service: example
    provider: sample-token-browser
    expiry: none
    places: [{ repo: acme-app, scope: repository }]
`;

async function setup(login: boolean) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = (async (url: string | URL | Request) => (String(url).endsWith("/public-key") ? new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 }) : new Response(null, { status: 204 }))) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-auto-"));
  await mkdir(join(dir, "recipes"));
  await writeFile(join(dir, "recipes", "sample.yaml"), RECIPE);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n`);
  const opened: FakeDriver[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    bundledRecipes: null,
    automationDriver: () => {
      const d = new FakeDriver({
        visible: ['button "Create"'],
        pollMs: 5,
        on: (e, drv) => {
          if (e.action === "goto") drv.url = login ? "https://example.test/login" : "https://example.test/tokens/new";
          if (e.action === "click") {
            drv.visible.add("css #tok");
            drv.texts.set("css #tok", TOKEN);
          }
        },
      });
      opened.push(d);
      return d;
    },
  });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, opened };
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
    if (Date.now() - t > 3000) throw new Error("Zeitueberschreitung im Test");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("Browser-Automatisierung ueber die Schnittstelle", () => {
  it("GET automation zeigt Chrome, Profil, Rezepte, Probleme; Agenten sehen nichts davon", async () => {
    const { deps } = await setup(false);
    const res = await route(ui(deps, "GET", "automation"), deps);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ enabled: true, loginTimeoutMinutes: 10, recipes: [{ id: "sample-token", providerId: "sample-token-browser", label: "Beispiel", status: "nicht gegen die echte Seite geprueft" }], problems: [], runs: [] });
    expect(body.recipes[0]).toMatchObject({ host: "example.test", allowHosts: [], bundled: false });
    expect(body.recipes[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.allowExternalRecipes).toBe("boolean");
    expect(typeof body.chrome.found).toBe("boolean");
    expect(typeof body.profileDir).toBe("string");
    expect((await route(agent(deps, "GET", "automation"), deps)).status).toBe(404);
    expect((await route(agent(deps, "GET", "automation/runs/sample-dev"), deps)).status).toBe(404);
    expect((await route(agent(deps, "POST", "automation/runs/sample-dev/cancel"), deps)).status).toBe(404);
  });

  it("Mensch startet ueber renewal-requests, sieht den Zustand und bricht ab; Antworten ohne Wert", async () => {
    const { deps } = await setup(true);
    const start = route(ui(deps, "POST", "renewal-requests", { secretId: "sample-dev" }), deps);
    await until(async () => (await json(await route(ui(deps, "GET", "automation/runs/sample-dev"), deps))).status === "waiting-human");
    const state = await json(await route(ui(deps, "GET", "automation/runs/sample-dev"), deps));
    expect(state).toMatchObject({ status: "waiting-human", host: "example.test" });
    const en = await json(await route(ui(deps, "GET", "automation/runs/sample-dev", undefined, { "x-secret-desk-lang": "en" }), deps));
    expect(en.text).toMatch(/Please sign in/);
    expect((await route(agent(deps, "POST", "automation/runs/sample-dev/cancel"), deps)).status).toBe(404);
    const cancelled = await route(ui(deps, "POST", "automation/runs/sample-dev/cancel"), deps);
    expect(cancelled.status).toBe(200);
    const res = await start;
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("Abgebrochen.");
    const after = JSON.stringify(await json(await route(ui(deps, "GET", "automation"), deps)));
    expect(after).toContain('"status":"cancelled"');
    expect(after).not.toContain(TOKEN);
    expect((await route(ui(deps, "POST", "automation/runs/sample-dev/cancel"), deps)).status).toBe(409);
  });

  it("Agent-Anfrage fuer einen Browser-Anbieter wird auch in dev nur eine Freigabe; der Browser oeffnet sich erst nach der Freigabe", async () => {
    const { deps, opened } = await setup(false);
    const r = await route(agent(deps, "POST", "renewal-requests", { secretId: "sample-dev" }), deps);
    const body = await json(r);
    expect(body).toMatchObject({ status: "pending-approval", secretId: "sample-dev" });
    expect(opened).toHaveLength(0);
    const approved = await route(ui(deps, "POST", `approvals/${body.approvalId}/approve`), deps);
    expect((await json(approved)).state).toBe("approved");
    expect(opened).toHaveLength(1);
    const reviews = await json(await route(ui(deps, "GET", "reviews"), deps));
    expect(reviews).toHaveLength(1);
    expect(JSON.stringify(reviews)).not.toContain(TOKEN);
  });
});
