import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, GitHubTruncatedError, SecretValue, githubAppProvider, patProvider } from "../src/index.js";

type Call = { method: string; url: string; body?: unknown; headers: Record<string, string>; redirect?: string };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers });
const empty = (status = 204): Response => new Response(null, { status });

function setup(handler: (call: Call) => Response | Promise<Response>, extra: { sleep?: (ms: number) => Promise<void>; maxRetryWaitMs?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(url).replace("https://api.github.com", ""), headers: init?.headers as Record<string, string>, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), ...(init?.redirect ? { redirect: init.redirect } : {}) };
    calls.push(call);
    return handler(call);
  };
  const gh = new GitHubClient({ auth: patProvider(new SecretValue("made-up-token")), fetch: fetchImpl as never, sleep: async () => undefined, ...extra });
  return { gh, calls };
}
const repo = { owner: "acme", repo: "web", scope: "repository" as const };
const org = { owner: "acme", repo: "", scope: "organization" as const };
const items = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));

describe("paths and scopes", () => {
  it("an organization is addressed by its own paths; secrets and variables get visibility selected on creation", async () => {
    const { gh, calls } = setup((c) => (c.method === "PATCH" ? json({ message: "Not Found" }, 404) : c.url.includes("/secrets?") ? json({}) : empty(201)));
    expect(await gh.listSecrets(org)).toEqual([]);
    expect(await gh.putEncrypted(org, "NAME", "enc", "k")).toBe("created");
    expect(await gh.putVariable(org, "NAME", "v")).toBe("created");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /orgs/acme/actions/secrets?per_page=100&page=1", "PUT /orgs/acme/actions/secrets/NAME", "PATCH /orgs/acme/actions/variables/NAME", "POST /orgs/acme/actions/variables"]);
    expect(calls[1]!.body).toMatchObject({ visibility: "selected" });
    expect(calls[3]!.body).toMatchObject({ visibility: "selected" });
  });

  it("an environment target needs a name", async () => {
    const { gh } = setup(() => json({}));
    await expect(gh.listSecrets({ owner: "acme", repo: "web", scope: "environment" })).rejects.toThrow(new GitHubError(0, "environment fehlt"));
  });

  it("uses the global fetch and a real timer by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ message: "slow" }, 429, { "retry-after": "0" })).mockResolvedValueOnce(json({ secrets: [] }));
    try {
      expect(await new GitHubClient({ auth: patProvider(new SecretValue("t")) }).listSecrets(repo)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("lists", () => {
  it("secrets and variables: missing keys give empty lists; full pages are followed; too many entries are an error", async () => {
    const { gh } = setup(() => json({}));
    expect(await gh.listSecrets(repo)).toEqual([]);
    expect(await gh.listVariables(repo)).toEqual([]);
    const full = setup((c) => json({ secrets: items(100, (i) => ({ name: `S_${c.url}_${i}`, created_at: "c", updated_at: "u" })) }));
    await expect(full.gh.listSecrets(repo)).rejects.toBeInstanceOf(GitHubTruncatedError);
    const fullVars = setup((c) => json({ variables: items(30, (i) => ({ name: `V_${c.url}_${i}`, value: "v", created_at: "c", updated_at: "u" })) }));
    await expect(fullVars.gh.listVariables(repo)).rejects.toThrow("Variablen hat mehr als 600");
  });

  it("environments: with and without the list", async () => {
    expect(await setup(() => json({ environments: [{ name: "staging" }] })).gh.listEnvironments("acme", "web")).toEqual(["staging"]);
    expect(await setup(() => json({})).gh.listEnvironments("acme", "web")).toEqual([]);
  });

  it("repositories: organization first, then the user; defaults for missing fields; other errors pass on", async () => {
    const { gh, calls } = setup((c) => (c.url.startsWith("/orgs/") ? json({ message: "Not Found" }, 404) : json([{ name: "a" }, { name: "b", private: true, archived: true, default_branch: "main", pushed_at: "2026-03-01" }])));
    expect(await gh.listRepos("acme")).toEqual([
      { name: "a", private: false, archived: false, defaultBranch: null, pushedAt: null },
      { name: "b", private: true, archived: true, defaultBranch: "main", pushedAt: "2026-03-01" },
    ]);
    expect(calls.map((c) => c.url.split("?")[0])).toEqual(["/orgs/acme/repos", "/users/acme/repos"]);
    await expect(setup(() => json({ message: "boom" }, 500)).gh.listRepos("acme")).rejects.toThrow(GitHubError);
    const pages = setup((c) => json(items(100, (i) => ({ name: `r${c.url}${i}` }))));
    expect((await pages.gh.listRepos("acme")).length).toBe(500);
  });

  describe("visible repositories", () => {
    it("reads a user list (array) and an installation list (object); the owner comes from owner.login or full_name; entries without owner or name are skipped", async () => {
      const user = setup(() => json([{ name: "a", owner: { login: "me" }, pushed_at: "2026-01-01" }, { name: "b", full_name: "org/b", private: true, archived: true, default_branch: "dev", pushed_at: "2026-02-01" }, { name: "c" }, { owner: { login: "me" } }]));
      const r = await user.gh.listVisibleRepos("user");
      expect(r.repos.map((x) => x.fullName)).toEqual(["org/b", "me/a"]);
      expect(r.repos[0]).toMatchObject({ private: true, archived: true, defaultBranch: "dev" });
      expect(r.repos[1]).toMatchObject({ private: false, archived: false, defaultBranch: null });
      expect(r.truncated).toBe(false);
      expect(user.calls[0]!.url).toContain("/user/repos?");
      const inst = setup(() => json({ repositories: [{ name: "x", owner: { login: "o" } }] }));
      expect((await inst.gh.listVisibleRepos("installation")).repos).toHaveLength(1);
      expect(inst.calls[0]!.url).toContain("/installation/repositories?");
      expect((await setup(() => json({})).gh.listVisibleRepos("installation")).repos).toEqual([]);
    });
    it("says when more than ten pages exist; a repo without a push time sorts last", async () => {
      const many = setup((c) => json(items(100, (i) => ({ name: `r${c.url.length}-${i}`, owner: { login: "o" } }))));
      const r = await many.gh.listVisibleRepos("user");
      expect(r.truncated).toBe(true);
      expect(r.repos).toHaveLength(1000);
    });
  });

  it("branches: names only, full pages are followed, the cut is reported", async () => {
    const { gh } = setup(() => json([{ name: "main" }, { nope: true }]));
    expect(await gh.listBranches("acme", "web")).toEqual({ names: ["main"], truncated: false });
    const many = setup((c) => json(items(100, (i) => ({ name: `b${c.url.length}-${i}` }))));
    expect((await many.gh.listBranches("acme", "web")).truncated).toBe(true);
  });

  it("file paths: the tree of a branch; blobs only; unknown branch is null; a cut tree is reported", async () => {
    const { gh } = setup((c) => (c.url.includes("/git/ref/") ? json({ object: { sha: "abc" } }) : json({ tree: [{ path: "a.txt", type: "blob" }, { path: "dir", type: "tree" }, { type: "blob" }], truncated: true })));
    expect(await gh.listFilePaths("acme", "web", "main")).toEqual({ paths: ["a.txt"], truncated: true });
    expect(await setup((c) => (c.url.includes("/git/ref/") ? json({ object: { sha: "abc" } }) : json({}))).gh.listFilePaths("acme", "web", "main")).toEqual({ paths: [], truncated: false });
    expect(await setup(() => json({ message: "Not Found" }, 404)).gh.listFilePaths("acme", "web", "main")).toBeNull();
  });

  it("workflow files: only files, size defaults to 0, a missing folder or a non-list is empty", async () => {
    const { gh } = setup(() => json([{ name: "ci.yml", type: "file", size: 12 }, { name: "x.yml", type: "file" }, { name: "dir", type: "dir" }]));
    expect(await gh.listWorkflowFiles("acme", "web")).toEqual([{ name: "ci.yml", size: 12 }, { name: "x.yml", size: 0 }]);
    expect(await setup(() => json({ message: "Not Found" }, 404)).gh.listWorkflowFiles("acme", "web")).toEqual([]);
    expect(await setup(() => json({ type: "file" })).gh.listWorkflowFiles("acme", "web")).toEqual([]);
    await expect(setup(() => json({ message: "boom" }, 500)).gh.listWorkflowFiles("acme", "web")).rejects.toThrow(GitHubError);
  });
});

describe("writes", () => {
  it("a variable update that fails for another reason than 'missing' is not turned into a create", async () => {
    const { gh, calls } = setup(() => json({ message: "boom" }, 500));
    await expect(gh.putVariable(repo, "NAME", "v")).rejects.toThrow("500");
    expect(calls).toHaveLength(1);
  });

  it("variables and secrets can be deleted", async () => {
    const { gh, calls } = setup(() => empty());
    await gh.deleteVariable(repo, "A B");
    await gh.deleteSecret(repo, "C");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE /repos/acme/web/actions/variables/A%20B", "DELETE /repos/acme/web/actions/secrets/C"]);
  });
});

describe("repository files and branches", () => {
  it("getContentFile: decodes a file; an unknown file is null; a directory is an error; other errors pass on", async () => {
    const file = { type: "file", sha: "s1", content: Buffer.from("hello").toString("base64"), encoding: "base64" };
    expect(await setup(() => json(file)).gh.getContentFile("acme", "web", "team.yaml", "main")).toEqual({ sha: "s1", text: "hello" });
    expect(await setup(() => json({ message: "Not Found" }, 404)).gh.getContentFile("acme", "web", "team.yaml", "main")).toBeNull();
    for (const bad of [{ type: "dir" }, { type: "file", content: "x" }, { type: "file", sha: "s" }]) {
      await expect(setup(() => json(bad)).gh.getContentFile("acme", "web", "team.yaml", "main")).rejects.toThrow("ist keine Datei");
    }
    await expect(setup(() => json({ message: "boom" }, 500)).gh.getContentFile("acme", "web", "team.yaml", "main")).rejects.toThrow("500");
  });

  it("putContentFile: sends the replaced blob only when there is one and returns the new blob", async () => {
    const { gh, calls } = setup(() => json({ content: { sha: "new-sha" } }));
    expect(await gh.putContentFile("acme", "web", "team.yaml", "main", "text", "msg", "old-sha")).toBe("new-sha");
    expect(await gh.putContentFile("acme", "web", "team.yaml", "main", "text", "msg")).toBe("new-sha");
    expect(calls[0]!.body).toMatchObject({ sha: "old-sha", branch: "main", content: Buffer.from("text").toString("base64") });
    expect(calls[1]!.body).not.toHaveProperty("sha");
    expect(await setup(() => json({})).gh.putContentFile("acme", "web", "team.yaml", "main", "t", "m")).toBe("");
  });

  it("getBranchHead: the commit, null for a missing branch or a missing sha; other errors pass on", async () => {
    expect(await setup(() => json({ object: { sha: "abc" } })).gh.getBranchHead("acme", "web", "feature/x")).toBe("abc");
    expect(await setup(() => json({})).gh.getBranchHead("acme", "web", "main")).toBeNull();
    expect(await setup(() => json({ message: "Not Found" }, 404)).gh.getBranchHead("acme", "web", "main")).toBeNull();
    await expect(setup(() => json({ message: "boom" }, 500)).gh.getBranchHead("acme", "web", "main")).rejects.toThrow("500");
  });

  it("creates and deletes a branch", async () => {
    const { gh, calls } = setup(() => empty(201));
    await gh.createBranch("acme", "web", "probe/x", "sha1");
    await gh.deleteBranch("acme", "web", "probe/x");
    expect(calls[0]!.body).toEqual({ ref: "refs/heads/probe/x", sha: "sha1" });
    expect(calls[1]!.url).toBe("/repos/acme/web/git/refs/heads/probe/x");
  });

  it("getRepo: reads visibility, permissions and the default branch where they are well formed", async () => {
    expect(await setup(() => json({ private: true, permissions: { push: true }, default_branch: "main" })).gh.getRepo("acme", "web")).toEqual({ private: true, permissions: { push: true }, defaultBranch: "main" });
    expect(await setup(() => json({ private: "yes", permissions: { push: "yes" }, default_branch: 5 })).gh.getRepo("acme", "web")).toEqual({ private: null, permissions: { push: null }, defaultBranch: null });
    expect(await setup(() => json({})).gh.getRepo("acme", "web")).toEqual({ private: null, permissions: null, defaultBranch: null });
  });
});

describe("pull requests", () => {
  it("findOpenPull: the first open one, or null", async () => {
    expect(await setup(() => json([{ number: 5, html_url: "https://github.test/pr/5" }])).gh.findOpenPull("acme", "web", "feature", "main")).toEqual({ number: 5, url: "https://github.test/pr/5" });
    expect(await setup(() => json([{ number: 6 }])).gh.findOpenPull("acme", "web", "feature", "main")).toEqual({ number: 6, url: "" });
    expect(await setup(() => json([])).gh.findOpenPull("acme", "web", "feature", "main")).toBeNull();
    expect(await setup(() => json([{ title: "x" }])).gh.findOpenPull("acme", "web", "feature", "main")).toBeNull();
  });
  it("createPull and updatePull", async () => {
    const { gh, calls } = setup((c) => (c.method === "POST" ? json({ number: 7, html_url: "https://github.test/pr/7" }, 201) : json({})));
    expect(await gh.createPull("acme", "web", "feature", "main", "Title", "Body")).toEqual({ number: 7, url: "https://github.test/pr/7" });
    await gh.updatePull("acme", "web", 7, "New", "Text");
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "/repos/acme/web/pulls/7", body: { title: "New", body: "Text" } });
    expect(await setup(() => json({}, 201)).gh.createPull("acme", "web", "feature", "main", "T", "B")).toEqual({ number: 0, url: "" });
  });
});

describe("resolveRepo", () => {
  const redirect = (location: string | null, status = 301): Response => new Response(null, { status, headers: location === null ? {} : { location } });

  it("follows a rename inside GitHub", async () => {
    const { gh, calls } = setup((c) => (c.url === "/repos/acme/old" ? redirect("https://api.github.com/repositories/42") : json({ name: "new", full_name: "acme/new" })));
    expect(await gh.resolveRepo("acme", "old")).toEqual({ name: "new", fullName: "acme/new" });
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });
  it("a repository without a full name gets one from the owner", async () => {
    expect(await setup(() => json({ name: "web" })).gh.resolveRepo("acme", "web")).toEqual({ name: "web", fullName: "acme/web" });
  });
  it("refuses a redirect without target or to another host", async () => {
    await expect(setup(() => redirect(null, 302)).gh.resolveRepo("acme", "old")).rejects.toThrow("ohne Ziel");
    await expect(setup(() => redirect("https://evil.example.com/steal")).gh.resolveRepo("acme", "old")).rejects.toThrow("fremde Adresse");
  });
  it("gives up after three redirects", async () => {
    await expect(setup(() => redirect("/repos/acme/again", 307)).gh.resolveRepo("acme", "old")).rejects.toThrow(new GitHubError(310, "Zu viele Weiterleitungen"));
  });
  it("404 and 410 mean no such repository; other failures and answers without a name are told apart", async () => {
    expect(await setup(() => json({}, 404)).gh.resolveRepo("acme", "x")).toBeNull();
    expect(await setup(() => json({}, 410)).gh.resolveRepo("acme", "x")).toBeNull();
    await expect(setup(() => json({}, 500)).gh.resolveRepo("acme", "x")).rejects.toThrow("500");
    expect(await setup(() => json({ full_name: "acme/x" })).gh.resolveRepo("acme", "x")).toBeNull();
  });
});

describe("snapshotDetailed", () => {
  it("reads each store once, lists errors that are no GitHub errors with status 0, and names environments", async () => {
    const { gh, calls } = setup((c) => {
      if (c.url.includes("/web/")) return json({ secrets: [{ name: "A", created_at: "c", updated_at: "u" }] });
      throw "plain failure";
    });
    const r = await gh.snapshotDetailed("acme", [{ repo: "web", scope: "repository" }, { repo: "web", scope: "repository" }, { repo: "api", scope: "environment", environment: "staging" }]);
    expect(r.snapshot.size).toBe(1);
    expect(r.errors).toEqual([{ repo: "api", scope: "environment", environment: "staging", status: 0, message: "plain failure" }]);
    expect(calls).toHaveLength(2);
  });
  it("an Error that is no GitHub error is reported with its message", async () => {
    const { gh } = setup(() => { throw new Error("socket hang up"); });
    expect((await gh.snapshotDetailed("acme", [{ repo: "web", scope: "repository" }])).errors[0]).toMatchObject({ status: 0, message: "socket hang up" });
  });
});

describe("retry and error text", () => {
  it("a rate limit with a numeric Retry-After is retried once; a missing, blank or too long one is not", async () => {
    for (const header of [undefined, "  ", "abc", "60"]) {
      const sleep = vi.fn(async () => undefined);
      const { gh, calls } = setup(() => json({ message: "slow down" }, 429, header === undefined ? {} : { "retry-after": header }), { sleep });
      await expect(gh.listSecrets(repo)).rejects.toThrow("429");
      expect(calls, String(header)).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    }
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    const { gh } = setup(() => (n++ === 0 ? json({}, 403, { "x-ratelimit-remaining": "0", "retry-after": "1" }) : json({ secrets: [] })), { sleep });
    expect(await gh.listSecrets(repo)).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
  it("the error names GitHub's message, or the status text when there is none or the body is no JSON", async () => {
    await expect(setup(() => json({ message: "Bad credentials" }, 401)).gh.listSecrets(repo)).rejects.toThrow("-> 401: Bad credentials");
    await expect(setup(() => json({}, 500)).gh.listSecrets(repo)).rejects.toThrow(/-> 500: /);
    await expect(setup(() => new Response("<html>", { status: 502, statusText: "Bad Gateway" })).gh.listSecrets(repo)).rejects.toThrow("-> 502: Bad Gateway");
  });
});

describe("GitHub App token provider", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const NOW = new Date("2026-03-01T10:00:00Z");

  function provider(handler: (c: Call) => Response, over: object = {}) {
    const calls: Call[] = [];
    const tokens: object[] = [];
    const p = githubAppProvider({
      appId: "123",
      privateKey: new SecretValue(privateKey),
      owner: "Acme",
      now: () => NOW,
      fetch: (async (url: string, init?: RequestInit) => {
        const c: Call = { method: init?.method ?? "GET", url: String(url).replace("https://api.github.com", ""), headers: init?.headers as Record<string, string>, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
        calls.push(c);
        return handler(c);
      }) as never,
      onToken: (info) => tokens.push(info),
      ...over,
    });
    return { p, calls, tokens };
  }
  const installs = () => json([{ id: 9, account: { login: "other" } }, { id: 42, account: { login: "acme" } }, { id: 1 }]);
  const created = (over: object = {}) => json({ token: "made-up-installation-token", expires_at: "2026-03-01T11:00:00Z", ...over }, 201);

  it("issues an installation token for the owner (case-insensitive), reports what GitHub granted and caches it", async () => {
    const { p, calls, tokens } = provider((c) => (c.method === "GET" ? installs() : created({ permissions: { secrets: "write" }, repositories: [{ name: "web" }, {}] })), { repositories: ["web"], permissions: { secrets: "write" } });
    expect((await p()).reveal()).toBe("made-up-installation-token");
    expect((await p()).reveal()).toBe("made-up-installation-token");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /app/installations?per_page=100", "POST /app/installations/42/access_tokens"]);
    expect(calls[1]!.body).toEqual({ repositories: ["web"], permissions: { secrets: "write" } });
    expect(calls[0]!.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(tokens).toEqual([{ permissions: { secrets: "write" }, repositories: ["web"], expiresAt: "2026-03-01T11:00:00Z" }]);
  });

  it("a token without restrictions sends an empty body and reports empty permissions and repositories", async () => {
    const { p, calls, tokens } = provider((c) => (c.method === "GET" ? installs() : created()));
    await p();
    expect(calls[1]!.body).toEqual({});
    expect(tokens).toEqual([{ permissions: {}, repositories: [], expiresAt: "2026-03-01T11:00:00Z" }]);
    const { p: bare } = provider((c) => (c.method === "GET" ? installs() : created()), { repositories: [], onToken: undefined });
    await bare();
  });

  it("fails when the app is not installed on the owner, or GitHub refuses", async () => {
    await expect(provider(() => json([{ id: 1, account: { login: "someone" } }])).p()).rejects.toThrow("GitHub App ist auf Acme nicht installiert");
    await expect(provider(() => json({}, 401)).p()).rejects.toThrow("GitHub App GET /app/installations?per_page=100 -> 401");
  });

  it("uses the global fetch and the real clock by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => (init?.method === "POST" ? created({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : installs())) as never);
    try {
      const p = githubAppProvider({ appId: "1", privateKey: new SecretValue(privateKey), owner: "acme" });
      expect((await p()).reveal()).toBe("made-up-installation-token");
    } finally {
      spy.mockRestore();
    }
  });
});
