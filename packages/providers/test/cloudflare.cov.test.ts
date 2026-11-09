import { describe, expect, it } from "vitest";
import { NotConnectedError, ParamsInvalidError, type ConnectionStore } from "@secret-desk/core";
import { cloudflareProviders, expiryCheck } from "../src/cloudflare.js";
import { byId, connections, issueCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const token = cloudflareProviders.find((p) => p.id === "cloudflare-token")!;
const turnstile = cloudflareProviders.find((p) => p.id === "cloudflare-turnstile")!;
const API = "https://api.cloudflare.com/client/v4";
const ACCOUNT = "com.cloudflare.api.account";
const ZONE = "com.cloudflare.api.account.zone";

const dctx = (f: typeof fetch, conn: string, params: Record<string, unknown> = {}) => ({ connections: connections(conn), fetch: f, params, hint: { repos: [] as string[] } });
const pctx = (f: typeof fetch, params: Record<string, unknown>, conns: ConnectionStore = connections("cloudflare", "cloudflare-turnstile")) => ({ secret: secretEntry(), params, stage: "dev" as const, connections: conns, fetch: f });
const failFrom = (store: ConnectionStore, nth: number, thrown: unknown) => {
  let calls = 0;
  const real = store.token.bind(store);
  store.token = (async (id: string) => {
    if (++calls >= nth) throw thrown;
    return real(id);
  }) as typeof store.token;
  return store;
};

describe("cloudflare discovery", () => {
  it("accounts: skips entries without id, names fall back to the id, empty answer is an empty list", async () => {
    const m = routeFetch({ url: "/accounts?per_page=50", reply: { body: { result: [{ id: "a1" }, { name: "no id" }, { id: "a2", name: "Two" }] } } });
    expect(await token.discover!("cloudflare.account", dctx(m.fetch, "cloudflare"))).toEqual([
      { value: "a1", label: "a1", detail: "a1" },
      { value: "a2", label: "Two", detail: "a2" },
    ]);
    const none = routeFetch({ url: "/accounts?per_page=50", reply: { status: 204 } });
    expect(await token.discover!("cloudflare.account", dctx(none.fetch, "cloudflare"))).toEqual([]);
  });

  it("zones: filters by account, shows the account name in the detail, handles missing fields", async () => {
    const zones = { result: [{ id: "z1", name: "a.com", account: { name: "Acme" } }, { id: "z2" }, { id: "z3", name: "c.com", account: "x" }, { name: "no id" }] };
    const m = routeFetch({ url: "/zones?per_page=50&account.id=acc%201", reply: { body: zones } });
    const opts = await token.discover!("cloudflare.zone", dctx(m.fetch, "cloudflare", { accountId: "acc 1" }));
    expect(opts).toEqual([
      { value: "z1", label: "a.com", detail: "z1 (Acme)" },
      { value: "z2", label: "z2", detail: "z2" },
      { value: "z3", label: "c.com", detail: "z3" },
    ]);
    const all = routeFetch({ url: "/zones?per_page=50", reply: { body: zones } });
    await token.discover!("cloudflare.zone", dctx(all.fetch, "cloudflare", { accountId: "" }));
    expect(all.calls[0]!.url).toBe(`${API}/zones?per_page=50`);
  });

  it("zoneName: lists names with the zone id as detail, with and without account filter", async () => {
    const zones = { result: [{ id: "z1", name: "a.com" }, { name: "b.com" }, { id: "z3" }] };
    const m = routeFetch({ url: "/zones?per_page=50", reply: { body: zones } });
    expect(await token.discover!("cloudflare.zoneName", dctx(m.fetch, "cloudflare"))).toEqual([
      { value: "a.com", label: "a.com", detail: "z1" },
      { value: "b.com", label: "b.com", detail: "" },
    ]);
    await token.discover!("cloudflare.zoneName", dctx(m.fetch, "cloudflare", { accountId: "acc1" }));
    expect(m.calls[1]!.url).toBe(`${API}/zones?per_page=50&account.id=acc1`);
  });

  it("permission groups: merges scopes per name and labels the scope", async () => {
    const groups = {
      result: [
        { name: "Both", scopes: [ACCOUNT] },
        { name: "Both", scopes: [ZONE] },
        { name: "ZoneOnly", scopes: [ZONE] },
        { name: "AccountOnly", scopes: [ACCOUNT] },
        { name: "Other", scopes: ["com.example", 5] },
        { name: "NoScopes", scopes: "x" },
        { scopes: [ACCOUNT] },
      ],
    };
    const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: groups } });
    const opts = await token.discover!("cloudflare.permissionGroups", dctx(m.fetch, "cloudflare"));
    expect(Object.fromEntries(opts.map((o) => [o.value, o.detail]))).toEqual({ Both: "account, zone", ZoneOnly: "zone", AccountOnly: "account", Other: "com.example", NoScopes: "" });
  });

  it("worker scripts: needs an account and lists ids with the modification date", async () => {
    const m = routeFetch({ url: "/accounts/acc1/workers/scripts", reply: { body: { result: [{ id: "w1", modified_on: "2026-01-01" }, { id: "w2" }, { name: "no id" }] } } });
    expect(await token.discover!("cloudflare.workerScript", dctx(m.fetch, "cloudflare", { accountId: "acc1" }))).toEqual([
      { value: "w1", label: "w1", detail: "2026-01-01" },
      { value: "w2", label: "w2", detail: "" },
    ]);
    await expect(token.discover!("cloudflare.workerScript", dctx(m.fetch, "cloudflare"))).rejects.toThrow(ParamsInvalidError);
  });

  it("turnstile widgets: domains, names and missing keys", async () => {
    const widgets = { result: [{ sitekey: "k1", name: "Login", domains: ["a.com", 5, "b.com"] }, { sitekey: "k2", domains: [] }, { sitekey: "k3", domains: "x" }, { name: "no key" }] };
    const m = routeFetch({ url: "/accounts/acc1/challenges/widgets", reply: { body: widgets } });
    expect(await turnstile.discover!("cloudflare.turnstileWidget", dctx(m.fetch, "cloudflare-turnstile", { accountId: "acc1" }))).toEqual([
      { value: "k1", label: "Login", detail: "k1 (a.com, b.com)" },
      { value: "k2", label: "k2", detail: "k2" },
      { value: "k3", label: "k3", detail: "k3" },
    ]);
  });

  it("rejects an unknown kind", async () => {
    await expect(token.discover!("cloudflare.nope", dctx(routeFetch().fetch, "cloudflare"))).rejects.toThrow();
  });
});

