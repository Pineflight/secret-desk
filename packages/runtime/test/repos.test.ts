import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { linkedFolder, listRepos, parseGitRemote, removeLink, scanLocal, setLink } from "../src/repos.js";
import { createRuntime } from "../src/runtime.js";

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
variables: []
envTemplates:
  - id: wm-dev
    repo: wake-miles
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
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(linksFile)}\ngithub:\n  owner: Pineflight\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  agentStages: [dev]\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const fetchMock = (async (u: string | URL | Request) => github(String(u))) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock });
  return { rt, dir, projects, linksFile };
}

describe("parseGitRemote", () => {
  it("versteht https, ssh und scp-Form", () => {
    expect(parseGitRemote("https://github.com/Pineflight/wake-miles.git")).toEqual({ owner: "Pineflight", repo: "wake-miles" });
    expect(parseGitRemote("git@github.com:Pineflight/wake-miles.git")).toEqual({ owner: "Pineflight", repo: "wake-miles" });
    expect(parseGitRemote("ssh://git@github.com/Pineflight/wake-miles")).toEqual({ owner: "Pineflight", repo: "wake-miles" });
    expect(parseGitRemote("kaputt")).toBeNull();
  });
});

describe("Verknuepfen", () => {
  it("speichert den absoluten Pfad lokal mit Modus 600 (Ordner 700)", async () => {
    const { rt, projects, linksFile, dir } = await setup();
    const repo = await repoDir(projects, "wake-miles", "git@github.com:Pineflight/wake-miles.git");
    const r = await setLink(rt, "wake-miles", repo);
    expect(r).toMatchObject({ path: repo, remoteMatches: true, warnings: [] });
    if (process.platform !== "win32") expect((await stat(linksFile)).mode & 0o777).toBe(0o600); // Windows kennt keine POSIX-Modi
    if (process.platform !== "win32") expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700); // Windows kennt keine POSIX-Modi
    expect(JSON.parse(await readFile(linksFile, "utf8"))).toEqual({ version: 1, links: { "wake-miles": repo } });
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).not.toContain(repo);
    expect(await linkedFolder(rt, "wake-miles")).toBe(repo);
  });

  it("entfernt eine Verknuepfung", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "wake-miles", await repoDir(projects, "wake-miles"));
    expect(await removeLink(rt, "wake-miles")).toEqual({ ok: true, removed: true });
    expect(await linkedFolder(rt, "wake-miles")).toBeNull();
    expect(await removeLink(rt, "wake-miles")).toEqual({ ok: true, removed: false });
  });

  it("lehnt ungueltige Pfade ab", async () => {
    const { rt, projects, dir } = await setup();
    await expect(setLink(rt, "wake-miles", join(projects, "gibt-es-nicht"))).rejects.toThrow("Ordner existiert nicht");
    await expect(setLink(rt, "wake-miles", "relativ/pfad")).rejects.toThrow("absolut");
    await writeFile(join(projects, "datei"), "x");
    await expect(setLink(rt, "wake-miles", join(projects, "datei"))).rejects.toThrow("kein Ordner");
    await mkdir(join(projects, "ohne-git"));
    await expect(setLink(rt, "wake-miles", join(projects, "ohne-git"))).rejects.toThrow(".git fehlt");
    await expect(setLink(rt, "../boese", projects)).rejects.toThrow("Repository-Name");
    expect(await stat(join(dir, "state")).then(() => true, () => false)).toBe(false);
  });

  it("lehnt Pfade ausserhalb von Home und envRoots ab", async () => {
    const { rt } = await setup();
    const fremd = await repoDir(await realpath("/private/tmp"), `sd-fremd-${process.pid}`);
    try {
      await expect(setLink(rt, "wake-miles", fremd)).rejects.toThrow("ausserhalb");
      await expect(setLink(rt, "wake-miles", "/etc")).rejects.toThrow("ausserhalb");
    } finally {
      await rm(fremd, { recursive: true, force: true });
    }
  });

  it("warnt bei fremdem oder fehlendem Remote, blockiert aber nicht", async () => {
    const { rt, projects } = await setup();
    const fremd = await repoDir(projects, "a", "https://github.com/Andere/wake-miles.git");
    const r1 = await setLink(rt, "wake-miles", fremd);
    expect(r1.remoteMatches).toBe(false);
    expect(r1.warnings[0]).toContain("zeigt nicht auf Pineflight/wake-miles");
    const ohne = await repoDir(projects, "b");
    const r2 = await setLink(rt, "wake-miles", ohne);
    expect(r2.remote).toBeNull();
    expect(r2.warnings).toHaveLength(1);
  });
});

