import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConnectionResources, putConnectionDefaults } from "../src/params.js";
import { createRuntime } from "../src/runtime.js";

const TOKEN = "gh_connection_token_made_up_1";

async function setup(automation: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "sd-connres-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nautomation:\n  enabled: ${automation}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nteamSync:\n  repo: acme/team-config\n`);
  return createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: TOKEN, SECRET_DESK_TEAM_TOKEN: "team_token_made_up_2" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
}
const human = { kind: "human", name: "tester" } as const;

describe("connection resources without discoverable resources", () => {
  it("github with automation off: empty resources instead of an error", async () => {
    const rt = await setup(false);
    expect(rt.providers.list().some((p) => p.connection === "github")).toBe(false);
    const r = await getConnectionResources(rt, human, "github");
    expect(r).toMatchObject({ connection: "github", connected: true, defaultSpecs: [], defaults: {}, resources: {} });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("github, github-app-key and team-sync are known connections", async () => {
    const rt = await setup(false);
    for (const id of ["github", "github-app-key", "team-sync"]) {
      const r = await getConnectionResources(rt, human, id);
      expect(r.defaultSpecs).toEqual([]);
      expect(r.resources).toEqual({});
    }
  });

  it("a requested kind on such a connection is reported as unsupported, not thrown", async () => {
    const rt = await setup(false);
    const r = await getConnectionResources(rt, human, "github", { kind: "account" });
    expect(r.resources["account"]?.status).toBe("unsupported");
  });

  it("setting defaults on a connection without default parameters is rejected as invalid input, not as unknown", async () => {
    const rt = await setup(false);
    const err = await putConnectionDefaults(rt, human, "github", { values: { accountId: "x" } }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/Unbekannte Verbindung/);
    expect(await putConnectionDefaults(rt, human, "github", { values: {} })).toMatchObject({ connection: "github", defaults: {}, defaultSpecs: [] });
  });

  it("a really unknown connection still throws", async () => {
    const rt = await setup(false);
    await expect(getConnectionResources(rt, human, "does-not-exist")).rejects.toThrow(/Unbekannte Verbindung: does-not-exist/);
    await expect(putConnectionDefaults(rt, human, "does-not-exist", { values: {} })).rejects.toThrow(/Unbekannte Verbindung/);
  });

  it("agents still cannot read resources", async () => {
    const rt = await setup(false);
    await expect(getConnectionResources(rt, { kind: "agent", name: "bot" }, "github")).rejects.toThrow();
  });
});

describe("connection resources use saved integration defaults", () => {
  async function grafanaRuntime(inventory: string) {
    const dir = await mkdtemp(join(tmpdir(), "sd-connres-grafana-"));
    await writeFile(join(dir, "inventory.yaml"), inventory);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nautomation:\n  enabled: true\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    return createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: TOKEN } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  }

  it("grafana service accounts get baseUrl from the integration defaults", async () => {
    const rt = await grafanaRuntime("version: 1\nsecrets: []\nvariables: []\nintegrationDefaults:\n  grafana:\n    baseUrl: https://acme.grafana.net\n");
    const r = await getConnectionResources(rt, human, "grafana");
    const state = r.resources["grafana.serviceAccount"];
    expect(state).toBeDefined();
    expect(state?.error ?? "").not.toMatch(/baseUrl/);
  });

  it("without a saved default the missing baseUrl is still reported", async () => {
    const rt = await grafanaRuntime("version: 1\nsecrets: []\nvariables: []\n");
    const r = await getConnectionResources(rt, human, "grafana");
    expect(r.resources["grafana.serviceAccount"]?.error ?? "").toMatch(/baseUrl/);
  });
});
