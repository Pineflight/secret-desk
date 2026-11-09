import { describe, expect, it } from "vitest";
import { connectionGuide, grafanaServiceAccountsUrl, tokenPrefixProblem } from "../src/connection-guides.js";

describe("grafana-cloud guide", () => {
  it("lists the scopes the sign-in asks for, marks the unsure ones and points to the sign-in", () => {
    const g = connectionGuide("grafana-cloud", "acme")!;
    expect(g.permissions.join("\n")).toMatch(/accesspolicies:write[\s\S]*accesspolicies:read[\s\S]*stacks:read/);
    expect(g.permissions.filter((p) => p.includes("nicht sicher"))).toHaveLength(2);
    expect(g.steps.join("\n")).toContain("Mit Anmeldung verbinden");
  });
  it("accepts glc_ tokens only", () => {
    expect(tokenPrefixProblem("grafana-cloud", "glc_abc")).toBeUndefined();
    expect(tokenPrefixProblem("grafana-cloud", "glsa_abc")).toMatch(/glc_/);
    expect(tokenPrefixProblem("grafana", "glsa_abc")).toBeUndefined();
  });
});

describe("grafana guide link", () => {
  it("falls back to the profile page that forwards to the own organization", () => {
    const g = connectionGuide("grafana", "acme")!;
    expect(g.url).toBe("https://grafana.com/profile/org");
    expect(g.openUrl).toBeUndefined();
  });
  it("links straight to the service accounts of a known stack", () => {
    expect(connectionGuide("grafana", "acme", { grafanaBaseUrl: "https://acme.grafana.net/" })!.openUrl).toBe("https://acme.grafana.net/org/serviceaccounts");
    expect(grafanaServiceAccountsUrl("http://acme.grafana.net")).toBeUndefined();
    expect(grafanaServiceAccountsUrl("not a url")).toBeUndefined();
    expect(grafanaServiceAccountsUrl("https://user:pw@acme.grafana.net")).toBeUndefined();
  });
});

describe("stripe account guides", () => {
  it("a live connection points at the live key page and asks for a live key", () => {
    const g = connectionGuide("stripe:acct_madeup1:live", "acme")!;
    expect(g.label).toBe("Stripe acct_madeup1 (Live)");
    expect(g.url).toBe("https://dashboard.stripe.com/acct_madeup1/apikeys");
    expect(g.description).toMatch(/Live-Modus/);
    expect(g.steps.join("\n")).toMatch(/Dashboard des Kontos acct_madeup1 \(Live\)/);
    expect(g.steps.join("\n")).toMatch(/beginnt mit rk_live_/);
  });

  it("a sandbox connection points at the test key page and asks for a sandbox key", () => {
    const g = connectionGuide("stripe:acct_madeup1:sandbox", "acme")!;
    expect(g.label).toBe("Stripe acct_madeup1 (Sandbox)");
    expect(g.url).toBe("https://dashboard.stripe.com/acct_madeup1/test/apikeys");
    expect(g.description).toMatch(/Sandbox des Kontos/);
    expect(g.steps.join("\n")).toMatch(/Dashboard des Kontos acct_madeup1 \(Sandbox\)/);
    expect(g.steps.join("\n")).toMatch(/beginnt mit rk_test_/);
  });
});

describe("team-sync guide", () => {
  it("without options: default read rights, the owner as target and a generic repository hint", () => {
    const g = connectionGuide("team-sync", "acme")!;
    expect(g.permissions).toEqual(["Contents: Read", "Metadata: Read"]);
    const q = new URL(g.openUrl!).searchParams;
    expect(q.get("target_name")).toBe("acme");
    expect(q.get("contents")).toBe("read");
    expect(q.has("pull_requests")).toBe(false);
    expect(g.steps.join("\n")).toContain("das Team-Repository");
    expect(g.steps.join("\n")).not.toMatch(/Eigentuemer \(/);
  });

  it("with the team repository: its owner and name appear, write rights are requested as given", () => {
    const g = connectionGuide("team-sync", "acme", { teamRepo: "team-org/team-config", teamRights: ["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"] })!;
    const q = new URL(g.openUrl!).searchParams;
    expect(q.get("target_name")).toBe("team-org");
    expect(q.get("contents")).toBe("write");
    expect(q.get("pull_requests")).toBe("write");
    expect(g.steps.join("\n")).toContain("Eigentuemer (team-org)");
    expect(g.steps.join("\n")).toContain("genau team-config ankreuzen");
  });
});

describe("token prefix checks of the admin connections", () => {
  it("openai needs sk-admin-", () => {
    expect(tokenPrefixProblem("openai", "sk-admin-made-up")).toBeUndefined();
    expect(tokenPrefixProblem("openai", " sk-admin-made-up ")).toBeUndefined();
    expect(tokenPrefixProblem("openai", "sk-made-up")).toMatch(/OpenAI-Admin-Key/);
  });

  it("anthropic needs sk-ant-admin", () => {
    expect(tokenPrefixProblem("anthropic", "sk-ant-admin01-made-up")).toBeUndefined();
    expect(tokenPrefixProblem("anthropic", "sk-ant-api03-made-up")).toMatch(/Anthropic-Admin-Key/);
  });

  it("revenuecat needs sk_", () => {
    expect(tokenPrefixProblem("revenuecat", "sk_made_up")).toBeUndefined();
    expect(tokenPrefixProblem("revenuecat", "made_up")).toMatch(/RevenueCat-v2/);
  });
});
