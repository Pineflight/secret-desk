import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InventoryStore } from "../src/inventory.js";
import { applyNormalization, planNormalization, type NormalizationChange } from "../src/normalize.js";

const REF = "abcdefghijklmnopqrst";
const VALUE_URL = `https://${REF}.supabase.co`;
const VALUE_ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET_LIKE = "made-up-secret-value-9f3a";

const YAML = `version: 1
secrets:
  - id: sb-secret-staging
    name: SUPABASE_STAGING_SERVICE_ROLE_KEY
    stage: staging
    service: supabase
    expiry: none
    params: { projectRef: ${REF} }
    places: [{ repo: web, scope: environment, environment: staging }]
  - id: sb-secret-prod
    name: SUPABASE_PRODUCTION_SERVICE_ROLE_KEY
    stage: production
    service: supabase
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: sb-db-password
    name: SUPABASE_DB_PASSWORD
    stage: production
    service: supabase
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: revenuecat
    name: REVENUECAT_API_KEY
    stage: production
    service: revenuecat
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: anthropic-key
    name: ANTHROPIC_API_KEY
    stage: production
    service: anthropic
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: openai-key
    name: OPENAI_API_KEY
    stage: production
    service: openai
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: cf-access
    name: CF_ACCESS_CLIENT_ID
    stage: shared
    service: cloudflare
    expiry: none
    notes: ${SECRET_LIKE}
    places: [{ repo: web, scope: repository }]
  - id: clean
    name: STRIPE_WEBHOOK_SECRET
    stage: production
    service: stripe
    provider: stripe-webhook-secret
    params: { url: https://example.invalid/hook, events: [checkout.session.completed] }
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
variables:
  - id: v-url-staging
    name: SUPABASE_STAGING_URL
    stage: shared
    value: ${VALUE_URL}
    places: [{ repo: web, scope: environment, environment: staging }]
  - id: v-url-prod
    name: SUPABASE_PRODUCTION_URL
    stage: shared
    value: null
    places: [{ repo: web, scope: environment, environment: production }]
  - id: v-ref
    name: SUPABASE_PROJECT_REF
    stage: staging
    value: ${REF}
    places: [{ repo: web, scope: environment, environment: staging }]
  - id: v-account
    name: CLOUDFLARE_ACCOUNT_ID
    stage: shared
    value: ${VALUE_ACCOUNT}
    places: [{ repo: web, scope: repository }]
  - id: v-zone
    name: CLOUDFLARE_ZONE_ID
    stage: shared
    value: null
    places: [{ repo: web, scope: repository }]
  - id: v-sitekey
    name: TURNSTILE_SITE_KEY
    stage: shared
    value: null
    places: [{ repo: lonely, scope: repository }]
  - id: v-has-source
    name: SUPABASE_URL
    stage: production
    value: null
    from: { connection: supabase, kind: supabase.project, resource: ${REF}, field: url }
    places: [{ repo: other, scope: environment, environment: production }]
resourceMap:
  - { kind: cloudflare.turnstileWidget, repo: lonely, value: 0xmadeupsitekey01 }
`;

const open = (yaml = YAML) => InventoryStore.fromText(yaml);
const planOf = (yaml = YAML, naming = {}) => planNormalization(open(yaml).data, { naming });
const find = (changes: NormalizationChange[], id: string) => changes.find((c) => c.id === id);

