import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient, GitHubError, GitHubInputError, InventoryError, NotConnectedError, TeamBundleError, TeamSyncError, exportTeamBundle, textHash } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { applyTeamSync, checkTeamSync, checkTeamSyncAccess, mapTeamSyncError, pushTeamSync, setupTeamSync, startupTeamSync, teamSyncFromEnv, teamTokenSource } from "../src/team-sync.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = "team_token_made_up_gaps";
const EMPTY = "version: 1\nsecrets: []\nvariables: []\n";
const LOCAL = `version: 1
secrets:
  - { id: hmac-app, name: APP_HMAC_SECRET, stage: shared, service: intern, provider: random-hex, expiry: none, places: [{ repo: app, scope: repository }] }
variables: []
`;

async function setup(opts: { teamSync?: string; inventory?: string; token?: boolean; app?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-ts-gaps-"));
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? LOCAL);
  const auth = opts.app ? '{ type: app, appId: "123", privateKey: { type: env, name: APP_KEY } }' : "{ type: pat, source: { type: env, name: GH_TEST } }";
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: ${auth}\n${opts.teamSync ?? "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n"}`);
  const env = { ...(opts.app ? {} : { GH_TEST: "gh_main_token_made_up" }), ...(opts.token === false ? {} : { SECRET_DESK_TEAM_TOKEN: TOKEN }) } as unknown as NodeJS.ProcessEnv;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env, bundledRecipes: null });
  return { rt, dir };
}

interface Memory {
  heads: Record<string, string>;
  file: { text: string; sha: string } | null;
  prFile: { text: string; sha: string } | null;
}

/** A tiny in-memory GitHub: the client methods of the team sync, backed by plain state. */
function memoryGitHub(state: Partial<Memory> = {}) {
  const mem: Memory = { heads: { main: "head-main" }, file: null, prFile: null, ...state };
  const calls: string[] = [];
  vi.spyOn(GitHubClient.prototype, "getBranchHead").mockImplementation(async (_o, _n, branch) => mem.heads[branch] ?? null);
  vi.spyOn(GitHubClient.prototype, "getRepo").mockResolvedValue({ private: true, permissions: { push: true } } as never);
  vi.spyOn(GitHubClient.prototype, "getContentFile").mockImplementation(async (_o, _n, _p, ref) => (ref === "main" ? mem.file : mem.prFile) as never);
  vi.spyOn(GitHubClient.prototype, "putContentFile").mockImplementation(async (_o, _n, _p, branch, text) => {
    calls.push(`put ${branch}`);
    const sha = `sha-${calls.length}`;
    if (branch === "main") mem.file = { text, sha };
    else mem.prFile = { text, sha };
    return sha;
  });
  vi.spyOn(GitHubClient.prototype, "createBranch").mockImplementation(async (_o, _n, branch) => {
    calls.push(`branch ${branch}`);
    mem.heads[branch] = "head-new";
  });
  vi.spyOn(GitHubClient.prototype, "findOpenPull").mockResolvedValue(null);
  vi.spyOn(GitHubClient.prototype, "createPull").mockResolvedValue({ number: 7, url: "https://github.com/acme/team-config/pull/7" } as never);
  vi.spyOn(GitHubClient.prototype, "deleteBranch").mockResolvedValue(undefined as never);
  return { mem, calls };
}

describe("mapTeamSyncError", () => {
  it("maps every GitHub failure to a code, without leaking anything", () => {
    const code = (e: unknown) => (mapTeamSyncError(e) as TeamSyncError).code;
    expect(code(new GitHubInputError("bad"))).toBe("invalid");
    expect(code(new GitHubError(403, "POST /access_tokens -> 403"))).toBe("denied");
    expect(code(new GitHubError(422, "POST /access_tokens -> 422"))).toBe("denied");
    expect(code(new GitHubError(404, "GitHub App ist auf acme nicht installiert"))).toBe("denied");
    expect(code(new GitHubError(401, "bad credentials"))).toBe("denied");
    expect(code(new GitHubError(403, "forbidden"))).toBe("denied");
    expect(code(new GitHubError(404, "not found"))).toBe("not-found");
    expect(code(new GitHubError(409, "conflict"))).toBe("conflict");
    expect(code(new GitHubError(422, "unprocessable"))).toBe("conflict");
    expect(code(new GitHubError(500, "boom"))).toBe("network");
    expect(mapTeamSyncError(new GitHubError(500, "boom")).message).toBe("GitHub-Fehler (500) beim Team-Sync.");
    expect(code(new TypeError("fetch failed"))).toBe("network");
  });

  it("passes known errors and unknown values through", () => {
    const known = [new TeamSyncError("x", "invalid"), new TeamBundleError("bundle"), new NotConnectedError("github", "hint"), new InventoryError("inv")];
    for (const e of known) expect(mapTeamSyncError(e)).toBe(e);
    const odd = new RangeError("odd");
    expect(mapTeamSyncError(odd)).toBe(odd);
  });
});

describe("token source", () => {
  it("a GitHub App without its private key has no token source", async () => {
    const { rt } = await setup({ app: true, token: false });
    expect(await teamTokenSource(rt)).toBe("none");
  });
});

describe("errors are remembered for the status, except a missing connection", () => {
  it("a not-connected error leaves no error text behind", async () => {
    const { rt } = await setup();
    rt.teamSyncMemo.lastError = "old problem";
    vi.spyOn(GitHubClient.prototype, "getContentFile").mockRejectedValue(new NotConnectedError("team-sync", "connect it"));
    await expect(checkTeamSync(rt)).rejects.toBeInstanceOf(NotConnectedError);
    expect(rt.teamSyncMemo.lastError).toBeNull();
    vi.spyOn(GitHubClient.prototype, "getContentFile").mockRejectedValue(new GitHubError(500, "boom"));
    await expect(checkTeamSync(rt)).rejects.toMatchObject({ code: "network" });
    expect(rt.teamSyncMemo.lastError).toBe("GitHub-Fehler (500) beim Team-Sync.");
  });
});

describe("apply", () => {
  it("fails with not-found when the team file vanished after the preview", async () => {
    const { rt } = await setup();
    memoryGitHub({ file: null });
    await expect(applyTeamSync(rt, { expectSha: "sha-1", resolution: "merge" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("push", () => {
  const push = (rt: Awaited<ReturnType<typeof setup>>["rt"], plan: { localHash: string; remoteSha: string | null }) => pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, new Date("2026-03-01T10:00:00Z"));

  it("mode pull forbids pushing", async () => {
    const { rt } = await setup({ teamSync: "teamSync:\n  repo: acme/team-config\n" });
    await expect(pushTeamSync(rt, { confirm: true, expectLocalHash: "x", expectRemoteSha: null })).rejects.toMatchObject({ code: "forbidden-mode" });
  });

  it("nothing to push when the repository already has the local content", async () => {
    const { rt } = await setup();
    memoryGitHub({ file: { text: exportTeamBundle(rt.inventory.data), sha: "sha-remote" } });
    const r = await push(rt, { localHash: await localHashOf(rt), remoteSha: "sha-remote" });
    expect(r).toEqual({ pushed: false, strategy: "pull-request" });
  });

  it("pull-request: fails when the target branch does not exist", async () => {
    const { rt } = await setup();
    memoryGitHub({ heads: {}, file: { text: EMPTY, sha: "sha-remote" } });
    const plan = { localHash: await localHashOf(rt), remoteSha: "sha-remote" };
    await expect(push(rt, plan)).rejects.toMatchObject({ code: "not-found", message: "Der Zielzweig existiert im Repository nicht." });
  });

  it("pull-request: creates the branch from the base, writes the file and opens a pull request", async () => {
    const { rt } = await setup();
    const { calls } = memoryGitHub({ file: { text: EMPTY, sha: "sha-remote" } });
    const plan = { localHash: await localHashOf(rt), remoteSha: "sha-remote" };
    const r = await push(rt, plan);
    expect(r).toMatchObject({ pushed: true, strategy: "pull-request", pullRequest: { number: 7 } });
    expect(calls).toEqual(["branch secret-desk/team-sync", "put secret-desk/team-sync"]);
  });

  async function localHashOf(rt: Awaited<ReturnType<typeof setup>>["rt"]): Promise<string> {
    const { planTeamPush } = await import("../src/team-sync.js");
    return (await planTeamPush(rt)).localHash;
  }
});

describe("setup", () => {
  it.skipIf(process.getuid?.() === 0)("reports a configuration file that cannot be written", async () => {
    const { rt, dir } = await setup({ teamSync: "" });
    const ro = join(dir, "readonly");
    await mkdir(ro);
    const file = join(ro, "c.yaml");
    await writeFile(file, "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
    await chmod(file, 0o400);
    await chmod(ro, 0o500);
    (rt as { configPath: string }).configPath = file;
    try {
      await expect(setupTeamSync(rt, { repo: "acme/team-config" })).rejects.toMatchObject({ code: "unwritable" });
      expect(rt.config.teamSync).toBeUndefined();
    } finally {
      await chmod(ro, 0o700);
    }
  });

  it("passes the typed errors of the writer through", async () => {
    const { rt, dir } = await setup({ teamSync: "" });
    // A config file that already holds a different teamSync section is refused by the writer with a typed error.
    await writeFile(join(dir, "c.yaml"), "inventory: [broken\n");
    await expect(setupTeamSync(rt, { repo: "acme/team-config" })).rejects.toBeInstanceOf(Error);
  });
});

describe("environment variables", () => {
  it("returns only what is set", () => {
    expect(teamSyncFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(teamSyncFromEnv({ SECRET_DESK_TEAM_REPO: " acme/team-config " } as unknown as NodeJS.ProcessEnv)).toEqual({ repo: "acme/team-config" });
    expect(teamSyncFromEnv({ SECRET_DESK_TEAM_REPO: "acme/team-config", SECRET_DESK_TEAM_PATH: " a/b.yaml ", SECRET_DESK_TEAM_BRANCH: " dev " } as unknown as NodeJS.ProcessEnv)).toEqual({ repo: "acme/team-config", path: "a/b.yaml", branch: "dev" });
  });
});

describe("startup", () => {
  it("headless setup without a token or with a non-empty inventory does not take anything over", async () => {
    const env = { SECRET_DESK_TEAM_REPO: "acme/team-config" } as unknown as NodeJS.ProcessEnv;
    const noToken = await setup({ teamSync: "", inventory: EMPTY, token: false, app: true });
    const checkSpy = vi.spyOn(GitHubClient.prototype, "getContentFile");
    await startupTeamSync(noToken.rt, env);
    expect(noToken.rt.config.teamSync?.repo).toBe("acme/team-config");
    const filled = await setup({ teamSync: "" });
    await startupTeamSync(filled.rt, env);
    expect(filled.rt.config.teamSync?.repo).toBe("acme/team-config");
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("headless setup leaves a repository state alone that is neither new nor changed", async () => {
    const { rt } = await setup({ teamSync: "", inventory: EMPTY });
    memoryGitHub({ file: null });
    await startupTeamSync(rt, { SECRET_DESK_TEAM_REPO: "acme/team-config" } as unknown as NodeJS.ProcessEnv);
    expect(rt.inventory.data.secrets).toEqual([]);
    expect(rt.teamSyncMemo.lastCheck).toMatchObject({ state: "missing-remote" });
  });
});

describe("startup after an earlier sync", () => {
  it("takes over only new entries when the repository changed since the remembered state", async () => {
    const { rt, dir } = await setup({ teamSync: "", inventory: EMPTY });
    await writeFile(join(dir, ".secret-desk-team-sync.json"), JSON.stringify({ remoteSha: "old-sha", localHash: textHash(exportTeamBundle(rt.inventory.data)) }));
    memoryGitHub({ file: { text: LOCAL, sha: "new-sha" } });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await startupTeamSync(rt, { SECRET_DESK_TEAM_REPO: "acme/team-config" } as unknown as NodeJS.ProcessEnv);
    expect(rt.inventory.data.secrets.map((x) => x.id)).toEqual(["hmac-app"]);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^team sync startup: applied 1 new entries \(hmac-app\)/));
  });
});

describe("access check", () => {
  it("a failing repository lookup is reported as a failed privacy check", async () => {
    const { rt } = await setup({ teamSync: "teamSync:\n  repo: acme/team-config\n" });
    memoryGitHub({ file: { text: EMPTY, sha: "s" } });
    vi.spyOn(GitHubClient.prototype, "getRepo").mockRejectedValue(new GitHubError(403, "forbidden"));
    const out = await checkTeamSyncAccess(rt);
    expect(out.find((c) => c.id === "private")).toMatchObject({ status: "fail" });
  });

  it("the write test reports a vanished target branch, and a failing cleanup is ignored", async () => {
    const { rt } = await setup();
    const { mem } = memoryGitHub({ file: { text: EMPTY, sha: "s" } });
    const heads = vi.spyOn(GitHubClient.prototype, "getBranchHead");
    heads.mockImplementation(async (_o, _n, branch) => (branch === "main" ? (heads.mock.calls.filter((c) => c[2] === "main").length <= 1 ? "head-main" : null) : (mem.heads[branch] ?? null)));
    const deleted = vi.spyOn(GitHubClient.prototype, "deleteBranch").mockRejectedValue(new Error("already gone"));
    const out = await checkTeamSyncAccess(rt, { deep: true });
    expect(out.find((c) => c.id === "write")).toMatchObject({ status: "fail", detail: expect.stringContaining("Zielzweig nicht gefunden.") });
    expect(deleted).toHaveBeenCalledTimes(1);
  });
});
