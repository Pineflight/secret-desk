import { describe, expect, it } from "vitest";
import { baseUrl } from "../src/grafana.js";
import { probeWithValue } from "../src/checks.js";
import { callWithToken } from "../src/http.js";
import { grafanaAccessPolicyProvider as policy, grafanaProvider as p } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, byId, connections, expectNoLeak, issueCtx, mockFetch, revokeCtx, routeFetch, secretEntry, verifyCtx } from "./helpers.js";

const params = { baseUrl: "https://example.grafana.net/", serviceAccountId: 7 };

describe("grafana-service-account-token", () => {
  it("creates a token with lifetime", async () => {
    const m = mockFetch({ body: { id: 42, key: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"], ttlDays: 30 }));
    expect(m.calls[0]).toMatchObject({ url: "https://example.grafana.net/api/serviceaccounts/7/tokens", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: "test-secret-2026-11-01", secondsToLive: 30 * 86400 });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("42");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("sends no secondsToLive without ttlDays", async () => {
    const m = mockFetch({ body: { id: 1, key: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] }));
    expect(JSON.parse(m.calls[0]!.body!)).not.toHaveProperty("secondsToLive");
    expect(r.expiresAt).toBeNull();
  });
  it("rejects http addresses", async () => {
    await expect(p.issue!(issueCtx(mockFetch().fetch, { ...params, baseUrl: "http://x.example" }, { conns: ["grafana"] }))).rejects.toThrow(ProviderError);
  });
  it("revokes via DELETE", async () => {
    const m = mockFetch({ body: { message: "ok" } });
    await p.revoke!(revokeCtx(m.fetch, params, "42", ["grafana"]));
    expect(m.calls[0]).toMatchObject({ url: "https://example.grafana.net/api/serviceaccounts/7/tokens/42", method: "DELETE" });
  });
  it("error 403 without values", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
});

describe("F4: baseUrl is not free (connection token must not go to foreign hosts)", () => {
  const evil = [
    "https://evil.example",
    "https://evil.example/",
    "https://example.grafana.net.evil.example",
    "https://evil-grafana.net",
    "https://grafana.net",
    "https://example.grafana.net@evil.example/",
    "https://user:pw@example.grafana.net",
    "https://example.grafana.net:8443",
    "https://evil.example/.grafana.net",
    "http://example.grafana.net",
    "https://127.0.0.1",
  ];
  for (const url of evil) {
    it(`issue rejects ${url} without a network call`, async () => {
      const m = mockFetch({ body: { id: 1, key: ISSUED } });
      await expect(p.issue!(issueCtx(m.fetch, { ...params, baseUrl: url }, { conns: ["grafana"] }))).rejects.toThrow(ProviderError);
      expect(m.calls).toHaveLength(0);
    });
  }
  it("revoke and verify reject as well, without a network call", async () => {
    const m = mockFetch({ body: [] });
    await expect(p.revoke!(revokeCtx(m.fetch, { ...params, baseUrl: "https://evil.example" }, "42", ["grafana"]))).rejects.toThrow(ProviderError);
    const checks = await p.verify!(verifyCtx(m.fetch, { ...params, baseUrl: "https://evil.example" }, { conns: ["grafana"], externalId: "42" }));
    expect(checks[0]!.status).toBe("warn");
    expect(m.calls).toHaveLength(0);
  });
  it("*.grafana.net works, also in different letter case; path prefix stays", () => {
    expect(baseUrl({ baseUrl: "https://Stack.Grafana.NET/" })).toBe("https://stack.grafana.net");
    expect(baseUrl({ baseUrl: "https://stack.grafana.net/grafana/" })).toBe("https://stack.grafana.net/grafana");
  });
  it("own hosts only via providers.grafana.allowedHosts, exact", async () => {
    const cfg = { grafana: { allowedHosts: ["metrics.corp.example"] } };
    expect(baseUrl({ baseUrl: "https://metrics.corp.example" }, cfg)).toBe("https://metrics.corp.example");
    expect(() => baseUrl({ baseUrl: "https://metrics.corp.example" })).toThrow(ProviderError);
    expect(() => baseUrl({ baseUrl: "https://x.metrics.corp.example" }, cfg)).toThrow(ProviderError);
    expect(() => baseUrl({ baseUrl: "https://metrics.corp.example.evil.example" }, cfg)).toThrow(ProviderError);
    const m = mockFetch({ body: { id: 5, key: ISSUED } });
    const ctx = { ...issueCtx(m.fetch, { ...params, baseUrl: "https://metrics.corp.example" }, { conns: ["grafana"] }), providerConfig: cfg };
    await p.issue!(ctx);
    expect(m.calls[0]!.url).toBe("https://metrics.corp.example/api/serviceaccounts/7/tokens");
  });
});

describe("F4/N8: redirects are never followed", () => {
  it("call with bearer token: redirect manual, 3xx is an error", async () => {
    const m = mockFetch({ status: 302 });
    const err = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(m.calls[0]!.redirect).toBe("manual");
    expect(m.calls).toHaveLength(1);
  });
  it("callWithToken: redirect manual", async () => {
    const m = mockFetch({ status: 301 });
    await expect(callWithToken("x", { fetch: m.fetch, connections: connections("grafana") }, "grafana", "https://example.grafana.net/a", { method: "GET" })).rejects.toThrow(/Weiterleitung/);
    expect(m.calls[0]!.redirect).toBe("manual");
  });
  it("checker with value (probeWithValue, also apikey header): redirect manual, status 3xx comes back", async () => {
    const m = mockFetch({ status: 307 });
    const r = await probeWithValue("x", verifyCtx(m.fetch, {}), "https://api.example.com/x", { apikey: "k" });
    expect(r.status).toBe(307);
    expect(m.calls[0]!.redirect).toBe("manual");
    expect(m.calls).toHaveLength(1);
  });
});

describe("grafana-access-policy-token", () => {
  const pp = { region: "eu", accessPolicyId: "pol-1" };
  const conns = { conns: ["grafana-cloud"] };
  it("is automatic and uses the grafana-cloud connection", () => {
    expect(policy).toMatchObject({ kind: "automatic", connection: "grafana-cloud" });
    expect(policy.params!.find((s) => s.key === "accessPolicyId")).toMatchObject({ required: true, discover: "grafana.accessPolicy" });
    expect(policy.params!.find((s) => s.key === "region")).toMatchObject({ required: true });
  });
  it("creates a token with name and expiry (default 90 days) at the fixed Grafana host", async () => {
    const m = mockFetch({ body: { id: "tok-9", token: ISSUED } });
    const r = await policy.issue!(issueCtx(m.fetch, pp, conns));
    expect(m.calls[0]).toMatchObject({ url: "https://www.grafana.com/api/v1/tokens?region=eu", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ accessPolicyId: "pol-1", name: "test-secret-2026-11-01", displayName: "test-secret-2026-11-01", expiresAt: "2027-01-30T10:00:00Z" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("tok-9");
    expect(r.expiresAt).toBe("2027-01-30T10:00:00Z");
  });
  it("uses ttlDays when set", async () => {
    const m = mockFetch({ body: { id: "t", token: ISSUED } });
    const r = await policy.issue!(issueCtx(m.fetch, pp, { ...conns, ttlDays: 30 }));
    expect(JSON.parse(m.calls[0]!.body!).expiresAt).toBe("2026-12-01T10:00:00Z");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
  });
  it("revokes via DELETE with the region", async () => {
    const m = mockFetch({ status: 204 });
    await policy.revoke!(revokeCtx(m.fetch, pp, "tok-9", ["grafana-cloud"]));
    expect(m.calls[0]).toMatchObject({ url: "https://www.grafana.com/api/v1/tokens/tok-9?region=eu", method: "DELETE" });
  });
  it("revoke is idempotent on 404 but not on 403", async () => {
    await expect(policy.revoke!(revokeCtx(mockFetch({ status: 404, body: "gone" }).fetch, pp, "t", ["grafana-cloud"]))).resolves.toBeUndefined();
    await expect(policy.revoke!(revokeCtx(mockFetch({ status: 403, body: "no" }).fetch, pp, "t", ["grafana-cloud"]))).rejects.toThrow(ProviderError);
  });
  it("discovers access policies of the region", async () => {
    const m = mockFetch({ body: { items: [{ id: "pol-1", name: "ci", displayName: "CI shipper", scopes: ["logs:write", "metrics:write"] }, { name: "no-id" }] } });
    const opts = await policy.discover!("grafana.accessPolicy", { connections: connections("grafana-cloud"), fetch: m.fetch, params: { region: "eu" }, hint: { repos: [] } });
    expect(m.calls[0]).toMatchObject({ url: "https://www.grafana.com/api/v1/accesspolicies?region=eu", method: "GET" });
    expect(opts).toEqual([{ value: "pol-1", label: "CI shipper", detail: "logs:write, metrics:write" }]);
  });
  it("discovery needs the region and rejects other kinds", async () => {
    const ctx = { connections: connections("grafana-cloud"), fetch: mockFetch().fetch, params: {}, hint: { repos: [] } };
    await expect(policy.discover!("grafana.accessPolicy", ctx)).rejects.toThrow();
    await expect(policy.discover!("other", ctx)).rejects.toThrow();
  });
  it("rejects a region that could change the request", async () => {
    for (const region of ["eu&x=1", "EU", "a/b", "", "e"]) await expect(policy.issue!(issueCtx(mockFetch().fetch, { ...pp, region }, conns))).rejects.toThrow(ProviderError);
  });
  it("error responses carry no token values", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await policy.issue!(issueCtx(m.fetch, pp, conns)).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
  it("an answer without token or id is an error", async () => {
    await expect(policy.issue!(issueCtx(mockFetch({ body: { id: "x" } }).fetch, pp, conns))).rejects.toThrow(/Unerwartete Antwort/);
  });
  it("verify: 200 passes, 401 fails, 403 and others are not checkable", async () => {
    const run = (status: number) => policy.verify!(verifyCtx(mockFetch({ status, body: [] }).fetch, pp, { externalId: "t", expiresAt: "2027-01-30T10:00:00Z" }));
    expect(byId(await run(200))["works"]).toBe("pass");
    expect(byId(await run(401))["works"]).toBe("fail");
    const c403 = await run(403);
    expect(byId(c403)["works"]).toBe("info");
    expect(c403.find((c) => c.id === "works")!.detail).toContain("nicht pruefbar");
    expect(byId(await run(500))["works"]).toBe("info");
    expectNoLeak(await run(401));
  });
  it("preflight finds the policy, fails for an unknown one and warns on an empty list", async () => {
    const pctx = (fetch: typeof globalThis.fetch, params: Record<string, unknown>) => ({ params, stage: "dev" as const, connections: connections("grafana-cloud"), fetch, secret: secretEntry() });
    const list = { body: { items: [{ id: "pol-1", displayName: "CI shipper" }] } };
    const ok = await policy.preflight!(pctx(routeFetch({ url: "/accesspolicies", reply: list }).fetch, pp));
    expect(ok.findings).toEqual([expect.objectContaining({ id: "accessPolicy", level: "ok" })]);
    const bad = await policy.preflight!(pctx(routeFetch({ url: "/accesspolicies", reply: list }).fetch, { ...pp, accessPolicyId: "nope" }));
    expect(bad.findings[0]).toMatchObject({ level: "fail" });
    const empty = await policy.preflight!(pctx(routeFetch({ url: "/accesspolicies", reply: { body: { items: [] } } }).fetch, pp));
    expect(empty.findings[0]).toMatchObject({ level: "warn" });
    const denied = await policy.preflight!(pctx(routeFetch({ url: "/accesspolicies", reply: { status: 403, body: "no" } }).fetch, pp));
    expect(denied.findings[0]).toMatchObject({ level: "warn" });
  });
  it("review checklist names the policy and the default expiry", () => {
    const items = policy.reviewChecklist!(secretEntry({ params: pp })).join(" | ");
    expect(items).toContain("pol-1");
    expect(items).toContain("90 Tage");
  });
});
