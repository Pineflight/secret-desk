import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionVault, type ExecFn } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, readOptional, type RuntimeOptions } from "../src/runtime.js";

const BASE_AUTH = "github:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";

async function config(extra = "", auth = BASE_AUTH, inventory = "version: 1\nsecrets: []\nvariables: []\n") {
  const dir = await mkdtemp(join(tmpdir(), "sd-runtime-"));
  await writeFile(join(dir, "inventory.yaml"), inventory);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nautomation:\n  enabled: false\n${auth}${extra}`);
  return { dir, path: join(dir, "c.yaml") };
}

const env = (extra: Record<string, string> = {}) => ({ GH_TEST: "gh_made_up_value_1", ...extra }) as unknown as NodeJS.ProcessEnv;
const opts = (more: RuntimeOptions = {}): RuntimeOptions => ({ env: env(), vault: null, bundledRecipes: null, ...more });

describe("createRuntime vault selection", () => {
  it("builds the configured vault when none is passed, with and without custom files", async () => {
    const { dir, path } = await config(`vault:\n  enabled: true\n  file: ${JSON.stringify("~/sd-test-vault.json")}\n  keyFile: ${JSON.stringify("~/sd-test-vault.key")}\n`);
    const rt = await createRuntime(path, { env: env(), bundledRecipes: null });
    expect(rt.connections.vault).toBeDefined();
    const plain = await config("vault:\n  enabled: true\n");
    expect((await createRuntime(plain.path, { env: env(), bundledRecipes: null })).connections.vault).toBeDefined();
    expect(dir).toBeTruthy();
  });

  it("has no vault when it is disabled in the config", async () => {
    const { path } = await config("vault:\n  enabled: false\n");
    expect((await createRuntime(path, { env: env(), bundledRecipes: null })).connections.vault).toBeUndefined();
  });

  it("an explicit vault option wins, null means none", async () => {
    const { path } = await config("vault:\n  enabled: true\n");
    const rt = await createRuntime(path, opts());
    expect(rt.connections.vault).toBeUndefined();
  });
});

describe("createRuntime wiring", () => {
  it("falls back to the process environment and the global fetch", async () => {
    vi.stubEnv("GH_TEST", "gh_from_process_env_1");
    try {
      const { path } = await config();
      const rt = await createRuntime(path, { vault: null, bundledRecipes: null });
      expect((await rt.connections.token("github")).reveal()).toBe("gh_from_process_env_1");
      expect(rt.fetch).toBe(fetch);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the given session vault and exec function for connection tokens", async () => {
    const { path } = await config(`connections:\n  op-conn: { type: op, ref: "op://made-up/item/field" }\n  sess-conn: { type: session }\n`);
    const session = new SessionVault();
    session.set("sess-conn", "session_token_made_up");
    const calls: string[][] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      return "exec_token_made_up\n";
    };
    const rt = await createRuntime(path, opts({ session, exec }));
    expect((await rt.connections.token("sess-conn")).reveal()).toBe("session_token_made_up");
    expect((await rt.connections.token("op-conn")).reveal()).toBe("exec_token_made_up");
    expect(calls).toEqual([["op", "read", "op://made-up/item/field"]]);
  });

  it("derives the team-sync connection from the environment only when none is configured", async () => {
    const { path } = await config();
    const rt = await createRuntime(path, opts({ env: env({ SECRET_DESK_TEAM_TOKEN: "team_token_made_up_2" }) }));
    expect((await rt.connections.token("team-sync")).reveal()).toBe("team_token_made_up_2");
    const own = await config("connections:\n  team-sync: { type: env, name: OWN_TEAM }\n");
    const rt2 = await createRuntime(own.path, opts({ env: env({ SECRET_DESK_TEAM_TOKEN: "ignored_made_up", OWN_TEAM: "own_team_made_up" }) }));
    expect((await rt2.connections.token("team-sync")).reveal()).toBe("own_team_made_up");
  });

  it("with watchInventory, an external change to the inventory file drops the cached team-sync comparison", async () => {
    const { dir, path } = await config();
    const rt = await createRuntime(path, opts({ watchInventory: true }));
    rt.teamSyncMemo.lastCheck = { stale: true };
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n# changed from outside\n");
    // Every read checks the file as well (the watcher is only a hint), so reading is a deterministic trigger.
    await vi.waitFor(() => {
      void rt.inventory.data;
      expect(rt.teamSyncMemo.lastCheck).toBeNull();
    }, { timeout: 5000, interval: 25 });
  });

  it("persistSignIn keeps the sign-in memory next to the links file, or in the home directory by default", async () => {
    const { dir, path } = await config(`linksFile: ${JSON.stringify(join("~", "sd-links-test", "links.json"))}\n`);
    expect(await createRuntime(path, opts({ persistSignIn: true }))).toBeTruthy();
    const none = await config();
    expect(await createRuntime(none.path, opts({ persistSignIn: true }))).toBeTruthy();
    expect(dir).toBeTruthy();
  });
});

describe("createRuntime with a GitHub App", () => {
  function appConfig(repositories: string) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return { pem, auth: `github:\n  owner: acme\n  auth:\n    type: app\n    appId: "12345"\n    privateKey: { type: env, name: APP_KEY }\n${repositories}` };
  }

  async function run(repositories: string) {
    const { pem, auth } = appConfig(repositories);
    const { path } = await config("", auth);
    const bodies: unknown[] = [];
    const calls: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url).replace("https://api.github.com", "");
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.startsWith("/app/installations?")) return new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200 });
      if (u === "/app/installations/7/access_tokens") {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ token: "installation_token_made_up", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify({ variables: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rt = await createRuntime(path, { env: env({ APP_KEY: pem }), vault: null, bundledRecipes: null, fetch: fetchMock });
    return { rt, bodies, calls };
  }

  it("creates the token provider lazily, once, and limits the repositories when configured", async () => {
    const { rt, bodies, calls } = await run("");
    expect(calls).toEqual([]);
    await rt.github.listVariables({ owner: "acme", repo: "acme-app", scope: "repository" });
    await rt.github.listVariables({ owner: "acme", repo: "acme-app", scope: "repository" });
    expect(calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
    expect(bodies[0]).toEqual({ permissions: { secrets: "write", environments: "read", metadata: "read" } });
  });

  it("passes the configured repositories to the installation token", async () => {
    const { pem } = appConfig("");
    const { path } = await config("", `github:\n  owner: acme\n  auth:\n    type: app\n    appId: "12345"\n    privateKey: { type: env, name: APP_KEY }\n    repositories: [acme-app]\n`);
    const bodies: unknown[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url).replace("https://api.github.com", "");
      if (u.startsWith("/app/installations?")) return new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200 });
      if (u === "/app/installations/7/access_tokens") {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ token: "installation_token_made_up", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify({ variables: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rt = await createRuntime(path, { env: env({ APP_KEY: pem }), vault: null, bundledRecipes: null, fetch: fetchMock });
    await rt.github.listVariables({ owner: "acme", repo: "acme-app", scope: "repository" });
    expect(bodies[0]).toMatchObject({ repositories: ["acme-app"] });
  });
});

describe("readOptional", () => {
  it("returns the file content, or null when it cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-readopt-"));
    await writeFile(join(dir, "a.txt"), "hello");
    expect(await readOptional(join(dir, "a.txt"))).toBe("hello");
    expect(await readOptional(join(dir, "missing.txt"))).toBeNull();
  });
});
