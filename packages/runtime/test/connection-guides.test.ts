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
