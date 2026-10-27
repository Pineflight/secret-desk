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
  - id: hmac-wakemiles
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: wake-miles, scope: repository }
variables:
  - id: site-url
    name: NEXT_PUBLIC_SITE_URL
    stage: staging
    value: "https://staging.example.com"
    places:
      - { repo: web-studio, scope: environment, environment: staging }
envTemplates:
  - id: ws-dev
    repo: web-studio
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
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: Pineflight\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(dir)}]\n`);
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


describe("Stages", () => {
  it("GET liefert die Standard-Stages, PUT ersetzt die Liste (nur Portal)", async () => {
    const { deps } = await setup();
    const list = (await (await route(ui(deps, "GET", "stages"), deps)).json()) as { id: string; kind: string; environmentName: string | null }[];
    expect(list.map((s) => [s.id, s.kind, s.environmentName])).toEqual([["dev", "dev", null], ["staging", "test", "staging"], ["production", "live", "production"], ["shared", "shared", null]]);
    const put = await route(ui(deps, "PUT", "stages", { stages: [...list.map(({ id, kind }) => ({ id, kind })), { id: "qa", label: "QA", kind: "test", tone: "warn" }] }), deps);
    expect(put.status).toBe(200);
    const after = (await (await route(ui(deps, "GET", "stages"), deps)).json()) as { id: string }[];
    expect(after.map((s) => s.id)).toContain("qa");
  });
  it("entfernen blockiert, wenn genutzt; ungueltige Eingaben liefern 400", async () => {
    const { deps } = await setup();
    const noStaging = await route(ui(deps, "PUT", "stages", { stages: [{ id: "dev", kind: "dev" }, { id: "shared", kind: "shared" }, { id: "production", kind: "live" }] }), deps);
    expect(noStaging.status).toBe(400);
    expect(JSON.stringify(await noStaging.json())).toContain("staging");
    expect((await route(ui(deps, "PUT", "stages", { stages: [{ id: "A B", kind: "dev" }] }), deps)).status).toBe(400);
    expect((await route(ui(deps, "PUT", "stages", {}), deps)).status).toBe(400);
  });
  it("Agenten duerfen lesen, aber nicht schreiben", async () => {
    const { deps } = await setup();
    expect((await route(agent(deps, "GET", "stages"), deps)).status).toBe(200);
    expect((await route(agent(deps, "PUT", "stages", { stages: [{ id: "x", kind: "dev" }] }), deps)).status).toBe(404);
  });
});
