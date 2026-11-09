import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretVault } from "@secret-desk/core";
import { createRuntime, type RuntimeOptions } from "@secret-desk/runtime";
import { PortalSession, allowedHosts } from "../../src/server/security.js";
import type { RouterDeps } from "../../src/server/router.js";

export const HOST = "127.0.0.1:4747";
export const BASE = `http://${HOST}`;

export const FIXTURE_INVENTORY = `version: 1
secrets:
  - id: manual-one
    name: MANUAL_ONE_TOKEN
    stage: dev
    service: intern
    provider: manual
    expiry: none
    tags: [core]
    places:
      - { repo: acme-docs, scope: repository }
variables:
  - id: proj-id
    name: ACME_PROJECT_ID
    stage: dev
    value: "proj-1"
    places:
      - { repo: acme-app, scope: repository }
envTemplates:
  - id: acme-dev
    repo: acme-app
    stage: dev
    entries:
      - { key: A_VAR, from: { type: variable, variable: proj-id } }
      - { key: B_ISSUE, from: { type: issue, secret: manual-one }, description: "from a secret" }
      - { key: C_DEFAULT, from: { type: default, value: "x" } }
      - { key: D_PROMPT, from: { type: prompt, optional: true } }
      - { key: E_REF, from: { type: ref, template: acme-other, key: C_DEFAULT } }
      - { key: F_CMD, from: { type: command, command: supabase-status, key: API_URL, optional: true } }
      - { key: G_GEN, from: { type: generate, kind: hex, bytes: 16 } }
  - id: acme-other
    repo: acme-app
    stage: dev
    file: .env.other
    entries:
      - { key: C_DEFAULT, from: { type: default, value: "y" } }
`;

/** A runtime on a temp directory with a fake fetch (nothing leaves the process) and an in-memory vault key. */
export async function routerFixture(opts: { inventory?: string; runtime?: RuntimeOptions; withVault?: boolean } = {}) {
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-gaps-"));
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? FIXTURE_INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nevidenceDir: ./evidence\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(dir)}]\n`);
  const vault = opts.withVault ? new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test key", key: async () => Buffer.alloc(32, 7) } }) : null;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null, ...opts.runtime });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { rt, deps, dir, calls };
}

export const uiRequest = (deps: RouterDeps, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Request =>
  new Request(`${BASE}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: BASE, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
