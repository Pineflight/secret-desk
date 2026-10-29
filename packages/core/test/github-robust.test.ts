import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, GitHubTruncatedError, patProvider } from "../src/github.js";
import { SecretValue } from "../src/secret.js";
import { computeStatus } from "../src/status.js";
import { InventoryStore } from "../src/inventory.js";
import { INVENTORY_YAML } from "./fixtures.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers });
const secrets = (n: number, offset = 0) => ({ secrets: Array.from({ length: n }, (_, i) => ({ name: `S_${offset + i}`, created_at: "c", updated_at: "u" })) });
const client = (fetchImpl: (url: string) => Response | Promise<Response>, extra: { sleep?: (ms: number) => Promise<void>; maxRetryWaitMs?: number } = {}) =>
  new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: (async (url: string | URL | Request) => fetchImpl(String(url))) as unknown as typeof fetch, sleep: async () => undefined, ...extra });
const repoTarget = (repo: string) => ({ owner: "acme", repo, scope: "repository" as const });

describe("M8: snapshot with partial result", () => {
  it("403/5xx at one target does not topple all: partial result plus error list, 404 is no error", async () => {
    const gh = client((url) => {
      if (url.includes("/ok/")) return json({ secrets: [{ name: "A_B", created_at: "c", updated_at: "u" }] });
      if (url.includes("/denied/")) return json({ message: "Forbidden" }, 403);
      if (url.includes("/broken/")) return json({ message: "boom" }, 502);
      return json({ message: "Not Found" }, 404);
    });
    const places = ["ok", "denied", "broken", "gone"].map((repo) => ({ repo, scope: "repository" as const }));
    const r = await gh.snapshotDetailed("acme", places);
    expect(r.snapshot.size).toBe(1);
    expect(r.errors.map((e) => [e.repo, e.status])).toEqual([["denied", 403], ["broken", 502]]);
  });
  it("snapshot() no longer throws on 403", async () => {
    const gh = client(() => json({ message: "Forbidden" }, 403));
    await expect(gh.snapshot("acme", [{ repo: "x", scope: "repository" }])).resolves.toBeInstanceOf(Map);
  });
  it("computeStatus does not count unreadable targets as missing", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML).getSecret("cf-deploy-acme-app")!;
    const r = computeStatus(s, new Date("2026-10-23T00:00:00Z"), { live: new Map(), owner: "acme", unreadable: (p) => p.repo === "acme-app" });
    expect(r.missingPlaces.map((p) => p.repo)).toEqual(["acme-app-landing"]);
  });
});

describe("M8: 429 with Retry-After", () => {
  it("is retried once", async () => {
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    const gh = client(() => (++n === 1 ? json({ message: "slow" }, 429, { "retry-after": "2" }) : json(secrets(1))), { sleep });
    expect(await gh.listSecrets(repoTarget("r"))).toHaveLength(1);
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it("second 429 or too long wait: GitHubError, no endless loop", async () => {
    let n = 0;
    const gh = client(() => (n++, json({ message: "slow" }, 429, { "retry-after": "1" })));
    await expect(gh.listSecrets(repoTarget("r"))).rejects.toMatchObject({ status: 429 });
    expect(n).toBe(2);
    let m = 0;
    const long = client(() => (m++, json({ message: "slow" }, 429, { "retry-after": "3600" })));
    await expect(long.listSecrets(repoTarget("r"))).rejects.toBeInstanceOf(GitHubError);
    expect(m).toBe(1);
  });
  it("no retry without Retry-After", async () => {
    let n = 0;
    const gh = client(() => (n++, json({ message: "slow" }, 429)));
    await expect(gh.listSecrets(repoTarget("r"))).rejects.toBeInstanceOf(GitHubError);
    expect(n).toBe(1);
  });
});

describe("M8: pagination", () => {
  it("more than 100 entries: all pages", async () => {
    const gh = client((url) => (/&page=1$/.test(url) ? json(secrets(100)) : /&page=2$/.test(url) ? json(secrets(30, 100)) : json(secrets(0))));
    expect(await gh.listSecrets(repoTarget("r"))).toHaveLength(130);
  });
  it("page limit 20 reached: error instead of silent truncation, in the comparison as error per target", async () => {
    const gh = client(() => json(secrets(100)));
    await expect(gh.listSecrets(repoTarget("r"))).rejects.toBeInstanceOf(GitHubTruncatedError);
    const r = await gh.snapshotDetailed("acme", [{ repo: "r", scope: "repository" }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/unvollstaendig/);
  });
});
