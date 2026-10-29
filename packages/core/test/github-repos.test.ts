import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, patProvider } from "../src/github.js";
import { SecretValue } from "../src/secret.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = (i: number) => ({ name: `r${i}`, private: i % 2 === 0, archived: false, default_branch: "main", pushed_at: "2026-10-01T00:00:00Z", html_url: "x" });
const client = (f: (url: string) => Response) => new GitHubClient({ auth: patProvider(new SecretValue("ghp_x")), fetch: vi.fn(async (u: string | URL | Request) => f(String(u))) as unknown as typeof fetch });

describe("GitHubClient.listRepos", () => {
  it("reads the organization path first and returns metadata only", async () => {
    const urls: string[] = [];
    const repos = await client((u) => { urls.push(u); return json([item(1), item(2)]); }).listRepos("acme");
    expect(urls).toEqual(["https://api.github.com/orgs/acme/repos?per_page=100&page=1"]);
    expect(repos).toEqual([
      { name: "r1", private: false, archived: false, defaultBranch: "main", pushedAt: "2026-10-01T00:00:00Z" },
      { name: "r2", private: true, archived: false, defaultBranch: "main", pushedAt: "2026-10-01T00:00:00Z" },
    ]);
  });

  it("falls back to the user path on 404", async () => {
    const urls: string[] = [];
    const repos = await client((u) => { urls.push(u); return u.includes("/orgs/") ? json({ message: "Not Found" }, 404) : json([item(1)]); }).listRepos("alice");
    expect(urls[1]).toBe("https://api.github.com/users/alice/repos?per_page=100&page=1");
    expect(repos.map((r) => r.name)).toEqual(["r1"]);
  });

  it("pages through several pages, five at most", async () => {
    const pages: number[] = [];
    const repos = await client((u) => { pages.push(Number(new URL(u).searchParams.get("page"))); return json(Array.from({ length: 100 }, (_, i) => item(i))); }).listRepos("o");
    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(repos).toHaveLength(500);
  });

  it("stops at a short page", async () => {
    const pages: number[] = [];
    const repos = await client((u) => { const p = Number(new URL(u).searchParams.get("page")); pages.push(p); return json(p === 1 ? Array.from({ length: 100 }, (_, i) => item(i)) : [item(1)]); }).listRepos("o");
    expect(pages).toEqual([1, 2]);
    expect(repos).toHaveLength(101);
  });

  it("passes on other errors", async () => {
    await expect(client(() => json({ message: "Bad credentials" }, 401)).listRepos("o")).rejects.toBeInstanceOf(GitHubError);
  });
});
