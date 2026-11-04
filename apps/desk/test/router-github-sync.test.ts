import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretVault } from "@secret-desk/core";
import { createRuntime, secretValueEntry } from "@secret-desk/runtime";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const VALUE = "made-up-stored-secret-4417";
const INVENTORY = `version: 1
variables:
  - { id: site-url, name: SITE_URL, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: region, name: REGION, stage: production, value: "eu", places: [{ repo: acme-web, scope: environment, environment: production }] }
secrets:
  - { id: api-key, name: API_KEY, stage: production, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-web, scope: environment, environment: production }] }
  - { id: no-value, name: NO_VALUE, stage: staging, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-web, scope: environment, environment: staging }] }
`;

async function setup(opts: { failVariable?: string } = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const writes: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (method === "GET") {
      if (u.includes("/variables")) return new Response(JSON.stringify({ variables: [] }), { status: 200 });
      return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
    }
    writes.push(`${method} ${u}`);
    if (opts.failVariable && u.includes(`/variables/${opts.failVariable}`)) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
    if (method === "PATCH") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(null, { status: method === "POST" || method === "PUT" ? 201 : 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-sync-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n`);
  const key = randomBytes(32);
  const fixed = new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => key } });
  await fixed.set(secretValueEntry("api-key"), VALUE);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: fixed, env: { GH_TEST: "ghp_made_up_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, dir, writes, fixed };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
interface PlanBody { lines: { key: string; entryId: string; action: string; reason: string; production: boolean }[]; counts: Record<string, number>; hasProduction: boolean }
const planOf = async (deps: RouterDeps): Promise<PlanBody> => (await route(ui(deps, "POST", "compare/sync-plan", {}), deps)).json() as Promise<PlanBody>;
const keyOf = (p: PlanBody, id: string): string => p.lines.find((l) => l.entryId === id)!.key;

describe("POST compare/sync-plan", () => {
  it("humans and agents may read the plan; it has no value", async () => {
    const { deps } = await setup();
    const human = await route(ui(deps, "POST", "compare/sync-plan", {}), deps);
    expect(human.status).toBe(200);
    const text = JSON.stringify(await human.json());
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain("ghp_made_up_token_1");
    expect(text).not.toContain("staging.example.com");
    const ag = await route(agent(deps, "POST", "compare/sync-plan", {}), deps);
    expect(ag.status).toBe(200);
    const p = (await ag.json()) as PlanBody;
    expect(p.counts).toMatchObject({ set: 2, write: 1, skip: 1 });
    expect(p.lines.find((l) => l.entryId === "no-value")).toMatchObject({ action: "skip", reason: "no-value" });
  });
  it("does not list the stored value as a connection", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "connections"), deps);
    expect(JSON.stringify(await res.json())).not.toContain("api-key#value");
  });
});

describe("POST compare/sync", () => {
  it("agents get 404: running is humans only", async () => {
    const { deps, writes } = await setup();
    const p = await planOf(deps);
    const res = await route(agent(deps, "POST", "compare/sync", { keys: [keyOf(p, "site-url")] }), deps);
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });
  it("needs the CSRF token", async () => {
    const { deps, writes } = await setup();
    const p = await planOf(deps);
    const req = new Request(`${base}/api/ui/compare/sync`, { method: "POST", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "content-type": "application/json" }, body: JSON.stringify({ keys: [keyOf(p, "site-url")] }) });
    expect((await route(req, deps)).status).toBe(401);
    expect(writes).toEqual([]);
  });
  it("refuses production places without the confirmation (409) and writes nothing", async () => {
    const { deps, writes } = await setup();
    const p = await planOf(deps);
    const res = await route(ui(deps, "POST", "compare/sync", { keys: [keyOf(p, "region"), keyOf(p, "api-key")] }), deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "production-confirmation" });
    expect(writes).toEqual([]);
  });
  it("writes the selection with the confirmation: variable and the stored secret, never the value in the answer", async () => {
    const { deps, writes } = await setup();
    const p = await planOf(deps);
    const res = await route(ui(deps, "POST", "compare/sync", { keys: [keyOf(p, "site-url"), keyOf(p, "region"), keyOf(p, "api-key")], confirmProduction: true }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: number; failed: number; outcomes: { outcome: string }[] };
    expect(body).toMatchObject({ ok: 3, failed: 0 });
    expect(writes.some((w) => w.includes("/staging/variables"))).toBe(true);
    expect(writes.some((w) => w.startsWith("PUT") && w.includes("/production/secrets/API_KEY"))).toBe(true);
    expect(writes.some((w) => w.startsWith("DELETE"))).toBe(false);
    expect(JSON.stringify(body)).not.toContain(VALUE);
  });
  it("reports a partial failure per line", async () => {
    const { deps } = await setup({ failVariable: "SITE_URL" });
    const p = await planOf(deps);
    const res = await route(ui(deps, "POST", "compare/sync", { keys: [keyOf(p, "site-url")] }), deps);
    const body = (await res.json()) as { ok: number; failed: number; outcomes: { outcome: string; error?: string }[] };
    expect(body.failed).toBe(1);
    expect(body.outcomes[0]!.error).toContain("Validation Failed");
  });
  it("refuses a key that is not in the plan and an empty selection (400)", async () => {
    const { deps, writes } = await setup();
    expect((await route(ui(deps, "POST", "compare/sync", { keys: ["variable:x:y:repository::"] }), deps)).status).toBe(400);
    expect((await route(ui(deps, "POST", "compare/sync", { keys: [] }), deps)).status).toBe(400);
    expect(writes).toEqual([]);
  });
  it("leaves the inventory file untouched", async () => {
    const { deps, dir } = await setup();
    const p = await planOf(deps);
    await route(ui(deps, "POST", "compare/sync", { keys: [keyOf(p, "site-url")] }), deps);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe(INVENTORY);
  });
});
