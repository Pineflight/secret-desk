import { describe, expect, it } from "vitest";
import { GitHubError, InventoryStore, SecretValue, buildSyncPlan, runSync, syncLineKey } from "../src/index.js";
import type { Inventory, Place, SyncLine, SyncPlan } from "../src/index.js";

const ACC = "0123456789abcdef0123456789abcdef";
const worker: Place = { scope: "cloudflare-worker", accountId: ACC, script: "portal" };
const repoPlace: Place = { repo: "web", scope: "repository" };

describe("buildSyncPlan edge cases", () => {
  const github = (over: object = {}) => ({ listSecrets: async () => [], listVariables: async () => [], ...over }) as never;

  it("a listing that fails with something that is no Error is shown as text", async () => {
    const inv = InventoryStore.fromText(`version: 1\nvariables:\n  - { id: v1, name: SITE_URL, stage: shared, value: "https://a.example.com", places: [{ repo: web, scope: repository }] }\n`).data;
    const p = await buildSyncPlan({ github: github({ listVariables: async () => { throw "plain failure"; } }), owner: "acme", inventory: inv });
    expect(p.lines[0]).toMatchObject({ action: "skip", reason: "unreadable", detail: "plain failure" });
  });

  it("a value that only looks suspicious needs an acknowledgement; a Worker place has no variable listing", async () => {
    const inv = InventoryStore.fromText(`version: 1\nvariables:\n  - { id: v1, name: SITE_URL, stage: shared, value: "${"ab".repeat(32)}", places: [{ repo: web, scope: repository }] }\n`).data;
    const p = await buildSyncPlan({ github: github(), owner: "acme", inventory: inv });
    expect(p.lines[0]).toMatchObject({ action: "skip", reason: "needs-ack" });
    const crafted = { ...inv, variables: [{ id: "v2", name: "SITE_URL", stage: "shared", value: "https://a.example.com", places: [worker] }] } as unknown as Inventory;
    const q = await buildSyncPlan({ github: github(), owner: "acme", inventory: crafted });
    expect(q.lines[0]).toMatchObject({ action: "set", reason: "missing", repo: "worker:portal" });
  });

  it("without values, secrets are skipped; a Worker secret is read through the Worker client and never 'github-newer'", async () => {
    const inv = InventoryStore.fromText(`version: 1\nsecrets:\n  - { id: s1, name: API_KEY, stage: shared, service: x, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ACC}", script: portal }] }\n`).data;
    const p = await buildSyncPlan({ github: github(), owner: "acme", inventory: inv, repo: "worker:portal" });
    expect(p.lines[0]).toMatchObject({ action: "skip", reason: "no-value" });
    const values = { info: async () => ({ fingerprint: "f", savedAt: "2026-01-01T00:00:00Z" }), get: async () => SecretValue.from("v") };
    const withWorkers = await buildSyncPlan({ github: github(), workers: { listSecretNames: async () => ["API_KEY"] }, owner: "acme", inventory: inv, values });
    expect(withWorkers.lines[0]).toMatchObject({ action: "write", reason: "overwrite", repo: "worker:portal" });
    const other = await buildSyncPlan({ github: github(), owner: "acme", inventory: inv, repo: "web" });
    expect(other.lines).toEqual([]);
  });

  it("a value source that fails counts as no stored value", async () => {
    const inv = InventoryStore.fromText(`version: 1\nsecrets:\n  - { id: s1, name: API_KEY, stage: shared, service: x, provider: random-hex, expiry: none, places: [{ repo: web, scope: repository }] }\n`).data;
    const values = { info: async () => { throw new Error("vault locked"); }, get: async () => null };
    const p = await buildSyncPlan({ github: github(), owner: "acme", inventory: inv, values, canIssue: () => false });
    expect(p.lines[0]).toMatchObject({ action: "skip", reason: "no-value" });
    expect(p.lines[0]).not.toHaveProperty("renewable");
  });
});

describe("runSync edge cases", () => {
  const line = (over: Partial<SyncLine>): SyncLine => ({
    key: "k",
    kind: "variable",
    entryId: "v1",
    name: "SITE_URL",
    repo: "web",
    place: repoPlace,
    placeLabel: "web/repo",
    stage: "shared",
    production: false,
    action: "set",
    reason: "missing",
    defaultOn: true,
    ...over,
  });
  const planOf = (...lines: SyncLine[]): SyncPlan => ({ generatedAt: "t", lines, counts: { set: 0, write: 0, skip: 0, unchanged: 0 }, hasProduction: false });
  const inventory = (value: string | null = "https://a.example.com") => ({ variables: [{ id: "v1", name: "SITE_URL", value, places: [repoPlace] }] }) as unknown as Inventory;
  const run = (lines: SyncLine[], over: { inv?: Inventory; github?: object; values?: object } = {}, options: object = {}) =>
    runSync({ github: { putVariable: async () => "created", putSecret: async () => "created", ...over.github } as never, owner: "acme", plan: planOf(...lines), inventory: over.inv ?? inventory(), ...(over.values ? { values: over.values as never } : {}) }, { keys: lines.map((l) => l.key), ...options });

  it("a Worker variable is skipped with a reason", async () => {
    const r = await run([line({ place: worker, key: syncLineKey("variable", "v1", worker) })]);
    expect(r.outcomes[0]).toMatchObject({ outcome: "skipped", error: "Worker-Variablen gehoeren nicht zu secret-desk" });
  });

  it("a variable that changed since the plan is skipped, never guessed", async () => {
    expect((await run([line({})], { inv: inventory(null) })).outcomes[0]!.error).toContain("keinen Sollwert mehr");
    expect((await run([line({ entryId: "gone" })])).outcomes[0]!.error).toContain("keinen Sollwert mehr");
    const leaked = ["sk", "live", "a".repeat(24)].join("_");
    expect((await run([line({})], { inv: inventory(leaked) })).outcomes[0]!.error).toContain("Sieht aus wie");
  });

  it("a secret without a stored value any more is skipped", async () => {
    const secretLine = line({ kind: "secret", entryId: "s1", name: "API_KEY", action: "write" });
    expect((await run([secretLine])).outcomes[0]!.error).toContain("Kein gespeicherter Wert mehr");
    expect((await run([secretLine], { values: { get: async () => null } })).outcomes[0]!.error).toContain("Kein gespeicherter Wert mehr");
    const ok = await run([secretLine], { values: { get: async () => SecretValue.from("v") } });
    expect(ok.outcomes[0]).toMatchObject({ outcome: "created" });
  });

  it("a failure that is no Error is shown as text, and a run goes on after it", async () => {
    const r = await run([line({}), line({ key: "k2" })], { github: { putVariable: async () => { throw "plain failure"; } } });
    expect(r.outcomes.map((o) => [o.outcome, o.error])).toEqual([["failed", "plain failure"], ["failed", "plain failure"]]);
    expect(r).toMatchObject({ ok: 0, failed: 2 });
  });

  it("waits with the real timer after a rate limit when no sleep is given, then succeeds", async () => {
    let calls = 0;
    const putVariable = async () => {
      calls += 1;
      if (calls === 1) throw new GitHubError(429, "slow down");
      return "updated" as const;
    };
    const r = await run([line({})], { github: { putVariable } }, { retryWaitsMs: [1] });
    expect(r.outcomes[0]).toMatchObject({ outcome: "updated" });
    expect(calls).toBe(2);
  });
});
