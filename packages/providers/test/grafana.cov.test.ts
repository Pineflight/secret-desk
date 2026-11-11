import { describe, expect, it } from "vitest";
import { NotConnectedError, type ProviderConfig } from "@secret-desk/core";
import { baseUrl, cloudProxyBase, grafanaAccessPolicyProvider as policy, grafanaProvider as p } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { byId, connections, issueCtx, mockFetch, revokeCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const MADE_UP = ["made", "up", "value", "0123456789"].join("-");
const STACK = "https://acme.grafana.net";
const PROXY = "https://grafana.com/api/instances/acme";
const COM = "https://grafana.com/api/v1";
const params = { baseUrl: STACK, serviceAccountId: 7 };
const OWN_HOST = "https://grafana.internal.example";
const cfg = { grafana: { allowedHosts: ["grafana.internal.example"] } } as unknown as ProviderConfig;
const ownParams = { baseUrl: OWN_HOST, serviceAccountId: 7 };

const failFrom = (store: ReturnType<typeof connections>, nth: number, thrown: unknown) => {
  let calls = 0;
  const real = store.token.bind(store);
  store.token = (async (id: string) => {
    if (++calls >= nth) throw thrown;
    return real(id);
  }) as typeof store.token;
  return store;
};
const pctx = (f: typeof fetch, prm: Record<string, unknown>, conns = connections("grafana", "grafana-cloud"), providerConfig?: ProviderConfig) => ({ secret: secretEntry(), params: prm, stage: "dev" as const, connections: conns, fetch: f, ...(providerConfig ? { providerConfig } : {}) });
const dctx = (f: typeof fetch, conn: string, prm: Record<string, unknown> = {}) => ({ connections: connections(conn), fetch: f, params: prm, hint: { repos: [] as string[] } });

describe("grafana: base url and cloud proxy", () => {
  it("rejects text that is not a URL", () => {
    expect(() => baseUrl({ baseUrl: "not a url" })).toThrow('Parameter "baseUrl" ist keine gueltige URL');
  });
  it("cloudProxyBase only accepts a bare grafana.net host with a valid slug", () => {
    expect(cloudProxyBase("https://acme.grafana.net")).toBe(PROXY);
    expect(cloudProxyBase("https://acme.grafana.net/sub")).toBeNull();
    expect(cloudProxyBase("https://grafana.internal.example")).toBeNull();
    expect(cloudProxyBase("https://-bad.grafana.net")).toBeNull();
  });
});

describe("grafana: stack call fallback", () => {
  const search = (list: unknown[]): Route => ({ url: "/api/serviceaccounts/search", reply: { body: { serviceAccounts: list } } });
  it("keeps the first error when neither connection exists", async () => {
    const m = mockFetch();
    const ctx = issueCtx(m.fetch, params, { conns: [] });
    await expect(p.issue!(ctx)).rejects.toThrow(NotConnectedError);
    expect(m.calls).toHaveLength(0);
  });
  it("surfaces the error of the cloud route when the stack refuses and the cloud route fails too", async () => {
    const m = routeFetch({ url: `${STACK}/api/serviceaccounts/7/tokens`, method: "POST", reply: { status: 403, body: "no" } }, { url: `${PROXY}/api/serviceaccounts/7/tokens`, method: "POST", reply: { status: 500, body: "boom" } });
    await expect(p.issue!(issueCtx(m.fetch, params, { conns: ["grafana", "grafana-cloud"] }))).rejects.toThrow("HTTP 500");
  });
  it("does not use the cloud route for a host outside grafana.net and keeps the refusal", async () => {
    const m = routeFetch({ url: `${OWN_HOST}/api/serviceaccounts/7/tokens`, method: "POST", reply: { status: 403, body: "no" } });
    const ctx = { ...issueCtx(m.fetch, ownParams, { conns: ["grafana", "grafana-cloud"] }), providerConfig: cfg };
    await expect(p.issue!(ctx)).rejects.toThrow("HTTP 403");
    expect(m.calls).toHaveLength(1);
  });

  it("resolves a service account by name: found, or created", async () => {
    const byName = { baseUrl: STACK, serviceAccountName: "ci-reader" };
    const found = routeFetch(search([{ id: 3, name: "ci-reader" }]), { method: "POST", url: "/api/serviceaccounts/3/tokens", reply: { body: { id: 5, key: "KEY-0123456789" } } });
    const r = await p.issue!(issueCtx(found.fetch, byName, { conns: ["grafana"] }));
    expect(r.externalId).toBe("3:5");
    const created = routeFetch(search([{ id: "x", name: "ci-reader" }, { id: 4, name: "other" }]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { body: { id: 8 } } }, { method: "POST", url: "/api/serviceaccounts/8/tokens", reply: { body: { id: 9, key: "KEY-0123456789" } } });
    expect((await p.issue!(issueCtx(created.fetch, byName, { conns: ["grafana"] }))).externalId).toBe("8:9");
    expect(JSON.parse(created.calls.find((c) => c.url === `${STACK}/api/serviceaccounts` && c.method === "POST")!.body!)).toEqual({ name: "ci-reader", role: "Viewer", isDisabled: false });
  });
  it("fails when the created service account has no numeric id", async () => {
    const m = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { body: { id: "8" } } });
    await expect(p.issue!(issueCtx(m.fetch, { baseUrl: STACK, serviceAccountName: "ci" }, { conns: ["grafana"] }))).rejects.toThrow("Unerwartete Antwort");
    const none = routeFetch(search([]), { method: "POST", url: /\/api\/serviceaccounts$/, reply: { status: 204 } });
    await expect(p.issue!(issueCtx(none.fetch, { baseUrl: STACK, serviceAccountName: "ci" }, { conns: ["grafana"] }))).rejects.toThrow("Unerwartete Antwort");
  });
  it("on a 409 conflict: finds the account through the cloud route, keeps the conflict when it cannot", async () => {
    const stackSearch: Route = { url: `${STACK}/api/serviceaccounts/search`, reply: { body: { serviceAccounts: [] } } };
    const conflict: Route = { method: "POST", url: /\/api\/serviceaccounts$/, reply: { status: 409, body: "exists" } };
    const viaCloud = routeFetch(stackSearch, conflict, { url: `${PROXY}/api/serviceaccounts/search`, reply: { body: { serviceAccounts: [{ id: 11, name: "ci" }] } } }, { method: "POST", url: "/api/serviceaccounts/11/tokens", reply: { body: { id: 1, key: "KEY-0123456789" } } });
    expect((await p.issue!(issueCtx(viaCloud.fetch, { baseUrl: STACK, serviceAccountName: "ci" }, { conns: ["grafana", "grafana-cloud"] }))).externalId).toBe("11:1");
    const noHit = routeFetch(stackSearch, conflict, { url: `${PROXY}/api/serviceaccounts/search`, reply: { body: { serviceAccounts: [{ id: 12, name: "other" }] } } });
    await expect(p.issue!(issueCtx(noHit.fetch, { baseUrl: STACK, serviceAccountName: "ci" }, { conns: ["grafana", "grafana-cloud"] }))).rejects.toThrow("HTTP 409");
    const cloudFails = routeFetch(stackSearch, conflict, { url: `${PROXY}/api/serviceaccounts/search`, reply: { status: 500, body: "x" } });
    await expect(p.issue!(issueCtx(cloudFails.fetch, { baseUrl: STACK, serviceAccountName: "ci" }, { conns: ["grafana", "grafana-cloud"] }))).rejects.toThrow("HTTP 409");
    const ownConflict = routeFetch({ url: `${OWN_HOST}/api/serviceaccounts/search`, reply: { body: { serviceAccounts: [] } } }, { method: "POST", url: /\/api\/serviceaccounts$/, reply: { status: 409, body: "exists" } });
    const ctx = { ...issueCtx(ownConflict.fetch, { baseUrl: OWN_HOST, serviceAccountName: "ci" }, { conns: ["grafana", "grafana-cloud"] }), providerConfig: cfg };
    await expect(p.issue!(ctx)).rejects.toThrow("HTTP 409");
  });
  it("fails when the token answer has no key or no id", async () => {
    const noKey = mockFetch({ body: { id: 1 } });
    await expect(p.issue!(issueCtx(noKey.fetch, params, { conns: ["grafana"] }))).rejects.toThrow("Unerwartete Antwort");
    const noId = mockFetch({ body: { key: "KEY-0123456789" } });
    await expect(p.issue!(issueCtx(noId.fetch, params, { conns: ["grafana"] }))).rejects.toThrow("Unerwartete Antwort");
  });
  it("issues without an expiry for a ttl of 0", async () => {
    const m = mockFetch({ body: { id: 1, key: "KEY-0123456789" } });
    const ctx = issueCtx(m.fetch, params, { conns: ["grafana"] });
    const r = await p.issue!({ ...ctx, secret: { ...ctx.secret, ttlDays: 0 } as typeof ctx.secret });
    expect(r.expiresAt).toBeNull();
  });
});