describe("cloudflare-token preflight", () => {
  const accounts = (list: unknown[]): Route => ({ url: "/accounts?per_page=50", reply: { body: { result: list } } });
  const groups = (list: unknown[]): Route => ({ url: "/user/tokens/permission_groups", reply: { body: { result: list } } });
  const zones = (list: unknown[]): Route => ({ url: "/zones?per_page=50", reply: { body: { result: list } } });
  const acc1 = accounts([{ id: "acc1", name: "Acme" }]);
  const level = (r: { findings: { id: string; level: string }[] }, id: string) => r.findings.find((f) => f.id === id)?.level;

  it("warns when the connection lists no accounts and everything is fine without permissions", async () => {
    const m = routeFetch(accounts([]), groups([]));
    const r = await token.preflight!(pctx(m.fetch, { accountId: "acc1" }));
    expect(level(r, "account")).toBe("warn");
    expect(level(r, "permissions")).toBe("ok");
    expect(r.resource).toBe("Cloudflare-Konto acc1");
  });

  it("fails when the account is not one of the connection's accounts", async () => {
    const m = routeFetch(accounts([{ id: "other", name: "Other Co" }, { id: "x" }]), groups([]));
    const r = await token.preflight!(pctx(m.fetch, { accountId: "acc1" }));
    expect(r.findings.find((f) => f.id === "account")).toMatchObject({ level: "fail", detail: "Verfuegbar: Other Co, x" });
  });

  it("reports an unreadable account list and rethrows a missing connection", async () => {
    const forbidden = routeFetch({ url: "/accounts?per_page=50", reply: { status: 403, body: "no" } }, groups([]));
    const r = await token.preflight!(pctx(forbidden.fetch, { accountId: "acc1" }));
    expect(r.findings.find((f) => f.id === "read")!.label).toContain("dem Token fehlt das Leserecht");
    const m = routeFetch(acc1, groups([]));
    await expect(token.preflight!(pctx(m.fetch, { accountId: "acc1" }, failFrom(connections("cloudflare"), 1, new NotConnectedError("cloudflare"))))).rejects.toThrow(NotConnectedError);
  });

  it("names missing permission groups and demands a zone for zone-bound permissions", async () => {
    const m = routeFetch(acc1, groups([{ name: "Zone Read", scopes: [ZONE] }, { name: "DNS Write", scopes: [ZONE, ACCOUNT] }]));
    const r = await token.preflight!(pctx(m.fetch, { accountId: "acc1", permissions: ["Zone Read", "Zone Read", "Nope"] }));
    expect(r.findings.find((f) => f.id === "permissions")).toMatchObject({ level: "fail", label: "Unbekannte Berechtigungsgruppen: Nope" });
    expect(r.findings.find((f) => f.id === "zone")).toMatchObject({ level: "fail" });
    expect(r.findings.find((f) => f.id === "zone")!.label).toContain("Zone Read");
  });

  it("warns for allZones and extends the resource", async () => {
    const m = routeFetch(acc1, groups([{ name: "Zone Read", scopes: [ZONE] }]));
    const r = await token.preflight!(pctx(m.fetch, { accountId: "acc1", permissions: ["Zone Read"], allZones: true }));
    expect(level(r, "zone")).toBe("warn");
    expect(r.resource).toBe("Cloudflare-Konto Acme (acc1), alle Zonen");
  });

  it("checks zone id and zone names against the zones of the account", async () => {
    const zoneGroups = groups([{ name: "Zone Read", scopes: [ZONE] }]);
    const okRun = routeFetch(acc1, zoneGroups, zones([{ id: "zid1", name: "Example.com" }]));
    const ok = await token.preflight!(pctx(okRun.fetch, { accountId: "acc1", permissions: ["Zone Read"], zoneId: "zid1", zones: ["EXAMPLE.com"] }));
    expect(ok.findings.find((f) => f.id === "zone")).toMatchObject({ level: "ok", label: "Alle Zonen existieren im Konto (Example.com, Example.com)" });
    expect(ok.resource).toBe("Cloudflare-Konto Acme (acc1), Zone Example.com, Example.com");

    const partial = routeFetch(acc1, zoneGroups, zones([{ id: "zid1", name: "example.com" }]));
    const p = await token.preflight!(pctx(partial.fetch, { accountId: "acc1", permissions: ["Zone Read"], zones: ["example.com", "missing.com"] }));
    expect(p.findings.find((f) => f.id === "zone")).toMatchObject({ level: "fail", label: "Zonen nicht im Konto acc1: missing.com" });

    const empty = routeFetch(acc1, zoneGroups, zones([]));
    const e = await token.preflight!(pctx(empty.fetch, { accountId: "acc1", permissions: ["Zone Read"], zoneId: "zid1" }));
    expect(e.findings.find((f) => f.id === "zone")).toMatchObject({ level: "warn" });
    expect(e.resource).toBe("Cloudflare-Konto Acme (acc1)");
  });

  it("reports unreadable permission groups, an invalid zone combination, and rethrows a missing connection", async () => {
    const bad = routeFetch(acc1, { url: "/user/tokens/permission_groups", reply: { status: 500, body: "x" } });
    const r = await token.preflight!(pctx(bad.fetch, { accountId: "acc1", permissions: ["Zone Read"] }));
    expect(r.findings.find((f) => f.label.startsWith("Berechtigungsgruppen nicht lesbar"))).toBeDefined();
    const both = routeFetch(acc1, groups([]));
    const c = await token.preflight!(pctx(both.fetch, { accountId: "acc1", permissions: [], allZones: true, zoneId: "z" }));
    expect(c.findings.at(-1)!.detail).toContain("allZones gilt fuer jede Zone");
    const m = routeFetch(acc1, groups([]));
    await expect(token.preflight!(pctx(m.fetch, { accountId: "acc1" }, failFrom(connections("cloudflare"), 2, new NotConnectedError("cloudflare"))))).rejects.toThrow(NotConnectedError);
  });
});

