import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { linkedFolder, listRepos, parseGitRemote, removeLink, scanLocal, setLink } from "../src/repos.js";
import { createRuntime } from "../src/runtime.js";

// Git ohne Benutzer-/Systemkonfiguration (url.insteadOf, init.templateDir, Hooks ...): gilt auch fuer die Aufrufe der Runtime.
const GIT_ENV_SAVED = { GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"], GIT_CONFIG_NOSYSTEM: process.env["GIT_CONFIG_NOSYSTEM"] };
beforeAll(() => {
  process.env["GIT_CONFIG_GLOBAL"] = devNull;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV_SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

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
variables: []
envTemplates:
  - id: wm-dev
    repo: acme-app
    stage: dev
    file: .env.local
    entries:
      - { key: SITE_URL, from: { type: default, value: "http://localhost:3000" } }
`;

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
async function repoDir(parent: string, name: string, origin?: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
  return realpath(dir);
}

async function setup(github: (url: string) => Response = () => new Response(JSON.stringify({ message: "x" }), { status: 500 })) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-repos-")));
  const projects = join(dir, "projekte");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  const linksFile = join(dir, "state", "links.json");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(linksFile)}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const fetchMock = (async (u: string | URL | Request) => github(String(u))) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock });
  return { rt, dir, projects, linksFile };
}

describe("parseGitRemote", () => {
  it("versteht https, ssh und scp-Form", () => {
    expect(parseGitRemote("https://github.com/acme/acme-app.git")).toEqual({ owner: "acme", repo: "acme-app" });
    expect(parseGitRemote("git@github.com:acme/acme-app.git")).toEqual({ owner: "acme", repo: "acme-app" });
    expect(parseGitRemote("ssh://git@github.com/acme/acme-app")).toEqual({ owner: "acme", repo: "acme-app" });
    expect(parseGitRemote("kaputt")).toBeNull();
  });
});

describe("Verknuepfen", () => {
  it("speichert den absoluten Pfad lokal mit Modus 600 (Ordner 700)", async () => {
    const { rt, projects, linksFile, dir } = await setup();
    const repo = await repoDir(projects, "acme-app", "git@github.com:acme/acme-app.git");
    const r = await setLink(rt, "acme-app", repo);
    expect(r).toMatchObject({ path: repo, remoteMatches: true, warnings: [] });
    if (process.platform !== "win32") expect((await stat(linksFile)).mode & 0o777).toBe(0o600); // Windows kennt keine POSIX-Modi
    if (process.platform !== "win32") expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700); // Windows kennt keine POSIX-Modi
    expect(JSON.parse(await readFile(linksFile, "utf8"))).toEqual({ version: 1, links: { "acme-app": repo } });
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).not.toContain(repo);
    expect(await linkedFolder(rt, "acme-app")).toBe(repo);
  });

  it("entfernt eine Verknuepfung", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "acme-app", await repoDir(projects, "acme-app"));
    expect(await removeLink(rt, "acme-app")).toEqual({ ok: true, removed: true });
    expect(await linkedFolder(rt, "acme-app")).toBeNull();
    expect(await removeLink(rt, "acme-app")).toEqual({ ok: true, removed: false });
  });

  it("lehnt ungueltige Pfade ab", async () => {
    const { rt, projects, dir } = await setup();
    await expect(setLink(rt, "acme-app", join(projects, "gibt-es-nicht"))).rejects.toThrow("Ordner existiert nicht");
    await expect(setLink(rt, "acme-app", "relativ/pfad")).rejects.toThrow("absolut");
    await writeFile(join(projects, "datei"), "x");
    await expect(setLink(rt, "acme-app", join(projects, "datei"))).rejects.toThrow("kein Ordner");
    await mkdir(join(projects, "ohne-git"));
    await expect(setLink(rt, "acme-app", join(projects, "ohne-git"))).rejects.toThrow(".git fehlt");
    await expect(setLink(rt, "../boese", projects)).rejects.toThrow("Repository-Name");
    expect(await stat(join(dir, "state")).then(() => true, () => false)).toBe(false);
  });

  it("lehnt Pfade ausserhalb von Home und envRoots ab", async () => {
    const { rt } = await setup();
    // Ein eigener Temp-Ordner (nicht /tmp fest); ausserhalb von Home liegt er, solange das Home nicht darueber liegt.
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sd-fremd-")));
    const fremd = await repoDir(outside, "fremd");
    const savedHome = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
    process.env["HOME"] = join(outside, "..", "sd-home-unrelated");
    process.env["USERPROFILE"] = process.env["HOME"];
    try {
      await expect(setLink(rt, "acme-app", fremd)).rejects.toThrow("ausserhalb");
      await expect(setLink(rt, "acme-app", "/etc")).rejects.toThrow("ausserhalb");
    } finally {
      for (const [k, v] of Object.entries(savedHome)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("warnt bei fremdem oder fehlendem Remote, blockiert aber nicht", async () => {
    const { rt, projects } = await setup();
    const fremd = await repoDir(projects, "a", "https://github.com/Andere/acme-app.git");
    const r1 = await setLink(rt, "acme-app", fremd);
    expect(r1.remoteMatches).toBe(false);
    expect(r1.warnings[0]).toContain("zeigt nicht auf acme/acme-app");
    const ohne = await repoDir(projects, "b");
    const r2 = await setLink(rt, "acme-app", ohne);
    expect(r2.remote).toBeNull();
    expect(r2.warnings).toHaveLength(1);
  });
});

describe("Lokal suchen", () => {
  it("findet Git-Ordner mit passendem origin (Tiefe 2), sonst nichts", async () => {
    const { rt, projects } = await setup();
    const a = await repoDir(projects, "acme-app", "git@github.com:acme/acme-app.git");
    const b = await repoDir(join(projects, "gruppe"), "acme-api", "https://github.com/acme/acme-api.git");
    await repoDir(projects, "fremd", "https://github.com/Andere/x.git");
    await repoDir(projects, "ohne-remote");
    await repoDir(join(projects, "x", "y"), "zu-tief", "https://github.com/acme/zu-tief.git");
    await setLink(rt, "acme-app", a);
    const found = await scanLocal(rt);
    expect(found).toEqual([
      { name: "acme-api", path: b, remote: "https://github.com/acme/acme-api.git", linked: false },
      { name: "acme-app", path: a, remote: "git@github.com:acme/acme-app.git", linked: true },
    ]);
  });
});

describe("Liste", () => {
  it("fasst Inventar, Verknuepfungen und GitHub zusammen; GitHub-Fehler blockieren nicht", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "acme-app", await repoDir(projects, "acme-app", "git@github.com:acme/acme-app.git"));
    const off = await listRepos(rt);
    expect(off.github).toBe("off");
    expect(off.repos).toHaveLength(1);
    expect(off.repos[0]).toMatchObject({ name: "acme-app", secrets: 1, variables: 0, templates: 1, inInventory: true, link: { exists: true, remoteMatches: true } });
    const failed = await listRepos(rt, { live: true });
    expect(failed.github).toBe("unavailable");
    expect(failed.repos.map((r) => r.name)).toEqual(["acme-app"]);
  });

  it("markiert Repositories, die nur auf GitHub existieren", async () => {
    const { rt } = await setup(() => new Response(JSON.stringify([{ name: "nur-github", private: true, archived: false, default_branch: "main", pushed_at: null }, { name: "acme-app" }]), { status: 200 }));
    const list = await listRepos(rt, { live: true });
    expect(list.github).toBe("ok");
    expect(list.repos.find((r) => r.name === "nur-github")).toMatchObject({ inInventory: false, github: { private: true }, link: null });
    expect(list.repos.find((r) => r.name === "acme-app")?.inInventory).toBe(true);
  });

  it("zeigt Agenten keine Pfade", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "acme-app", await repoDir(projects, "acme-app"));
    expect((await listRepos(rt, { includePaths: false })).repos[0]?.link).toMatchObject({ path: null, exists: true });
  });
});

describe("Env-Export mit Verknuepfung", () => {
  it("nimmt <ordner>/<template.file> als Standardpfad", async () => {
    const { rt, projects } = await setup();
    const repo = await repoDir(projects, "acme-app");
    await setLink(rt, "acme-app", repo);
    const r = await exportEnv(rt, { kind: "human", name: "n" }, { repo: "acme-app" });
    expect(r).toMatchObject({ status: "written", path: join(repo, ".env.local") });
    expect(await readFile(join(repo, ".env.local"), "utf8")).toContain("SITE_URL=");
  });

  it("verlangt Pfad oder Verknuepfung", async () => {
    const { rt } = await setup();
    await expect(exportEnv(rt, { kind: "human", name: "n" }, { repo: "acme-app" })).rejects.toThrow("kein Ordner");
  });

  it("explizite Pfade ausserhalb der Wurzeln bleiben abgelehnt", async () => {
    const { rt, projects, dir } = await setup();
    await setLink(rt, "acme-app", await repoDir(projects, "acme-app"));
    await expect(exportEnv(rt, { kind: "human", name: "n" }, { repo: "acme-app", path: join(dir, "anderswo", ".env") })).rejects.toThrow("ausserhalb");
  });
});