describe("Lokal suchen", () => {
  it("findet Git-Ordner mit passendem origin (Tiefe 2), sonst nichts", async () => {
    const { rt, projects } = await setup();
    const a = await repoDir(projects, "wake-miles", "git@github.com:Pineflight/wake-miles.git");
    const b = await repoDir(join(projects, "gruppe"), "lupe", "https://github.com/pineflight/lupe.git");
    await repoDir(projects, "fremd", "https://github.com/Andere/x.git");
    await repoDir(projects, "ohne-remote");
    await repoDir(join(projects, "x", "y"), "zu-tief", "https://github.com/Pineflight/zu-tief.git");
    await setLink(rt, "wake-miles", a);
    const found = await scanLocal(rt);
    expect(found).toEqual([
      { name: "lupe", path: b, remote: "https://github.com/pineflight/lupe.git", linked: false },
      { name: "wake-miles", path: a, remote: "git@github.com:Pineflight/wake-miles.git", linked: true },
    ]);
  });
});

describe("Liste", () => {
  it("fasst Inventar, Verknuepfungen und GitHub zusammen; GitHub-Fehler blockieren nicht", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "wake-miles", await repoDir(projects, "wake-miles", "git@github.com:Pineflight/wake-miles.git"));
    const off = await listRepos(rt);
    expect(off.github).toBe("off");
    expect(off.repos).toHaveLength(1);
    expect(off.repos[0]).toMatchObject({ name: "wake-miles", secrets: 1, variables: 0, templates: 1, inInventory: true, link: { exists: true, remoteMatches: true } });
    const failed = await listRepos(rt, { live: true });
    expect(failed.github).toBe("unavailable");
    expect(failed.repos.map((r) => r.name)).toEqual(["wake-miles"]);
  });

  it("markiert Repositories, die nur auf GitHub existieren", async () => {
    const { rt } = await setup(() => new Response(JSON.stringify([{ name: "nur-github", private: true, archived: false, default_branch: "main", pushed_at: null }, { name: "wake-miles" }]), { status: 200 }));
    const list = await listRepos(rt, { live: true });
    expect(list.github).toBe("ok");
    expect(list.repos.find((r) => r.name === "nur-github")).toMatchObject({ inInventory: false, github: { private: true }, link: null });
    expect(list.repos.find((r) => r.name === "wake-miles")?.inInventory).toBe(true);
  });

  it("zeigt Agenten keine Pfade", async () => {
    const { rt, projects } = await setup();
    await setLink(rt, "wake-miles", await repoDir(projects, "wake-miles"));
    expect((await listRepos(rt, { includePaths: false })).repos[0]?.link).toMatchObject({ path: null, exists: true });
  });
});

describe("Env-Export mit Verknuepfung", () => {
  it("nimmt <ordner>/<template.file> als Standardpfad", async () => {
    const { rt, projects } = await setup();
    const repo = await repoDir(projects, "wake-miles");
    await setLink(rt, "wake-miles", repo);
    const r = await exportEnv(rt, { kind: "human", name: "n" }, { repo: "wake-miles" });
    expect(r).toMatchObject({ status: "written", path: join(repo, ".env.local") });
    expect(await readFile(join(repo, ".env.local"), "utf8")).toContain("SITE_URL=");
  });

  it("verlangt Pfad oder Verknuepfung", async () => {
    const { rt } = await setup();
    await expect(exportEnv(rt, { kind: "human", name: "n" }, { repo: "wake-miles" })).rejects.toThrow("kein Ordner");
  });

  it("explizite Pfade ausserhalb der Wurzeln bleiben abgelehnt", async () => {
    const { rt, projects, dir } = await setup();
    await setLink(rt, "wake-miles", await repoDir(projects, "wake-miles"));
    await expect(exportEnv(rt, { kind: "human", name: "n" }, { repo: "wake-miles", path: join(dir, "anderswo", ".env") })).rejects.toThrow("ausserhalb");
  });
});