describe("cloudflare-turnstile", () => {
  const accounts: Route = { url: "/accounts?per_page=50", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } };
  const widgets = (list: unknown[]): Route => ({ url: "/accounts/acc1/challenges/widgets", reply: { body: { result: list } } });
  const params = { accountId: "acc1", sitekey: "k1" };

  it("preflight: widget exists, widget belongs to no known widget, no widgets listed", async () => {
    const found = await turnstile.preflight!(pctx(routeFetch(accounts, widgets([{ sitekey: "k1", name: "Login" }])).fetch, params));
    expect(found.findings.find((f) => f.id === "widget")).toMatchObject({ level: "ok", label: "Das Widget Login existiert" });
    const missing = await turnstile.preflight!(pctx(routeFetch(accounts, widgets([{ sitekey: "other" }])).fetch, params));
    expect(missing.findings.find((f) => f.id === "widget")).toMatchObject({ level: "fail", label: "Das Widget k1 gehoert nicht zum Konto" });
    const none = await turnstile.preflight!(pctx(routeFetch(accounts, widgets([])).fetch, params));
    expect(none.findings.some((f) => f.id === "widget")).toBe(false);
  });

  it("preflight: unreadable widget list is a warning, a missing connection is rethrown, a missing sitekey is invalid", async () => {
    const forbidden = routeFetch(accounts, { url: "/challenges/widgets", reply: { status: 403, body: "no" } });
    const r = await turnstile.preflight!(pctx(forbidden.fetch, params));
    expect(r.findings.find((f) => f.label.startsWith("Widgets nicht lesbar"))).toBeDefined();
    await expect(turnstile.preflight!(pctx(routeFetch(accounts, widgets([])).fetch, params, failFrom(connections("cloudflare-turnstile"), 2, new NotConnectedError("x"))))).rejects.toThrow(NotConnectedError);
    await expect(turnstile.preflight!(pctx(routeFetch(accounts).fetch, { accountId: "acc1" }))).rejects.toThrow(ParamsInvalidError);
  });

  it("checklist with and without sitekey, verify gives an info check", async () => {
    expect(turnstile.reviewChecklist!(secretEntry({ params: { sitekey: "k1" } }))[0]).toContain("k1");
    expect(turnstile.reviewChecklist!(secretEntry())[0]).toBe("Widget und Sitekey stimmen mit dem Dienst ueberein");
    expect(byId(await turnstile.verify!(verifyCtx(routeFetch().fetch, {})))).toEqual({ "old-key": "info" });
  });

  it("issue rejects an answer without a secret", async () => {
    const m = routeFetch({ method: "POST", url: "/challenges/widgets/k1/", reply: { body: { result: {} } } });
    await expect(turnstile.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare-turnstile"] }))).rejects.toThrow("Unerwartete Antwort");
    const none = routeFetch({ method: "POST", url: "/challenges/widgets/k1/", reply: { body: {} } });
    await expect(turnstile.issue!(issueCtx(none.fetch, params, { conns: ["cloudflare-turnstile"] }))).rejects.toThrow("Unerwartete Antwort");
  });
});

