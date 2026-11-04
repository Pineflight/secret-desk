import { describe, expect, it, vi } from "vitest";
import { GitHubError } from "../src/github.js";
import { buildSyncPlan, runSync, SyncError, syncLineKey, type SecretValueSource, type SyncPlan } from "../src/github-sync.js";
import { InventoryStore } from "../src/inventory.js";
import { SecretValue } from "../src/secret.js";

const VALUE = "made-up-secret-value-7781";

// The secret-looking fixture is assembled at run time so the repository secret scan does not match it.
const SECRETISH = ["sk", "live", "a".repeat(24)].join("_");
const YAML = `version: 1
variables:
  - { id: v-same, name: SITE_URL, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: v-diff, name: API_URL, stage: staging, value: "https://api.example.com", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: v-missing, name: REGION, stage: production, value: "eu", places: [{ repo: acme-web, scope: environment, environment: production }] }
  - { id: v-none, name: UNSET_VAR, stage: staging, places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: v-ignored, name: IGN_VAR, stage: shared, value: "x", places: [{ repo: acme-ignored, scope: repository }] }
  - { id: v-gone-env, name: PREVIEW_URL, stage: shared, value: "https://p.example.com", places: [{ repo: acme-web, scope: environment, environment: preview }] }
  - { id: v-broken, name: BROKEN_VAR, stage: shared, value: "b", places: [{ repo: acme-broken, scope: repository }] }
  - { id: v-secretish, name: LEAKED, stage: shared, value: "${SECRETISH}", places: [{ repo: acme-web, scope: repository }] }
secrets:
  - { id: s-new, name: API_KEY, stage: production, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-web, scope: environment, environment: production }] }
  - { id: s-old, name: OLD_KEY, stage: staging, service: x, provider: random-hex, expiry: none, rotatedAt: "2026-10-10", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: s-newer, name: NEWER_KEY, stage: staging, service: x, provider: random-hex, expiry: none, rotatedAt: "2026-10-10", places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: s-empty, name: EMPTY_KEY, stage: staging, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: s-manual, name: MANUAL_KEY, stage: staging, service: x, provider: manual, expiry: none, places: [{ repo: acme-web, scope: environment, environment: staging }] }
  - { id: s-ign, name: IGN_KEY, stage: shared, service: x, provider: random-hex, expiry: none, places: [{ repo: acme-ignored, scope: repository }] }
`;

const inventory = () => InventoryStore.fromText(YAML).data;
const stored = new Set(["s-new", "s-old", "s-newer", "s-ign"]);
const values = (): SecretValueSource => ({
  info: async (id) => (stored.has(id) ? { fingerprint: "abc123def456", savedAt: "2026-10-01T10:00:00Z" } : null),
  get: async (id) => (stored.has(id) ? new SecretValue(VALUE) : null),
});

type Vars = Record<string, string>;
function fakeGithub(over: { putVariable?: (...a: unknown[]) => Promise<"created" | "updated">; putSecret?: (...a: unknown[]) => Promise<"created" | "updated"> } = {}) {
  const calls: string[] = [];
  const vars: Record<string, Vars | number> = {
    "acme-web/environment/staging": { SITE_URL: "https://staging.example.com", API_URL: "https://old.example.com" },
    "acme-web/environment/production": {},
    "acme-web/repository/": {},
    "acme-broken/repository/": 500,
  };
  const secrets: Record<string, { name: string; updatedAt: string }[]> = {
    "acme-web/environment/production": [],
    "acme-web/environment/staging": [
      { name: "OLD_KEY", updatedAt: "2026-10-05T00:00:00Z" },
      { name: "NEWER_KEY", updatedAt: "2026-10-20T00:00:00Z" },
    ],
  };
  const key = (t: { repo: string; scope: string; environment?: string }) => `${t.repo}/${t.scope}/${t.environment ?? ""}`;
  const github = {
    listVariables: async (t: { repo: string; scope: string; environment?: string }) => {
      const v = vars[key(t)];
      if (v === undefined) throw new GitHubError(404, "Not Found");
      if (typeof v === "number") throw new GitHubError(v, "boom");
      return Object.entries(v).map(([name, value]) => ({ name, value, createdAt: "c", updatedAt: "u" }));
    },
    listSecrets: async (t: { repo: string; scope: string; environment?: string }) => {
      const s = secrets[key(t)];
      if (!s) throw new GitHubError(404, "Not Found");
      return s.map((x) => ({ name: x.name, createdAt: "c", updatedAt: x.updatedAt }));
    },
    putVariable: over.putVariable ?? (async (...a: unknown[]) => (calls.push(`putVariable ${(a[1] as string)}`), "updated" as const)),
    putSecret: over.putSecret ?? (async (...a: unknown[]) => (calls.push(`putSecret ${(a[1] as string)}`), "created" as const)),
    deleteVariable: vi.fn(),
    deleteSecret: vi.fn(),
  };
  return { github, calls };
}

