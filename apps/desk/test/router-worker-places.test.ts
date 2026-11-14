import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
// Assembled at run time so the repository secret scan does not match the made-up value.
const CF_TOKEN = ["CF", "CONNECTION", "TOKEN", "0001"].join("-");

async function setup() {
  const urls: string[] = [];
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/workers/scripts") && !u.includes("/secrets")) return json({ result: [{ id: "acme-portal" }, { id: "acme-portal-staging" }] });
    if (u.includes("/accounts?")) return json({ result: [{ id: ACCOUNT, name: "Acme Org" }] });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-worker-places-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  rt.connections.session.set("cloudflare", CF_TOKEN);
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, dir, urls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const call = async (deps: RouterDeps, req: Request) => {
  const res = await route(req, deps);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
};

const workerPlace = { scope: "cloudflare-worker", accountId: ACCOUNT, script: "acme-portal-staging" };
const secret = (extra: Record<string, unknown> = {}) => ({ id: "anthropic-portal-staging", name: "ANTHROPIC_API_KEY", service: "anthropic", stage: "staging", provider: "manual", expiry: "none", places: [workerPlace], ...extra });

describe("Worker secret places through the portal API", () => {
  it("creates a secret with a Worker place and lists it back", async () => {
    const { deps, dir } = await setup();
    const created = await call(deps, ui(deps, "POST", "secrets", secret()));
    expect(created.status).toBe(200);
    expect(created.json.places).toEqual([workerPlace]);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("cloudflare-worker");
    const list = await call(deps, ui(deps, "GET", "secrets"));
    expect(list.json[0].places).toEqual([workerPlace]);
    expect(created.text).not.toContain(CF_TOKEN);
  });

  it("refuses a malformed account id or Worker name", async () => {
    const { deps } = await setup();
    expect((await call(deps, ui(deps, "POST", "secrets", secret({ places: [{ ...workerPlace, accountId: "acc1" }] })))).status).toBe(400);
    expect((await call(deps, ui(deps, "POST", "secrets", secret({ places: [{ ...workerPlace, script: "../x" }] })))).status).toBe(400);
  });

  it("refuses a Worker place on a variable", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "POST", "variables", { id: "v1", name: "PUBLIC_URL", stage: "staging", value: "https://x.example.com", places: [workerPlace] }));
    expect(r.status).toBe(400);
    // The same variable with a GitHub place is fine, so the refusal is about the place.
    const ok = await call(deps, ui(deps, "POST", "variables", { id: "v1", name: "PUBLIC_URL", stage: "staging", value: "https://x.example.com", places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] }));
    expect(ok.status).toBe(200);
  });

  it("the editor discovers the account and the Workers through the cloudflare connection", async () => {
    const { deps, urls } = await setup();
    await call(deps, ui(deps, "PUT", "connections/cloudflare/defaults", { values: { accountId: ACCOUNT } }));
    const accounts = await call(deps, ui(deps, "GET", "connections/cloudflare/resources?kind=cloudflare.account"));
    expect(accounts.json.defaults).toEqual({ accountId: ACCOUNT });
    expect(accounts.json.resources["cloudflare.account"].options[0].value).toBe(ACCOUNT);
    const scripts = await call(deps, ui(deps, "GET", `connections/cloudflare/resources?kind=cloudflare.workerScript&param.accountId=${ACCOUNT}`));
    expect(scripts.json.resources["cloudflare.workerScript"]).toMatchObject({ status: "ok" });
    expect(scripts.json.resources["cloudflare.workerScript"].options.map((o: { value: string }) => o.value)).toEqual(["acme-portal", "acme-portal-staging"]);
    expect(urls.some((u) => u.includes(`/accounts/${ACCOUNT}/workers/scripts`))).toBe(true);
    expect(scripts.text).not.toContain(CF_TOKEN);
  });

  it("the Worker list needs the account: without one the status asks for it", async () => {
    const { deps } = await setup();
    const r = await call(deps, ui(deps, "GET", "connections/cloudflare/resources?kind=cloudflare.workerScript"));
    expect(r.json.resources["cloudflare.workerScript"].status).toBe("needs-params");
  });
});