describe("grafana: discovery and preflight", () => {
  it("lists service accounts, skipping those without a numeric id", async () => {
    const accounts = { serviceAccounts: [{ id: 1, name: "a", login: "sa-a", role: "Admin" }, { id: 2 }, { id: "x", name: "bad" }] };
    const m = routeFetch({ url: "/api/serviceaccounts/search?perpage=100", reply: { body: accounts } });
    expect(await p.discover!("grafana.serviceAccount", dctx(m.fetch, "grafana", params))).toEqual([
      { value: 1, label: "a", detail: "sa-a, Admin" },
      { value: 2, label: "2", detail: "" },
    ]);
    await expect(p.discover!("grafana.other", dctx(m.fetch, "grafana", params))).rejects.toThrow();
  });

  const health = (status = 200): Route => ({ url: "/api/health", reply: { status, body: "{}" } });
  const list = (accounts: unknown[]): Route => ({ url: "/api/serviceaccounts/search", reply: { body: { serviceAccounts: accounts } } });
  const find = (r: { findings: { id: string; level: string; label: string; detail?: string }[] }, id: string) => r.findings.find((f) => f.id === id)!;

  it("reports a bad address, with a generic text for an unexpected error type", async () => {
    const bad = await p.preflight!(pctx(routeFetch().fetch, { baseUrl: "http://x.example" }));
    expect(find(bad, "baseUrl").label).toContain("https://");
    const broken = { get grafana(): never { throw new Error("config exploded"); } } as unknown as ProviderConfig;
    const generic = await p.preflight!(pctx(routeFetch().fetch, params, connections("grafana"), broken));
    expect(find(generic, "baseUrl").label).toBe("Adresse ungueltig");
  });
  it("reports an unreachable instance and a non-OK health answer", async () => {
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const r = await p.preflight!(pctx(down, params));
    expect(r.findings).toEqual([{ id: "reachable", level: "fail", label: `Die Instanz ${STACK} ist nicht erreichbar` }]);
    const sick = await p.preflight!(pctx(routeFetch(health(503), list([])).fetch, params));
    expect(find(sick, "reachable")).toMatchObject({ level: "warn", label: `Die Instanz ${STACK} antwortet mit HTTP 503` });
  });
  it("by name: existing, to be created (with role), and missing name", async () => {
    const existing = await p.preflight!(pctx(routeFetch(health(), list([{ id: 3, name: "ci" }])).fetch, { baseUrl: STACK, serviceAccountName: "ci" }));
    expect(find(existing, "serviceAccount").label).toBe("Der Service-Account ci existiert");
    expect(existing.resource).toBe(`Grafana-Service-Account ci (${STACK})`);
    const create = await p.preflight!(pctx(routeFetch(health(), list([])).fetch, { baseUrl: STACK, serviceAccountName: "ci", serviceAccountRole: "Editor" }));
    expect(find(create, "serviceAccount")).toMatchObject({ level: "ok", detail: "Rolle Editor" });
    const defaultRole = await p.preflight!(pctx(routeFetch(health(), list([])).fetch, { baseUrl: STACK, serviceAccountName: "ci" }));
    expect(find(defaultRole, "serviceAccount").detail).toBe("Rolle Viewer");
    const none = await p.preflight!(pctx(routeFetch(health(), list([])).fetch, { baseUrl: STACK }));
    expect(find(none, "serviceAccount").level).toBe("fail");
  });
  it("by id: found, not found, nothing listed, unreadable, and a missing connection is rethrown", async () => {
    const hit = await p.preflight!(pctx(routeFetch(health(), list([{ id: 7, name: "seven" }])).fetch, params));
    expect(find(hit, "serviceAccount").label).toBe("Der Service-Account seven existiert");
    expect(hit.resource).toBe(`Grafana-Service-Account seven (${STACK})`);
    const miss = await p.preflight!(pctx(routeFetch(health(), list([{ id: 1, name: "one" }])).fetch, params));
    expect(find(miss, "serviceAccount")).toMatchObject({ level: "fail", detail: "Verfuegbar: one" });
    const empty = await p.preflight!(pctx(routeFetch(health(), list([])).fetch, params));
    expect(find(empty, "serviceAccount").level).toBe("warn");
    const denied = await p.preflight!(pctx(routeFetch(health(), { url: "/api/serviceaccounts/search", reply: { status: 500, body: "x" } }).fetch, params));
    expect(find(denied, "read").label).toBe("Service-Accounts nicht lesbar");
    await expect(p.preflight!(pctx(routeFetch(health(), list([])).fetch, params, connections()))).rejects.toThrow(NotConnectedError);
  });
});

