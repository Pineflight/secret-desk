import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { NotConnectedError } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportEnv, getAutomation } from "../src/agent-api.js";
import { nodeRuntimeHost, readHostEnv, type RuntimeHost } from "../src/host.js";
import { listRepos, scanLocal, setLink } from "../src/repos.js";
import { createLocalRuntime, createRuntime } from "../src/runtime.js";
import { startupTeamSync } from "../src/team-sync.js";

// Everything here uses made-up values. The "poisoned" values sit in the real process environment on purpose: a runtime
// without a host must never return them, and the environment object must not even be asked for them.
const POISON = {
  SECRET_DESK_TEAM_TOKEN: "poison_team_token_made_up",
  SECRET_DESK_TEAM_REPO: "acme/poison-team-config",
  SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9",
  SECRET_DESK_BROWSER_VIEWER_URL: "http://poison.invalid/vnc.html",
  MADE_UP_HOST_VAR: "poison_env_value_made_up",
  GH_TEST: "poison_github_token_made_up",
};
const human = { kind: "human", name: "alice" } as const;
const windows = process.platform === "win32";

const INVENTORY = `version: 1
secrets: []
variables: []
envTemplates:
  - id: acme-dev
    repo: acme-app
    stage: dev
    file: .env.local
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
      - { key: ANON_KEY, from: { type: command, command: supabase-status, key: ANON_KEY, optional: true } }
`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Fake `git`, `op` and `supabase` programs first on PATH. Each one leaves a line in a marker file when it is started. */
async function fakePrograms(): Promise<{ marker: string; started: () => Promise<string[]> }> {
  const bin = await realpath(await mkdtemp(join(tmpdir(), "sd-host-bin-")));
  const marker = join(bin, "started.log");
  const script = (name: string, output: string) => writeFile(join(bin, name), `#!/bin/sh\necho "${name}" >> "${marker}"\necho "${output}"\n`, { mode: 0o755 });
  await script("git", "git@github.com:acme/acme-app.git");
  await script("op", "op_value_made_up");
  await script("supabase", "ANON_KEY=anon_made_up_value");
  await chmod(join(bin, "git"), 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
  return { marker, started: () => readFile(marker, "utf8").then((t) => t.split("\n").filter(Boolean), () => []) };
}

function poisonProcessEnv(): void {
  for (const [name, value] of Object.entries(POISON)) vi.stubEnv(name, value);
}

/** Replaces `process.env` with a proxy that records every name asked for (and every enumeration). */
function watchProcessEnv(): { reads: string[]; stop: () => void } {
  const original = Object.getOwnPropertyDescriptor(process, "env")!;
  const real = process.env;
  const reads: string[] = [];
  const proxy = new Proxy(real, {
    get: (target, key, receiver) => {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver);
    },
    has: (target, key) => {
      if (typeof key === "string") reads.push(key);
      return Reflect.has(target, key);
    },
    ownKeys: (target) => {
      reads.push("<enumeration>");
      return Reflect.ownKeys(target);
    },
  });
  Object.defineProperty(process, "env", { value: proxy, configurable: true, writable: true, enumerable: true });
  return { reads, stop: () => Object.defineProperty(process, "env", original) };
}

async function setup(options: { host?: RuntimeHost | null | "local"; teamRepo?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-host-")));
  const projects = join(dir, "projects");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "c.yaml"),
    [
      "inventory: ./inventory.yaml",
      `linksFile: ${JSON.stringify(join(dir, "links.json"))}`,
      "github:",
      "  owner: acme",
      "  auth: { type: pat, source: { type: env, name: GH_TEST } }",
      "connections:",
      "  env-conn: { type: env, name: MADE_UP_HOST_VAR }",
      '  op-conn: { type: op, ref: "op://made-up/item/field" }',
      "policy:",
      `  envRoots: [${JSON.stringify(projects)}]`,
      "",
    ].join("\n"),
  );
  const path = join(dir, "c.yaml");
  const base = { vault: null, bundledRecipes: null } as const;
  const rt =
    options.host === "local"
      ? await createLocalRuntime(path, base)
      : await createRuntime(path, { ...base, ...(options.host !== undefined ? { host: options.host } : {}) });
  return { rt, dir, projects, path };
}