const plan = async (repo?: string, ignoreRepos: string[] = ["acme-ignored"]) => {
  const { github } = fakeGithub();
  return buildSyncPlan({ github, owner: "acme", inventory: inventory(), ignoreRepos, values: values(), ...(repo ? { repo } : {}), now: new Date("2026-11-04T00:00:00Z") });
};
const find = (p: SyncPlan, entry: string) => p.lines.find((l) => l.entryId === entry)!;

describe("sync plan: variables", () => {
  it("sets variables that differ or are missing, and only counts the ones that are equal", async () => {
    const p = await plan();
    expect(find(p, "v-diff")).toMatchObject({ action: "set", reason: "different", defaultOn: true });
    expect(find(p, "v-missing")).toMatchObject({ action: "set", reason: "missing", defaultOn: true });
    expect(p.lines.some((l) => l.entryId === "v-same")).toBe(false);
    expect(p.counts.unchanged).toBe(1);
  });
  it("skips with a reason: no value, ignored repository, unreadable target, missing environment, secret-like value", async () => {
    const p = await plan();
    expect(find(p, "v-none")).toMatchObject({ action: "skip", reason: "no-value", defaultOn: false });
    expect(find(p, "v-ignored")).toMatchObject({ action: "skip", reason: "ignored-repo" });
    expect(find(p, "v-broken")).toMatchObject({ action: "skip", reason: "unreadable" });
    expect(find(p, "v-gone-env")).toMatchObject({ action: "skip", reason: "target-missing" });
    expect(find(p, "v-secretish")).toMatchObject({ action: "skip", reason: "secret-like" });
  });
});

describe("sync plan: secrets", () => {
  it("writes a secret with a stored value that is missing in GitHub", async () => {
    expect(find(await plan(), "s-new")).toMatchObject({ action: "write", reason: "missing", defaultOn: true, production: true });
  });
  it("overwrites when GitHub is older than the rotation, and switches the line off with a warning when GitHub is newer", async () => {
    const p = await plan();
    expect(find(p, "s-old")).toMatchObject({ action: "write", reason: "overwrite", defaultOn: true });
    expect(find(p, "s-old").warning).toBeUndefined();
    expect(find(p, "s-newer")).toMatchObject({ action: "write", reason: "github-newer", defaultOn: false, warning: "github-newer" });
  });
  it("skips entries without a value and offers Renew only for providers that can issue", async () => {
    const p = await plan();
    expect(find(p, "s-empty")).toMatchObject({ action: "skip", reason: "no-value", renewable: true });
    const manual = find(p, "s-manual");
    expect(manual).toMatchObject({ action: "skip", reason: "no-value" });
    expect(manual.renewable).toBeUndefined();
    const { github } = fakeGithub();
    const noVault = await buildSyncPlan({ github, owner: "acme", inventory: inventory(), ignoreRepos: [], canIssue: (id) => id === "random-hex" });
    expect(noVault.lines.filter((l) => l.kind === "secret").every((l) => l.action === "skip" && l.reason === "no-value")).toBe(true);
  });
  it("skips places in ignored repositories even with a stored value", async () => {
    expect(find(await plan(), "s-ign")).toMatchObject({ action: "skip", reason: "ignored-repo" });
  });
  it("treats an unreadable vault as no value", async () => {
    const { github } = fakeGithub();
    const broken: SecretValueSource = { info: async () => { throw new Error("vault locked"); }, get: async () => null };
    const p = await buildSyncPlan({ github, owner: "acme", inventory: inventory(), ignoreRepos: [], values: broken });
    expect(find(p, "s-new")).toMatchObject({ action: "skip", reason: "no-value" });
  });
});

