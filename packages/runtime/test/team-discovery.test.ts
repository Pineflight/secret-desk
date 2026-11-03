import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import {
  CONVENTIONAL_TEAM_FILE,
  checkTeamModeAccess,
  choosePreselectedRepo,
  chooseBranch,
  isTeamFilePath,
  listTeamBranches,
  listTeamFiles,
  listTeamRepos,
  nameHintsTeamRepo,
  selectTeamFiles,
  toRepoChoice,
  type RepoChoice,
} from "../src/team-discovery.js";

const PAT = "github_pat_made_up_discovery";
const OWN = "team_token_made_up_discovery";
const INSTALL_TOKEN = "ghs_made_up_discovery_install";
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FILE = "version: 1\nsecrets: []\nvariables: []\n";

const repo = (name: string, over: Partial<RepoChoice> = {}): RepoChoice => ({ owner: "acme", name, fullName: `acme/${name}`, private: true, archived: false, defaultBranch: "main", pushedAt: "2026-01-01T00:00:00Z", selectable: true, reason: null, ...over });

describe("pure rules", () => {
  it("name hints: team-config or secret-desk, any case", () => {
    expect(nameHintsTeamRepo("acme-team-config")).toBe(true);
    expect(nameHintsTeamRepo("My-Secret-Desk-Data")).toBe(true);
    expect(nameHintsTeamRepo("website")).toBe(false);
  });

  it("public repositories are listed but not selectable, with the reason", () => {
    const pub = toRepoChoice({ owner: "acme", name: "x", fullName: "acme/x", private: false, archived: false, defaultBranch: "main", pushedAt: null });
    expect(pub).toMatchObject({ selectable: false, reason: "public" });
    const priv = toRepoChoice({ owner: "acme", name: "y", fullName: "acme/y", private: true, archived: false, defaultBranch: "main", pushedAt: null });
    expect(priv).toMatchObject({ selectable: true, reason: null });
  });

  it("preselects the most recently pushed repository with a name hint", () => {
    const repos = [repo("web"), repo("team-config", { pushedAt: "2026-02-01T00:00:00Z" }), repo("secret-desk-team", { pushedAt: "2026-03-01T00:00:00Z" })];
    expect(choosePreselectedRepo(repos)).toBe("acme/secret-desk-team");
  });

  it("never preselects a public or archived repository", () => {
    expect(choosePreselectedRepo([repo("team-config", { selectable: false, reason: "public", private: false })])).toBeNull();
    expect(choosePreselectedRepo([repo("team-config", { archived: true })])).toBeNull();
  });

  it("without a name hint a repository that holds the team file is preselected", () => {
    const repos = [repo("a"), repo("b")];
    expect(choosePreselectedRepo(repos)).toBeNull();
    expect(choosePreselectedRepo(repos, new Set(["acme/b"]))).toBe("acme/b");
  });

  it("a name hint that also holds the file beats a name hint without it", () => {
    const repos = [repo("team-config", { pushedAt: "2026-05-01T00:00:00Z" }), repo("secret-desk-old", { pushedAt: "2026-01-01T00:00:00Z" })];
    expect(choosePreselectedRepo(repos, new Set(["acme/secret-desk-old"]))).toBe("acme/secret-desk-old");
  });

  it("branch: the default branch when it exists, else main, master, first", () => {
    expect(chooseBranch(["dev", "trunk"], "trunk")).toBe("trunk");
    expect(chooseBranch(["dev", "main"], "gone")).toBe("main");
    expect(chooseBranch(["dev", "master"], null)).toBe("master");
    expect(chooseBranch(["dev", "x"], null)).toBe("dev");
    expect(chooseBranch([], "main")).toBeNull();
  });

  it("file detection: conventional name, *.team.yaml and secret-desk/*.yaml", () => {
    for (const p of ["secret-desk.team.yaml", "ops/acme.team.yaml", "a.team.yml", "secret-desk/team.yaml"]) expect(isTeamFilePath(p), p).toBe(true);
    for (const p of ["package.json", "config.yaml", "secret-desk/deep/x.yaml", "team.yaml", "secret-desk.team.yaml.bak"]) expect(isTeamFilePath(p), p).toBe(false);
  });

  it("matching files are ordered: conventional name, then root files, then the rest", () => {
    expect(selectTeamFiles(["z/b.team.yaml", "other.txt", "secret-desk.team.yaml", "a.team.yaml", "secret-desk/x.yaml"])).toEqual(["secret-desk.team.yaml", "a.team.yaml", "secret-desk/x.yaml", "z/b.team.yaml"]);
  });
});

interface RepoDef {
  name: string;
  private: boolean;
  default_branch?: string;
  pushed_at?: string;
  push?: boolean;
  holdsFile?: boolean;
}

