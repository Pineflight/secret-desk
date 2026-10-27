import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const GITHUB_TOKEN = "ghp_geheim_token_settings_1";
const AGENT_TOKEN = "agent-token-1234567890-agent-token-1234567890";
const ENV_NAME = "GH_SETTINGS_TEST";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-settings-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nserver: { port: 4747 }\ngithub:\n  owner: Pineflight\n  auth: { type: pat, source: { type: env, name: ${ENV_NAME} } }\nconnections:\n  cloudflare: { type: env, name: CF_SETTINGS_TEST }\npolicy:\n  agentStages: [dev, production]\n  envRoots: [${JSON.stringify(join(dir, "wurzel"))}]\n`);
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { [ENV_NAME]: GITHUB_TOKEN, CF_SETTINGS_TEST: "cf_geheim_wert_settings_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: AGENT_TOKEN, hosts: allowedHosts(4747) };
  return { deps, dir };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, withSession = true): Request =>
  new Request(`${base}/api/ui/${path}`, { method, headers: { host: HOST, origin: base, ...(withSession ? { cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf } : {}) } });
const agent = (deps: RouterDeps, path: string): Request => new Request(`${base}/api/agent/${path}`, { headers: { host: HOST, authorization: `Bearer ${deps.agentToken}` } });

describe("GET settings", () => {
  it("Portal bekommt die aufgeloeste Richtlinie und die Metadaten", async () => {
    const { deps } = await setup();
    const res = await route(ui(deps, "GET", "settings"), deps);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { policy: { agentStages: string[]; agentStagesSource: string; envRoots: string[] }; stages: { id: string; agentAccess: string }[]; vault: { enabled: boolean }; automation: { enabled: boolean }; server: { port: number } };
    expect(s.policy.agentStages).toEqual(["dev"]);
    expect(s.policy.agentStagesSource).toBe("policy");
    expect(s.policy.envRoots).toHaveLength(1);
    expect(s.stages.find((x) => x.id === "production")!.agentAccess).toBe("approval");
    expect(s.vault.enabled).toBe(false);
    expect(s.server.port).toBe(4747);
  });
  it("ohne Sitzung 401, Agenten bekommen 404", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "GET", "settings", false), deps)).status).toBe(401);
    expect((await route(agent(deps, "settings"), deps)).status).toBe(404);
  });
  it("keine Werte, Tokens oder Variablennamen im JSON (de und en)", async () => {
    const { deps } = await setup();
    for (const lang of ["de", "en"]) {
      const req = ui(deps, "GET", "settings");
      req.headers.set("x-secret-desk-lang", lang);
      const text = await (await route(req, deps)).text();
      for (const bad of [GITHUB_TOKEN, "cf_geheim_wert_settings_1", AGENT_TOKEN, deps.session.csrf, deps.session.cookie, ENV_NAME, "CF_SETTINGS_TEST"]) expect(text).not.toContain(bad);
    }
  });
});
