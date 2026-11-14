import { mkdtemp, writeFile } from "node:fs/promises";
import { InventoryStore } from "@secret-desk/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime } from "@secret-desk/runtime";
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
    expiry: required
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
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock });
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



const json = async <T,>(res: Response): Promise<T> => (await res.json()) as T;

/** What the CLI does: a second store on the same file. */
async function cliPatch(dir: string, id: string, patch: Parameters<InventoryStore["patchSecret"]>[1]): Promise<void> {
  const cli = await InventoryStore.open(join(dir, "inventory.yaml"));
  cli.patchSecret(id, patch);
  await cli.save();
}

describe("the portal follows inventory changes made outside it", () => {
  it("GET secrets and overview show an expiry written by the CLI, without a restart", async () => {
    const { deps, dir } = await setup();
    const before = await json<{ expires: string | null; status: string }[]>(await route(ui(deps, "GET", "secrets"), deps));
    expect(before[0]!.expires).toBeNull();
    const ov0 = await json<{ byStatus: Record<string, number> }>(await route(ui(deps, "GET", "overview"), deps));
    expect(ov0.byStatus["no-date"]).toBe(1);

    await cliPatch(dir, "hmac-acme-app", { expires: "2099-01-01", rotatedAt: "2026-11-01" });

    const after = await json<{ expires: string | null; status: string }[]>(await route(ui(deps, "GET", "secrets"), deps));
    expect(after[0]!.expires).toBe("2099-01-01");
    const ov1 = await json<{ byStatus: Record<string, number> }>(await route(ui(deps, "GET", "overview"), deps));
    expect(ov1.byStatus["no-date"]).toBe(0);
    expect(ov1.byStatus["ok"]).toBe(1);
  });

  it("a portal save after a CLI write keeps the CLI result", async () => {
    const { deps, dir } = await setup();
    await route(ui(deps, "GET", "secrets"), deps); // the portal has the old state in memory
    await cliPatch(dir, "hmac-acme-app", { expires: "2099-01-01" });
    const res = await route(ui(deps, "PATCH", "secrets/hmac-acme-app", { notes: "from the portal" }), deps);
    expect(res.status).toBe(200);
    const saved = await InventoryStore.open(join(dir, "inventory.yaml"));
    expect(saved.getSecret("hmac-acme-app")!.expires).toBe("2099-01-01");
    expect(saved.getSecret("hmac-acme-app")!.notes).toBe("from the portal");
  });

  it("GET inventory/version counts external and own changes", async () => {
    const { deps, dir } = await setup();
    const v0 = await json<{ version: number; problem: unknown }>(await route(ui(deps, "GET", "inventory/version"), deps));
    expect(v0.problem).toBeNull();
    await cliPatch(dir, "hmac-acme-app", { notes: "x" });
    const v1 = await json<{ version: number }>(await route(ui(deps, "GET", "inventory/version"), deps));
    expect(v1.version).toBeGreaterThan(v0.version);
    expect((await route(ui(deps, "PATCH", "secrets/hmac-acme-app", { notes: "y" }), deps)).status).toBe(200);
    const v2 = await json<{ version: number }>(await route(ui(deps, "GET", "inventory/version"), deps));
    expect(v2.version).toBeGreaterThan(v1.version);
  });

  it("reports a conflict as 409 and writes nothing", async () => {
    const { deps, dir } = await setup();
    await route(ui(deps, "GET", "secrets"), deps);
    await writeFile(join(dir, "inventory.yaml"), "not: [valid");
    const res = await route(ui(deps, "PATCH", "secrets/hmac-acme-app", { notes: "z" }), deps);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("inventory-conflict");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toBe("not: [valid");
  });
});
