import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyError, createLocalRuntime } from "@secret-desk/runtime";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const GH = "ghp_" + "ROUTERSECRET1234567890";
const INVENTORY = `version: 1
secrets:
  - id: stage-secret
    name: STAGE_SECRET
    stage: staging
    service: x
    provider: manual
    expiry: none
    places: [{ repo: acme-docs, scope: environment, environment: staging }]
  - id: prod-secret
    name: PROD_SECRET
    stage: production
    service: x
    provider: manual
    expiry: none
    places: [{ repo: acme-docs, scope: environment, environment: production }]
`;

async function setup() {
  await sodium.ready;
  const pub = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
  const calls: { url: string; method: string }[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (u === "https://api.github.com/user") return new Response(JSON.stringify({ login: "alice" }), { status: 200, headers: { "github-authentication-token-expiration": "2099-01-01 00:00:00 UTC" } });
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && /\/(secrets|variables)\?/.test(u)) return new Response(JSON.stringify({ secrets: [], variables: [] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-conn-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  rt.connections.session.set("github", GH, null);
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, calls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown, lang?: string): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(lang ? { "x-secret-desk-lang": lang } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, {
    method,
    headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe("POST connections/:id/check", () => {
  it("UI may, response contains check items and never the token", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "POST", "connections/github/check", {}), deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GH);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ id: "github", ok: true, expires: "2099-01-01" });
    expect(body.checks.map((c: { id: string }) => c.id)).toContain("login");
  });

  it("agents get 404, even with token and body", async () => {
    const { deps, calls } = await setup();
    expect((await route(agent(deps, "POST", "connections/github/check", { deep: true, targets: ["x"] }), deps)).status).toBe(404);
    expect((await route(agent(deps, "GET", "connections/github/write-targets"), deps)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("401 without cookie and CSRF", async () => {
    const { deps } = await setup();
    const req = new Request(`${base}/api/ui/connections/github/check`, { method: "POST", headers: { host: HOST, origin: base, "content-type": "application/json" }, body: "{}" });
    expect((await route(req, deps)).status).toBe(401);
  });

  it("deep only with chosen targets; without deep nothing is written", async () => {
    const { deps, calls } = await setup();
    await route(ui(deps, "POST", "connections/github/check", { targets: ["environment:acme-docs/staging"] }), deps);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    const res = await route(ui(deps, "POST", "connections/github/check", { deep: true, targets: ["environment:acme-docs/staging"] }), deps);
    expect(res.status).toBe(200);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.url.includes("/environments/staging/"))).toBe(true);
    expect(writes.some((c) => c.method === "PUT" && c.url.endsWith("/secrets/SD_WRITE_PROBE"))).toBe(true);
    expect(writes.some((c) => c.method === "DELETE" && c.url.endsWith("/secrets/SD_WRITE_PROBE"))).toBe(true);
  });

  it("unknown connection 400, English texts on request", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "connections/gibt-es-nicht/check", {}), deps)).status).toBe(400);
    deps.rt.connections.session.delete("github");
    const en = await json(await route(ui(deps, "POST", "connections/github/check", {}, "en"), deps));
    expect(en.checks[0].detail).toBe("Not connected");
  });
});

describe("GET connections/github/write-targets", () => {
  it("returns targets with live marker, UI only", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "connections/github/write-targets"), deps);
    const body = (await res.json()) as { id: string; live: boolean }[];
    expect(body).toEqual([
      expect.objectContaining({ id: "environment:acme-docs/production", live: true }),
      expect.objectContaining({ id: "environment:acme-docs/staging", live: false }),
    ]);
  });
});

describe("POST connections/:id/token: Stripe prefix", () => {
  const post = (deps: RouterDeps, id: string, token: string) => route(ui(deps, "POST", `connections/${id}/token`, { token, neverExpires: true }), deps);
  it("rejects live keys on the sandbox connection and vice versa, without showing the value", async () => {
    const { deps } = await setup();
    const a = await post(deps, "stripe-test", "rk_live_abcdefghijklmnop");
    expect(a.status).toBe(400);
    const text = await a.text();
    expect(text).toContain("rk_live_");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(deps.rt.connections.session.has("stripe-test")).toBe(false);
    expect((await post(deps, "stripe-live", "rk_test_abcdefghijklmnop")).status).toBe(400);
    expect(deps.rt.connections.session.has("stripe-live")).toBe(false);
  });
  it("accepts matching and general keys", async () => {
    const { deps } = await setup();
    expect((await post(deps, "stripe-test", "rk_test_abcdefghijklmnop")).status).toBe(200);
    expect((await post(deps, "stripe-live", "rk_live_abcdefghijklmnop")).status).toBe(200);
    expect((await post(deps, "stripe", "rk_live_abcdefghijklmnop")).status).toBe(200);
  });
  it("the connection list carries stripe-test and stripe-live with guide", async () => {
    const { deps } = await setup();
    const list = (await json(await route(ui(deps, "GET", "connections"), deps))) as unknown as { id: string; label: string; permissions: string[] }[];
    expect(list.find((c) => c.id === "stripe-test")?.label).toBe("Stripe (Sandbox)");
    expect(list.find((c) => c.id === "stripe-live")?.label).toBe("Stripe (Live)");
    expect(list.find((c) => c.id === "stripe")?.label).toBe("Stripe");
  });
});