describe("grafana: verify through the stack and the cloud route", () => {
  const tokens = (list: unknown): Route => ({ url: "/api/serviceaccounts/7/tokens", reply: { body: list } });
  const run = (f: typeof fetch, conns: string[], prm: Record<string, unknown> = params, opts: Parameters<typeof verifyCtx>[2] = {}, providerConfig?: ProviderConfig) =>
    p.verify!({ ...verifyCtx(f, prm, { conns, externalId: "9", ...opts }), ...(providerConfig ? { providerConfig } : {}) });
  const find = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as { status: string; detail?: string; actual?: string; expected?: string };
  const entry = { id: 9, hasExpired: false, expiration: "2026-12-01T10:00:00Z" };

  it("uses the cloud route when the grafana connection is missing", async () => {
    const m = routeFetch({ url: `${PROXY}/api/serviceaccounts/7/tokens`, reply: { body: [entry] } });
    const checks = await run(m.fetch, ["grafana-cloud"], params, { expiresAt: "2026-12-01T10:00:00Z" });
    expect(byId(checks)).toEqual({ exists: "pass", valid: "pass", expires: "pass" });
  });
  it("warns when no connection exists at all", async () => {
    const checks = await run(routeFetch().fetch, []);
    expect(find(checks, "exists").detail).toContain("Pruefung nicht moeglich");
  });
  it("warns on a network error of the first call", async () => {
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(find(await run(down, ["grafana", "grafana-cloud"]), "exists").status).toBe("warn");
  });
  it("keeps the refusal of the stack when there is no cloud route or no cloud connection", async () => {
    const refused = routeFetch({ url: `${OWN_HOST}/api/serviceaccounts/7/tokens`, reply: { status: 401, body: "no" } });
    const own = await run(refused.fetch, ["grafana", "grafana-cloud"], ownParams, {}, cfg);
    expect(find(own, "exists")).toMatchObject({ status: "warn", actual: "HTTP 401" });
    const noCloud = routeFetch({ url: `${STACK}/api/serviceaccounts/7/tokens`, reply: { status: 403, body: "no" } });
    expect(find(await run(noCloud.fetch, ["grafana"]), "exists")).toMatchObject({ status: "warn", actual: "HTTP 403" });
  });
  it("warns when the cloud route fails after a refusal by the stack", async () => {
    const m = routeFetch({ url: `${STACK}/api/serviceaccounts/7/tokens`, reply: { status: 401, body: "no" } }, { url: `${PROXY}/api/serviceaccounts/7/tokens`, reply: { status: 500, body: "x" } });
    const checks = await run(m.fetch, ["grafana", "grafana-cloud"]);
    expect(find(checks, "exists")).toMatchObject({ status: "warn", actual: "HTTP 500" });
    const down = (async (url: string | URL | Request) => {
      if (String(url).startsWith(PROXY)) throw new Error("cloud down");
      return new Response("no", { status: 401 });
    }) as unknown as typeof fetch;
    expect(find(await run(down, ["grafana", "grafana-cloud"]), "exists").detail).toContain("cloud down");
  });
  it("handles an unreadable list, a missing token and a missing token id", async () => {
    const notList = routeFetch(tokens({ a: 1 }));
    expect(find(await run(notList.fetch, ["grafana"]), "exists")).toMatchObject({ status: "warn", detail: "Tokenliste nicht lesbar" });
    const missing = routeFetch(tokens([{ id: 1 }, "x"]));
    expect(find(await run(missing.fetch, ["grafana"]), "exists")).toMatchObject({ status: "fail", expected: "9", actual: "nicht in der Liste" });
    const noId = routeFetch(tokens([entry]));
    expect(find(await run(noId.fetch, ["grafana"], params, { externalId: undefined as never }), "exists")).toMatchObject({ status: "fail", expected: "Kennung" });
  });
  it("expiry: compares, warns on a missing expiry, reports without expectation", async () => {
    const far = routeFetch(tokens([{ ...entry, expiration: "2027-06-01T00:00:00Z" }]));
    expect(find(await run(far.fetch, ["grafana"], params, { expiresAt: "2026-12-01T10:00:00Z" }), "expires").status).toBe("warn");
    const never = routeFetch(tokens([{ id: 9, hasExpired: true }]));
    const neverChecks = await run(never.fetch, ["grafana"], params, { expiresAt: "2026-12-01T10:00:00Z" });
    expect(find(neverChecks, "expires")).toMatchObject({ status: "warn", actual: "kein Ablauf" });
    expect(find(neverChecks, "valid").status).toBe("fail");
    const withDate = routeFetch(tokens([entry]));
    expect(find(await run(withDate.fetch, ["grafana"]), "expires")).toMatchObject({ status: "info", actual: "2026-12-01" });
    const bare = routeFetch(tokens([{ id: 9, hasExpired: false }]));
    expect(find(await run(bare.fetch, ["grafana"]), "expires")).toMatchObject({ status: "info", actual: "kein Ablauf" });
  });
  it("checklist: with and without a stored account, with a ttl", () => {
    expect(p.reviewChecklist!(secretEntry({ ttlDays: 5, params: { serviceAccountName: "ci" } }))).toEqual(
      expect.arrayContaining(["Der Token gehoert zum Service-Account ci", "Ablauf ist 5 Tage nach heute"]),
    );
    expect(p.reviewChecklist!(secretEntry())[0]).toBe("Der Token gehoert zum vorgesehenen Service-Account");
  });
  it("revoke goes through the account in a combined external id", async () => {
    const m = mockFetch({ status: 204 });
    await p.revoke!(revokeCtx(m.fetch, { baseUrl: STACK }, "4:77", ["grafana"]));
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: `${STACK}/api/serviceaccounts/4/tokens/77` });
  });
  it("a service account id must be a positive integer", async () => {
    await expect(p.revoke!(revokeCtx(mockFetch().fetch, { baseUrl: STACK, serviceAccountId: 0 }, "77", ["grafana"]))).rejects.toThrow(ProviderError);
  });
});