async function gitFolder(projects: string, name: string): Promise<string> {
  const dir = join(projects, name);
  await mkdir(join(dir, ".git"), { recursive: true });
  return realpath(dir);
}

describe("a runtime without a host", () => {
  it.skipIf(windows)("does not read the process environment and does not start a process, on any of the paths", async () => {
    poisonProcessEnv();
    const programs = await fakePrograms();
    const { rt, projects } = await setup();
    const folder = await gitFolder(projects, "acme-app");
    await writeFile(join(projects, "..", "links.json"), JSON.stringify({ version: 1, links: { "acme-app": folder } }));

    const watch = watchProcessEnv();
    let results: Awaited<ReturnType<typeof exercise>>;
    try {
      results = await exercise();
    } finally {
      watch.stop();
    }
    expect(watch.reads).toEqual([]);
    expect(await programs.started()).toEqual([]);
    expect(JSON.stringify(results)).not.toMatch(/poison_/);

    async function exercise() {
      const env = await rt.connections.status("env-conn");
      const op = await rt.connections.status("op-conn");
      const team = await rt.connections.status("team-sync");
      const tokenError = await rt.connections.token("env-conn").catch((e: unknown) => e);
      await startupTeamSync(rt);
      const automation = await getAutomation(rt, human);
      const link = await setLink(rt, "acme-app", folder);
      const found = await scanLocal(rt);
      const repos = await listRepos(rt, { includePaths: true });
      const exported = await exportEnv(rt, human, { repo: "acme-app", runCommands: true, runValues: new Map(), prompts: {} });
      return { env, op, team, tokenError, automation, link, found, repos, exported, teamConfig: rt.config.teamSync };
    }
    expect(results.env).toMatchObject({ connected: false, source: "env" });
    expect(results.op).toMatchObject({ connected: false, source: "op" });
    expect(results.team).toMatchObject({ connected: false });
    expect(results.tokenError).toBeInstanceOf(NotConnectedError);
    expect(results.teamConfig).toBeUndefined();
    expect(results.automation.browser).toMatchObject({ mode: "local", viewerUrl: null });
    expect(results.link).toMatchObject({ remote: null, remoteMatches: null, warnings: ["Der Remote des Ordners laesst sich in dieser Umgebung nicht pruefen."] });
    expect(results.found).toEqual([]);
    expect(results.repos.repos.find((r) => r.name === "acme-app")?.link).toMatchObject({ exists: true, remote: null, remoteMatches: null });
    expect(results.exported).toMatchObject({ status: "written", skipped: ["ANON_KEY"], gitIgnored: null });
    if (results.exported.status === "written") {
      expect(results.exported.warnings).toContain("Befehle der Vorlage laufen in dieser Umgebung nicht; die betroffenen Werte bleiben leer.");
      expect(results.exported.warnings).toContain("Ob Git die Datei ignoriert, liess sich nicht pruefen.");
      expect(await readFile(join(folder, ".env.local"), "utf8")).not.toContain("anon_made_up_value");
    }
  });

  it("is the same with `host: null` and when the option is left out", async () => {
    poisonProcessEnv();
    for (const host of [null, undefined] as const) {
      const { rt } = await setup(host === undefined ? {} : { host });
      expect(rt.host).toBeUndefined();
      expect(await rt.connections.status("env-conn")).toMatchObject({ connected: false, hint: expect.stringContaining("nicht verfuegbar") });
      expect(await rt.connections.status("team-sync")).toMatchObject({ connected: false });
    }
  });

  it("never falls back to the Node host when an environment-looking option is given to createRuntime", async () => {
    poisonProcessEnv();
    const { path } = await setup();
    const rt = await createRuntime(path, { vault: null, bundledRecipes: null, env: { MADE_UP_HOST_VAR: "other_made_up" } } as never);
    expect(rt.host).toBeUndefined();
    expect(await rt.connections.status("env-conn")).toMatchObject({ connected: false });
  });
});

