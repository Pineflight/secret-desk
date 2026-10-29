import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { SecretValue } from "../src/secret.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function client(f: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const c = new GitHubClient({ auth: patProvider(new SecretValue("ghp_x")), fetch: vi.fn(async (u: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(u), ...(init ? { init } : {}) }); return f(String(u), init); }) as unknown as typeof fetch });
  return { c, calls };
}

describe("GitHubClient: workflow files", () => {
  it("lists files only; missing folder (404) is empty; 403 stays an error", async () => {
    const ok = client(() => json([{ name: "deploy.yml", type: "file", size: 10 }, { name: "sub", type: "dir" }]));
    expect(await ok.c.listWorkflowFiles("acme", "web")).toEqual([{ name: "deploy.yml", size: 10 }]);
    expect(ok.calls[0]!.url).toBe("https://api.github.com/repos/acme/web/contents/.github/workflows");
    expect(await client(() => json({ message: "Not Found" }, 404)).c.listWorkflowFiles("acme", "web")).toEqual([]);
    await expect(client(() => json({ message: "Resource not accessible by personal access token" }, 403)).c.listWorkflowFiles("acme", "web")).rejects.toMatchObject({ status: 403 });
  });
  it("reads the file text raw", async () => {
    const { c, calls } = client(() => new Response("name: x\n", { status: 200 }));
    expect(await c.readTextFile("acme", "web", ".github/workflows/deploy.yml")).toBe("name: x\n");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/web/contents/.github/workflows/deploy.yml");
    expect((calls[0]!.init!.headers as Record<string, string>)["Accept"]).toBe("application/vnd.github.raw+json");
  });
});

describe("GitHubClient.resolveRepo", () => {
  it("301: follows the redirect itself (within GitHub only) and names the new name", async () => {
    const { c, calls } = client((u) =>
      u.endsWith("/repos/acme/leitfaden") ? new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42" } }) : json({ name: "night-before", full_name: "acme/night-before" }),
    );
    expect(await c.resolveRepo("acme", "leitfaden")).toEqual({ name: "night-before", fullName: "acme/night-before" });
    expect(calls.map((x) => x.url)).toEqual(["https://api.github.com/repos/acme/leitfaden", "https://api.github.com/repositories/42"]);
    expect((calls[0]!.init as RequestInit).redirect).toBe("manual");
  });
  it("200 without rename, 404 and 410 -> null", async () => {
    expect(await client(() => json({ name: "web", full_name: "acme/web" })).c.resolveRepo("acme", "web")).toEqual({ name: "web", fullName: "acme/web" });
    expect(await client(() => json({ message: "Not Found" }, 404)).c.resolveRepo("acme", "gone")).toBeNull();
    expect(await client(() => json({}, 410)).c.resolveRepo("acme", "gone")).toBeNull();
  });
  it("redirect to a foreign address: no token goes there", async () => {
    const { c, calls } = client(() => new Response(null, { status: 301, headers: { location: "https://evil.example/steal" } }));
    await expect(c.resolveRepo("acme", "x")).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toHaveLength(1);
  });
  it("other errors (500) are thrown", async () => {
    await expect(client(() => json({}, 500)).c.resolveRepo("acme", "x")).rejects.toMatchObject({ status: 500 });
  });
});

describe("InventoryStore.renameRepo", () => {
  const YAML = `version: 1
secrets:
  - { id: a, name: A_KEY, stage: staging, service: x, expiry: none, places: [{ repo: leitfaden, scope: environment }, { repo: other, scope: repository }] }
variables:
  - { id: v, name: A_VAR, stage: shared, value: null, places: [{ repo: leitfaden, scope: repository }] }
envTemplates:
  - { id: t, repo: leitfaden, stage: dev, entries: [{ key: K, from: { type: default, value: "1" } }] }
`;
  it("replaces targets of secrets, variables and templates, nothing else", () => {
    const inv = InventoryStore.fromText(YAML);
    expect(inv.renameRepo("leitfaden", "night-before")).toBe(3);
    expect(inv.data.secrets[0]!.places.map((p) => p.repo)).toEqual(["night-before", "other"]);
    expect(inv.data.variables[0]!.places[0]!.repo).toBe("night-before");
    expect(inv.data.envTemplates[0]!.repo).toBe("night-before");
    expect(inv.toString()).toContain("night-before");
    expect(inv.toString()).not.toContain("leitfaden");
  });
  it("unknown name: 0 changes; invalid new name throws", () => {
    const inv = InventoryStore.fromText(YAML);
    expect(inv.renameRepo("nope", "x")).toBe(0);
    expect(() => inv.renameRepo("leitfaden", "a/b")).toThrow();
    expect(() => inv.renameRepo("leitfaden", " ")).toThrow();
  });
});
