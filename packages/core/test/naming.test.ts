import { describe, expect, it } from "vitest";
import { analyzeName, checkName, suggestName } from "../src/naming.js";

describe("suggestName: real-world examples", () => {
  const cases: [string, string][] = [
    ["CF_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_ID"],
    ["CF_ACCESS_CLIENT_SECRET", "CLOUDFLARE_ACCESS_CLIENT_SECRET"],
    ["GH_SECRETS_SYNC_TOKEN", "SECRETS_SYNC_GITHUB_TOKEN"],
    ["TF_STATE_BUCKET", "TERRAFORM_STATE_BUCKET"],
    ["R2_STATE_ACCESS_KEY_ID", "CLOUDFLARE_R2_STATE_ACCESS_KEY_ID"],
    ["SUPABASE_STAGING_PROJECT_REF", "SUPABASE_PROJECT_REF"],
    ["SUPABASE_PRODUCTION_URL", "SUPABASE_URL"],
    ["VAPID_PRIVATE_KEY_PRODUCTION", "VAPID_PRIVATE_KEY"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"],
    ["VITE_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"],
    ["SUPABASE_STAGING_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"],
    ["SUPABASE_PRODUCTION_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY"],
    ["SUPABASE_STAGING_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
    ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
    ["VITE_SUPABASE_URL", "SUPABASE_URL"],
    ["RATE_LIMIT_GEHEIMNIS_WEB", "RATE_LIMIT_SECRET_WEB"],
    ["KUNDENDOMAIN_ABGLEICH_TOKEN", "CUSTOMER_DOMAIN_RECONCILIATION_TOKEN"],
    ["CLOUDFLARE_ZONE_ID_WAKEMILES", "CLOUDFLARE_ZONE_ID_WAKEMILES"],
    ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"],
  ];
  for (const [from, to] of cases) it(`${from} -> ${to}`, () => expect(suggestName(from)).toBe(to));
});

describe("rules", () => {
  it("1: upper snake case", () => {
    expect(suggestName("stripe-webhook-secret")).toBe("STRIPE_WEBHOOK_SECRET");
    expect(suggestName("stripeWebhookSecret")).toBe("STRIPE_WEBHOOK_SECRET");
    expect(checkName("stripe_key").map((f) => f.code)).toContain("not-upper-snake");
  });
  it("2: stage tokens only as whole tokens", () => {
    for (const t of ["STAGING", "STAGE", "PRODUCTION", "PROD", "LIVE", "DEV", "TEST"]) expect(suggestName(`MAIL_${t}_KEY`)).toBe("MAIL_KEY");
    expect(suggestName("DEVICE_KEY")).toBe("DEVICE_KEY");
    expect(suggestName("PRODUCT_KEY")).toBe("PRODUCT_KEY");
    expect(analyzeName("MAIL_PRODUCTION_KEY").removedStageTokens).toEqual(["PRODUCTION"]);
  });
  it("2: a name that is only a stage word stays", () => {
    expect(suggestName("LIVE")).toBe("LIVE");
  });
  it("3: provider abbreviations", () => {
    expect(suggestName("CF_API_TOKEN")).toBe("CLOUDFLARE_API_TOKEN");
    expect(suggestName("GH_DEPLOY")).toBe("DEPLOY_GITHUB");
    expect(suggestName("GH_DEPLOY_TOKEN")).toBe("DEPLOY_GITHUB_TOKEN");
    expect(suggestName("CFX_KEY")).toBe("CFX_KEY");
  });
  it("3: GITHUB_ is flagged and moved to the end", () => {
    const f = checkName("GITHUB_DEPLOY_TOKEN");
    expect(f.map((x) => x.code)).toContain("github-prefix");
    expect(f[0]!.suggested).toBe("DEPLOY_GITHUB_TOKEN");
    expect(suggestName("GITHUB_APP_ID")).toBe("APP_ID_GITHUB");
  });
  it("3: a bare GITHUB_TOKEN is flagged but there is no suggestion", () => {
    const f = checkName("GITHUB_TOKEN");
    expect(f.map((x) => x.code)).toEqual(["github-prefix"]);
    expect(f[0]!.suggested).toBe("GITHUB_TOKEN");
  });
  it("4: framework prefixes", () => {
    expect(suggestName("NEXT_PUBLIC_TURNSTILE_SITE_KEY")).toBe("TURNSTILE_SITE_KEY");
    expect(suggestName("VITE_API_URL")).toBe("API_URL");
    expect(checkName("VITE_API_URL").map((f) => f.code)).toEqual(["framework-prefix"]);
  });
  it("5: supabase canonical names", () => {
    expect(suggestName("SUPABASE_ANON_KEY")).toBe("SUPABASE_PUBLISHABLE_KEY");
    expect(suggestName("SUPABASE_SERVICE_ROLE_KEY")).toBe("SUPABASE_SECRET_KEY");
    expect(suggestName("OTHER_ANON_KEY")).toBe("OTHER_ANON_KEY");
  });
  it("6: the German dictionary, unknown words are not guessed", () => {
    expect(suggestName("MANDANT_BENUTZER_HINWEIS")).toBe("TENANT_USER_NOTICE");
    expect(suggestName("WIDERRUFSBELEHRUNG_SENDEN")).toBe("WITHDRAWAL_NOTICE_SEND");
    expect(suggestName("FROBNICATOR_KEY")).toBe("FROBNICATOR_KEY");
  });
  it("names that comply produce no finding", () => {
    for (const n of ["STRIPE_WEBHOOK_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID_WAKEMILES", "SUPABASE_SECRET_KEY"]) expect(checkName(n)).toEqual([]);
  });
  it("every finding carries a code, a text and the suggested name", () => {
    for (const f of checkName("NEXT_PUBLIC_CF_SUPABASE_ANON_KEY_PRODUCTION")) {
      expect(f.code).toBeTruthy();
      expect(f.text).toBeTruthy();
      expect(f.suggested).toBe("CLOUDFLARE_SUPABASE_ANON_KEY");
    }
  });
});

describe("workspace overrides", () => {
  it("renames win over the generic rules", () => {
    expect(suggestName("MAIL_API_KEY", { renames: { MAIL_API_KEY: "RESEND_API_KEY" } })).toBe("RESEND_API_KEY");
    expect(suggestName("CF_API_TOKEN", { renames: { CF_API_TOKEN: "EDGE_TOKEN" } })).toBe("EDGE_TOKEN");
    expect(checkName("MAIL_API_KEY", { renames: { MAIL_API_KEY: "RESEND_API_KEY" } }).map((f) => f.code)).toEqual(["workspace-rename"]);
  });
  it("keep is never changed", () => {
    expect(suggestName("CF_API_TOKEN", { keep: ["CF_API_TOKEN"] })).toBe("CF_API_TOKEN");
    expect(checkName("CF_API_TOKEN", { keep: ["CF_API_TOKEN"] })).toEqual([]);
  });
  it("keep wins over renames", () => {
    expect(suggestName("A_KEY", { keep: ["A_KEY"], renames: { A_KEY: "B_KEY" } })).toBe("A_KEY");
  });
  it("an empty renames map changes nothing", () => {
    expect(suggestName("TOSTRING_KEY", { renames: {} })).toBe("TOSTRING_KEY");
  });
});

describe("idempotency", () => {
  const samples = [
    "CF_ACCESS_CLIENT_ID", "GH_SECRETS_SYNC_TOKEN", "GITHUB_DEPLOY_TOKEN", "GITHUB_TOKEN", "TF_STATE_BUCKET", "R2_STATE_KEY", "NEXT_PUBLIC_CF_TOKEN",
    "VITE_GH_X", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_STAGING_SERVICE_ROLE_KEY", "KUNDENDOMAIN_ABGLEICH_TOKEN", "stripe-key", "myCamelKey",
    "STAGING_PRODUCTION_LIVE", "GH_GH_X", "CF_CF_X", "DEV_GITHUB_X", "ZIEL_BASIS_STOPP", "R2_R2_KEY", "A", "LIVE", "VITE_NEXT_PUBLIC_X", "TEST_SUPABASE_ANON_KEY_PROD",
  ];
  for (const s of samples) it(s, () => expect(suggestName(suggestName(s))).toBe(suggestName(s)));
  it("with overrides", () => {
    const naming = { renames: { MAIL_API_KEY: "RESEND_API_KEY" } };
    expect(suggestName(suggestName("MAIL_API_KEY", naming), naming)).toBe("RESEND_API_KEY");
  });
  it("the suggestion has no finding left", () => {
    for (const s of samples) expect(checkName(suggestName(s)).filter((f) => f.code !== "github-prefix")).toEqual([]);
  });
});
