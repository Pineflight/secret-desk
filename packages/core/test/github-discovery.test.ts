import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubInputError, SecretValue } from "../src/index.js";

function client(handler: (path: string) => unknown, calls: string[] = []) {
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    const body = handler(u.pathname + u.search);
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return new GitHubClient({ auth: async () => new SecretValue("t"), fetch: f });
}

describe("GitHubClient discovery reads", () => {
  it("listVisibleRepos: user repos, owner from the payload, newest push first, paginated", async () => {
    const calls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, owner: { login: "acme" }, private: true, pushed_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` }));
    const gh = client((p) => (p.endsWith("&page=1") ? page1 : p.endsWith("&page=2") ? [{ name: "last", owner: { login: "other" }, private: false, pushed_at: "2030-01-01T00:00:00Z", default_branch: "dev" }] : undefined), calls);
    const { repos, truncated } = await gh.listVisibleRepos("user");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/user/repos?per_page=100");
    expect(truncated).toBe(false);
    expect(repos).toHaveLength(101);
    expect(repos[0]).toMatchObject({ fullName: "other/last", private: false, defaultBranch: "dev" });
  });

  it("listVisibleRepos: installation repositories come wrapped, truncation is reported after ten pages", async () => {
    const full = { repositories: Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, owner: { login: "acme" } })) };
    const gh = client(() => full);
    const r = await gh.listVisibleRepos("installation");
    expect(r.truncated).toBe(true);
    expect(r.repos).toHaveLength(1000);
  });

  it("listBranches reads names", async () => {
    const gh = client(() => [{ name: "main" }, { name: "dev" }]);
    expect(await gh.listBranches("acme", "team-config")).toEqual({ names: ["main", "dev"], truncated: false });
  });

  it("listFilePaths resolves the branch head and keeps only files; unknown branch is null", async () => {
    const gh = client((p) => (p.startsWith("/repos/acme/x/git/ref/heads/main") ? { object: { sha: "h1" } } : p.startsWith("/repos/acme/x/git/trees/h1") ? { tree: [{ path: "a.yaml", type: "blob" }, { path: "dir", type: "tree" }], truncated: true } : undefined));
    expect(await gh.listFilePaths("acme", "x", "main")).toEqual({ paths: ["a.yaml"], truncated: true });
    expect(await gh.listFilePaths("acme", "x", "nope")).toBeNull();
  });

  it("rejects unsafe names before any request", async () => {
    const calls: string[] = [];
    const gh = client(() => [], calls);
    await expect(gh.listBranches("acme", "..")).rejects.toBeInstanceOf(GitHubInputError);
    await expect(gh.listFilePaths("acme", "x", "a..b")).rejects.toBeInstanceOf(GitHubInputError);
    expect(calls).toEqual([]);
  });

  it("getRepo returns the default branch", async () => {
    const gh = client(() => ({ private: true, default_branch: "trunk", permissions: { push: true } }));
    expect(await gh.getRepo("acme", "x")).toMatchObject({ private: true, defaultBranch: "trunk" });
  });
});
