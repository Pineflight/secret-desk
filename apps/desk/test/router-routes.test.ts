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
  - id: manual-one
    name: MANUAL_ONE_TOKEN
    stage: dev
    service: intern
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: repository }
variables:
  - id: proj-id
    name: ACME_PROJECT_ID
    stage: dev
    places:
      - { repo: acme-app, scope: repository }
  - id: site-url
    name: NEXT_PUBLIC_SITE_URL
    stage: dev
    value: "https://dev.example.com"
    places:
      - { repo: acme-web, scope: repository }
`;

async function setup() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (method === "GET" && u.includes("/variables")) return new Response(JSON.stringify({ variables: [{ name: "ACME_PROJECT_ID", value: "proj_live_1", created_at: "c", updated_at: "u" }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-routes-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nevidenceDir: ./evidence\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(dir)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, rt, calls };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const headers = (deps: RouterDeps, json: boolean): Record<string, string> => ({ host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(json ? { "content-type": "application/json" } : {}) });
const ui = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/ui/${path}`, { method, headers: headers(deps, body !== undefined), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const agent = (deps: RouterDeps, method: string, path: string, body?: unknown): Request =>
  new Request(`${base}/api/agent/${path}`, { method, headers: { host: HOST, authorization: `Bearer ${deps.agentToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const jsonOf = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;

describe("L3: team file", () => {
  it("export returns YAML without values and with file name; the agent may read", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "GET", "team-export"), deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/yaml");
    expect(r.headers.get("content-disposition")).toContain("secret-desk.team.yaml");
    const text = await r.text();
    expect(text).toContain("manual-one");
    expect(text).not.toContain("ghp_x");
    expect((await route(agent(deps, "GET", "team-export"), deps)).status).toBe(200);
  });
  it("import merge adds new entries, replace with confirmReplace replaces, broken YAML -> 400 without change", async () => {
    const { deps } = await setup();
    const extra = "version: 1\nsecrets:\n  - { id: neu-secret, name: NEU_SECRET, service: x, stage: dev, expiry: none, provider: manual }\n";
    const merged = await route(ui(deps, "POST", "team-import", { text: extra }), deps);
    expect(merged.status).toBe(200);
    expect(await jsonOf(merged)).toMatchObject({ added: ["neu-secret"] });
    expect(deps.rt.inventory.data.secrets.map((s) => s.id).sort()).toEqual(["manual-one", "neu-secret"]);
    const before = deps.rt.inventory.toString();
    const bad = await route(ui(deps, "POST", "team-import", { text: "version: [\n  kaputt" }), deps);
    expect(bad.status).toBe(400);
    expect(deps.rt.inventory.toString()).toBe(before);
    const replaced = await route(ui(deps, "POST", "team-import", { text: extra, replace: true, confirmReplace: true }), deps);
    expect(replaced.status).toBe(200);
    expect(deps.rt.inventory.data.secrets.map((s) => s.id)).toEqual(["neu-secret"]);
  });
  it("import without text -> 400", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "team-import", {}), deps)).status).toBe(400);
  });
});

describe("L3: manual input, rejecting a review", () => {
  it("manual-value creates a review without showing the value; reject writes nothing", async () => {
    const { deps, calls } = await setup();
    const r = await route(ui(deps, "POST", "secrets/manual-one/manual-value", { value: "mein-handwert-123456789" }), deps);
    expect(r.status).toBe(200);
    const view = await jsonOf<{ id: string }>(r);
    expect(JSON.stringify(view)).not.toContain("mein-handwert");
    const rej = await route(ui(deps, "POST", `reviews/${view.id}/reject`, { note: "falsch" }), deps);
    expect(rej.status).toBe(200);
    expect(await jsonOf(rej)).toHaveProperty("revokedNew");
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    expect(await jsonOf<unknown[]>(await route(ui(deps, "GET", "reviews"), deps))).toHaveLength(0);
  });
  it("manual-value: without value 400, the agent has no route, unknown secret -> 400", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "secrets/manual-one/manual-value", {}), deps)).status).toBe(400);
    expect((await route(agent(deps, "POST", "secrets/manual-one/manual-value", { value: "x" }), deps)).status).toBe(404);
    expect((await route(ui(deps, "POST", "secrets/gibt-es-nicht/manual-value", { value: "x".repeat(20) }), deps)).status).toBe(409);
  });
  it("reject of an unknown review -> error, not 500", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "POST", "reviews/unbekannt/reject", {}), deps);
    expect(r.status).toBeLessThan(500);
  });
});

describe("L3: adopting and removing variables", () => {
  it("adopt takes the value from GitHub (human only)", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "POST", "variables/proj-id/adopt", {}), deps)).status).toBe(404);
    const r = await route(ui(deps, "POST", "variables/proj-id/adopt"), deps);
    expect(r.status).toBe(200);
    expect(await jsonOf(r)).toMatchObject({ id: "proj-id", value: "proj_live_1" });
    expect(deps.rt.inventory.getVariable("proj-id")!.value).toBe("proj_live_1");
  });
  it("adopt of an unknown variable -> 400", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "variables/nope/adopt"), deps)).status).toBe(400);
  });
  it("DELETE removes the variable; second DELETE -> 400; the agent may not", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "DELETE", "variables/site-url"), deps)).status).toBe(404);
    const r = await route(ui(deps, "DELETE", "variables/site-url"), deps);
    expect(r.status).toBe(200);
    expect(await jsonOf(r)).toEqual({ ok: true });
    expect(deps.rt.inventory.getVariable("site-url")).toBeUndefined();
    expect((await route(ui(deps, "DELETE", "variables/site-url"), deps)).status).toBe(400);
  });
});

describe("L3: attachments", () => {
  async function withReport() {
    const ctx = await setup();
    const view = await jsonOf<{ id: string }>(await route(ui(ctx.deps, "POST", "secrets/manual-one/manual-value", { value: "mein-handwert-123456789" }), ctx.deps));
    return { ...ctx, reportId: view.id };
  }
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const upload = (deps: RouterDeps, secret: string, report: string, file: Blob, name = "bild.png") => {
    const form = new FormData();
    form.set("file", file, name);
    return route(new Request(`${base}/api/ui/evidence/${secret}/${report}/attachments`, { method: "POST", headers: headers(deps, false), body: form }), deps);
  };
  it("PNG is accepted (201), readable with safe headers", async () => {
    const { deps, reportId } = await withReport();
    const r = await upload(deps, "manual-one", reportId, new Blob([PNG], { type: "image/png" }));
    expect(r.status).toBe(201);
    const att = await jsonOf<{ file: string; mime: string }>(r);
    const get = await route(new Request(`${base}/api/ui/evidence/manual-one/${reportId}/attachments/${att.file}`, { headers: { host: HOST, cookie: `sd_session=${deps.session.cookie}` } }), deps);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
  });
  it("wrong MIME type -> 400", async () => {
    const { deps, reportId } = await withReport();
    for (const type of ["text/html", "image/svg+xml", "application/pdf"]) {
      expect((await upload(deps, "manual-one", reportId, new Blob(["<script>"], { type }), "x.html")).status, type).toBe(400);
    }
  });
  it("larger than 5 MB or empty -> 400", async () => {
    const { deps, reportId } = await withReport();
    expect((await upload(deps, "manual-one", reportId, new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }))).status).toBe(400);
    expect((await upload(deps, "manual-one", reportId, new Blob([], { type: "image/png" }))).status).toBe(400);
  });
  it("no file field -> 400; unknown report -> 400", async () => {
    const { deps, reportId } = await withReport();
    const form = new FormData();
    form.set("note", "x");
    const none = await route(new Request(`${base}/api/ui/evidence/manual-one/${reportId}/attachments`, { method: "POST", headers: headers(deps, false), body: form }), deps);
    expect(none.status).toBe(400);
    expect((await upload(deps, "manual-one", "gibt-es-nicht", new Blob([PNG], { type: "image/png" }))).status).toBe(400);
  });
  it("path traversal in secret, report and file name: never 200, never 500", async () => {
    const { deps, reportId } = await withReport();
    const cookieOnly = { host: HOST, cookie: `sd_session=${deps.session.cookie}` };
    for (const path of [
      `evidence/..%2F..%2Fetc/${reportId}/attachments/anlage-1.png`,
      `evidence/manual-one/..%2F..%2Fx/attachments/anlage-1.png`,
      `evidence/manual-one/${reportId}/attachments/..%2F..%2F..%2Fetc%2Fpasswd`,
      `evidence/manual-one/${reportId}/attachments/%2e%2e%2fsecret-desk.config.yaml`,
    ]) {
      const r = await route(new Request(`${base}/api/ui/${path}`, { headers: cookieOnly }), deps);
      expect([400, 404], path).toContain(r.status);
    }
    const up = await upload(deps, "..%2F..%2Fetc", reportId, new Blob([PNG], { type: "image/png" }));
    expect([400, 404]).toContain(up.status);
  });
  it("the agent has no access to attachments", async () => {
    const { deps, reportId } = await withReport();
    expect((await route(agent(deps, "GET", `evidence/manual-one/${reportId}/attachments/anlage-1.png`), deps)).status).toBe(404);
  });
});

describe("L3: connections", () => {
  it("remember with vault disabled -> 400, nothing stored", async () => {
    const { deps } = await setup();
    const r = await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_token_geheim", expires: "2999-01-01", remember: true }), deps);
    expect(r.status).toBe(400);
    expect(JSON.stringify(await jsonOf(r))).not.toContain("cf_token_geheim");
    expect(deps.rt.connections.session.has("cloudflare")).toBe(false);
  });
  it("DELETE removes the session token and returns the new status without value", async () => {
    const { deps } = await setup();
    await route(ui(deps, "POST", "connections/cloudflare/token", { token: "cf_token_geheim", neverExpires: true }), deps);
    expect(deps.rt.connections.session.has("cloudflare")).toBe(true);
    const r = await route(ui(deps, "DELETE", "connections/cloudflare/token"), deps);
    expect(r.status).toBe(200);
    const body = await jsonOf<{ connected: boolean }>(r);
    expect(body.connected).toBe(false);
    expect(JSON.stringify(body)).not.toContain("cf_token_geheim");
    expect(deps.rt.connections.session.has("cloudflare")).toBe(false);
  });
  it("DELETE without an existing token is harmless; the agent may not", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "DELETE", "connections/github/token"), deps)).status).toBe(200);
    expect((await route(agent(deps, "DELETE", "connections/github/token"), deps)).status).toBe(404);
  });
  it("token without value -> 400", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "connections/github/token", { neverExpires: true }), deps)).status).toBe(400);
  });
});
