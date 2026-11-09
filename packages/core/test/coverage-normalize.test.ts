import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InventoryStore } from "../src/inventory.js";
import { applyNormalization, planNormalization } from "../src/normalize.js";

const REF = "abcdefghijklmnopqrst";
const ID32 = "0123456789abcdef0123456789abcdef";
const variable = (id: string, name: string, value: string | null, extra = "stage: shared, places: [{ repo: web, scope: repository }]") =>
  `  - { id: ${id}, name: ${name}, ${value === null ? "" : `value: "${value}", `}${extra} }\n`;
const plan = (yaml: string) => planNormalization(InventoryStore.fromText(`version: 1\n${yaml}`).data);
const change = (p: ReturnType<typeof plan>, id: string) => p.changes.find((c) => c.id === id);

describe("source rules read the resource from a value of the right shape only", () => {
  const cases: [string, string, string | null][] = [
    ["REVENUECAT_PROJECT_ID", "projAbc123", "projAbc123"],
    ["REVENUECAT_PROJECT_ID", "not-a-project", null],
    ["REVENUECAT_WEB_APP_ID", "appAbc123", "appAbc123"],
    ["REVENUECAT_WEB_APP_ID", "not-an-app", null],
    ["SUPABASE_URL", `https://${REF}.supabase.co`, REF],
    ["SUPABASE_URL", "https://example.com", null],
    ["SUPABASE_PROJECT_REF", REF, REF],
    ["SUPABASE_PROJECT_REF", "short", null],
    ["CLOUDFLARE_ACCOUNT_ID", ID32, ID32],
    ["CLOUDFLARE_ACCOUNT_ID", "not-an-id", null],
    ["CLOUDFLARE_ZONE_ID", ID32, ID32],
    ["CLOUDFLARE_ZONE_ID", "not-an-id", null],
    ["TURNSTILE_SITE_KEY", "0x4AAAAAAABcdefgh", "0x4AAAAAAABcdefgh"],
    ["TURNSTILE_SITE_KEY", "plain", null],
  ];
  it.each(cases)("%s = %s", (name, value, resource) => {
    const p = plan(`variables:\n${variable("v1", name, value)}`);
    const c = change(p, "source:variable:v1")!;
    expect(c.after[0]!.source!.resource).toBe(resource);
    expect(c.autoApplicable).toBe(resource !== null);
    expect(c.reasons[0]!.code).toBe(resource ? "source-known" : "source-choose-resource");
  });
});

describe("resources inferred from sibling variables", () => {
  it("a Supabase project comes from a sibling URL on the same target, but not from a value that names no project", () => {
    const yaml = `variables:\n${variable("v1", "SUPABASE_PUBLISHABLE_KEY", null)}${variable("v2", "SUPABASE_URL", `https://${REF}.supabase.co`)}${variable("v3", "SUPABASE_PROJECT_REF", "not-a-ref")}`;
    expect(change(plan(yaml), "source:variable:v1")!.after[0]!.source!.resource).toBe(REF);
  });
  it("a sibling whose value names no project gives nothing", () => {
    const yaml = `variables:\n${variable("v1", "SUPABASE_PUBLISHABLE_KEY", null)}${variable("v3", "SUPABASE_PROJECT_REF", "not-a-ref")}`;
    const c = change(plan(yaml), "source:variable:v1")!;
    expect(c.after[0]!.source!.resource).toBeNull();
    expect(c.autoApplicable).toBe(false);
  });
  it("siblings on another stage, another target or without a value are ignored", () => {
    const yaml = `variables:\n${variable("v1", "SUPABASE_PUBLISHABLE_KEY", null, "stage: staging, places: [{ repo: web, scope: environment, environment: staging }]")}${variable("v2", "SUPABASE_URL", `https://${REF}.supabase.co`, "stage: production, places: [{ repo: web, scope: environment, environment: production }]")}${variable("v3", "SUPABASE_URL", `https://${REF}.supabase.co`, "stage: staging, places: [{ repo: other, scope: repository }]")}${variable("v4", "SUPABASE_URL", null, "stage: staging, places: [{ repo: web, scope: environment, environment: staging }]")}`;
    expect(change(plan(yaml), "source:variable:v1")!.after[0]!.source!.resource).toBeNull();
  });
  it("organization places are told apart from repository places", () => {
    const yaml = `variables:\n${variable("v1", "SUPABASE_PUBLISHABLE_KEY", null, "stage: shared, places: [{ repo: acme, scope: organization }]")}${variable("v2", "SUPABASE_URL", `https://${REF}.supabase.co`, "stage: shared, places: [{ repo: acme, scope: repository }]")}`;
    expect(change(plan(yaml), "source:variable:v1")!.after[0]!.source!.resource).toBeNull();
    const same = `variables:\n${variable("v1", "SUPABASE_PUBLISHABLE_KEY", null, "stage: shared, places: [{ repo: acme, scope: organization }]")}${variable("v2", "SUPABASE_URL", `https://${REF}.supabase.co`, "stage: shared, places: [{ repo: acme, scope: organization }]")}`;
    expect(change(plan(same), "source:variable:v1")!.after[0]!.source!.resource).toBe(REF);
  });
});

