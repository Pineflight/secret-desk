import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, NotConnectedError } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareStages } from "../src/compare.js";
import { createRuntime } from "../src/runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const INVENTORY = `version: 1
secrets:
  - { id: web-key, name: API_KEY, stage: shared, service: x, expiry: none, places: [{ repo: web, scope: repository }] }
variables: []
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-cmp-err-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  vi.spyOn(rt.github, "listSecrets").mockResolvedValue([]);
  vi.spyOn(rt.github, "listVariables").mockResolvedValue([]);
  vi.spyOn(rt.github, "listEnvironments").mockResolvedValue([]);
  vi.spyOn(rt.github, "listRepos").mockResolvedValue([
    { name: "web", private: true, archived: false, pushedAt: null },
    { name: "orphan", private: true, archived: false, pushedAt: null },
  ] as never);
  return rt;
}

describe("compareStages read errors", () => {
  it("a thrown non-Error becomes the error text of the cell, a GitHubError keeps its status", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listSecrets").mockRejectedValueOnce("plain failure text");
    const r = await compareStages(rt, { live: true });
    expect(JSON.stringify(r)).toContain("plain failure text");
  });

  it("a plain Error becomes the error text without a status", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listSecrets").mockRejectedValueOnce(new Error("socket hang up"));
    const r = await compareStages(rt, { live: true });
    expect(JSON.stringify(r)).toContain("socket hang up");
  });

  it("not connected fails the whole call", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listSecrets").mockRejectedValue(new NotConnectedError("github", "Connect it"));
    await expect(compareStages(rt, { live: true })).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe("compareStages with allRepos", () => {
  it("not connected on the repository list fails the call; other errors become an error entry", async () => {
    const rt = await setup();
    const list = vi.spyOn(rt.github, "listRepos");
    list.mockRejectedValueOnce(new NotConnectedError("github", "Connect it"));
    await expect(compareStages(rt, { live: true, allRepos: true })).rejects.toBeInstanceOf(NotConnectedError);
    list.mockRejectedValueOnce(new Error("repo list broke"));
    const r = await compareStages(rt, { live: true, allRepos: true });
    expect(r.errors).toContainEqual({ target: "repositories", message: "repo list broke" });
    list.mockRejectedValueOnce("repo list text");
    const r2 = await compareStages(rt, { live: true, allRepos: true });
    expect(r2.errors).toContainEqual({ target: "repositories", message: "repo list text" });
  });

  it("not connected while listing environments fails the call", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listEnvironments").mockRejectedValue(new NotConnectedError("github", "Connect it"));
    await expect(compareStages(rt, { live: true, allRepos: true })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("unreadable environments become notes (Error, GitHubError, plain text)", async () => {
    const rt = await setup();
    const envs = vi.spyOn(rt.github, "listEnvironments");
    envs.mockRejectedValueOnce(new Error("env list broke"));
    expect(JSON.stringify(await compareStages(rt, { live: true, allRepos: true }))).toContain("env list broke");
    envs.mockRejectedValueOnce(new GitHubError(403, "env forbidden"));
    expect(JSON.stringify(await compareStages(rt, { live: true, allRepos: true }))).toContain("env forbidden");
    envs.mockRejectedValueOnce("env list text");
    expect(JSON.stringify(await compareStages(rt, { live: true, allRepos: true }))).toContain("env list text");
  });

  it("a repository without inventory entry that GitHub answers 404 for is a read error, not empty", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listSecrets").mockImplementation(async (target) => {
      if (target.repo === "orphan") throw new GitHubError(404, "Not Found");
      return [];
    });
    const r = await compareStages(rt, { live: true, allRepos: true });
    expect(JSON.stringify(r)).toContain("Repository nicht gefunden oder dem Token nicht freigegeben");
  });

  it("an extra repository's environments are read when they exist", async () => {
    const rt = await setup();
    vi.spyOn(rt.github, "listEnvironments").mockImplementation(async (_owner, repo) => (repo === "orphan" ? ["preview"] : []));
    const secrets = vi.spyOn(rt.github, "listSecrets");
    await compareStages(rt, { live: true, allRepos: true });
    expect(secrets.mock.calls.some(([t]) => t.repo === "orphan" && t.scope === "environment" && t.environment === "preview")).toBe(true);
  });
});