class Fake {
  auth: string[] = [];
  tokenRequests: Record<string, unknown>[] = [];
  paths: string[] = [];
  repos: RepoDef[] = [{ name: "team-config", private: true, pushed_at: "2026-02-01T00:00:00Z", push: true }];
  branches = ["main", "dev"];
  tree = ["README.md", "secret-desk.team.yaml"];
  reposStatus = 200;
  granted: Record<string, string> = { contents: "write", pull_requests: "write", metadata: "read" };
  validTokens = new Set<string>();
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const bearer = ((init?.headers as Record<string, string>)["Authorization"] ?? "").replace("Bearer ", "");
    this.auth.push(bearer);
    this.paths.push(`${method} ${url.pathname}`);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app/installations") return j([{ id: 7, account: { login: "acme" } }]);
    if (url.pathname === "/app/installations/7/access_tokens") {
      this.tokenRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      this.validTokens.add(INSTALL_TOKEN);
      return j({ token: INSTALL_TOKEN, expires_at: "2099-01-01T00:00:00Z", permissions: this.granted, repositories: [] }, 201);
    }
    if (!this.validTokens.has(bearer)) return j({ message: "Bad credentials" }, 401);
    const asApi = (r: RepoDef) => ({ name: r.name, owner: { login: "acme" }, private: r.private, archived: false, default_branch: r.default_branch ?? "main", pushed_at: r.pushed_at ?? null, permissions: { push: r.push ?? true } });
    if (url.pathname === "/user/repos" || url.pathname === "/installation/repositories") {
      if (this.reposStatus !== 200) return j({ message: "denied" }, this.reposStatus);
      const items = this.repos.map(asApi);
      return j(url.pathname === "/user/repos" ? items : { repositories: items });
    }
    const m = /^\/repos\/acme\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) return j({ message: "Not Found" }, 404);
    const def = this.repos.find((r) => r.name === m[1]);
    if (!def) return j({ message: "Not Found" }, 404);
    const rest = m[2] ?? "";
    if (rest === "") return j({ ...asApi(def), permissions: this.validTokens.has(INSTALL_TOKEN) && bearer === INSTALL_TOKEN ? undefined : { push: def.push ?? true } });
    if (rest === "branches") return j(this.branches.map((name) => ({ name })));
    if (rest.startsWith("git/ref/heads/")) return this.branches.includes(decodeURIComponent(rest.slice("git/ref/heads/".length))) ? j({ object: { sha: "head1" } }) : j({ message: "Not Found" }, 404);
    if (rest === "git/trees/head1") return j({ tree: this.tree.map((p) => ({ path: p, type: "blob" })), truncated: false });
    if (rest.startsWith("contents/")) return def.holdsFile ? j({ type: "file", sha: "s1", content: Buffer.from(FILE).toString("base64") }) : j({ message: "Not Found" }, 404);
    if (rest.startsWith("pulls")) return j([]);
    return j({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

async function setup(opts: { auth: "pat" | "app" | "none"; ownToken?: boolean; fake?: Fake }) {
  const fake = opts.fake ?? new Fake();
  if (opts.auth === "pat") fake.validTokens.add(PAT);
  if (opts.ownToken) fake.validTokens.add(OWN);
  const dir = await mkdtemp(join(tmpdir(), "sd-disc-"));
  await writeFile(join(dir, "inventory.yaml"), FILE);
  const authYaml = opts.auth === "app" ? '{ type: app, appId: "123", privateKey: { type: env, name: APP_KEY } }' : "{ type: pat, source: { type: env, name: GH_TEST } }";
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: ${authYaml}\n`);
  const env = { ...(opts.auth === "pat" ? { GH_TEST: PAT } : {}), ...(opts.auth === "app" ? { APP_KEY: PRIVATE_KEY } : {}), ...(opts.ownToken ? { SECRET_DESK_TEAM_TOKEN: OWN } : {}) } as unknown as NodeJS.ProcessEnv;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env, fetch: fake.fetch, bundledRecipes: null });
  return { rt, fake };
}

describe("missing integration", () => {
  it("every route reports no-integration with the rights it needs, and calls GitHub never", async () => {
    const { rt, fake } = await setup({ auth: "none" });
    const repos = await listTeamRepos(rt);
    expect(repos).toMatchObject({ source: "none", repos: [], preselected: null, problem: { code: "no-integration" } });
    expect(repos.problem?.neededRights).toContain("Contents: Read");
    expect(await listTeamBranches(rt, "acme/team-config")).toMatchObject({ problem: { code: "no-integration" } });
    expect(await listTeamFiles(rt, "acme/team-config", "main")).toMatchObject({ problem: { code: "no-integration" } });
    expect(await checkTeamModeAccess(rt, { repo: "acme/team-config", branch: "main", path: CONVENTIONAL_TEAM_FILE, mode: "pull" })).toMatchObject({ ok: false, problem: { code: "no-integration" } });
    expect(fake.paths).toEqual([]);
  });
});

describe("repository discovery", () => {
  it("lists with the PAT, marks public repositories and preselects by name", async () => {
    const fake = new Fake();
    fake.repos = [
      { name: "website", private: true, pushed_at: "2026-03-01T00:00:00Z" },
      { name: "team-config-public", private: false, pushed_at: "2026-04-01T00:00:00Z" },
      { name: "team-config", private: true, pushed_at: "2026-02-01T00:00:00Z" },
    ];
    const { rt } = await setup({ auth: "pat", fake });
    const r = await listTeamRepos(rt);
    expect(r.source).toBe("github-pat");
    expect(r.preselected).toBe("acme/team-config");
    expect(r.repos.map((x) => x.fullName)).toEqual(["acme/team-config-public", "acme/website", "acme/team-config"]);
    expect(r.repos.find((x) => x.name === "team-config-public")).toMatchObject({ selectable: false, reason: "public" });
    expect(new Set(fake.auth)).toEqual(new Set([PAT]));
    // A name hint is enough: no probing for the file.
    expect(fake.paths.some((p) => p.includes("/contents/"))).toBe(false);
  });

  it("without a name hint it probes the conventional file in a few repositories", async () => {
    const fake = new Fake();
    fake.repos = [
      { name: "alpha", private: true, pushed_at: "2026-03-01T00:00:00Z" },
      { name: "beta", private: true, pushed_at: "2026-02-01T00:00:00Z", holdsFile: true },
    ];
    const { rt } = await setup({ auth: "pat", fake });
    expect((await listTeamRepos(rt)).preselected).toBe("acme/beta");
    expect(fake.paths.filter((p) => p.includes("/contents/"))).toHaveLength(2);
  });

  it("probes at most five repositories", async () => {
    const fake = new Fake();
    fake.repos = Array.from({ length: 9 }, (_, i) => ({ name: `repo${i}`, private: true, pushed_at: `2026-01-0${i + 1}T00:00:00Z` }));
    const { rt } = await setup({ auth: "pat", fake });
    expect((await listTeamRepos(rt)).preselected).toBeNull();
    expect(fake.paths.filter((p) => p.includes("/contents/"))).toHaveLength(5);
  });

  it("with a GitHub App it lists the installation repositories with a metadata and contents read token", async () => {
    const { rt, fake } = await setup({ auth: "app" });
    const r = await listTeamRepos(rt);
    expect(r).toMatchObject({ source: "github-app", problem: null, preselected: "acme/team-config" });
    expect(fake.tokenRequests[0]).toEqual({ permissions: { metadata: "read", contents: "read" } });
    expect(fake.paths).toContain("GET /installation/repositories");
    expect(fake.paths).not.toContain("GET /user/repos");
  });

  it("an own token (the collapsed fallback) is used instead of the integration", async () => {
    const { rt, fake } = await setup({ auth: "pat", ownToken: true });
    await listTeamRepos(rt);
    expect(new Set(fake.auth)).toEqual(new Set([OWN]));
  });

  it("a rejected or too weak token becomes a problem, not an exception", async () => {
    const fake = new Fake();
    fake.reposStatus = 403;
    const { rt } = await setup({ auth: "pat", fake });
    expect(await listTeamRepos(rt)).toMatchObject({ repos: [], problem: { code: "missing-permission" } });
    fake.reposStatus = 401;
    expect(await listTeamRepos(rt)).toMatchObject({ problem: { code: "token-rejected" } });
  });

  it("an App without the contents right reports the missing permission", async () => {
    const fake = new Fake();
    const original = fake.fetch;
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith("/access_tokens") ? new Response(JSON.stringify({ message: "not granted" }), { status: 422 }) : original(input, init))) as typeof fetch;
    const { rt } = await setup({ auth: "app", fake: Object.assign(fake, { fetch: wrapped }) });
    expect(await listTeamRepos(rt)).toMatchObject({ problem: { code: "missing-permission" } });
  });

  it("the token never appears in a result", async () => {
    const { rt } = await setup({ auth: "pat" });
    expect(JSON.stringify(await listTeamRepos(rt))).not.toContain(PAT);
  });
});

describe("branches and files", () => {
  it("lists branches and preselects the default branch", async () => {
    const fake = new Fake();
    fake.repos = [{ name: "team-config", private: true, default_branch: "dev" }];
    const { rt } = await setup({ auth: "pat", fake });
    expect(await listTeamBranches(rt, "acme/team-config")).toMatchObject({ branches: ["main", "dev"], defaultBranch: "dev", problem: null });
  });

  it("finds team files on the branch, conventional name first", async () => {
    const fake = new Fake();
    fake.tree = ["ops/b.team.yaml", "README.md", "secret-desk.team.yaml", "package.json"];
    const { rt } = await setup({ auth: "pat", fake });
    expect(await listTeamFiles(rt, "acme/team-config", "main")).toMatchObject({ files: ["secret-desk.team.yaml", "ops/b.team.yaml"], preselected: "secret-desk.team.yaml", canCreate: false });
  });

  it("offers to create the conventional file when none matches", async () => {
    const fake = new Fake();
    fake.tree = ["README.md"];
    const { rt } = await setup({ auth: "pat", fake });
    expect(await listTeamFiles(rt, "acme/team-config", "main")).toMatchObject({ files: [], preselected: null, canCreate: true, createPath: "secret-desk.team.yaml" });
  });

  it("an unknown branch has no files", async () => {
    const { rt } = await setup({ auth: "pat" });
    expect(await listTeamFiles(rt, "acme/team-config", "nope")).toMatchObject({ files: [], canCreate: true });
  });

  it("rejects malformed repository and branch input before any request", async () => {
    const { rt, fake } = await setup({ auth: "pat" });
    await expect(listTeamBranches(rt, "../x")).rejects.toThrow(/owner\/name/);
    await expect(listTeamFiles(rt, "acme/team-config", "a..b")).rejects.toThrow(/Zweig/);
    expect(fake.paths).toEqual([]);
  });
});

describe("permission check per mode", () => {
  const input = { repo: "acme/team-config", branch: "main", path: CONVENTIONAL_TEAM_FILE };

  it("read only needs Contents: Read and passes", async () => {
    const { rt } = await setup({ auth: "pat" });
    const a = await checkTeamModeAccess(rt, { ...input, mode: "pull" });
    expect(a).toMatchObject({ ok: true, mode: "pull", neededRights: ["Contents: Read", "Metadata: Read"] });
    expect(a.checks.some((c) => c.id === "push")).toBe(false);
  });

  it("read and write shows the push rights and checks push permission (user token with push)", async () => {
    const { rt } = await setup({ auth: "pat" });
    const a = await checkTeamModeAccess(rt, { ...input, mode: "pull-push", strategy: "direct" });
    expect(a.neededRights).toEqual(["Contents: Read and write", "Metadata: Read"]);
    expect(a.checks.find((c) => c.id === "push")).toMatchObject({ status: "pass" });
    expect(a.ok).toBe(true);
  });

  it("read and write with pull requests also needs Pull requests", async () => {
    const { rt } = await setup({ auth: "pat" });
    const a = await checkTeamModeAccess(rt, { ...input, mode: "pull-push", strategy: "pull-request" });
    expect(a.neededRights).toContain("Pull requests: Read and write");
  });

  it("a token without push permission fails the write mode but not the read mode", async () => {
    const fake = new Fake();
    fake.repos = [{ name: "team-config", private: true, push: false }];
    const { rt } = await setup({ auth: "pat", fake });
    const write = await checkTeamModeAccess(rt, { ...input, mode: "pull-push" });
    expect(write.ok).toBe(false);
    expect(write.checks.find((c) => c.id === "push")).toMatchObject({ status: "fail" });
    expect((await checkTeamModeAccess(rt, { ...input, mode: "pull" })).ok).toBe(true);
  });

  it("a GitHub App that was granted only read fails the write mode", async () => {
    const fake = new Fake();
    fake.granted = { contents: "read", metadata: "read" };
    const { rt } = await setup({ auth: "app", fake });
    const write = await checkTeamModeAccess(rt, { ...input, mode: "pull-push", strategy: "direct" });
    expect(write.ok).toBe(false);
    expect(write.checks.find((c) => c.id === "granted")).toMatchObject({ status: "fail" });
    expect(write.checks.find((c) => c.id === "push")).toMatchObject({ status: "fail" });
    // The installation token is requested for this repository with exactly the rights of the mode.
    expect(fake.tokenRequests[0]).toEqual({ repositories: ["team-config"], permissions: { contents: "write", metadata: "read" } });
  });

  it("a public repository fails the private check in every mode", async () => {
    const fake = new Fake();
    fake.repos = [{ name: "team-config", private: false }];
    const { rt } = await setup({ auth: "pat", fake });
    const a = await checkTeamModeAccess(rt, { ...input, mode: "pull" });
    expect(a.ok).toBe(false);
    expect(a.checks.find((c) => c.id === "private")).toMatchObject({ status: "fail" });
  });

  it("rejects an unknown mode", async () => {
    const { rt } = await setup({ auth: "pat" });
    await expect(checkTeamModeAccess(rt, { ...input, mode: "everything" })).rejects.toThrow(/ungueltig/);
  });
});