describe("the test instruments", () => {
  it("the environment watcher records reads and enumerations, so an empty list means something", () => {
    const watch = watchProcessEnv();
    try {
      void process.env["MADE_UP_WATCHED_NAME"];
      void Object.keys(process.env);
    } finally {
      watch.stop();
    }
    expect(watch.reads).toEqual(expect.arrayContaining(["MADE_UP_WATCHED_NAME", "<enumeration>"]));
  });

  it.skipIf(windows)("the fake programs leave a trace when they are started", async () => {
    const programs = await fakePrograms();
    const host = nodeRuntimeHost({ env: {} });
    await host.gitOrigin?.(tmpdir());
    expect(await programs.started()).toEqual(["git"]);
  });
});

describe("a runtime with a host that offers only some members", () => {
  it("env alone: variables are read by name, everything else stays unavailable", async () => {
    poisonProcessEnv();
    const programs = await fakePrograms();
    const asked: string[] = [];
    const host: RuntimeHost = { label: "test", env: (name) => (asked.push(name), { SECRET_DESK_TEAM_TOKEN: "team_token_made_up_host", MADE_UP_HOST_VAR: "host_value_made_up", SECRET_DESK_BROWSER_CDP: "http://127.0.0.1:9", SECRET_DESK_BROWSER_VIEWER_URL: "http://host.invalid/v" }[name]) };
    const { rt, projects } = await setup({ host });
    expect((await rt.connections.token("env-conn")).reveal()).toBe("host_value_made_up");
    expect((await rt.connections.token("team-sync")).reveal()).toBe("team_token_made_up_host");
    expect(await rt.connections.status("op-conn")).toMatchObject({ connected: false, source: "op", hint: expect.stringContaining("nicht verfuegbar") });
    expect(rt.automation.viewerUrl).toBe("http://host.invalid/v");
    expect(asked).toEqual(expect.arrayContaining(["SECRET_DESK_TEAM_TOKEN", "SECRET_DESK_BROWSER_CDP", "SECRET_DESK_BROWSER_VIEWER_URL"]));
    const link = await setLink(rt, "acme-app", await gitFolder(projects, "acme-app"));
    expect(link.remote).toBeNull();
    const exported = await exportEnv(rt, human, { repo: "acme-app", runCommands: true, runValues: new Map(), prompts: {} });
    expect(exported).toMatchObject({ status: "written", skipped: ["ANON_KEY"] });
    if (!windows) expect(await programs.started()).toEqual([]);
  });

  it("the start-up sync takes its settings from the host of the runtime, and from nobody else", async () => {
    poisonProcessEnv();
    const host: RuntimeHost = { label: "t", env: (name) => ({ SECRET_DESK_TEAM_REPO: "acme/team-config", SECRET_DESK_TEAM_BRANCH: "dev" })[name] };
    const withHost = await setup({ host });
    await startupTeamSync(withHost.rt);
    expect(withHost.rt.config.teamSync).toMatchObject({ repo: "acme/team-config" });
    const without = await setup();
    await startupTeamSync(without.rt);
    expect(without.rt.config.teamSync).toBeUndefined();
    // An explicit `null` overrides the host of the runtime.
    const overridden = await setup({ host });
    await startupTeamSync(overridden.rt, null);
    expect(overridden.rt.config.teamSync).toBeUndefined();
  });

  it("a host that answers with something that is not text counts as not set", () => {
    const odd = { label: "t", env: () => ({ toString: () => "x" }) as unknown as string } satisfies RuntimeHost;
    expect(readHostEnv(odd, "ANY")).toBeUndefined();
    expect(readHostEnv(null, "ANY")).toBeUndefined();
    expect(readHostEnv(undefined, "ANY")).toBeUndefined();
    expect(readHostEnv({ label: "t" }, "ANY")).toBeUndefined();
    expect(readHostEnv({ label: "t", env: () => "value_made_up" }, "ANY")).toBe("value_made_up");
  });

  it("a host without gitOrigin, or one that answers badly, gives no remote", async () => {
    const { rt, projects } = await setup({ host: { label: "t", gitOrigin: async () => 7 as unknown as string } });
    const link = await setLink(rt, "acme-app", await gitFolder(projects, "acme-app"));
    expect(link.remote).toBeNull();
    expect(link.warnings).not.toContain("Der Remote des Ordners laesst sich in dieser Umgebung nicht pruefen.");
  });

  it("the host decides about commands and the Git check; they are asked with fixed values only", async () => {
    const calls: unknown[][] = [];
    const host: RuntimeHost = {
      label: "t",
      runCommand: async (command, cwd) => (calls.push(["run", command, cwd]), new Map([["ANON_KEY", "anon_from_host_made_up"]])),
      gitCheckIgnored: async (path) => (calls.push(["ignored", path]), true),
    };
    const { rt, projects } = await setup({ host });
    const folder = await gitFolder(projects, "acme-app");
    await writeFile(join(projects, "..", "links.json"), JSON.stringify({ version: 1, links: { "acme-app": folder } }));
    const exported = await exportEnv(rt, human, { repo: "acme-app", runCommands: true, runValues: new Map(), prompts: {} });
    expect(exported).toMatchObject({ status: "written", gitIgnored: true, warnings: [] });
    expect(calls).toEqual([["run", "supabase-status", folder], ["ignored", join(folder, ".env.local")]]);
    expect(await readFile(join(folder, ".env.local"), "utf8")).toContain("anon_from_host_made_up");
    // Not asked for when the human did not request commands, and never for an agent.
    calls.length = 0;
    await exportEnv(rt, human, { repo: "acme-app", overwrite: true, runValues: new Map(), prompts: {} });
    expect(calls.filter((c) => c[0] === "run")).toEqual([]);
  });
});

