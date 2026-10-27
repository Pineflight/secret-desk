import { describe, expect, it } from "vitest";
import type { Check, Provider, Stage } from "@secret-desk/core";
import { createDefaultRegistry } from "../src/index.js";
import { CONN_TOKEN, ISSUED, LEAK, byId, expectNoLeak, mockFetch, secretEntry, verifyCtx } from "./helpers.js";

const reg = createDefaultRegistry();
const get = (id: string): Provider => reg.get(id)!;
const run = (id: string, ...args: Parameters<typeof verifyCtx>): Promise<Check[]> => get(id).verify!(verifyCtx(...args));

describe("cloudflare-token verify", () => {
  const params = { accountId: "acc1", permissions: ["Workers Scripts Write", "Account Settings Read"] };
  const tokenInfo = (groups: string[], resources: Record<string, string> = { "com.cloudflare.api.account.acc1": "*" }) => ({
    result: { id: "tok1", policies: [{ effect: "allow", resources, permission_groups: groups.map((name, i) => ({ id: `g${i}`, name })) }] },
  });
  const verifyOk = { body: { result: { status: "active", expires_on: "2026-12-01T10:00:00Z" } } };
  const opts = { conns: ["cloudflare"], externalId: "tok1", ttlDays: 30, expiresAt: "2026-12-01T10:00:00Z" };

  it("Erfolg: alles pass, richtige Aufrufe", async () => {
    const m = mockFetch(verifyOk, { body: tokenInfo(["Account Settings Read", "Workers Scripts Write"]) });
    const checks = await run("cloudflare-token", m.fetch, params, opts);
    expect(byId(checks)).toEqual({ active: "pass", expires: "pass", permissions: "pass", "account-scope": "pass" });
    expect(m.calls.map((c) => c.url).sort()).toEqual(["https://api.cloudflare.com/client/v4/user/tokens/tok1", "https://api.cloudflare.com/client/v4/user/tokens/verify"]);
    const verifyCall = m.calls.find((c) => c.url.endsWith("/verify"))!;
    expect(verifyCall.headers).toMatchObject({ Authorization: `Bearer ${ISSUED}` });
    expect(verifyCall.signal).toBeInstanceOf(AbortSignal);
    expect(m.calls.find((c) => c.url.endsWith("/tok1"))!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
    expectNoLeak(checks);
  });
  it("zusaetzliche Rechte und fremdes Konto sind fail und nennen die Namen", async () => {
    const m = mockFetch(verifyOk, { body: tokenInfo(["Workers Scripts Write", "Account Settings Read", "DNS Write"], { "com.cloudflare.api.account.acc1": "*", "com.cloudflare.api.account.zzz": "*" }) });
    const checks = await run("cloudflare-token", m.fetch, params, opts);
    const perm = checks.find((c) => c.id === "permissions")!;
    expect(perm.status).toBe("fail");
    expect(perm.detail).toContain("DNS Write");
    const scope = checks.find((c) => c.id === "account-scope")!;
    expect(scope.status).toBe("fail");
    expect(scope.detail).toContain("com.cloudflare.api.account.zzz");
    expectNoLeak(checks);
  });
  it("fehlende Rechte sind fail", async () => {
    const m = mockFetch(verifyOk, { body: tokenInfo(["Workers Scripts Write"]) });
    const perm = (await run("cloudflare-token", m.fetch, params, opts)).find((c) => c.id === "permissions")!;
    expect(perm.status).toBe("fail");
    expect(perm.detail).toContain("Account Settings Read");
  });
  it("inaktiver Token ist fail, Ablaufabweichung warn", async () => {
    const m = mockFetch({ body: { result: { status: "expired", expires_on: "2026-12-10T10:00:00Z" } } }, { body: tokenInfo(params.permissions) });
    const s = byId(await run("cloudflare-token", m.fetch, params, opts));
    expect(s["active"]).toBe("fail");
    expect(s["expires"]).toBe("warn");
  });
  it("kein Ablauf trotz ttlDays ist warn", async () => {
    const m = mockFetch({ body: { result: { status: "active" } } }, { body: tokenInfo(params.permissions) });
    expect(byId(await run("cloudflare-token", m.fetch, params, { ...opts, expiresAt: null }))["expires"]).toBe("warn");
  });
  it("Fehler wird zu warn ohne Wert und Token", async () => {
    const m = mockFetch({ status: 403, body: LEAK }, { status: 403, body: LEAK });
    const checks = await run("cloudflare-token", m.fetch, params, opts);
    expect(byId(checks)["permissions"]).toBe("warn");
    expectNoLeak(checks);
    // Netzfehler nennen jeweils den Wert, den der Aufruf selbst gesendet hat.
    const net = (async (_u: unknown, init?: RequestInit) => {
      throw new Error(`down ${(init?.headers as Record<string, string>)["Authorization"]}`);
    }) as unknown as typeof fetch;
    const c2 = await run("cloudflare-token", net, params, opts);
    expect(c2.every((c) => c.status === "warn")).toBe(true);
    expectNoLeak(c2);
  });
  it("ohne Verbindung: warn", async () => {
    const m = mockFetch(verifyOk);
    const checks = await run("cloudflare-token", m.fetch, params, { externalId: "tok1" });
    expect(byId(checks)["permissions"]).toBe("warn");
    expectNoLeak(checks);
  });
  it("Pruefpunkte nennen Parameter", () => {
    const items = get("cloudflare-token").reviewChecklist!(secretEntry({ params, ttlDays: 30 }));
    expect(items.join("\n")).toContain("test-secret");
    expect(items.join("\n")).toContain("Workers Scripts Write, Account Settings Read");
    expect(items.join("\n")).toContain("acc1");
    expect(items.join("\n")).toContain("30 Tage");
    expect(get("cloudflare-token").reviewChecklist!(secretEntry()).length).toBe(4);
  });
});

describe("cloudflare-turnstile verify", () => {
  it("liefert nur info", async () => {
    const m = mockFetch();
    const checks = await run("cloudflare-turnstile", m.fetch, {});
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("info");
    expect(m.calls).toHaveLength(0);
    expect(get("cloudflare-turnstile").reviewChecklist!(secretEntry({ params: { sitekey: "sk1" } })).join(" ")).toContain("sk1");
  });
});

describe("supabase-api-key verify", () => {
  const KEY = "sb_secret_ABCDEFGHIJKLMNOP";
  it("Erfolg: Form info, REST pass, kein Wert", async () => {
    const m = mockFetch({ status: 200, body: {} });
    const checks = await run("supabase-api-key", m.fetch, { type: "secret", url: "https://abc.supabase.co" }, { value: KEY });
    expect(byId(checks)).toEqual({ shape: "info", rest: "pass" });
    expect(checks[0]!.actual).toBe("Praefix sb_secret_, 26 Zeichen");
    expect(m.calls[0]).toMatchObject({ url: "https://abc.supabase.co/rest/v1/" });
    expect(m.calls[0]!.headers).toMatchObject({ apikey: KEY });
    expectNoLeak(checks, [KEY, "ABCDEFGH"]);
  });
  it("ohne url nur Form; Typ passt nicht = fail", async () => {
    const m = mockFetch();
    expect(byId(await run("supabase-api-key", m.fetch, { type: "secret" }, { value: KEY }))).toEqual({ shape: "info" });
    expect(byId(await run("supabase-api-key", m.fetch, { type: "publishable" }, { value: KEY }))["shape"]).toBe("fail");
    expect(byId(await run("supabase-api-key", m.fetch, {}, { value: "irgendwas" }))["shape"]).toBe("warn");
    expect(m.calls).toHaveLength(0);
  });
  it("401 = fail, 500 = warn, fremde Url = warn ohne Aufruf, Netzfehler = warn", async () => {
    const p = { url: "https://abc.supabase.co" };
    expect(byId(await run("supabase-api-key", mockFetch({ status: 401, body: LEAK }).fetch, p, { value: KEY }))["rest"]).toBe("fail");
    expect(byId(await run("supabase-api-key", mockFetch({ status: 500 }).fetch, p, { value: KEY }))["rest"]).toBe("warn");
    const m = mockFetch();
    expect(byId(await run("supabase-api-key", m.fetch, { url: "https://evil.example.com" }, { value: KEY }))["rest"]).toBe("warn");
    expect(m.calls).toHaveLength(0);
    const net = (async () => {
      throw new Error(`down ${KEY}`);
    }) as unknown as typeof fetch;
    const c = await run("supabase-api-key", net, p, { value: KEY });
    expect(byId(c)["rest"]).toBe("warn");
    expectNoLeak(c, [KEY]);
  });
  it("Pruefpunkte nennen Ref und Staging", () => {
    const items = get("supabase-api-key").reviewChecklist!(secretEntry({ stage: "staging", params: { projectRef: "abc", type: "secret" }, places: [{ repo: "x", scope: "repository" }] }));
    expect(items.join(" ")).toContain("abc");
    expect(items.join(" ")).toContain("Staging");
  });
});

describe("stripe-webhook-secret verify", () => {
  const params = { url: "https://x.example/hook", events: ["checkout.session.completed", "invoice.paid"] };
  const endpoint = (extra: Record<string, unknown> = {}) => ({ id: "we_1", status: "enabled", url: params.url, enabled_events: ["invoice.paid", "checkout.session.completed"], livemode: false, ...extra });
  const opts = { conns: ["stripe"], externalId: "we_1" };
  it("Erfolg in der Sandbox (Reihenfolge egal)", async () => {
    const m = mockFetch({ body: endpoint() });
    const checks = await run("stripe-webhook-secret", m.fetch, params, { ...opts, stage: "staging" });
    expect(byId(checks)).toEqual({ status: "pass", url: "pass", events: "pass", mode: "pass" });
    expect(m.calls[0]).toMatchObject({ url: "https://api.stripe.com/v1/webhook_endpoints/we_1", method: "GET" });
    expectNoLeak(checks);
  });
  it.each<[Stage, boolean, string]>([
    ["dev", false, "pass"],
    ["dev", true, "fail"],
    ["staging", false, "pass"],
    ["staging", true, "fail"],
    ["production", true, "pass"],
    ["production", false, "fail"],
    ["shared", true, "info"],
    ["shared", false, "info"],
  ])("Modus: Stage %s, livemode %s -> %s", async (stage, live, expected) => {
    const m = mockFetch({ body: endpoint({ livemode: live }) });
    expect(byId(await run("stripe-webhook-secret", m.fetch, params, { ...opts, stage }))["mode"]).toBe(expected);
  });
  it("deaktiviert, andere Url, andere Ereignisse = fail", async () => {
    const m = mockFetch({ body: endpoint({ status: "disabled", url: "https://other.example/h", enabled_events: ["invoice.paid", "charge.failed"] }) });
    const s = byId(await run("stripe-webhook-secret", m.fetch, params, opts));
    expect(s).toMatchObject({ status: "fail", url: "fail", events: "fail" });
  });
  it("404 = fail, 500 = warn, kein Wert im Befund", async () => {
    expect(byId(await run("stripe-webhook-secret", mockFetch({ status: 404, body: LEAK }).fetch, params, opts))["status"]).toBe("fail");
    const c = await run("stripe-webhook-secret", mockFetch({ status: 500, body: LEAK }).fetch, params, opts);
    expect(byId(c)["status"]).toBe("warn");
    expectNoLeak(c);
  });
});

describe("resend-api-key verify", () => {
  const opts = { conns: ["resend"], externalId: "k1" };
  it("Erfolg", async () => {
    const m = mockFetch({ body: { data: [{ id: "k0", name: "a" }, { id: "k1", name: "b", permission: "sending_access" }] } });
    const checks = await run("resend-api-key", m.fetch, {}, opts);
    expect(byId(checks)).toEqual({ exists: "pass", permission: "pass" });
    expect(m.calls[0]!.url).toBe("https://api.resend.com/api-keys");
    expectNoLeak(checks);
  });
  it("fehlender Eintrag und falsche Berechtigung = fail", async () => {
    expect(byId(await run("resend-api-key", mockFetch({ body: { data: [{ id: "k0" }] } }).fetch, {}, opts))["exists"]).toBe("fail");
    expect(byId(await run("resend-api-key", mockFetch({ body: { data: [{ id: "k1", permission: "full_access" }] } }).fetch, {}, opts))["permission"]).toBe("fail");
  });
  it("Berechtigung nicht ausgewiesen = info; Fehler = warn ohne Werte", async () => {
    expect(byId(await run("resend-api-key", mockFetch({ body: { data: [{ id: "k1" }] } }).fetch, { permission: "full_access" }, opts))["permission"]).toBe("info");
    const c = await run("resend-api-key", mockFetch({ status: 401, body: LEAK }).fetch, {}, opts);
    expect(byId(c)["exists"]).toBe("warn");
    expectNoLeak(c);
  });
});

describe("grafana verify", () => {
  const params = { baseUrl: "https://g.example.net/", serviceAccountId: 7 };
  const opts = { conns: ["grafana"], externalId: "42", expiresAt: "2026-12-01T10:00:00Z" };
  it("Erfolg", async () => {
    const m = mockFetch({ body: [{ id: 41, hasExpired: true }, { id: 42, hasExpired: false, expiration: "2026-12-01T10:00:00Z" }] });
    const checks = await run("grafana-service-account-token", m.fetch, params, opts);
    expect(byId(checks)).toEqual({ exists: "pass", valid: "pass", expires: "pass" });
    expect(m.calls[0]!.url).toBe("https://g.example.net/api/serviceaccounts/7/tokens");
    expectNoLeak(checks);
  });
  it("abgelaufen = fail, fehlend = fail, Ablauf weicht ab = warn", async () => {
    expect(byId(await run("grafana-service-account-token", mockFetch({ body: [{ id: 42, hasExpired: true }] }).fetch, params, opts))["valid"]).toBe("fail");
    expect(byId(await run("grafana-service-account-token", mockFetch({ body: [] }).fetch, params, opts))["exists"]).toBe("fail");
    expect(byId(await run("grafana-service-account-token", mockFetch({ body: [{ id: 42, hasExpired: false, expiration: "2027-03-01T00:00:00Z" }] }).fetch, params, opts))["expires"]).toBe("warn");
  });
  it("Fehler = warn ohne Werte, ungueltige Parameter = warn", async () => {
    const c = await run("grafana-service-account-token", mockFetch({ status: 500, body: LEAK }).fetch, params, opts);
    expect(byId(c)["exists"]).toBe("warn");
    expectNoLeak(c);
    expect(byId(await run("grafana-service-account-token", mockFetch().fetch, {}, opts))["exists"]).toBe("warn");
  });
});

describe("random verify", () => {
  const ok = (id: string, value: string, params: Record<string, unknown> = {}) => run(id, mockFetch().fetch, params, { value });
  it("hex", async () => {
    expect(byId(await ok("random-hex", "ab".repeat(32)))).toEqual({ shape: "pass", local: "info" });
    expect(byId(await ok("random-hex", "ab".repeat(16), { bytes: 16 }))["shape"]).toBe("pass");
    expect(byId(await ok("random-hex", "ab".repeat(15)))["shape"]).toBe("fail");
    expect(byId(await ok("random-hex", "zz".repeat(32)))["shape"]).toBe("fail");
  });
  it("base64", async () => {
    expect(byId(await ok("random-base64", Buffer.alloc(32, 7).toString("base64")))["shape"]).toBe("pass");
    expect(byId(await ok("random-base64", "abc"))["shape"]).toBe("fail");
  });
  it("uuid", async () => {
    expect(byId(await ok("random-uuid", "123e4567-e89b-12d3-a456-426614174000"))["shape"]).toBe("pass");
    expect(byId(await ok("random-uuid", "nope"))["shape"]).toBe("fail");
  });
  it("Befund enthaelt den Wert nicht; Pruefpunkte vorhanden", async () => {
    const v = "ab".repeat(32);
    expectNoLeak(await ok("random-hex", v), [v]);
    expect(get("random-uuid").reviewChecklist!(secretEntry())).toHaveLength(2);
  });
});

describe("manual: stripe-restricted-key", () => {
  const KEYS: Record<string, string> = { rk_test: "rk_test_AAAABBBBCCCC", rk_live: "rk_live_AAAABBBBCCCC", sk_test: "sk_test_AAAABBBBCCCC", sk_live: "sk_live_AAAABBBBCCCC" };
  const EXPECT: Record<Stage, Record<string, string>> = {
    dev: { rk_test: "pass", rk_live: "fail", sk_test: "pass", sk_live: "fail" },
    staging: { rk_test: "pass", rk_live: "fail", sk_test: "pass", sk_live: "fail" },
    production: { rk_test: "fail", rk_live: "pass", sk_test: "fail", sk_live: "pass" },
    shared: { rk_test: "info", rk_live: "info", sk_test: "info", sk_live: "info" },
  };
  for (const stage of Object.keys(EXPECT) as Stage[]) {
    for (const [name, value] of Object.entries(KEYS)) {
      it(`Modus: ${stage} x ${name} -> ${EXPECT[stage][name]}`, async () => {
        const m = mockFetch({ status: 200, body: {} });
        const checks = await run("stripe-restricted-key", m.fetch, {}, { stage, value });
        const s = byId(checks);
        expect(s["mode"]).toBe(EXPECT[stage][name]);
        expect(s["restricted"]).toBe(name.startsWith("rk") ? "pass" : "warn");
        expect(s["works"]).toBe("pass");
        expectNoLeak(checks, [value, "AAAABBBB"]);
      });
    }
  }
  it("unbekannter Praefix = warn", async () => {
    expect(byId(await run("stripe-restricted-key", mockFetch({ status: 200 }).fetch, {}, { value: "pk_test_xxx" }))["mode"]).toBe("warn");
  });
  it("Guthaben: 200 pass, 401 fail, 403 info, 500 warn; Bearer wird gesendet", async () => {
    const v = KEYS["rk_test"]!;
    const m = mockFetch({ status: 200 });
    await run("stripe-restricted-key", m.fetch, {}, { value: v });
    expect(m.calls[0]).toMatchObject({ url: "https://api.stripe.com/v1/balance" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${v}` });
    const t = async (status: number) => {
      const c = await run("stripe-restricted-key", mockFetch({ status, body: `err ${v}` }).fetch, {}, { value: v });
      expectNoLeak(c, [v]);
      return byId(c)["works"];
    };
    expect(await t(401)).toBe("fail");
    expect(await t(403)).toBe("info");
    expect(await t(500)).toBe("warn");
  });
  it("Netzfehler = warn ohne Wert", async () => {
    const v = KEYS["rk_test"]!;
    const net = (async () => {
      throw new Error(`down ${v}`);
    }) as unknown as typeof fetch;
    const c = await run("stripe-restricted-key", net, {}, { value: v });
    expect(byId(c)["works"]).toBe("warn");
    expectNoLeak(c, [v]);
  });
});

describe("manual: github-fine-grained-token", () => {
  const withHeader = (header: string | null, body: unknown = { login: "octo" }) => {
    const f = (async () => new Response(JSON.stringify(body), { status: 200, headers: header ? { "github-authentication-token-expiration": header } : {} })) as unknown as typeof fetch;
    return f;
  };
  it("Erfolg mit Ablauf", async () => {
    const c = await run("github-fine-grained-token", withHeader("2026-12-01 10:00:00 UTC"), {});
    expect(byId(c)).toEqual({ works: "pass", expires: "pass" });
    expect(c[0]!.actual).toBe("octo");
    expect(c[1]!.actual).toBe("2026-12-01");
    expectNoLeak(c);
  });
  it("kein Ablauf und zu langer Ablauf = warn", async () => {
    expect(byId(await run("github-fine-grained-token", withHeader(null), {}))["expires"]).toBe("warn");
    expect(byId(await run("github-fine-grained-token", withHeader("2028-01-01 00:00:00 UTC"), {}))["expires"]).toBe("warn");
  });
  it("401 = fail, kein Wert", async () => {
    const c = await run("github-fine-grained-token", mockFetch({ status: 401, body: LEAK }).fetch, {});
    expect(byId(c)).toEqual({ works: "fail" });
    expectNoLeak(c);
  });
});

describe("manual: supabase-access-token und openai", () => {
  it("supabase: 200 pass mit Anzahl, 401 fail", async () => {
    const m = mockFetch({ body: [{ id: "a" }, { id: "b" }] });
    const c = await run("supabase-access-token", m.fetch, {});
    expect(byId(c)).toEqual({ works: "pass", organizations: "info" });
    expect(c[1]!.actual).toBe("2");
    expect(m.calls[0]!.url).toBe("https://api.supabase.com/v1/organizations");
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${ISSUED}` });
    expectNoLeak(c);
    const f = await run("supabase-access-token", mockFetch({ status: 401, body: LEAK }).fetch, {});
    expect(byId(f)["works"]).toBe("fail");
    expectNoLeak(f);
  });
  it("openai: 200 pass, 401 fail, 500 warn", async () => {
    const m = mockFetch({ body: { data: [] } });
    expect(byId(await run("openai", m.fetch, {}))["works"]).toBe("pass");
    expect(m.calls[0]!.url).toBe("https://api.openai.com/v1/models?limit=1");
    const f = await run("openai", mockFetch({ status: 401, body: LEAK }).fetch, {});
    expect(byId(f)["works"]).toBe("fail");
    expectNoLeak(f);
    expect(byId(await run("openai", mockFetch({ status: 500 }).fetch, {}))["works"]).toBe("warn");
  });
});

describe("Pruefpunkte aller Anbieter", () => {
  const list = reg.list();
  it("jeder Anbieter hat eine nicht leere Liste", () => {
    expect(list.length).toBeGreaterThanOrEqual(19);
    for (const p of list.filter((x) => x.kind === "manual" || x.kind === "automatic")) {
      const items = p.reviewChecklist?.(secretEntry());
      expect(items, p.id).toBeDefined();
      expect(items!.length, p.id).toBeGreaterThanOrEqual(2);
      expect(items!.length, p.id).toBeLessThanOrEqual(5);
      for (const i of items!) expect(i.trim().length).toBeGreaterThan(5);
    }
  });
  it("manuelle ohne API-Pruefung haben kein verify, mit API schon", () => {
    for (const id of ["peecho", "vesselapi", "dip-bundestag", "telegram-bot", "awin", "revenuecat"]) expect(get(id).verify).toBeUndefined();
    for (const id of ["stripe-restricted-key", "github-fine-grained-token", "supabase-access-token", "openai"]) expect(typeof get(id).verify).toBe("function");
  });
});
