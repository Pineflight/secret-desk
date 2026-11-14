import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError, NotConnectedError } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportEnv, getAutomation, requestIssuance } from "../src/agent-api.js";
import { BrowserNotAvailableError } from "../src/automation.js";
import { HostCapabilityError, expandHomeFor, hostHome, nodeRuntimeHost, readHostEnv, type RuntimeHost } from "../src/host.js";
import { linksPath, listRepos, scanLocal, setLink } from "../src/repos.js";
import { createLocalRuntime, createRuntime } from "../src/runtime.js";
import { getSettings } from "../src/settings.js";
import { startupTeamSync } from "../src/team-sync.js";

// While `blocked` is set, every function of the child-process module that starts something throws and is recorded. The fake
// programs on PATH below are the second line: they leave a trace when something starts a process by any other route.
const spawnGuard = vi.hoisted(() => ({ blocked: false, calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const guard = <F extends (...args: never[]) => unknown>(name: string, fn: F): F =>
    ((...args: never[]) => {
      if (spawnGuard.blocked) {
        spawnGuard.calls.push(name);
        throw new Error(`blocked: ${name}`);
      }
      return fn(...args);
    }) as F;
  return {
    ...real,
    execFile: guard("execFile", real.execFile),
    execFileSync: guard("execFileSync", real.execFileSync),
    exec: guard("exec", real.exec),
    execSync: guard("execSync", real.execSync),
    spawn: guard("spawn", real.spawn),
    spawnSync: guard("spawnSync", real.spawnSync),
    fork: guard("fork", real.fork),
  };
});

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
  spawnGuard.blocked = false;
  spawnGuard.calls.length = 0;
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

/**
 * The YAML parser we depend on looks at two debug switches of its own (`LOG_TOKENS`, `LOG_STREAM`) every time it parses; that is
 * a third-party diagnostic flag, not a configuration path, and it cannot be turned off from here. Everything else counts.
 */
const THIRD_PARTY_DEBUG_SWITCHES = new Set(["LOG_TOKENS", "LOG_STREAM"]);
const ownReads = (reads: string[]): string[] => [...new Set(reads.filter((r) => !THIRD_PARTY_DEBUG_SWITCHES.has(r)))];

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

  it("the child-process guard blocks and records the starters the host uses", async () => {
    spawnGuard.blocked = true;
    await expect(nodeRuntimeHost({ env: {} }).gitOrigin?.(tmpdir())).rejects.toThrow("blocked: execFile");
    expect(spawnGuard.calls).toEqual(["execFile"]);
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
    expect(Object.keys(host).sort()).toEqual(["connectRemoteBrowser", "env", "findChrome", "gitCheckIgnored", "gitOrigin", "homeDir", "label", "launchLocalBrowser", "openVault", "readReference", "runCommand"]);
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

  it("the Node host hands git a filtered environment: system basics and the Git switches, never provider tokens", async () => {
    vi.stubEnv("GH_TEST", "poison_github_token_made_up");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
    const bin = await realpath(await mkdtemp(join(tmpdir(), "sd-host-envgit-")));
    const dump = join(bin, "env.txt");
    await writeFile(join(bin, "git"), `#!/bin/sh\nenv > "${dump}"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${delimiter}/usr/bin${delimiter}/bin`);
    const host = nodeRuntimeHost();
    await host.gitOrigin?.(tmpdir());
    const seen = await readFile(dump, "utf8");
    expect(seen).not.toContain("GH_TEST");
    expect(seen).not.toContain("poison_github_token_made_up");
    expect(seen).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(seen).toContain("GIT_TERMINAL_PROMPT=0");
    await rm(dump);
    await host.gitCheckIgnored?.(join(tmpdir(), "x.env"));
    expect(await readFile(dump, "utf8")).not.toContain("GH_TEST");
  });
});

const RECIPE = `# STATUS: not checked against the real site
id: sample-token
label: Sample
host: example.test
login:
  expect: { url: "^https://example\\\\.test/tokens" }
  message: Please sign in
steps:
  - goto: "https://example.test/tokens/new?name={{name}}"
  - click: { role: button, name: Create, createsToken: true }
capture:
  token:
    find: { css: "#tok" }
    pattern: "^(tok_[a-z0-9]+)$"
    timeoutSeconds: 0.05
  externalId: { from: name }
  expires: { from: days }
mask: [{ css: "#tok" }]
`;

const DEFAULTS_INVENTORY = `version: 1
secrets:
  - { id: sample-b, name: SAMPLE_B, stage: dev, service: example, provider: sample-token-browser, expiry: none, places: [{ repo: acme-app, scope: repository }] }
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

/** A configuration that sets neither `vault` nor `automation`, so both are on (the defaults), with a recipe and a connection of each kind. */
async function prepareDefaults(extra = ""): Promise<{ dir: string; path: string; projects: string; outside: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-host-defaults-")));
  const projects = join(dir, "projects");
  const outside = join(dir, "outside");
  await mkdir(projects);
  await mkdir(outside);
  await mkdir(join(dir, "recipes"));
  await writeFile(join(dir, "recipes", "sample.yaml"), RECIPE);
  await writeFile(join(dir, "inventory.yaml"), DEFAULTS_INVENTORY);
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
      "policy:",
      `  envRoots: [${JSON.stringify(projects)}]`,
      extra,
      "",
    ].join("\n"),
  );
  return { dir, path: join(dir, "c.yaml"), projects, outside };
}

describe("a runtime without a host, from a configuration with the defaults", () => {
  it.skipIf(windows)("reads no environment variable and starts no process, on any path that used to", async () => {
    poisonProcessEnv();
    const programs = await fakePrograms();
    const { path, projects } = await prepareDefaults();
    const folder = await gitFolder(projects, "acme-app");
    await writeFile(join(projects, "..", "links.json"), JSON.stringify({ version: 1, links: { "acme-app": folder } }));
    const fetchMock = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    const watch = watchProcessEnv();
    spawnGuard.blocked = true;
    let out: Awaited<ReturnType<typeof exercise>>;
    try {
      out = await exercise();
    } finally {
      spawnGuard.blocked = false;
      watch.stop();
    }
    expect(ownReads(watch.reads)).toEqual([]);
    expect(spawnGuard.calls).toEqual([]);
    expect(await programs.started()).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/poison_/);

    async function exercise() {
      // No `vault`, no `automationDriver`, no host: the configuration asks for a vault and automation, the runtime offers neither.
      const rt = await createRuntime(path, { bundledRecipes: undefined, fetch: fetchMock });
      const vault = rt.connections.vault;
      const token = await rt.connections.token("env-conn").catch((e: unknown) => e);
      const github = await rt.connections.status("github");
      const exported = await exportEnv(rt, human, { repo: "acme-app", runCommands: true, runValues: new Map(), prompts: {} });
      const link = await setLink(rt, "acme-app", folder);
      const found = await scanLocal(rt);
      const info = rt.automation.info();
      const status = await rt.automation.status();
      const settings = getSettings(rt);
      const recipeRun = await requestIssuance(rt, human, "sample-b").then(
        () => null,
        (e: unknown) => e,
      );
      const driver = await Promise.resolve()
        .then(() => rt.automation.newDriver())
        .then(
          () => null,
          (e: unknown) => e,
        );
      return { vault, token, github, exported, link, found, info, status, settings, recipeRun, driver, recipes: rt.automation.recipes.length };
    }
    expect(out.vault).toBeUndefined();
    expect(out.token).toBeInstanceOf(NotConnectedError);
    expect(out.github).toMatchObject({ connected: false });
    expect(out.exported).toMatchObject({ status: "written", skipped: ["ANON_KEY"] });
    expect(out.link.warnings).toEqual(["Der Remote des Ordners laesst sich in dieser Umgebung nicht pruefen."]);
    expect(out.found).toEqual([]);
    expect(out.recipes).toBeGreaterThan(1); // the bundled recipes and the sample one are loaded; only starting a browser is refused
    expect(out.info.chrome).toEqual({ found: false, path: null, hint: "A browser is not available in this environment." });
    expect(out.info.browser).toMatchObject({ mode: "local", detail: "A browser is not available in this environment." });
    expect(out.status.browser.detail).toBe("A browser is not available in this environment.");
    expect(out.settings.vault).toEqual({ enabled: false, file: "", keySourceLabel: null });
    expect(out.recipeRun).toBeInstanceOf(Error);
    expect(out.driver).toBeInstanceOf(BrowserNotAvailableError);
    expect(out.driver).toMatchObject({ mode: "local", kind: "browser-unavailable" });
  });
});

describe("the browser capability", () => {
  it("a configured remote endpoint is refused without the host's remote capability, and not even probed", async () => {
    poisonProcessEnv();
    const { path } = await prepareDefaults("automation: { cdpEndpoint: \"http://127.0.0.1:9\" }");
    const rt = await createRuntime(path, { bundledRecipes: null });
    const info = rt.automation.info();
    expect(info.browser).toMatchObject({ mode: "remote", reachable: false, detail: "A browser is not available in this environment." });
    expect((await rt.automation.status()).browser).toMatchObject({ reachable: false, detail: "A browser is not available in this environment." });
    expect(info.chrome.hint).toContain("remote browser");
    await expect(Promise.resolve().then(() => rt.automation.newDriver())).rejects.toMatchObject({ mode: "remote", name: "BrowserNotAvailableError" });
    // A local-only host does not make the remote endpoint available either.
    const localOnly = await createRuntime(path, { bundledRecipes: null, host: { label: "t", launchLocalBrowser: () => new FakeDriver({ url: "about:blank" }) } });
    await expect(Promise.resolve().then(() => localOnly.automation.newDriver())).rejects.toMatchObject({ mode: "remote" });
  });

  it("the host decides: remote and local drivers come from its members, with fixed values", async () => {
    const seen: unknown[] = [];
    const host: RuntimeHost = {
      label: "t",
      homeDir: () => "/home/made-up",
      connectRemoteBrowser: (o) => (seen.push(["remote", o]), new FakeDriver({ url: "about:blank" })),
      launchLocalBrowser: (o) => (seen.push(["local", o]), new FakeDriver({ url: "about:blank" })),
      findChrome: (preferred) => ({ path: preferred ?? null, hint: null }),
    };
    const remote = await prepareDefaults("automation: { cdpEndpoint: \"http://127.0.0.1:9\", slowMoMs: 5 }");
    const rtRemote = await createRuntime(remote.path, { bundledRecipes: null, host });
    expect(await rtRemote.automation.newDriver()).toBeInstanceOf(FakeDriver);
    expect(rtRemote.automation.info().browser).toMatchObject({ mode: "remote", detail: null });
    const local = await prepareDefaults("automation: { chromePath: /opt/made-up/chrome, profileDir: ~/made-up-profile }");
    const rtLocal = await createRuntime(local.path, { bundledRecipes: null, host });
    expect(await rtLocal.automation.newDriver()).toBeInstanceOf(FakeDriver);
    expect(rtLocal.automation.info().chrome).toEqual({ found: true, path: "/opt/made-up/chrome", hint: null });
    expect(seen).toEqual([
      ["remote", { cdpEndpoint: "http://127.0.0.1:9", slowMoMs: 5 }],
      ["local", { chromePath: "/opt/made-up/chrome", profileDir: "/home/made-up/made-up-profile" }],
    ]);
  });

  it("a host that finds no Chrome or throws while looking reports it without failing", async () => {
    const { path } = await prepareDefaults();
    const missing = await createRuntime(path, { bundledRecipes: null, host: { label: "t", findChrome: () => ({ path: null, hint: "install it" }) } });
    expect(missing.automation.info().chrome).toEqual({ found: false, path: null, hint: "install it" });
    const broken = await createRuntime(path, { bundledRecipes: null, host: { label: "t", findChrome: () => { throw new Error("lookup failed"); } } });
    expect(broken.automation.info().chrome).toEqual({ found: false, path: null, hint: "lookup failed" });
  });

  it("a local browser with a `~` profile needs the host's home folder", async () => {
    const { path } = await prepareDefaults();
    const host: RuntimeHost = { label: "t", launchLocalBrowser: () => new FakeDriver({ url: "about:blank" }) };
    const rt = await createRuntime(path, { bundledRecipes: null, host });
    expect(rt.automation.profileDir).toBe("");
    await expect(Promise.resolve().then(() => rt.automation.newDriver())).rejects.toBeInstanceOf(HostCapabilityError);
    const chrome = await prepareDefaults("automation: { chromePath: ~/chrome, profileDir: /abs/made-up-profile }");
    const rtChrome = await createRuntime(chrome.path, { bundledRecipes: null, host });
    expect(rtChrome.automation.profileDir).toBe("/abs/made-up-profile");
    await expect(Promise.resolve().then(() => rtChrome.automation.newDriver())).rejects.toBeInstanceOf(HostCapabilityError);
  });

  it("a test driver factory still works without a host", async () => {
    const { path } = await prepareDefaults();
    const rt = await createRuntime(path, { bundledRecipes: null, automationDriver: () => new FakeDriver({ url: "about:blank" }) });
    expect(await rt.automation.newDriver()).toBeInstanceOf(FakeDriver);
    expect(rt.automation.info().browser.detail).toBeNull();
  });

  it("recipe folders with `~` and no home folder are reported as a problem, not a crash", async () => {
    const { path } = await prepareDefaults("automation: { recipesDirs: [\"~/recipes\"] }");
    const rt = await createRuntime(path, { bundledRecipes: null });
    expect(rt.automation.problems.map((p) => p.file)).toContain("~/recipes");
  });
});

describe("the vault capability", () => {
  it("the default vault comes from the host's openVault, with expanded paths, and not at all without it", async () => {
    const opened: unknown[] = [];
    const host: RuntimeHost = { label: "t", homeDir: () => "/home/made-up", openVault: (o) => (opened.push(o), undefined as never) };
    const { path } = await prepareDefaults("vault: { file: ~/v.json, keyFile: ~/v.key }");
    await createRuntime(path, { bundledRecipes: null, host });
    expect(opened).toEqual([{ file: "/home/made-up/v.json", keyFile: "/home/made-up/v.key" }]);
    const plain = await prepareDefaults();
    await createRuntime(plain.path, { bundledRecipes: null, host });
    expect(opened[1]).toEqual({});
    expect(opened).toHaveLength(2);
    const noOpener = await createRuntime(plain.path, { bundledRecipes: null, host: { label: "t", env: () => undefined } });
    expect(noOpener.connections.vault).toBeUndefined();
  });

  it("an explicit vault (or null) wins over the host and the host's opener is not called", async () => {
    const opener = vi.fn(() => undefined as never);
    const { path } = await prepareDefaults();
    const rt = await createRuntime(path, { bundledRecipes: null, host: { label: "t", openVault: opener }, vault: null });
    expect(rt.connections.vault).toBeUndefined();
    expect(opener).not.toHaveBeenCalled();
  });

  it("a `~` vault file without a home folder is refused when the host would open it", async () => {
    const { path } = await prepareDefaults("vault: { file: ~/v.json }");
    await expect(createRuntime(path, { bundledRecipes: null, host: { label: "t", openVault: () => undefined as never } })).rejects.toBeInstanceOf(HostCapabilityError);
  });

  it("the local edition opens the vault through the Node host", async () => {
    const { dir, path } = await prepareDefaults(`vault: { file: ${JSON.stringify("PLACEHOLDER")} }`);
    const file = join(dir, "vault.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"PLACEHOLDER"', JSON.stringify(file)));
    const rt = await createLocalRuntime(path, { bundledRecipes: null, env: { SECRET_DESK_VAULT_KEY: "made_up_vault_key_32_bytes_long!!" } as never });
    expect(rt.connections.vault).toBeDefined();
  });
});

describe("the home folder", () => {
  it("expands `~` with the host's home folder and refuses it without one", () => {
    expect(expandHomeFor({ label: "t", homeDir: () => "/home/made-up" }, "~/x")).toBe("/home/made-up/x");
    expect(expandHomeFor({ label: "t", homeDir: () => "/home/made-up" }, "~")).toBe("/home/made-up");
    expect(expandHomeFor(undefined, "/abs/x")).toBe("/abs/x");
    expect(expandHomeFor(undefined, "~other/x")).toBe("~other/x");
    expect(() => expandHomeFor(undefined, "~/x")).toThrow(HostCapabilityError);
    expect(() => expandHomeFor({ label: "t", homeDir: () => "" }, "~")).toThrow("Home-Ordner");
    expect(hostHome({ label: "t", homeDir: () => 7 as never })).toBeUndefined();
  });

  it("without a host the home folder of the process is not an allowed root and not a default location", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-host-home-")));
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    const projects = join(dir, "work");
    await mkdir(projects);
    await mkdir(join(dir, "inv"));
    await writeFile(join(dir, "inv", "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
    await writeFile(join(dir, "inv", "c.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
    const repo = await gitFolder(projects, "acme-app");
    const rt = await createRuntime(join(dir, "inv", "c.yaml"), { vault: null, bundledRecipes: null });
    // Under the process home, but nobody gave the runtime a home folder or a root: refused.
    await expect(setLink(rt, "acme-app", repo)).rejects.toThrow("ausserhalb des Home-Ordners");
    await expect(setLink(rt, "acme-app", "~/work/acme-app")).rejects.toBeInstanceOf(InventoryError);
    expect(() => linksPath(rt)).toThrow(HostCapabilityError);
    expect(await listRepos(rt)).toMatchObject({ repos: [] });
    expect(getSettings(rt).linksFile).toBe("");
    // The local edition: the same folder is under the home folder of the Node host.
    const local = await createLocalRuntime(join(dir, "inv", "c.yaml"), { vault: null, bundledRecipes: null });
    expect(linksPath(local)).toBe(join(dir, ".secret-desk", "repo-links.json"));
    await mkdir(join(dir, ".secret-desk"));
    await expect(setLink(local, "acme-app", repo)).resolves.toMatchObject({ path: repo });
  });

  it("persisting the sign-in memory needs a place: a links file, or a host with a home folder", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-host-persist-")));
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
    await writeFile(join(dir, "c.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
    await expect(createRuntime(join(dir, "c.yaml"), { vault: null, bundledRecipes: null, persistSignIn: true })).rejects.toBeInstanceOf(HostCapabilityError);
    await writeFile(join(dir, "c2.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "state", "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    await expect(createRuntime(join(dir, "c2.yaml"), { vault: null, bundledRecipes: null, persistSignIn: true })).resolves.toBeDefined();
    await expect(createRuntime(join(dir, "c.yaml"), { vault: null, bundledRecipes: null, persistSignIn: true, host: { label: "t", homeDir: () => dir } })).resolves.toBeDefined();
  });

  it("settings show `~` paths as configured when the host has no home folder", async () => {
    const { path } = await prepareDefaults("evidenceDir: ~/evidence");
    const rt = await createRuntime(path, { vault: null, bundledRecipes: null });
    expect(getSettings(rt).evidenceDir).toBe("~/evidence");
  });
});

describe("template commands run only where they may", () => {
  it.skipIf(windows)("a command is not started in a folder outside policy.envRoots, even with a planted binary", async () => {
    const programs = await fakePrograms();
    const { path, outside } = await prepareDefaults();
    const bin = join(outside, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "supabase"), `#!/bin/sh\necho planted >> "${programs.marker}"\necho ANON_KEY=planted_made_up\n`, { mode: 0o755 });
    const rt = await createLocalRuntime(path, { vault: null, bundledRecipes: null });
    await expect(exportEnv(rt, human, { repo: "acme-app", path: join(outside, ".env.local"), runCommands: true, runValues: new Map(), prompts: {} })).rejects.toThrow("ausserhalb der erlaubten Ordner");
    expect(await programs.started()).toEqual([]);
    expect(await stat(join(outside, ".env.local")).then(() => true, () => false)).toBe(false);
  });

  it.skipIf(windows)("inside the roots the same command starts, so the check is the only difference", async () => {
    const programs = await fakePrograms();
    const { path, projects } = await prepareDefaults();
    const rt = await createLocalRuntime(path, { vault: null, bundledRecipes: null });
    const result = await exportEnv(rt, human, { repo: "acme-app", path: join(projects, ".env.local"), runCommands: true, runValues: new Map(), prompts: {} });
    expect(result).toMatchObject({ status: "written", warnings: expect.not.arrayContaining([expect.stringContaining("nur in einem Ordner")]) });
    expect(await programs.started()).toContain("supabase");
  });

  it.skipIf(windows)("with no roots configured only the linked folder may run commands", async () => {
    const programs = await fakePrograms();
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-host-noroots-")));
    await writeFile(join(dir, "inventory.yaml"), DEFAULTS_INVENTORY);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    const loose = join(dir, "loose");
    await mkdir(loose);
    const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, bundledRecipes: null });
    const result = await exportEnv(rt, human, { repo: "acme-app", path: join(loose, ".env.local"), runCommands: true, runValues: new Map(), prompts: {} });
    expect(result).toMatchObject({ status: "written", skipped: ["ANON_KEY"] });
    if (result.status === "written") expect(result.warnings).toContain("Befehle der Vorlage laufen nur in einem Ordner unter policy.envRoots oder im verknuepften Ordner; die betroffenen Werte bleiben leer.");
    expect(await programs.started()).not.toContain("supabase");
  });

  it.skipIf(windows)("a node_modules link that leads out of the folder is not the repository's own binary", async () => {
    const programs = await fakePrograms();
    const { path, projects, outside } = await prepareDefaults();
    await mkdir(join(outside, ".bin"), { recursive: true });
    await writeFile(join(outside, ".bin", "supabase"), `#!/bin/sh\necho planted-link >> "${programs.marker}"\necho ANON_KEY=planted_made_up\n`, { mode: 0o755 });
    await symlink(outside, join(projects, "node_modules"));
    const rt = await createLocalRuntime(path, { vault: null, bundledRecipes: null });
    const result = await exportEnv(rt, human, { repo: "acme-app", path: join(projects, ".env.local"), runCommands: true, runValues: new Map(), prompts: {} });
    expect(result.status).toBe("written");
    expect(await programs.started()).not.toContain("planted-link");
  });
});