describe("cloudflare-token issue edge cases", () => {
  const groupsRoute = (list: unknown): Route => ({ url: "/user/tokens/permission_groups", reply: { body: { result: list } } });
  const create = (reply: Route["reply"] = { body: { result: { id: "tok1", value: "v-0123456789" } } }): Route => ({ method: "POST", url: `${API}/user/tokens`, reply });
  const issue = (m: { fetch: typeof fetch }, p: Record<string, unknown>, ttlDays?: number) => token.issue!(issueCtx(m.fetch, p, { conns: ["cloudflare"], ...(ttlDays ? { ttlDays } : {}) }));
  const bodyOf = (m: { calls: { method: string; body: string | undefined }[] }) => JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);

  it("rejects a group list that is not a list", async () => {
    await expect(issue(routeFetch(groupsRoute("nope")), { accountId: "acc1", permissions: ["A"] })).rejects.toThrow("Unerwartete Antwort");
  });

  it("treats groups without scopes as account groups and prefers the group of the matching scope, else the first", async () => {
    const m = routeFetch(groupsRoute([{ id: "g1", name: "A" }, { id: "g2", name: "A", scopes: [ACCOUNT] }]), create());
    await issue(m, { accountId: "acc1", permissions: ["A"] });
    expect(bodyOf(m).policies).toEqual([{ effect: "allow", resources: { [`${ACCOUNT}.acc1`]: "*" }, permission_groups: [{ id: "g2" }] }]);
    const bare = routeFetch(groupsRoute([{ id: "g5", name: "A" }]), create());
    await issue(bare, { accountId: "acc1", permissions: ["A"] });
    expect(bodyOf(bare).policies[0].permission_groups).toEqual([{ id: "g5" }]);
    const fallback = routeFetch(groupsRoute([{ id: "g9", name: "A", scopes: ["other"] }]), create());
    await issue(fallback, { accountId: "acc1", permissions: ["A"] });
    expect(bodyOf(fallback).policies[0].permission_groups).toEqual([{ id: "g9" }]);
  });

  it("counts a group name as zone bound when one entry is zone scoped and another has no scopes", async () => {
    const m = routeFetch(groupsRoute([{ id: "gz", name: "Zone Read", scopes: [ZONE] }, { id: "gx", name: "Zone Read" }]), create());
    await issue(m, { accountId: "acc1", permissions: ["Zone Read"], zoneId: "zid" });
    expect(bodyOf(m).policies).toHaveLength(1);
    expect(bodyOf(m).policies[0].resources).toEqual({ [`${ZONE}.zid`]: "*" });
  });

  it("builds a zone-only policy without an account policy", async () => {
    const m = routeFetch(groupsRoute([{ id: "gz", name: "Zone Read", scopes: [ZONE] }]), create());
    await issue(m, { accountId: "acc1", permissions: ["Zone Read"], zoneId: "zid" });
    expect(bodyOf(m).policies).toEqual([{ effect: "allow", resources: { [`${ZONE}.zid`]: "*" }, permission_groups: [{ id: "gz" }] }]);
  });

  it("sends no expiry and returns none when the ttl is 0 and Cloudflare sets none", async () => {
    const m = routeFetch(groupsRoute([{ id: "g1", name: "A" }]), create());
    const ctx = issueCtx(m.fetch, { accountId: "acc1", permissions: ["A"] }, { conns: ["cloudflare"] });
    const r = await token.issue!({ ...ctx, secret: { ...ctx.secret, ttlDays: 0 } as typeof ctx.secret });
    expect(bodyOf(m)).not.toHaveProperty("expires_on");
    expect(r.expiresAt).toBeNull();
  });

  it("fails on answers with a value but no id, or with no result", async () => {
    const noId = routeFetch(groupsRoute([{ id: "g1", name: "A" }]), create({ body: { result: { value: "v-0123456789" } } }));
    await expect(issue(noId, { accountId: "acc1", permissions: ["A"] })).rejects.toThrow("Unerwartete Antwort");
    const none = routeFetch(groupsRoute([{ id: "g1", name: "A" }]), create({ body: {} }));
    await expect(issue(none, { accountId: "acc1", permissions: ["A"] })).rejects.toThrow("Unerwartete Antwort");
  });

  it("zone name lookup: an answer that is not a list, or a different name, counts as not found", async () => {
    const zoneGroup = groupsRoute([{ id: "gz", name: "Zone Read", scopes: [ZONE] }]);
    const notList = routeFetch(zoneGroup, { url: "/zones?name=a.com", reply: { body: { result: "x" } } }, create());
    await expect(issue(notList, { accountId: "acc1", permissions: ["Zone Read"], zones: ["a.com"] })).rejects.toThrow("Zonen nicht gefunden");
    const other = routeFetch(zoneGroup, { url: "/zones?name=a.com", reply: { body: { result: [{ id: "z", name: "b.com" }, { id: 5, name: "a.com" }] } } }, create());
    await expect(issue(other, { accountId: "acc1", permissions: ["Zone Read"], zones: ["a.com"] })).rejects.toThrow("a.com");
    expect(other.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("cloudflare-token verify", () => {
  const params = { accountId: "acc1", permissions: ["Workers Scripts Write"] };
  const opts = { conns: ["cloudflare"], externalId: "tok1" };
  const verifyRoute = (body: unknown, status = 200): Route => ({ url: "/user/tokens/verify", reply: { status, body } });
  const infoRoute = (body: unknown, status = 200): Route => ({ url: "/user/tokens/tok1", reply: { status, body } });
  const info = (policies: unknown, extra: Record<string, unknown> = {}) => infoRoute({ result: { id: "tok1", policies, ...extra } });
  const policy = (resources: unknown, groups: unknown = [{ name: "Workers Scripts Write" }]) => ({ resources, permission_groups: groups });
  const run = (routes: Route[], p: Record<string, unknown> = params, o: Parameters<typeof verifyCtx>[2] = opts) => token.verify!(verifyCtx(routeFetch(...routes).fetch, p, o));
  const find = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as { status: string; detail?: string; actual?: string; expected?: string };

  it("active: a result without a status falls back to the HTTP status", async () => {
    const checks = await run([verifyRoute({ result: "x" }, 401), info([])], params, opts);
    expect(find(checks, "active")).toMatchObject({ status: "fail", actual: "HTTP 401" });
    const nonRecord = await run([verifyRoute([]), info([])]);
    expect(find(nonRecord, "active").actual).toBe("HTTP 200");
  });

  it("permissions: no token id and unreadable token are warnings", async () => {
    const noId = await run([verifyRoute({ result: { status: "active" } })], params, { conns: ["cloudflare"] });
    expect(find(noId, "permissions")).toMatchObject({ status: "warn", detail: "Keine Token-Kennung, Rechte nicht abrufbar" });
    const server = await run([verifyRoute({ result: { status: "active" } }), infoRoute("x", 500)]);
    expect(find(server, "permissions").detail).toBe("Token konnte nicht gelesen werden (HTTP 500)");
    const noResult = await run([verifyRoute({ result: { status: "active" } }), infoRoute({ result: 1 })]);
    expect(find(noResult, "permissions").status).toBe("warn");
  });

  it("permissions: compares names, ignoring malformed groups, and reports differences", async () => {
    const same = await run([verifyRoute({ result: { status: "active" } }), info([policy({ [`${ACCOUNT}.acc1`]: "*" }, [{ name: "Workers Scripts Write" }, "str", { id: 1 }])])]);
    expect(find(same, "permissions")).toMatchObject({ status: "pass", actual: "Workers Scripts Write" });
    const diff = await run([verifyRoute({ result: { status: "active" } }), info([policy({ [`${ACCOUNT}.acc1`]: "*" }, [{ name: "Other" }])])]);
    expect(find(diff, "permissions")).toMatchObject({ status: "fail", detail: "Zusaetzlich: Other; Fehlt: Workers Scripts Write" });
    const noGroups = await run([verifyRoute({ result: { status: "active" } }), info([policy({ [`${ACCOUNT}.acc1`]: "*" }, "x")])]);
    expect(find(noGroups, "permissions")).toMatchObject({ status: "fail", actual: "keine", detail: "Fehlt: Workers Scripts Write" });
  });

  it("permissions: without a permissions parameter or an account id no comparison is possible", async () => {
    const checks = await run([verifyRoute({ result: { status: "active" } }), info("nope", {})], {});
    expect(find(checks, "permissions")).toMatchObject({ status: "warn", detail: "Parameter permissions fehlt, kein Vergleich moeglich" });
    expect(find(checks, "account-scope")).toMatchObject({ status: "warn", detail: "Parameter accountId fehlt, kein Vergleich moeglich" });
  });

  it("account scope: missing account, foreign resources, wrong zone count, resources that are no object", async () => {
    const ok = { result: { status: "active" } };
    const none = await run([verifyRoute(ok), info([policy("x")])]);
    expect(find(none, "account-scope")).toMatchObject({ status: "fail", actual: "keine Ressourcen", detail: "Erwartetes Konto fehlt" });
    const foreign = await run([verifyRoute(ok), info([policy({ [`${ACCOUNT}.acc1`]: "*", [`${ACCOUNT}.other`]: "*" })])]);
    expect(find(foreign, "account-scope").detail).toBe(`Weitere Ressourcen: ${ACCOUNT}.other`);
    const zoneParams = { ...params, zoneId: "z1", zones: ["a.com", "b.com"] };
    const count = await run([verifyRoute(ok), info([policy({ [`${ACCOUNT}.acc1`]: "*", [`${ZONE}.z1`]: "*" })])], zoneParams);
    expect(find(count, "account-scope").detail).toBe("Anzahl der Zonen weicht ab: erwartet 3, gefunden 1");
    const allZones = await run([verifyRoute(ok), info([policy({ [`${ACCOUNT}.acc1`]: "*", [`${ZONE}.z1`]: "*" })])], { ...params, allZones: true });
    expect(find(allZones, "account-scope").status).toBe("fail");
    const wrongZone = await run([verifyRoute(ok), info([policy({ [`${ZONE}.z2`]: "*" })])], { ...params, zoneId: "z1" });
    expect(find(wrongZone, "account-scope").status).toBe("fail");
    const good = await run([verifyRoute(ok), info([policy({ [`${ZONE}.z1`]: "*" })])], { ...params, zoneId: "z1" });
    expect(find(good, "account-scope").status).toBe("pass");
  });
});

describe("expiryCheck", () => {
  const ctx = (expiresAt: string | null | undefined, ttlDays?: number) => verifyCtx(routeFetch().fetch, {}, { expiresAt, ...(ttlDays ? { ttlDays } : {}) });
  it("passes within a day, warns beyond it or for unreadable dates", () => {
    expect(expiryCheck(ctx("2026-12-01T10:00:00Z"), "2026-12-01T20:00:00Z").status).toBe("pass");
    expect(expiryCheck(ctx("2026-12-01T10:00:00Z"), "2026-12-05T10:00:00Z").status).toBe("warn");
    expect(expiryCheck(ctx("not a date"), "also not").status).toBe("warn");
  });
  it("passes with only an actual expiry, warns when an expected expiry is missing, infos when none is planned", () => {
    expect(expiryCheck(ctx(undefined), "2026-12-01T10:00:00Z")).toMatchObject({ status: "pass", actual: "2026-12-01" });
    expect(expiryCheck(ctx("2026-12-01T10:00:00Z"), undefined)).toMatchObject({ status: "warn", expected: "2026-12-01", actual: "kein Ablauf" });
    expect(expiryCheck(ctx(null, 30), 5)).toMatchObject({ status: "warn", expected: "30 Tage" });
    expect(expiryCheck(ctx(null), undefined).status).toBe("info");
  });
  it("checklist uses the default ttl text and the permission list", () => {
    expect(token.reviewChecklist!(secretEntry())).toContain("Ablauf ist 90 Tage nach heute (Standard)");
    expect(token.reviewChecklist!(secretEntry({ ttlDays: 5, params: { accountId: "acc1", permissions: ["A", "B"] } }))).toEqual(
      expect.arrayContaining(["Rechte sind exakt: A, B", "Nur das Konto acc1 ist freigegeben", "Ablauf ist 5 Tage nach heute"]),
    );
  });
});
