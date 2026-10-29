import { describe, expect, it } from "vitest";
import { connectionGuide, grafanaServiceAccountsUrl } from "../src/connection-guides.js";

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
