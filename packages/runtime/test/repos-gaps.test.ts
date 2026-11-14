import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, NotConnectedError } from "@secret-desk/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { linkedFolder, listRepos, removeLink, renameInventoryRepo, scanLocal, setLink } from "../src/repos.js";
import { createLocalRuntime } from "../src/runtime.js";

// Git without user or system configuration, as in repos.test.ts.
const SAVED = { GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"], GIT_CONFIG_NOSYSTEM: process.env["GIT_CONFIG_NOSYSTEM"] };
beforeAll(() => {
  process.env["GIT_CONFIG_GLOBAL"] = devNull;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const INVENTORY = `version: 1
secrets:
  - { id: s1, name: S_ONE, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }, { repo: acme-app, scope: environment, environment: staging }] }
variables:
  - { id: v1, name: V_ONE, stage: shared, value: "x", places: [{ repo: acme-docs, scope: repository }, { repo: acme-docs, scope: environment, environment: staging }] }
envTemplates:
  - id: t1
    repo: acme-web
    stage: dev
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

async function setup(opts: { envRoots?: string[]; omitLinksFile?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-repos-gaps-")));
  const projects = join(dir, "projects");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  const linksFile = join(dir, "state", "links.json");
  const roots = opts.envRoots ?? [projects];
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(linksFile)}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${roots.map((r) => JSON.stringify(r)).join(", ")}]\n`);
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  return { rt, dir, projects, linksFile };
}

describe("link file handling", () => {
  it("a damaged links file is reported, a file without links or with bad entries is tolerated", async () => {
    const { rt, linksFile, dir } = await setup();
    await mkdir(join(dir, "state"));
    await writeFile(linksFile, "{ not json");
    await expect(removeLink(rt, "acme-app")).rejects.toThrow(/beschaedigt/);
    await writeFile(linksFile, "{}");
    expect(await removeLink(rt, "acme-app")).toEqual({ ok: true, removed: false });
    await writeFile(linksFile, JSON.stringify({ version: 1, links: { good: "/some/path", "bad name!": "/x", numeric: 5 } }));
    const list = await listRepos(rt);
    expect(list.repos.map((r) => r.name)).toContain("good");
    expect(list.repos.map((r) => r.name)).not.toContain("bad name!");
    expect(list.repos.map((r) => r.name)).not.toContain("numeric");
  });

  it("a link to a folder that vanished, or one outside the allowed roots, is not used", async () => {
    const { rt, linksFile, dir } = await setup();
    await mkdir(join(dir, "state"));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sd-outside-")));
    await writeFile(linksFile, JSON.stringify({ version: 1, links: { gone: join(dir, "projects", "missing"), outside, relative: "some/relative" } }));
    expect(await linkedFolder(rt, "gone")).toBeNull();
    expect(await linkedFolder(rt, "outside")).toBeNull();
    expect(await linkedFolder(rt, "relative")).toBeNull();
    expect(await linkedFolder(rt, "unknown")).toBeNull();
    const row = (await listRepos(rt)).repos.find((r) => r.name === "gone");
    expect(row?.link).toMatchObject({ exists: false, remote: null, remoteMatches: null });
  });
});

describe("setLink input checks", () => {
  it("rejects a missing path", async () => {
    const { rt } = await setup();
    await expect(setLink(rt, "acme-app", "   ")).rejects.toThrow("Der Pfad fehlt.");
    await expect(setLink(rt, "acme-app", undefined as never)).rejects.toThrow("Der Pfad fehlt.");
  });

  it("rejects paths the platform cannot use (Windows rules)", async () => {
    const { rt } = await setup();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(setLink(rt, "acme-app", "C:\\projects\\a?b")).rejects.toThrow(/Windows/);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("listRepos", () => {
  it("counts secrets, variables and templates per repository (each place repository once)", async () => {
    const { rt } = await setup();
    const rows = Object.fromEntries((await listRepos(rt)).repos.map((r) => [r.name, r]));
    expect(rows["acme-app"]).toMatchObject({ secrets: 1, variables: 0, templates: 0, inInventory: true });
    expect(rows["acme-docs"]).toMatchObject({ secrets: 0, variables: 1, templates: 0 });
    expect(rows["acme-web"]).toMatchObject({ secrets: 0, variables: 0, templates: 1 });
  });

  it("a failing GitHub listing never blocks: off without a connection, unavailable otherwise", async () => {
    const { rt } = await setup();
    const spy = vi.spyOn(rt.github, "listRepos");
    spy.mockRejectedValueOnce(new NotConnectedError("github", "Connect it"));
    expect((await listRepos(rt, { live: true })).github).toBe("off");
    spy.mockRejectedValueOnce(new GitHubError(500, "broken"));
    expect((await listRepos(rt, { live: true })).github).toBe("unavailable");
    spy.mockRejectedValueOnce(new Error("socket closed"));
    expect((await listRepos(rt, { live: true })).github).toBe("unavailable");
  });
});

describe("scanLocal", () => {
  it("skips missing roots, hidden and generated folders, files, and repeated origins", async () => {
    const { projects, rt } = await setup({ envRoots: [] });
    const missingRoot = join(projects, "does-not-exist");
    const real = join(projects, "real");
    await mkdir(real);
    await repoDir(real, "first", "git@github.com:acme/acme-app.git");
    await repoDir(real, "second-clone", "git@github.com:acme/acme-app.git");
    await repoDir(real, "foreign", "git@github.com:other/acme-lib.git");
    await repoDir(join(real, ".hidden"), "x", "git@github.com:acme/hidden-repo.git");
    await repoDir(join(real, "node_modules"), "y", "git@github.com:acme/vendored-repo.git");
    await repoDir(join(real, "a", "b", "c"), "too-deep", "git@github.com:acme/deep-repo.git");
    await writeFile(join(real, "loose-file.txt"), "x");
    rt.config.policy.envRoots.push(missingRoot, real);
    const found = await scanLocal(rt);
    expect(found.map((f) => f.name)).toEqual(["acme-app"]);
    expect(found[0]?.path.endsWith("first")).toBe(true);
  }, 30_000);

  it.skipIf(process.getuid?.() === 0)("an unreadable folder is skipped", async () => {
    const { projects, rt } = await setup({ envRoots: [] });
    const locked = join(projects, "locked");
    await mkdir(locked);
    await repoDir(projects, "open", "git@github.com:acme/open-repo.git");
    rt.config.policy.envRoots.push(projects);
    await chmod(locked, 0o000);
    try {
      expect((await scanLocal(rt)).map((f) => f.name)).toEqual(["open-repo"]);
    } finally {
      await chmod(locked, 0o700);
    }
  }, 30_000);
});

describe("renameInventoryRepo", () => {
  it("leaves the link alone when the new name already has one", async () => {
    const { rt, projects, linksFile } = await setup();
    const a = await repoDir(projects, "a");
    const b = await repoDir(projects, "b");
    await setLink(rt, "acme-docs", a);
    await setLink(rt, "acme-docs-new", b);
    const res = await renameInventoryRepo(rt, "acme-docs", "acme-docs-new");
    expect(res).toMatchObject({ from: "acme-docs", to: "acme-docs-new", linkMoved: false });
    expect(JSON.parse(await readFile(linksFile, "utf8")).links).toEqual({ "acme-docs": a, "acme-docs-new": b });
  });

  it("moves the link when only the old name has one", async () => {
    const { rt, projects, linksFile } = await setup();
    const a = await repoDir(projects, "a");
    await setLink(rt, "acme-docs", a);
    expect((await renameInventoryRepo(rt, "acme-docs", "acme-docs-new")).linkMoved).toBe(true);
    expect(JSON.parse(await readFile(linksFile, "utf8")).links).toEqual({ "acme-docs-new": a });
  });
});
