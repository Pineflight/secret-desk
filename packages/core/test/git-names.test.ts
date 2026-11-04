import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubInputError, TeamSyncSchema, isSafeContentPath, isSafeRepoSegment, isValidBranchName } from "../src/index.js";

describe("git name validators", () => {
  it("accepts normal names", () => {
    expect(isSafeRepoSegment(".github")).toBe(true);
    expect(isSafeContentPath("team/desk.yaml")).toBe(true);
    expect(isValidBranchName("secret-desk/team-sync")).toBe(true);
  });
  it("rejects dot segments and unsafe values", () => {
    expect(isSafeRepoSegment("..")).toBe(false);
    expect(isSafeRepoSegment(".")).toBe(false);
    expect(isSafeRepoSegment("a/b")).toBe(false);
    for (const p of ["", "..", "../x", "a/../b", "/a", "a//b", "a\\b", "a/./b", "a\nb", "../..", "./.."]) expect(isSafeContentPath(p), p).toBe(false);
    for (const b of ["", "@", "..", "a..b", "a@{b", "-x", "a/", "/a", "a.lock", "a/.b", "a b", "a^b", "../..", ".", "./x"]) expect(isValidBranchName(b), b).toBe(false);
  });
});

describe("TeamSyncSchema", () => {
  it("rejects traversal in repo, path and branches", () => {
    expect(TeamSyncSchema.safeParse({ repo: "../.." }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/." }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", path: "../../x" }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", path: "../.." }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", branch: "../.." }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", branch: "." }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", push: { branch: "." } }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", branch: "../x" }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "acme/x", push: { branch: "a/../b" } }).success).toBe(false);
  });
});

describe("GitHubClient input validation (fail closed, no request)", () => {
  function client() {
    const calls: string[] = [];
    const fetchFn = (async (u: string) => { calls.push(String(u)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const auth = async () => ({ reveal: () => "tok_made_up_value" }) as never;
    return { gh: new GitHubClient({ auth, fetch: fetchFn }), calls };
  }
  it("rejects bad owner, name, path and branch in every team sync call", async () => {
    const { gh, calls } = client();
    const bad: (() => Promise<unknown>)[] = [
      () => gh.getContentFile("..", "r", "p", "main"),
      () => gh.getContentFile("o", ".", "p", "main"),
      () => gh.getContentFile("o", "r", "../x", "main"),
      () => gh.getContentFile("o", "r", "../..", "main"),
      () => gh.getContentFile("o", "r", "p", "../.."),
      () => gh.getContentFile("o", "r", "p", "."),
      () => gh.getContentFile("o", "r", "p", "../main"),
      () => gh.putContentFile("o", "r", "a/../b", "main", "t", "m"),
      () => gh.putContentFile("o", "r", "p", "a/../b", "t", "m"),
      () => gh.getBranchHead("o", "..", "main"),
      () => gh.getBranchHead("o", "r", ".."),
      () => gh.createBranch("o", "r", "a..b", "sha"),
      () => gh.deleteBranch("..", "r", "main"),
      () => gh.deleteBranch("o", "r", "."),
      () => gh.getRepo("o", ".."),
    ];
    for (const f of bad) await expect(f()).rejects.toBeInstanceOf(GitHubInputError);
    expect(calls).toEqual([]);
  });
});