describe("planNormalization", () => {
  it("renames with reason codes and flags the workflow change", () => {
    const c = find(planOf().changes, "rename:secret:cf-access")!;
    expect(c).toMatchObject({ kind: "rename", needsWorkflowChange: true, autoApplicable: true });
    expect(c.before[0]!.name).toBe("CF_ACCESS_CLIENT_ID");
    expect(c.after[0]!.name).toBe("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(c.reasons.map((r) => r.code)).toEqual(["provider-abbreviation"]);
  });

  it("compliant names produce no change", () => {
    expect(planOf().changes.filter((c) => c.entryIds.includes("clean"))).toEqual([]);
  });

  it("keeps entry ids", () => {
    expect(find(planOf().changes, "rename:secret:sb-secret-staging")!.after[0]!.id).toBe("sb-secret-staging");
  });

  it("switches the supabase secret key to the provider and keeps projectRef", () => {
    const { changes } = planOf();
    const staging = find(changes, "provider:secret:sb-secret-staging")!;
    expect(staging.after[0]).toMatchObject({ provider: "supabase-api-key", paramKeys: ["projectRef", "type"] });
    expect(staging.missingParams).toEqual([]);
    const prod = find(changes, "provider:secret:sb-secret-prod")!;
    expect(prod.missingParams).toEqual(["projectRef"]);
    expect(prod.reasons.map((r) => r.code)).toContain("params-needed");
  });

  it("switches the DB password to supabase-db-password and names the missing projectRef", () => {
    const db = find(planOf().changes, "provider:secret:sb-db-password")!;
    expect(db).toMatchObject({ kind: "provider", missingParams: ["projectRef"], after: [{ provider: "supabase-db-password" }] });
    expect(db.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["supabase-db-password", "params-needed"]));
    expect(find(planOf().changes, "manual-only:secret:sb-db-password")).toBeUndefined();
  });

  it("leaves providers without an API as manual-only with the reason", () => {
    const { changes } = planOf();
    expect(find(changes, "manual-only:secret:revenuecat")!.reasons[0]!.code).toBe("revenuecat");
    const openai = find(changes, "manual-only:secret:openai-key")!.reasons[0]!;
    expect(openai.code).toBe("openai-admin");
    expect(openai.text).toMatch(/Admin-API/);
    expect(openai.text).not.toMatch(/nur von Hand/);
    const anthropic = find(changes, "manual-only:secret:anthropic-key")!.reasons[0]!;
    expect(anthropic.code).toBe("anthropic-browser");
    expect(anthropic.text).toMatch(/Console/);
    expect(anthropic.text).toMatch(/Admin-API/);
    // every other manual secret is listed too, with a reason
    expect(find(changes, "manual-only:secret:cf-access")!.reasons.map((r) => r.code)).toEqual(["cloudflare-access-companion"]);
  });

  it("switches stripe webhook secrets and grafana tokens to their providers and names the missing parameters", () => {
    const extra = `  - id: stripe-hook
    name: STRIPE_WEBHOOK_SECRET
    stage: production
    service: stripe
    provider: manual
    expiry: none
    places: [{ repo: web, scope: environment, environment: production }]
  - id: grafana-read
    name: GRAFANA_READ_TOKEN
    stage: shared
    service: grafana
    provider: manual
    expiry: none
    params: { baseUrl: https://made-up.grafana.net }
    places: [{ repo: web, scope: repository }]
  - id: unknown-manual
    name: SOME_PARTNER_KEY
    stage: shared
    service: partner
    provider: manual
    expiry: none
    places: [{ repo: web, scope: repository }]
variables:
`;
    const { changes } = planOf(YAML.replace("variables:\n", extra));
    expect(find(changes, "provider:secret:stripe-hook")!).toMatchObject({ autoApplicable: true, missingParams: ["url", "events"], after: [{ provider: "stripe-webhook-secret" }] });
    expect(find(changes, "provider:secret:grafana-read")!).toMatchObject({ missingParams: ["serviceAccountId"], after: [{ provider: "grafana-service-account-token" }] });
    expect(find(changes, "manual-only:secret:unknown-manual")!.reasons[0]!.code).toBe("no-provider");
  });

  it("proposes the stage when the name carried it and the entry is shared", () => {
    const { changes } = planOf();
    expect(find(changes, "stage:variable:v-url-staging")!.after[0]!.stage).toBe("staging");
    expect(find(changes, "stage:variable:v-url-prod")!.after[0]!.stage).toBe("production");
    expect(find(changes, "stage:secret:cf-access")).toBeUndefined();
  });

  it("switches the Access client secret to its provider and proposes the single matching client ID entry", async () => {
    const entry = (id: string, name: string, stage: string, repo: string) => `  - id: ${id}
    name: ${name}
    stage: ${stage}
    service: cloudflare
    provider: manual
    expiry: none
    places: [{ repo: ${repo}, scope: repository }]
`;
    const yaml = (extra: string) => YAML.replace("variables:\n", `${extra}variables:\n`);
    const one = yaml(entry("acc-secret", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "shared", "web") + entry("acc-id", "CLOUDFLARE_ACCESS_CLIENT_ID", "shared", "web"));
    const c = find(planOf(one).changes, "provider:secret:acc-secret")!;
    expect(c).toMatchObject({ autoApplicable: true, missingParams: ["accountId"], after: [{ provider: "cloudflare-access-service-token", paramKeys: ["clientIdTarget"] }] });
    // two candidates, another stage or another repository: nothing is guessed
    for (const other of [entry("acc-id", "CLOUDFLARE_ACCESS_CLIENT_ID", "production", "web"), entry("acc-id", "CLOUDFLARE_ACCESS_CLIENT_ID", "shared", "other-repo"), entry("acc-id", "CLOUDFLARE_ACCESS_CLIENT_ID", "shared", "web") + entry("acc-id-2", "CLOUDFLARE_ACCESS_CLIENT_ID", "shared", "web")]) {
      const d = find(planOf(yaml(entry("acc-secret", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "shared", "web") + other)).changes, "provider:secret:acc-secret")!;
      expect(d.missingParams).toEqual(["accountId", "clientIdTarget"]);
    }
    // applying writes the proposal into the params
    const dir = await mkdtemp(join(tmpdir(), "sd-norm-"));
    const path = join(dir, "inventory.yaml");
    await writeFile(path, one);
    const store = await InventoryStore.open(path);
    await applyNormalization(store, {}, ["provider:secret:acc-secret"]);
    expect((await InventoryStore.open(path)).getSecret("acc-secret")).toMatchObject({ provider: "cloudflare-access-service-token", params: { clientIdTarget: "acc-id" } });
    // the client ID entry itself stays manual with the companion hint
    expect(find(planOf(one).changes, "manual-only:secret:acc-id")!.reasons[0]!.code).toBe("cloudflare-access-companion");
  });

  it("switches an R2 secret access key to its provider, proposes the matching key id and says the account id is configuration", () => {
    const entry = (id: string, name: string, repo = "web") => `  - id: ${id}
    name: ${name}
    stage: shared
    service: cloudflare
    provider: manual
    expiry: none
    places: [{ repo: ${repo}, scope: repository }]
`;
    const yaml = (extra: string) => YAML.replace("variables:\n", `${extra}variables:\n`);
    const two = yaml(
      entry("r2-secret", "CLOUDFLARE_R2_SECRET_ACCESS_KEY") + entry("r2-id", "CLOUDFLARE_R2_ACCESS_KEY_ID") + entry("state-secret", "CLOUDFLARE_R2_STATE_SECRET_ACCESS_KEY") + entry("state-id", "CLOUDFLARE_R2_STATE_ACCESS_KEY_ID") + entry("acct", "CLOUDFLARE_ACCOUNT_ID"),
    );
    const { changes } = planOf(two);
    // each pair picks its own id entry (same infix), the other parameters stay to be completed
    expect(find(changes, "provider:secret:r2-secret")).toMatchObject({ autoApplicable: true, missingParams: ["accountId", "access"], after: [{ provider: "cloudflare-r2-credentials", paramKeys: ["companionEntry", "value"] }] });
    expect(find(changes, "provider:secret:state-secret")!.missingParams).toEqual(["accountId", "access"]);
    expect(find(changes, "manual-only:secret:r2-id")!.reasons[0]!.code).toBe("cloudflare-r2-companion");
    expect(find(changes, "manual-only:secret:state-id")!.reasons[0]!.code).toBe("cloudflare-r2-companion");
    expect(find(changes, "manual-only:secret:acct")!.reasons[0]!.code).toBe("cloudflare-account-id-is-config");
    // no matching id entry: nothing is guessed
    expect(find(planOf(yaml(entry("r2-secret", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"))).changes, "provider:secret:r2-secret")!.missingParams).toEqual(["accountId", "access", "companionEntry"]);
  });

  it("proposes no stage when the places contradict the name", () => {
    const yaml = YAML.replace(`value: ${VALUE_URL}\n    places: [{ repo: web, scope: environment, environment: staging }]`, `value: ${VALUE_URL}\n    places: [{ repo: web, scope: environment, environment: production }]`);
    expect(find(planOf(yaml).changes, "stage:variable:v-url-staging")).toBeUndefined();
  });

  it("sets a variable source only when the resource is unambiguous", () => {
    const { changes } = planOf();
    expect(find(changes, "source:variable:v-url-staging")!).toMatchObject({ autoApplicable: true, after: [{ source: { kind: "supabase.project", field: "url", resource: REF } }] });
    expect(find(changes, "source:variable:v-ref")!.after[0]!.source).toMatchObject({ field: "ref", resource: REF });
    expect(find(changes, "source:variable:v-account")!.after[0]!.source).toMatchObject({ connection: "cloudflare", kind: "cloudflare.account", resource: VALUE_ACCOUNT });
    // from the resource map for repo (+ stage)
    expect(find(changes, "source:variable:v-sitekey")!.after[0]!.source).toMatchObject({ connection: "cloudflare-turnstile", resource: "0xmadeupsitekey01" });
    // nothing to derive it from: choose the resource, not auto-applicable, never guessed
    const zone = find(changes, "source:variable:v-zone")!;
    expect(zone.autoApplicable).toBe(false);
    expect(zone.after[0]!.source!.resource).toBeNull();
    expect(zone.reasons[0]!.code).toBe("source-choose-resource");
    expect(find(changes, "source:variable:v-url-prod")!.autoApplicable).toBe(false);
    // already has a source
    expect(find(changes, "source:variable:v-has-source")).toBeUndefined();
  });

  it("a value and a map entry that disagree make the resource ambiguous", () => {
    const yaml = YAML.replace("resourceMap:\n", "resourceMap:\n  - { kind: supabase.project, repo: web, stage: staging, value: zzzzzzzzzzzzzzzzzzzz }\n");
    const c = find(planOf(yaml).changes, "source:variable:v-ref")!;
    expect(c.autoApplicable).toBe(false);
    expect(c.reasons[0]!.code).toBe("source-conflict");
  });

  it("uses the cloudflare integration default for the account id", () => {
    const yaml = YAML.replace(`value: ${VALUE_ACCOUNT}`, "value: null") + `integrationDefaults:\n  cloudflare: { accountId: ${VALUE_ACCOUNT} }\n`;
    expect(find(planOf(yaml).changes, "source:variable:v-account")!.autoApplicable).toBe(true);
  });

  it("derives the resource from sibling variables and the one cloudflare account in use", () => {
    const extra = `  - id: v-pub-staging
    name: SUPABASE_PUBLISHABLE_KEY
    stage: staging
    value: null
    places: [{ repo: web, scope: environment, environment: staging }]
  - id: v-account-other
    name: CLOUDFLARE_ACCOUNT_ID
    stage: shared
    value: null
    places: [{ repo: other, scope: repository }]
resourceMap:
`;
    const yaml = YAML.replace("resourceMap:\n", extra);
    const { changes } = planOf(yaml);
    expect(find(changes, "source:variable:v-pub-staging")!).toMatchObject({ autoApplicable: true, after: [{ source: { field: "publishableKey", resource: REF } }] });
    expect(find(changes, "source:variable:v-account-other")!).toMatchObject({ autoApplicable: true, after: [{ source: { resource: VALUE_ACCOUNT } }] });
    // a second account in use: no guess
    const two = yaml.replace("    value: null\n    places: [{ repo: other, scope: repository }]", "    value: fedcba9876543210fedcba9876543210\n    places: [{ repo: other, scope: repository }]") + `  - id: v-account-third
    name: CLOUDFLARE_ACCOUNT_ID
    stage: shared
    value: null
    places: [{ repo: third, scope: repository }]
`;
    expect(find(planOf(two.replace("resourceMap:\n", "").replace(/\n  - \{ kind: cloudflare.turnstileWidget.*\n/, "\n")).changes, "source:variable:v-account-third")!.autoApplicable).toBe(false);
  });

  it("turns a name collision into a merge change that is not auto-applicable", () => {
    const yaml = `version: 1
variables:
  - { id: a, name: VITE_SUPABASE_URL, value: null, places: [{ repo: web, scope: repository }] }
  - { id: b, name: SUPABASE_URL, value: null, places: [{ repo: web, scope: repository }] }
  - { id: c, name: NEXT_PUBLIC_SUPABASE_URL, value: null, places: [{ repo: other, scope: repository }] }
`;
    const { changes } = planOf(yaml);
    const merge = changes.find((c) => c.kind === "merge")!;
    expect(merge).toMatchObject({ entryIds: ["a", "b"], autoApplicable: false, conflicts: ["a", "b"] });
    expect(merge.reasons[0]!.code).toBe("name-collision");
    // the colliding rename is withheld, the unrelated one is offered
    expect(find(changes, "rename:variable:a")).toBeUndefined();
    expect(find(changes, "rename:variable:c")).toBeDefined();
  });

  it("does not report a collision when the environments differ", () => {
    const yaml = `version: 1
variables:
  - { id: a, name: SUPABASE_STAGING_URL, value: null, places: [{ repo: web, scope: environment, environment: staging }] }
  - { id: b, name: SUPABASE_PRODUCTION_URL, value: null, places: [{ repo: web, scope: environment, environment: production }] }
`;
    expect(planOf(yaml).changes.some((c) => c.kind === "merge")).toBe(false);
  });

  it("takes the stage proposal into account for collisions", () => {
    const yaml = `version: 1
variables:
  - { id: a, name: SUPABASE_STAGING_URL, stage: shared, value: null, places: [{ repo: web, scope: environment, environment: staging }] }
  - { id: b, name: SUPABASE_URL, stage: staging, value: null, places: [{ repo: web, scope: environment, environment: staging }] }
`;
    const { changes } = planOf(yaml);
    expect(changes.find((c) => c.kind === "merge")!.entryIds).toEqual(["a", "b"]);
  });

  it("does not touch pre-existing duplicates that are not renamed", () => {
    const yaml = `version: 1
variables:
  - { id: a, name: SAME_NAME, value: null, places: [{ repo: web, scope: repository }] }
  - { id: b, name: SAME_NAME, value: null, places: [{ repo: web, scope: repository }] }
`;
    expect(planOf(yaml).changes).toEqual([]);
  });

  it("honours naming.renames and naming.keep", () => {
    const yaml = `version: 1
secrets:
  - { id: m, name: MAIL_API_KEY, service: resend, expiry: none, stage: production, places: [{ repo: web, scope: environment }] }
  - { id: k, name: CF_API_TOKEN, service: cloudflare, expiry: none, stage: production, places: [{ repo: web, scope: environment }] }
`;
    const { changes } = planOf(yaml, { renames: { MAIL_API_KEY: "RESEND_API_KEY" }, keep: ["CF_API_TOKEN"] });
    expect(find(changes, "rename:secret:m")!.after[0]!.name).toBe("RESEND_API_KEY");
    expect(find(changes, "rename:secret:m")!.reasons[0]!.code).toBe("workspace-rename");
    expect(find(changes, "rename:secret:k")).toBeUndefined();
  });

  it("is deterministic and shows no value", () => {
    const a = JSON.stringify(planOf());
    expect(a).toBe(JSON.stringify(planOf()));
    // The variable's expected value (the full URL) and secret metadata never appear. A source's resource id is the same
    // identifier the variable list already shows under "from", so it is the only place an id may occur.
    for (const v of [VALUE_URL, SECRET_LIKE]) expect(a).not.toContain(v);
    expect(a.split(VALUE_ACCOUNT).length - 1).toBe(1);
  });
});

describe("applyNormalization", () => {
  const all = (store: InventoryStore) => planNormalization(store.data, {}).changes.filter((c) => c.autoApplicable).map((c) => c.id);

  async function onDisk() {
    const dir = await mkdtemp(join(tmpdir(), "sd-normalize-"));
    const path = join(dir, "inventory.yaml");
    await writeFile(path, YAML);
    return { path, store: await InventoryStore.open(path) };
  }

  it("applies all unambiguous changes and writes the file", async () => {
    const { path, store } = await onDisk();
    const result = await applyNormalization(store, {}, all(store));
    expect(result.applied.length).toBeGreaterThan(5);
    expect(result.needsParams).toEqual([{ secretId: "sb-secret-prod", missing: ["projectRef"] }, { secretId: "sb-db-password", missing: ["projectRef"] }]);
    const reloaded = await InventoryStore.open(path);
    expect(reloaded.getSecret("sb-secret-staging")).toMatchObject({ name: "SUPABASE_SECRET_KEY", provider: "supabase-api-key", params: { projectRef: REF, type: "secret" } });
    expect(reloaded.getVariable("v-url-staging")).toMatchObject({ name: "SUPABASE_URL", stage: "staging", from: { kind: "supabase.project", resource: REF, field: "url" } });
    expect(reloaded.getSecret("cf-access")!.name).toBe("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(reloaded.getSecret("sb-db-password")!.provider).toBe("supabase-db-password");
    // values and unrelated fields survive
    expect(reloaded.getVariable("v-account")!.value).toBe(VALUE_ACCOUNT);
    expect(reloaded.getSecret("cf-access")!.notes).toBe(SECRET_LIKE);
    // second run: nothing left to do automatically
    expect(all(reloaded)).toEqual([]);
  });

  it("applies only the selected changes", async () => {
    const { store } = await onDisk();
    await applyNormalization(store, {}, ["rename:secret:cf-access"]);
    expect(store.getSecret("cf-access")!.name).toBe("CLOUDFLARE_ACCESS_CLIENT_ID");
    expect(store.getSecret("sb-secret-prod")!.name).toBe("SUPABASE_PRODUCTION_SERVICE_ROLE_KEY");
  });

  it("is atomic: one bad id changes nothing in memory or on disk", async () => {
    const { path, store } = await onDisk();
    const before = await readFile(path, "utf8");
    await expect(applyNormalization(store, {}, ["rename:secret:cf-access", "rename:secret:does-not-exist"])).rejects.toThrow(/Unbekannte Aenderung/);
    expect(store.getSecret("cf-access")!.name).toBe("CF_ACCESS_CLIENT_ID");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("refuses merge, manual-only, unresolved sources and an empty selection", async () => {
    const { store } = await onDisk();
    await expect(applyNormalization(store, {}, ["manual-only:secret:revenuecat"])).rejects.toThrow(/nicht automatisch anwendbar/);
    await expect(applyNormalization(store, {}, ["source:variable:v-zone"])).rejects.toThrow(/nicht automatisch anwendbar/);
    await expect(applyNormalization(store, {}, [])).rejects.toThrow(/Keine Aenderung/);
  });

  it("rolls back when a partial selection would collide after the rename", async () => {
    // With the stage proposal the two differ (dev vs shared); a rename alone would make them clash.
    const yaml = `version: 1
variables:
  - { id: a, name: DEV_KEY, stage: shared, value: null, places: [{ repo: web, scope: repository }] }
  - { id: b, name: KEY, stage: shared, value: null, places: [{ repo: web, scope: repository }] }
`;
    const store = open(yaml);
    const ids = planNormalization(store.data).changes.map((c) => c.id);
    expect(ids).toEqual(["rename:variable:a", "stage:variable:a"]);
    const text = store.toString();
    await expect(applyNormalization(store, {}, ["rename:variable:a"])).rejects.toThrow(/denselben Namen/);
    expect(store.toString()).toBe(text);
    // the full selection is fine
    await applyNormalization(store, {}, ids);
    expect(store.getVariable("a")).toMatchObject({ name: "KEY", stage: "dev" });
  });

  it("never calls GitHub: no client is involved and a global fetch is not used", async () => {
    const { store } = await onDisk();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await applyNormalization(store, {}, all(store));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });

  it("the result lists no value", async () => {
    const { store } = await onDisk();
    const text = JSON.stringify(await applyNormalization(store, {}, all(store)));
    for (const v of [VALUE_URL, VALUE_ACCOUNT, SECRET_LIKE]) expect(text).not.toContain(v);
  });
});

describe("RevenueCat source suggestions", () => {
  const YML = `version: 1
variables:
  - id: rc-project
    name: REVENUECAT_PROJECT_ID
    stage: production
    value: proj1ab2c3d4
    places: [{ repo: web, scope: repository }]
  - id: rc-web-app
    name: REVENUECAT_WEB_APP_ID
    stage: production
    value: app1ab2c3d4
    places: [{ repo: web, scope: repository }]
  - id: rc-ios
    name: REVENUECAT_IOS_SDK_KEY
    stage: production
    value: null
    places: [{ repo: web, scope: repository }]
  - id: rc-sandbox
    name: REVENUECAT_SANDBOX_SDK_KEY
    stage: production
    value: null
    places: [{ repo: web, scope: repository }]
`;
  const src = (id: string) => find(planOf(YML).changes, `source:variable:${id}`)!;
  it("suggests the project and app id sources and resolves the resource from the value", () => {
    expect(src("rc-project").after[0]!.source).toEqual({ connection: "revenuecat", kind: "revenuecat.project", field: "id", resource: "proj1ab2c3d4" });
    expect(src("rc-project").autoApplicable).toBe(true);
    expect(src("rc-web-app").after[0]!.source).toMatchObject({ kind: "revenuecat.app", field: "id", resource: "app1ab2c3d4" });
  });
  it("suggests the SDK key sources but leaves the app to choose", () => {
    expect(src("rc-ios").after[0]!.source).toEqual({ connection: "revenuecat", kind: "revenuecat.publicApiKey", field: "production", resource: null });
    expect(src("rc-ios").autoApplicable).toBe(false);
    expect(src("rc-sandbox").after[0]!.source).toMatchObject({ field: "sandbox", resource: null });
  });
});