describe("sync plan: scope and safety", () => {
  it("restricts to one repository and flags production", async () => {
    const p = await plan("acme-web");
    expect(new Set(p.lines.map((l) => l.repo))).toEqual(new Set(["acme-web"]));
    expect(p.hasProduction).toBe(true);
    expect(p.counts.set + p.counts.write + p.counts.skip).toBe(p.lines.length);
  });
  it("never contains a value", async () => {
    const text = JSON.stringify(await plan());
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(SECRETISH);
    expect(text).not.toContain("https://api.example.com");
  });
  it("only reads: no delete is ever possible", async () => {
    const { github } = fakeGithub();
    await buildSyncPlan({ github, owner: "acme", inventory: inventory(), values: values() });
    expect(github.deleteSecret).not.toHaveBeenCalled();
    expect(github.deleteVariable).not.toHaveBeenCalled();
  });
});

describe("sync run", () => {
  const setup = async (over: Parameters<typeof fakeGithub>[0] = {}) => {
    const fake = fakeGithub(over);
    const p = await buildSyncPlan({ github: fake.github, owner: "acme", inventory: inventory(), ignoreRepos: ["acme-ignored"], values: values() });
    const run = (keys: string[], o: Partial<Parameters<typeof runSync>[1]> = {}) =>
      runSync({ github: fake.github, owner: "acme", plan: p, inventory: inventory(), values: values() }, { keys, sleep: async () => undefined, ...o });
    return { ...fake, plan: p, run };
  };

  it("writes selected variables and secrets, in batches with progress, and never deletes", async () => {
    const t = await setup();
    const keys = [find(t.plan, "v-diff").key, find(t.plan, "s-old").key, find(t.plan, "v-none").key];
    const progress: [number, number][] = [];
    const r = await t.run(keys, { batchSize: 1, onProgress: (d, n) => progress.push([d, n]) });
    expect(r.outcomes.map((o) => o.outcome)).toEqual(["updated", "created"]);
    expect(t.calls).toEqual(["putVariable API_URL", "putSecret OLD_KEY"]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(r.ok).toBe(2);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(t.github.deleteSecret).not.toHaveBeenCalled();
    expect(t.github.deleteVariable).not.toHaveBeenCalled();
  });

  it("needs the production confirmation for production places", async () => {
    const t = await setup();
    const prod = find(t.plan, "s-new").key;
    await expect(t.run([prod])).rejects.toMatchObject({ code: "production-confirmation" });
    await expect(t.run([prod], { confirmProduction: false })).rejects.toBeInstanceOf(SyncError);
    expect(t.calls).toEqual([]);
    const r = await t.run([prod], { confirmProduction: true });
    expect(r.ok).toBe(1);
  });

  it("keeps going after a partial failure and reports each failure with its reason", async () => {
    const t = await setup({ putVariable: async (...a) => { if (a[1] === "API_URL") throw new GitHubError(422, "Validation Failed"); return "created"; } });
    const r = await t.run([find(t.plan, "v-diff").key, find(t.plan, "v-missing").key], { confirmProduction: true });
    expect(r.outcomes.map((o) => o.outcome)).toEqual(["failed", "created"]);
    expect(r.failed).toBe(1);
    expect(r.outcomes[0]!.error).toContain("Validation Failed");
  });

  it("retries after a rate-limit answer with growing waits, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const t = await setup({ putVariable: async () => { n += 1; if (n <= 2) throw new GitHubError(429, "rate limited"); return "updated"; } });
    const r = await t.run([find(t.plan, "v-diff").key], { sleep: async (ms) => { waits.push(ms); }, retryWaitsMs: [5, 50, 500] });
    expect(r.outcomes[0]!.outcome).toBe("updated");
    expect(waits).toEqual([5, 50]);
  });

  it("gives up after the last retry and reports the line as failed", async () => {
    const t = await setup({ putVariable: async () => { throw new GitHubError(403, "API rate limit exceeded"); } });
    const r = await t.run([find(t.plan, "v-diff").key], { retryWaitsMs: [1, 1] });
    expect(r.outcomes[0]).toMatchObject({ outcome: "failed" });
  });

  it("does not retry other errors", async () => {
    const put = vi.fn(async () => { throw new GitHubError(404, "Not Found"); });
    const t = await setup({ putVariable: put as never });
    await t.run([find(t.plan, "v-diff").key]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("refuses keys that are not in the plan and ignores skipped lines", async () => {
    const t = await setup();
    await expect(t.run([syncLineKey("variable", "nope", { repo: "x", scope: "repository" })])).rejects.toMatchObject({ code: "unknown-line" });
    await expect(t.run([find(t.plan, "v-none").key])).rejects.toMatchObject({ code: "nothing-selected" });
  });
});
