import { describe, expect, it } from "vitest";
import { GRAFANA_COM_ROOT, baseUrl } from "../src/grafana.js";
import { probeWithValue } from "../src/checks.js";
import { callWithToken } from "../src/http.js";
import { grafanaAccessPolicyProvider as policy, grafanaProvider as p } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, byId, connections, expectNoLeak, issueCtx, mockFetch, revokeCtx, routeFetch, secretEntry, verifyCtx } from "./helpers.js";

const params = { baseUrl: "https://example.grafana.net/", serviceAccountId: 7 };

describe("grafana.com host", () => {
  it("is one constant, the same host for the policy API and the stack route", () => {
    expect(GRAFANA_COM_ROOT).toBe("https://grafana.com/api");
  });
});

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
  it("always sets secondsToLive: 90 days without ttlDays", async () => {
    const m = mockFetch({ body: { id: 1, key: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] }));
    expect(JSON.parse(m.calls[0]!.body!).secondsToLive).toBe(90 * 86400);
    expect(r.expiresAt).toBe("2027-01-30T10:00:00Z");
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
    expect(m.calls[0]).toMatchObject({ url: "https://grafana.com/api/v1/tokens?region=eu", method: "POST" });
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
    expect(m.calls[0]).toMatchObject({ url: "https://grafana.com/api/v1/tokens/tok-9?region=eu", method: "DELETE" });
  });
  it("revoke is idempotent on 404 but not on 403", async () => {
    await expect(policy.revoke!(revokeCtx(mockFetch({ status: 404, body: "gone" }).fetch, pp, "t", ["grafana-cloud"]))).resolves.toBeUndefined();
    await expect(policy.revoke!(revokeCtx(mockFetch({ status: 403, body: "no" }).fetch, pp, "t", ["grafana-cloud"]))).rejects.toThrow(ProviderError);
  });
  it("discovers access policies of the region", async () => {
    const m = mockFetch({ body: { items: [{ id: "pol-1", name: "ci", displayName: "CI shipper", scopes: ["logs:write", "metrics:write"] }, { name: "no-id" }] } });
    const opts = await policy.discover!("grafana.accessPolicy", { connections: connections("grafana-cloud"), fetch: m.fetch, params: { region: "eu" }, hint: { repos: [] } });
    expect(m.calls[0]).toMatchObject({ url: "https://grafana.com/api/v1/accesspolicies?region=eu", method: "GET" });
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
  it("verify: a token whose policy cannot read policies is checked through the connection, not failed on 401", async () => {
    const list = { body: { items: [{ id: "pol-1", displayName: "status reader", scopes: ["metrics:read"] }] } };
    const found = routeFetch({ url: "/accesspolicies", reply: list }, { url: "/tokens/t", reply: { body: { id: "t" } } });
    const ok = await policy.verify!(verifyCtx(found.fetch, pp, { externalId: "t", expiresAt: "2027-01-30T10:00:00Z", conns: ["grafana-cloud"] }));
    expect(byId(ok)["works"]).toBe("pass");
    expect(found.calls.some((c) => c.url.includes("/accesspolicies") && c.headers?.["Authorization"] === `Bearer ${ISSUED}`)).toBe(false);
    const missing = routeFetch({ url: "/accesspolicies", reply: list }, { url: "/tokens/t", reply: { status: 404, body: "gone" } });
    expect(byId(await policy.verify!(verifyCtx(missing.fetch, pp, { externalId: "t", conns: ["grafana-cloud"] })))["works"]).toBe("info");
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

describe("grafana-service-account-token: service account by name", () => {
  const named = { baseUrl: "https://acme.grafana.net", serviceAccountName: "ci-reader" };
  const search = (accounts: unknown[]) => ({ url: "/api/serviceaccounts/search", reply: { body: { serviceAccounts: accounts } } });
  const tokens = { method: "POST", url: /\/api\/serviceaccounts\/\d+\/tokens$/, reply: { body: { id: 42, key: ISSUED } } };
  const dctx = (f: typeof fetch, conns: string[], params: Record<string, unknown>) => ({ connections: connections(...conns), fetch: f, params, hint: { repos: [] } });

  it("declares the id as optional and the name and role as optional parameters (role limited to the three Grafana roles)", () => {
    expect(p.params!.find((s) => s.key === "serviceAccountId")).toMatchObject({ required: false, discover: "grafana.serviceAccount" });
    expect(p.params!.find((s) => s.key === "serviceAccountName")).toMatchObject({ required: false, type: "string" });
    const role = p.params!.find((s) => s.key === "serviceAccountRole")!;
    expect(role).toMatchObject({ required: false, type: "enum", defaultValue: "Viewer" });
    expect(role.options!.map((o) => o.value)).toEqual(["Viewer", "Editor", "Admin"]);
  });

  it("finds an existing account by its exact name and issues the token for it; the external id carries the account", async () => {
    const m = routeFetch(search([{ id: 3, name: "ci-reader-old" }, { id: 7, name: "ci-reader" }]), tokens);
    const r = await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana"] }));
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://acme.grafana.net/api/serviceaccounts/search?perpage=100&query=ci-reader",
      "POST https://acme.grafana.net/api/serviceaccounts/7/tokens",
    ]);
    expect(r.externalId).toBe("7:42");
    expect(r.value.reveal()).toBe(ISSUED);
    expect(m.calls.every((c) => c.headers["Authorization"] === `Bearer ${CONN_TOKEN}`)).toBe(true);
  });

  it("creates the account with the chosen role when it does not exist, then the token with the default 90-day expiry", async () => {
    const m = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { body: { id: 11, name: "ci-reader" } } }, { ...tokens, url: /\/serviceaccounts\/11\/tokens$/ });
    const r = await p.issue!(issueCtx(m.fetch, { ...named, serviceAccountRole: "Editor" }, { conns: ["grafana"] }));
    const create = m.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/serviceaccounts"))!;
    expect(JSON.parse(create.body!)).toEqual({ name: "ci-reader", role: "Editor", isDisabled: false });
    expect(JSON.parse(m.calls.at(-1)!.body!).secondsToLive).toBe(90 * 86400);
    expect(r.externalId).toBe("11:42");
  });

  it("defaults the role of a new account to Viewer", async () => {
    const m = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { body: { id: 11 } } }, tokens);
    await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana"] }));
    expect(JSON.parse(m.calls.find((c) => c.url.endsWith("/api/serviceaccounts") && c.method === "POST")!.body!).role).toBe("Viewer");
  });

  it("an explicit id wins over the name: no search, no create, plain external id", async () => {
    const m = routeFetch(tokens);
    const r = await p.issue!(issueCtx(m.fetch, { ...named, serviceAccountId: 5 }, { conns: ["grafana"] }));
    expect(m.calls.map((c) => c.url)).toEqual(["https://acme.grafana.net/api/serviceaccounts/5/tokens"]);
    expect(r.externalId).toBe("42");
  });

  it("neither id nor name, a bad name or a bad role fail without a network call", async () => {
    for (const params of [{ baseUrl: "https://acme.grafana.net" }, { ...named, serviceAccountName: "../x" }, { ...named, serviceAccountName: "a&b=1" }, { ...named, serviceAccountRole: "Owner" }]) {
      const m = mockFetch({ body: {} });
      await expect(p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] }))).rejects.toThrow(ProviderError);
      expect(m.calls).toHaveLength(0);
    }
  });

  it("when the stack refuses the token (403), the same calls go through the Cloud API with the grafana-cloud connection", async () => {
    const m = routeFetch(
      { url: "https://acme.grafana.net/", reply: { status: 403, body: "no" } },
      { method: "POST", url: "https://acme.grafana.net/", reply: { status: 403, body: "no" } },
      { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/search", reply: { body: { serviceAccounts: [] } } },
      { method: "POST", url: /grafana\.com\/api\/instances\/acme\/api\/serviceaccounts$/, reply: { body: { id: 11 } } },
      { method: "POST", url: "https://grafana.com/api/instances/acme/api/serviceaccounts/11/tokens", reply: { body: { id: 42, key: ISSUED } } },
    );
    const r = await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana", "grafana-cloud"] }));
    expect(r.externalId).toBe("11:42");
    expect(m.calls.some((c) => c.url.startsWith("https://grafana.com/api/instances/acme/api/serviceaccounts/11/tokens"))).toBe(true);
    // the stack was asked first, and a refused request changed nothing
    expect(m.calls[0]!.url.startsWith("https://acme.grafana.net/")).toBe(true);
  });

  it("without a grafana connection the Cloud API is used at once; the stack is not called", async () => {
    const m = routeFetch(
      { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/search", reply: { body: { serviceAccounts: [{ id: 7, name: "ci-reader" }] } } },
      { method: "POST", url: "https://grafana.com/api/instances/acme/api/serviceaccounts/7/tokens", reply: { body: { id: 42, key: ISSUED } } },
    );
    const r = await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana-cloud"] }));
    expect(r.externalId).toBe("7:42");
    expect(m.calls.every((c) => c.url.startsWith("https://grafana.com/api/instances/acme/"))).toBe(true);
  });

  it("without any way in the first error stays: not connected", async () => {
    const m = mockFetch({ body: {} });
    await expect(p.issue!(issueCtx(m.fetch, named, { conns: [] }))).rejects.toMatchObject({ name: "NotConnectedError", connection: "grafana" });
    expect(m.calls).toHaveLength(0);
  });

  it("a refusal with no grafana-cloud connection stays the stack's error", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("403");
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
    expect(m.calls).toHaveLength(1);
  });

  it("an own host (allowedHosts) has no Cloud route: the refusal stays", async () => {
    const cfg = { grafana: { allowedHosts: ["metrics.corp.example"] } };
    const m = mockFetch({ status: 403, body: "no" });
    const ctx = { ...issueCtx(m.fetch, { baseUrl: "https://metrics.corp.example", serviceAccountName: "ci-reader" }, { conns: ["grafana", "grafana-cloud"] }), providerConfig: cfg };
    await expect(p.issue!(ctx)).rejects.toThrow(ProviderError);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url.startsWith("https://metrics.corp.example/")).toBe(true);
  });

  it("the Cloud route needs a plain <stack>.grafana.net address: no path prefix, no extra labels", async () => {
    for (const baseUrl of ["https://acme.grafana.net/grafana", "https://a.b.grafana.net"]) {
      const m = mockFetch({ status: 403, body: "no" });
      await expect(p.issue!(issueCtx(m.fetch, { ...named, baseUrl }, { conns: ["grafana", "grafana-cloud"] }))).rejects.toThrow(ProviderError);
      expect(m.calls.every((c) => !c.url.startsWith("https://grafana.com"))).toBe(true);
    }
  });

  it("a conflict on create (the account exists but the search could not see it) is resolved through the Cloud API", async () => {
    const m = routeFetch(
      { url: "https://acme.grafana.net/api/serviceaccounts/search", reply: { body: { serviceAccounts: [] } } },
      { method: "POST", url: /acme\.grafana\.net\/api\/serviceaccounts$/, reply: { status: 409, body: "exists" } },
      { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/search", reply: { body: { serviceAccounts: [{ id: 9, name: "ci-reader" }] } } },
      { method: "POST", url: "https://acme.grafana.net/api/serviceaccounts/9/tokens", reply: { body: { id: 42, key: ISSUED } } },
    );
    const r = await p.issue!(issueCtx(m.fetch, named, { conns: ["grafana", "grafana-cloud"] }));
    expect(r.externalId).toBe("9:42");
  });

  it("a conflict without a Cloud answer stays the conflict", async () => {
    const m = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { status: 409, body: "exists" } });
    await expect(p.issue!(issueCtx(m.fetch, named, { conns: ["grafana"] }))).rejects.toThrow(/409/);
  });

  it("an answer without an id on create is an error", async () => {
    const m = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { body: { name: "x" } } });
    await expect(p.issue!(issueCtx(m.fetch, named, { conns: ["grafana"] }))).rejects.toThrow(/Unerwartete Antwort/);
  });

  it("verify and revoke read the account from the external id, the entry has no id", async () => {
    const list = routeFetch({ url: "/api/serviceaccounts/7/tokens", reply: { body: [{ id: 42, hasExpired: false, expiration: "2027-01-30T10:00:00Z" }] } });
    const checks = await p.verify!(verifyCtx(list.fetch, named, { conns: ["grafana"], externalId: "7:42", expiresAt: "2027-01-30T10:00:00Z" }));
    expect(byId(checks)).toMatchObject({ exists: "pass", valid: "pass", expires: "pass" });
    expect(list.calls[0]!.url).toBe("https://acme.grafana.net/api/serviceaccounts/7/tokens");
    const del = mockFetch({ body: { message: "ok" } });
    await p.revoke!(revokeCtx(del.fetch, named, "7:42", ["grafana"]));
    expect(del.calls[0]).toMatchObject({ url: "https://acme.grafana.net/api/serviceaccounts/7/tokens/42", method: "DELETE" });
  });

  it("verify and revoke fall back to the Cloud API too", async () => {
    const list = routeFetch({ url: "https://acme.grafana.net/", reply: { status: 401, body: "no" } }, { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/7/tokens", reply: { body: [{ id: 42, hasExpired: false }] } });
    const checks = await p.verify!(verifyCtx(list.fetch, named, { conns: ["grafana", "grafana-cloud"], externalId: "7:42" }));
    expect(byId(checks)["exists"]).toBe("pass");
    const del = routeFetch({ url: "https://acme.grafana.net/", method: "DELETE", reply: { status: 403, body: "no" } }, { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/7/tokens/42", method: "DELETE", reply: { status: 204 } });
    await expect(p.revoke!(revokeCtx(del.fetch, named, "7:42", ["grafana", "grafana-cloud"]))).resolves.toBeUndefined();
  });

  it("verify without an id anywhere is a warning, not a crash", async () => {
    const checks = await p.verify!(verifyCtx(mockFetch({ body: [] }).fetch, named, { conns: ["grafana"], externalId: "42" }));
    expect(checks[0]!.status).toBe("warn");
  });

  it("verify never leaks the values", async () => {
    const m = mockFetch({ status: 500, body: LEAK });
    expectNoLeak(await p.verify!(verifyCtx(m.fetch, named, { conns: ["grafana"], externalId: "7:42" })), [CONN_TOKEN]);
  });

  it("discovery lists the existing accounts through the Cloud API when the stack token cannot read", async () => {
    const m = routeFetch(
      { url: "https://acme.grafana.net/", reply: { status: 403, body: "no" } },
      { url: "https://grafana.com/api/instances/acme/api/serviceaccounts/search", reply: { body: { serviceAccounts: [{ id: 7, name: "ci-reader", login: "sa-ci-reader", role: "Viewer" }] } } },
    );
    const opts = await p.discover!("grafana.serviceAccount", dctx(m.fetch, ["grafana", "grafana-cloud"], { baseUrl: "https://acme.grafana.net" }));
    expect(opts).toEqual([{ value: 7, label: "ci-reader", detail: "sa-ci-reader, Viewer" }]);
  });

  it("preflight: an existing account, an account that will be created, and a missing id and name", async () => {
    const pctx = (f: typeof fetch, params: Record<string, unknown>) => ({ params, stage: "dev" as const, connections: connections("grafana"), fetch: f, secret: secretEntry() });
    const base = [{ url: "/api/health", reply: { body: { database: "ok" } } }];
    const have = await p.preflight!(pctx(routeFetch(...base, search([{ id: 7, name: "ci-reader" }])).fetch, named));
    expect(have.findings.find((f) => f.id === "serviceAccount")).toMatchObject({ level: "ok", label: "Der Service-Account ci-reader existiert" });
    expect(have.resource).toBe("Grafana-Service-Account ci-reader (https://acme.grafana.net)");
    const none = await p.preflight!(pctx(routeFetch(...base, search([])).fetch, { ...named, serviceAccountRole: "Admin" }));
    expect(none.findings.find((f) => f.id === "serviceAccount")).toMatchObject({ level: "ok", label: "Der Service-Account ci-reader wird beim Ausstellen angelegt", detail: "Rolle Admin" });
    const nothing = await p.preflight!(pctx(routeFetch(...base, search([])).fetch, { baseUrl: "https://acme.grafana.net" }));
    expect(nothing.findings.find((f) => f.id === "serviceAccount")).toMatchObject({ level: "fail" });
  });

  it("the review checklist names the account by name when there is no id", () => {
    expect(p.reviewChecklist!(secretEntry({ params: named })).join(" | ")).toContain("ci-reader");
  });
});
