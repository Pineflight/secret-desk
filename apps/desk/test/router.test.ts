import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
variables:
  - id: site-url
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: acme-web, scope: environment, environment: staging }
envTemplates:
  - id: ws-dev
    repo: acme-web
    stage: dev
    entries:
      - { key: SITE_URL, from: { type: variable, variable: site-url } }
`;

async function setup() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ secrets: [{ name: "ARTIFACT_HMAC_SECRET", created_at: "c", updated_at: new Date().toISOString() }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(dir)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, dir };
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

describe("Zugriffsschutz", () => {
  it("lehnt fremde Hosts ab (DNS-Rebinding)", async () => {
    const { deps } = await setup();
    const r = await route(new Request(`${base}/api/ui/overview`, { headers: { host: "evil.example.com" } }), deps);
    expect(r.status).toBe(403);
  });
  it("Portal braucht Cookie und CSRF-Token, Aenderungen zusaetzlich einen eigenen Ursprung", async () => {
    const { deps } = await setup();
    expect((await route(new Request(`${base}/api/ui/overview`, { headers: { host: HOST } }), deps)).status).toBe(401);
    expect((await route(new Request(`${base}/api/ui/overview`, { headers: { host: HOST, cookie: `sd_session=${deps.session.cookie}` } }), deps)).status).toBe(401);
    expect((await route(ui(deps, "GET", "overview"), deps)).status).toBe(200);
    const foreign = ui(deps, "POST", "renewal-requests", { secretId: "hmac-acme-app", dryRun: true }, { origin: "https://evil.example.com" });
    expect((await route(foreign, deps)).status).toBe(403);
  });
  it("Agenten brauchen den Token und koennen weder bestaetigen noch Verbindungen setzen", async () => {
    const { deps } = await setup();
    expect((await route(new Request(`${base}/api/agent/overview`, { headers: { host: HOST } }), deps)).status).toBe(401);
    expect((await route(agent(deps, "GET", "overview"), deps)).status).toBe(200);
    expect((await route(agent(deps, "POST", "reviews/x/confirm", { ticks: [] }), deps)).status).toBe(404);
    expect((await route(agent(deps, "POST", "connections/github/token", { token: "x" }), deps)).status).toBe(404);
    expect((await route(agent(deps, "GET", "evidence/hmac-acme-app/abc/svg"), deps)).status).toBe(404);
  });
});

describe("Ablauf ueber die Schnittstelle", () => {
  it("neuer Wert: Pruefung, Beleg-Bild, Bestaetigung, danach geschrieben", async () => {
    const { deps } = await setup();
    const started = (await (await route(ui(deps, "POST", "renewal-requests", { secretId: "hmac-acme-app" }), deps)).json()) as { status: string; issuance: { id: string; report: { checklist: { id: string }[] } } };
    expect(started.status).toBe("awaiting-review");
    expect(JSON.stringify(started)).not.toMatch(/[0-9a-f]{64}/);
    const id = started.issuance.id;
    const ticks = started.issuance.report.checklist.map((c) => c.id);
    expect(await (await route(ui(deps, "GET", "reviews"), deps)).json()).toHaveLength(1);
    const confirm = await route(ui(deps, "POST", `reviews/${id}/confirm`, { ticks, note: "ok" }), deps);
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { ok: boolean }).ok).toBe(true);
    const evidence = (await (await route(ui(deps, "GET", "evidence/hmac-acme-app"), deps)).json()) as { id: string }[];
    const svg = await route(ui(deps, "GET", `evidence/hmac-acme-app/${evidence[0]!.id}/svg`), deps);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    const imgOnly = new Request(`${base}/api/ui/evidence/hmac-acme-app/${evidence[0]!.id}/svg`, { headers: { host: HOST, cookie: `sd_session=${deps.session.cookie}` } });
    expect((await route(imgOnly, deps)).status).toBe(200);
    const noCookie = new Request(`${base}/api/ui/evidence/hmac-acme-app/${evidence[0]!.id}/svg`, { headers: { host: HOST } });
    expect((await route(noCookie, deps)).status).toBe(401);
    const jsonNeedsCsrf = new Request(`${base}/api/ui/evidence/hmac-acme-app/${evidence[0]!.id}`, { headers: { host: HOST, cookie: `sd_session=${deps.session.cookie}` } });
    expect((await route(jsonNeedsCsrf, deps)).status).toBe(401);
    expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await svg.text()).toContain("<svg");
  });
  it("Verbindungs-Token werden gesetzt, aber nie ausgegeben", async () => {
    const { deps } = await setup();
    const noDate = await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_sitzungs_token_geheim" }), deps);
    expect(noDate.status).toBe(400);
    const past = await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_sitzungs_token_geheim", expires: "2020-01-01" }), deps);
    expect(past.status).toBe(400);
    const set = await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_sitzungs_token_geheim", expires: "2999-01-01" }), deps);
    expect(await set.json()).toMatchObject({ id: "cloudflare", connected: true, source: "session", expires: "2999-01-01" });
    const never = await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_sitzungs_token_geheim", neverExpires: true }), deps);
    expect(await never.json()).toMatchObject({ connected: true, expires: null });
    const all = JSON.stringify(await (await route(ui(deps, "GET", "connections"), deps)).json());
    expect(all).not.toContain("cf_sitzungs_token_geheim");
    expect(all).not.toContain("ghp_geheim_token_1");
  });
  it("Variablen: Soll aendern, Geheimnisse werden abgelehnt, Env-Vorlage nutzt den Sollwert", async () => {
    const { deps, dir } = await setup();
    const bad = await route(ui(deps, "PATCH", "variables/site-url", { value: "sk_live_" + "a".repeat(24) }), deps);
    expect(bad.status).toBe(400);
    const ok = await route(ui(deps, "PATCH", "variables/site-url", { value: "https://neu.example.com" }), deps);
    expect(ok.status).toBe(200);
    const env = await route(ui(deps, "POST", "env-export", { repo: "acme-web", path: join(dir, "a", ".env.local") }), deps);
    expect(((await env.json()) as { status: string }).status).toBe("written");
  });
  it("Agent: Variable setzen in staging erzeugt eine Freigabe, Mensch gibt frei", async () => {
    const { deps } = await setup();
    const r = (await (await route(agent(deps, "POST", "variables/site-url/apply", {}), deps)).json()) as { status: string; approvalId: string };
    expect(r.status).toBe("pending-approval");
    const done = (await (await route(ui(deps, "POST", `approvals/${r.approvalId}/approve`), deps)).json()) as { state: string };
    expect(done.state).toBe("approved");
  });
  it("Fehler werden ohne Interna gemeldet", async () => {
    const { deps } = await setup();
    const r = await route(agent(deps, "POST", "env-export", { repo: "acme-web", stage: "staging", path: "/tmp/x" }), deps);
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toMatch(/at .*\.ts/);
  });
});

describe("Sprache der Servermeldungen", () => {
  it("ohne Header deutsch, mit x-secret-desk-lang: en englisch", async () => {
    const { deps } = await setup();
    const de = await route(ui(deps, "POST", "renewal-requests", {}), deps);
    expect(de.status).toBe(400);
    expect(await de.json()).toEqual({ error: "Feld fehlt: secretId" });
    const en = await route(ui(deps, "POST", "renewal-requests", {}, { "x-secret-desk-lang": "en" }), deps);
    expect(en.status).toBe(400);
    expect(await en.json()).toEqual({ error: "Field missing: secretId" });
    const bogus = await route(ui(deps, "POST", "renewal-requests", {}, { "x-secret-desk-lang": "fr" }), deps);
    expect(await bogus.json()).toEqual({ error: "Feld fehlt: secretId" });
  });
  it("uebersetzt auch frueh abgewiesene Anfragen und Erfolgsantworten", async () => {
    const { deps } = await setup();
    const r = await route(new Request(`${base}/api/ui/overview`, { headers: { host: HOST, "x-secret-desk-lang": "en" } }), deps);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "Portal session invalid. Reload the page." });
  });
});