describe("stage proposed from the name", () => {
  const stagePlan = (name: string, stages = "") => plan(`${stages}variables:\n${variable("v1", name, "x")}`);
  const stageChange = (p: ReturnType<typeof plan>) => p.changes.find((c) => c.kind === "stage");

  it("a single stage word proposes that stage", () => {
    expect(stageChange(stagePlan("API_STAGING_URL"))!.after[0]!.stage).toBe("staging");
  });
  it("two different stage words propose nothing", () => {
    expect(stageChange(stagePlan("API_STAGING_PRODUCTION_URL"))).toBeUndefined();
  });
  it("a stage word without a known stage hint (TEST) proposes nothing", () => {
    expect(stageChange(stagePlan("API_TEST_URL"))).toBeUndefined();
  });
  it("a stage that the inventory does not define proposes nothing", () => {
    expect(stageChange(stagePlan("API_PROD_URL", "stages:\n  - { id: shared, kind: shared }\n  - { id: dev, kind: dev }\n"))).toBeUndefined();
  });
  it("a target in another environment than the name says proposes nothing", () => {
    const p = plan(`variables:\n${variable("v1", "API_STAGING_URL", "x", "stage: shared, places: [{ repo: web, scope: environment, environment: production }]")}`);
    expect(stageChange(p)).toBeUndefined();
  });
});

describe("collisions and provider switches", () => {
  it("entries with their own place name are compared by that name", () => {
    const yaml = `variables:\n  - { id: v1, name: API_STAGING_URL, stage: staging, value: a, places: [{ repo: web, scope: environment, environment: staging, name: API_URL }] }\n  - { id: v2, name: API_URL, stage: staging, value: a, places: [{ repo: web, scope: environment, environment: staging }] }\n`;
    expect(plan(yaml).changes.some((c) => c.kind === "merge")).toBe(true);
  });
  it("Worker places are compared by account, script and name", () => {
    const worker = (id: string, name: string) => `  - { id: ${id}, name: ${name}, stage: staging, service: x, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: "${ID32}", script: portal }] }\n`;
    const p = plan(`secrets:\n${worker("s1", "STAGING_API_KEY")}${worker("s2", "API_KEY")}`);
    expect(p.changes.find((c) => c.kind === "merge")!.entryIds).toEqual(["s1", "s2"]);
  });

  it("the key id of an R2 pair is found for a secret that is renamed into the R2 name", () => {
    const secret = (id: string, name: string) => `  - { id: ${id}, name: ${name}, stage: production, service: cloudflare, provider: manual, expiry: none, places: [{ repo: web, scope: environment, environment: production }] }\n`;
    const p = plan(`secrets:\n${secret("r2-secret", "CF_R2_SECRET_ACCESS_KEY")}${secret("r2-id", "CLOUDFLARE_R2_ACCESS_KEY_ID")}`);
    const c = change(p, "provider:secret:r2-secret")!;
    expect(c.after[0]!.provider).toBe("cloudflare-r2-credentials");
    expect(c.missingParams).toEqual(["accountId", "access"]);
    expect(c.after[0]!.paramKeys).toContain("companionEntry");
  });
});

describe("applyNormalization", () => {
  it("applies a provider switch with fixed and proposed parameters, and keeps parameters the entry has already", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cov-norm-"));
    const file = join(dir, "inventory.yaml");
    const secret = (id: string, name: string, extra = "") => `  - { id: ${id}, name: ${name}, stage: production, service: cloudflare, provider: manual, expiry: none${extra}, places: [{ repo: web, scope: environment, environment: production }] }\n`;
    await writeFile(file, `version: 1\nsecrets:\n${secret("r2-secret", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", ", params: { accountId: acc }")}${secret("r2-id", "CLOUDFLARE_R2_ACCESS_KEY_ID")}`);
    const store = await InventoryStore.open(file);
    const result = await applyNormalization(store, {}, ["provider:secret:r2-secret"]);
    expect(result.applied).toEqual(["provider:secret:r2-secret"]);
    expect(result.needsParams).toEqual([{ secretId: "r2-secret", missing: ["access"] }]);
    const saved = store.getSecret("r2-secret")!;
    expect(saved.provider).toBe("cloudflare-r2-credentials");
    expect(saved.params).toMatchObject({ accountId: "acc", value: "secretAccessKey", companionEntry: "r2-id" });
  });

  it("applies a source change to a variable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cov-norm-"));
    const file = join(dir, "inventory.yaml");
    await writeFile(file, `version: 1\nvariables:\n${variable("v1", "CLOUDFLARE_ZONE_ID", ID32)}`);
    const store = await InventoryStore.open(file);
    await applyNormalization(store, {}, ["source:variable:v1"]);
    expect(store.getVariable("v1")!.from).toMatchObject({ kind: "cloudflare.zone", field: "zoneId", resource: ID32 });
  });
});