describe("the local edition", () => {
  it.skipIf(windows)("createLocalRuntime hands in the Node host: environment, Git and template commands behave as before", async () => {
    vi.stubEnv("MADE_UP_HOST_VAR", "local_env_value_made_up");
    vi.stubEnv("SECRET_DESK_TEAM_TOKEN", "local_team_token_made_up");
    const programs = await fakePrograms();
    const { rt, projects } = await setup({ host: "local" });
    expect(rt.host?.label).toBe("local process");
    expect((await rt.connections.token("env-conn")).reveal()).toBe("local_env_value_made_up");
    expect((await rt.connections.token("team-sync")).reveal()).toBe("local_team_token_made_up");
    expect((await rt.connections.token("op-conn")).reveal()).toBe("op_value_made_up");
    const folder = await gitFolder(projects, "acme-app");
    const link = await setLink(rt, "acme-app", folder);
    expect(link).toMatchObject({ remote: "git@github.com:acme/acme-app.git", remoteMatches: true, warnings: [] });
    await writeFile(join(projects, "..", "links.json"), JSON.stringify({ version: 1, links: { "acme-app": folder } }));
    const exported = await exportEnv(rt, human, { repo: "acme-app", runCommands: true, runValues: new Map(), prompts: {} });
    expect(exported).toMatchObject({ status: "written" });
    expect(await readFile(join(folder, ".env.local"), "utf8")).toContain("anon_made_up_value");
    const log = await programs.started();
    expect(log).toEqual(expect.arrayContaining(["op", "git", "supabase"]));
    expect((await stat(join(folder, ".env.local"))).isFile()).toBe(true);
  });

  it("nodeRuntimeHost offers every member and answers `env` only for own string properties", () => {
    const host = nodeRuntimeHost({ env: { MADE_UP_HOST_VAR: "v_made_up" } });
    expect(Object.keys(host).sort()).toEqual(["env", "gitCheckIgnored", "gitOrigin", "label", "readReference", "runCommand"]);
    expect(host.env?.("MADE_UP_HOST_VAR")).toBe("v_made_up");
    expect(host.env?.("toString")).toBeUndefined();
    expect(host.env?.("__proto__")).toBeUndefined();
  });

  it("nodeRuntimeHost refuses a template command that is not on the allow-list, before a process is started", async () => {
    const programs = await fakePrograms();
    const host = nodeRuntimeHost({ env: {} });
    for (const command of ["rm", "toString", "constructor", "__proto__", "supabase-status --x"]) {
      await expect(host.runCommand?.(command as never, tmpdir()), command).rejects.toThrow("Unknown template command.");
    }
    if (!windows) expect(await programs.started()).toEqual([]);
  });

  it("gitOrigin of the Node host gives null for a folder that is not a repository or when git fails", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "sd-host-nogit-")));
    vi.stubEnv("PATH", bin);
    expect(await nodeRuntimeHost().gitOrigin?.(tmpdir())).toBeNull();
  });
});