describe("grafana access policy token", () => {
  const prm = { region: "eu", accessPolicyId: "pol1" };
  const policiesRoute = (items: unknown[]): Route => ({ url: `${COM}/accesspolicies?region=eu`, reply: { body: { items } } });
  const pc = (f: typeof fetch, params2: Record<string, unknown>, conns = connections("grafana-cloud")) => ({ secret: secretEntry(), params: params2, stage: "dev" as const, connections: conns, fetch: f });

  it("discovers policies with display names, names, ids and scopes", async () => {
    const m = routeFetch(policiesRoute([{ id: "a", displayName: "Alpha", name: "alpha", scopes: ["metrics:read", 5] }, { id: "b", name: "beta", scopes: "x" }, { id: "c" }, { name: "no id" }]));
    expect(await policy.discover!("grafana.accessPolicy", dctx(m.fetch, "grafana-cloud", { region: "eu" }))).toEqual([
      { value: "a", label: "Alpha", detail: "metrics:read" },
      { value: "b", label: "beta", detail: "" },
      { value: "c", label: "c", detail: "" },
    ]);
    await expect(policy.discover!("grafana.other", dctx(m.fetch, "grafana-cloud", prm))).rejects.toThrow();
  });
  it("preflight: found, not found, none, unreadable, missing connection", async () => {
    const find = (r: { findings: { id: string; level: string }[] }) => r.findings[0]!;
    expect(find(await policy.preflight!(pc(routeFetch(policiesRoute([{ id: "pol1", name: "P" }])).fetch, prm)))).toMatchObject({ level: "ok" });
    expect(find(await policy.preflight!(pc(routeFetch(policiesRoute([{ id: "x", name: "X" }])).fetch, prm)))).toMatchObject({ level: "fail" });
    expect(find(await policy.preflight!(pc(routeFetch(policiesRoute([])).fetch, prm)))).toMatchObject({ level: "warn" });
    expect(find(await policy.preflight!(pc(routeFetch({ url: "accesspolicies", reply: { status: 500, body: "x" } }).fetch, prm))).id).toBe("read");
    await expect(policy.preflight!(pc(routeFetch().fetch, prm, connections()))).rejects.toThrow(NotConnectedError);
  });
  it("issue uses the expiry from the answer when there is one", async () => {
    const m = routeFetch({ method: "POST", url: `${COM}/tokens?region=eu`, reply: { body: { id: "t1", token: MADE_UP, expiresAt: "2030-01-01T00:00:00Z" } } });
    const r = await policy.issue!(issueCtx(m.fetch, prm, { conns: ["grafana-cloud"] }));
    expect(r).toMatchObject({ externalId: "t1", expiresAt: "2030-01-01T00:00:00Z" });
    const noAnswerExpiry = routeFetch({ method: "POST", url: `${COM}/tokens?region=eu`, reply: { body: { id: "t1", token: MADE_UP } } });
    expect((await policy.issue!(issueCtx(noAnswerExpiry.fetch, prm, { conns: ["grafana-cloud"] }))).expiresAt).toBe("2027-01-30T10:00:00Z");
  });

  const run = (routes: Route[], prm2: Record<string, unknown>, opts: Parameters<typeof verifyCtx>[2] = {}) => policy.verify!(verifyCtx(routeFetch(...routes).fetch, prm2, { conns: ["grafana-cloud"], ...opts }));
  const find = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as { status: string; actual?: string; detail?: string };
  it("verify without an access policy id probes the token itself", async () => {
    const checks = await run([{ url: `${COM}/accesspolicies?region=eu`, reply: { body: { items: [] } } }], { region: "eu" });
    expect(find(checks, "works")).toMatchObject({ status: "pass" });
    expect(find(checks, "expires").actual).toBe("kein Ablauf");
  });
  it("verify of a token whose policy cannot read: found through the connection, or not checkable", async () => {
    const noRead = policiesRoute([{ id: "pol1", name: "P", scopes: ["metrics:read"] }]);
    const found = await run([noRead, { url: `${COM}/tokens/t1?region=eu`, reply: { body: { id: "t1" } } }], prm, { externalId: "t1", expiresAt: "2026-12-01T10:00:00Z" });
    expect(find(found, "works")).toMatchObject({ status: "pass", actual: "Token bei Grafana Cloud vorhanden" });
    expect(find(found, "expires").actual).toBe("2026-12-01");
    const noId = await run([noRead], prm, {});
    expect(find(noId, "works")).toMatchObject({ status: "info", actual: "nicht pruefbar" });
    const other = await run([noRead, { url: `${COM}/tokens/t1?region=eu`, reply: { body: { id: "t2" } } }], prm, { externalId: "t1" });
    expect(find(other, "works").status).toBe("info");
    const failing = await run([noRead, { url: `${COM}/tokens/t1?region=eu`, reply: { status: 500, body: "x" } }], prm, { externalId: "t1" });
    expect(find(failing, "works").status).toBe("info");
  });
  it("verify probes the token when the policy can read policies, and maps the status", async () => {
    const canRead = policiesRoute([{ id: "pol1", name: "P", scopes: ["accesspolicies:read"] }]);
    expect(find(await run([canRead], prm), "works")).toMatchObject({ status: "pass", actual: "HTTP 200" });
    const status = (code: number): Route => ({ url: `${COM}/accesspolicies?region=eu`, reply: { status: code, body: "x" } });
    expect(find(await run([status(401)], { region: "eu" }), "works")).toMatchObject({ status: "fail" });
    expect(find(await run([status(403)], { region: "eu" }), "works")).toMatchObject({ status: "info", actual: "HTTP 403" });
    expect(find(await run([status(500)], { region: "eu" }, { expiresAt: "2026-12-01T10:00:00Z" }), "works")).toMatchObject({ status: "info", actual: "HTTP 500" });
    expect(find(await run([status(500)], { region: "eu" }, { expiresAt: "2026-12-01T10:00:00Z" }), "expires").actual).toBe("2026-12-01");
  });
  it("checklist names the policy and the ttl", () => {
    expect(policy.reviewChecklist!(secretEntry({ ttlDays: 14, params: prm }))).toEqual(expect.arrayContaining(["Der Token gehoert zur Zugriffsrichtlinie pol1", "Ablauf ist 14 Tage nach heute"]));
    expect(policy.reviewChecklist!(secretEntry())[0]).toBe("Der Token gehoert zur vorgesehenen Zugriffsrichtlinie");
  });
  it("revoke deletes the token in its region, and a 404 counts as revoked", async () => {
    const m = routeFetch({ method: "DELETE", url: `${COM}/tokens/t%201?region=eu`, reply: { status: 404, body: "gone" } });
    await policy.revoke!(revokeCtx(m.fetch, prm, "t 1", ["grafana-cloud"]));
    expect(m.calls).toHaveLength(1);
  });
});