describe("connections of a Stripe account (id with colons, sent percent-encoded)", () => {
  const ID = "stripe:acct_1AbC:sandbox";
  const enc = encodeURIComponent(ID);
  it("stores, lists under the account, rejects a wrong-mode key and removes the token and its label", async () => {
    const { deps } = await setup();
    const wrong = await route(ui(deps, "POST", `connections/${enc}/token`, { token: "rk_live_abcdefghijklmnop", neverExpires: true }), deps);
    expect(wrong.status).toBe(400);
    const ok = await route(ui(deps, "POST", `connections/${enc}/token`, { token: "rk_test_abcdefghijklmnop", neverExpires: true }), deps);
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ id: ID, connected: true });
    const list = (await json(await route(ui(deps, "GET", "connections"), deps))) as unknown as { id: string; connected: boolean; label: string }[];
    expect(list.find((c) => c.id === ID)).toMatchObject({ connected: true, label: "Stripe acct_1AbC (Sandbox)" });
    deps.rt.connections.session.set(`${ID}#label`, "Acme Studio", null);
    const del = await route(ui(deps, "DELETE", `connections/${enc}/token`), deps);
    expect(await json(del)).toMatchObject({ id: ID, connected: false });
    expect(deps.rt.connections.session.has(`${ID}#label`)).toBe(false);
  });
  it("is checked through the encoded id", async () => {
    const { deps } = await setup();
    deps.rt.connections.session.set(ID, "rk_test_abcdefghijklmnop", null);
    const res = await route(ui(deps, "POST", `connections/${enc}/check`, {}), deps);
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(ID);
  });
});

describe("authorization hook on connection tokens", () => {
  const sample = "cf_" + "madeupauthzvalue123";

  it("is asked with the connection id (never the token) before a token is stored or removed, and a refusal is a 403 that changes nothing", async () => {
    const { deps } = await setup();
    const seen: unknown[] = [];
    let refusing = true;
    deps.rt.authorize = (request) => {
      seen.push(request);
      if (refusing) throw new PolicyError("refused by test hook");
    };
    const stored = await route(ui(deps, "POST", "connections/cloudflare/token", { token: sample, neverExpires: true }), deps);
    expect(stored.status).toBe(403);
    expect(deps.rt.connections.session.has("cloudflare")).toBe(false);
    const removed = await route(ui(deps, "DELETE", "connections/github/token"), deps);
    expect(removed.status).toBe(403);
    expect(deps.rt.connections.session.has("github")).toBe(true);
    expect(seen).toEqual([
      { actor: { kind: "human", name: expect.any(String) }, action: "integration.connect", subject: { connectionId: "cloudflare" } },
      { actor: { kind: "human", name: expect.any(String) }, action: "integration.disconnect", subject: { connectionId: "github" } },
    ]);
    expect(JSON.stringify(seen)).not.toContain("madeupauthzvalue123");
    expect(JSON.stringify(seen)).not.toContain(GH);
    expect(await stored.text()).not.toContain("madeupauthzvalue123");
    // Allowing changes nothing: the token is stored and removed as before.
    refusing = false;
    expect((await route(ui(deps, "POST", "connections/cloudflare/token", { token: sample, neverExpires: true }), deps)).status).toBe(200);
    expect(deps.rt.connections.session.has("cloudflare")).toBe(true);
    expect((await route(ui(deps, "DELETE", "connections/cloudflare/token"), deps)).status).toBe(200);
    expect(deps.rt.connections.session.has("cloudflare")).toBe(false);
  });

  it("without a hook storing a token works as before", async () => {
    const { deps } = await setup();
    expect("authorize" in deps.rt).toBe(false);
    expect((await route(ui(deps, "POST", "connections/cloudflare/token", { token: sample, neverExpires: true }), deps)).status).toBe(200);
  });
});
