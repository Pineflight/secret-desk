import { describe, expect, it } from "vitest";
import { ParamsInvalidError, UnknownDiscoverKindError, validateEntryParams, type PreflightContext } from "@secret-desk/core";
import { cloudflareProviders, createDefaultRegistry, grafanaProvider, resendProvider, supabaseProviders, stripeWebhookProvider, readVariableField } from "../src/index.js";
import { CONN_TOKEN, connections, mockFetch, routeFetch, secretEntry } from "./helpers.js";

const registry = createDefaultRegistry();
const get = (id: string) => registry.get(id)!;
const dctx = (f: typeof fetch, conns: string[], params: Record<string, unknown> = {}) => ({ connections: connections(...conns), fetch: f, params, hint: { repos: ["wake-miles"], stage: "staging", stageKind: "test" as const } });
const pctx = (f: typeof fetch, conns: string[], params: Record<string, unknown>, stageKind: "test" | "live" = "test"): PreflightContext => ({ secret: secretEntry(), params, stage: "staging", stageKind, connections: connections(...conns), fetch: f });

const GROUPS = { result: [{ id: "g1", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] }, { id: "g2", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] }, { id: "g3", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] }] };
const cf = () =>
  routeFetch(
    { url: "/accounts?per_page=50", reply: { body: { result: [{ id: "acc1", name: "Pineflight" }] } } },
    { url: "/zones?", reply: { body: { result: [{ id: "z1", name: "wakemiles.com", account: { name: "Pineflight" } }] } } },
    { url: "/user/tokens/permission_groups", reply: { body: GROUPS } },
    { url: "/challenges/widgets", reply: { body: { result: [{ sitekey: "0xAAA", name: "Login", domains: ["wakemiles.com"] }] } } },
  );

describe("specifications", () => {
  it("every automatic provider with a connection declares its parameters; discover kinds are implemented", () => {
    for (const id of ["cloudflare-token", "cloudflare-turnstile", "supabase-api-key", "supabase-service-role", "resend-api-key", "grafana-service-account-token", "stripe-webhook-secret", "random-hex"]) {
      expect(get(id).params?.length, id).toBeGreaterThan(0);
    }
    for (const p of registry.list()) for (const s of p.params ?? []) if (s.discover) expect(p.discover, `${p.id}.${s.key}`).toBeTypeOf("function");
  });
  it("cloudflare-token declares presets and the zone parameter", () => {
    const perms = get("cloudflare-token").params!.find((s) => s.key === "permissions")!;
    expect(perms.presets!.map((p) => p.label)).toEqual(["Worker-Deploy", "Worker-Deploy mit Custom Domain"]);
    expect(perms.presets![0]!.values["permissions"]).toEqual(["Workers Scripts Write", "Account Settings Read"]);
    expect(perms.presets![1]!.needs).toEqual(["zoneId"]);
    expect(get("cloudflare-token").params!.map((s) => s.key)).toEqual(["accountId", "permissions", "zoneId"]);
  });
  it("validation without any network call names the missing keys", () => {
    const { fetch, calls } = mockFetch({ status: 599 });
    void fetch;
    const problems = (id: string, params: Record<string, unknown>) => validateEntryParams(get(id), { params }).map((p) => p.key);
    expect(problems("cloudflare-token", {})).toEqual(["accountId", "permissions"]);
    expect(problems("cloudflare-turnstile", {})).toEqual(["accountId", "sitekey"]);
    expect(problems("supabase-api-key", {})).toEqual(["projectRef"]);
    expect(problems("supabase-api-key", { projectRef: "a", type: "root" })).toEqual(["type"]);
    expect(problems("supabase-service-role", {})).toEqual(["projectRef"]);
    expect(problems("stripe-webhook-secret", {})).toEqual(["url", "events"]);
    expect(problems("grafana-service-account-token", { baseUrl: "https://x.grafana.net", serviceAccountId: "7" })).toEqual(["serviceAccountId"]);
    expect(problems("resend-api-key", {})).toEqual(["domainId"]);
    expect(problems("resend-api-key", { permission: "full_access" })).toEqual([]);
    expect(problems("random-hex", { bytes: 4 })).toEqual(["bytes"]);
    expect(problems("random-hex", {})).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("cloudflare discover and preflight", () => {
  it("discovers accounts, zones, permission groups (with scope) and turnstile widgets read-only", async () => {
    const { fetch, calls } = cf();
    const p = get("cloudflare-token");
    expect((await p.discover!("cloudflare.account", dctx(fetch, ["cloudflare"]))).map((o) => o.value)).toEqual(["acc1"]);
    expect((await p.discover!("cloudflare.zone", dctx(fetch, ["cloudflare"], { accountId: "acc1" })))[0]).toMatchObject({ value: "z1", label: "wakemiles.com" });
    expect((await p.discover!("cloudflare.permissionGroups", dctx(fetch, ["cloudflare"]))).map((o) => [o.value, o.detail])).toEqual([["Workers Scripts Write", "account"], ["Account Settings Read", "account"], ["Workers Routes Write", "zone"]]);
    const t = get("cloudflare-turnstile");
    expect((await t.discover!("cloudflare.turnstileWidget", dctx(fetch, ["cloudflare-turnstile"], { accountId: "acc1" })))[0]).toMatchObject({ value: "0xAAA" });
    await expect(t.discover!("cloudflare.turnstileWidget", dctx(fetch, ["cloudflare-turnstile"]))).rejects.toBeInstanceOf(ParamsInvalidError);
    await expect(p.discover!("nope", dctx(fetch, ["cloudflare"]))).rejects.toBeInstanceOf(UnknownDiscoverKindError);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("preflight: account belongs to the token, permissions exist, zone-bound permissions need a zone", async () => {
    const { fetch } = cf();
    const p = cloudflareProviders[0]!;
    const ok = await p.preflight!(pctx(fetch, ["cloudflare"], { accountId: "acc1", permissions: ["Workers Scripts Write"] }));
    expect(ok.resource).toBe("Cloudflare-Konto Pineflight (acc1)");
    expect(ok.findings.every((f) => f.level === "ok")).toBe(true);
    const wrong = await p.preflight!(pctx(fetch, ["cloudflare"], { accountId: "other", permissions: ["Nope"] }));
    expect(wrong.findings.filter((f) => f.level === "fail").map((f) => f.id)).toEqual(["account", "permissions"]);
    const zone = await p.preflight!(pctx(fetch, ["cloudflare"], { accountId: "acc1", permissions: ["Workers Routes Write"] }));
    expect(zone.findings.find((f) => f.id === "zone")).toMatchObject({ level: "fail" });
    const withZone = await p.preflight!(pctx(fetch, ["cloudflare"], { accountId: "acc1", zoneId: "z1", permissions: ["Workers Routes Write"] }));
    expect(withZone.resource).toContain("Zone wakemiles.com");
  });
  it("a token that may not read accounts gives a warning, not a failure", async () => {
    const { fetch } = routeFetch({ url: "/accounts", reply: { status: 403, body: { errors: [] } } }, { url: "/permission_groups", reply: { body: GROUPS } });
    const r = await cloudflareProviders[0]!.preflight!(pctx(fetch, ["cloudflare"], { accountId: "acc1", permissions: ["Workers Scripts Write"] }));
    expect(r.findings.find((f) => f.id === "read")).toMatchObject({ level: "warn" });
    expect(r.findings.some((f) => f.level === "fail")).toBe(false);
  });
  it("issue puts zone-bound permissions into a separate zone policy and demands zoneId", async () => {
    const issued = routeFetch(
      { url: "/user/tokens/permission_groups", reply: { body: GROUPS } },
      { method: "POST", url: "/user/tokens", reply: { body: { result: { id: "t1", value: "VALUE-NEW-TOKEN-1234567890" } } } },
    );
    const ctx = (params: Record<string, unknown>) => ({ secret: secretEntry(), params, stage: "staging", connections: connections("cloudflare"), fetch: issued.fetch, now: new Date("2026-11-01T10:00:00Z"), label: "x" });
    await expect(cloudflareProviders[0]!.issue!(ctx({ accountId: "acc1", permissions: ["Workers Scripts Write", "Workers Routes Write"] }))).rejects.toBeInstanceOf(ParamsInvalidError);
    await cloudflareProviders[0]!.issue!(ctx({ accountId: "acc1", zoneId: "z1", permissions: ["Workers Scripts Write", "Workers Routes Write"] }));
    const body = JSON.parse(issued.calls.find((c) => c.method === "POST")!.body!) as { policies: { resources: Record<string, string>; permission_groups: { id: string }[] }[] };
    expect(body.policies.map((p) => Object.keys(p.resources)[0])).toEqual(["com.cloudflare.api.account.acc1", "com.cloudflare.api.account.zone.z1"]);
    expect(body.policies[1]!.permission_groups).toEqual([{ id: "g3" }]);
  });
});

describe("supabase discover and preflight", () => {
  const projects = () => routeFetch({ url: "/v1/projects", reply: { body: [{ id: "abc", name: "wake-miles-staging", region: "eu-west-1" }, { id: "def", name: "wake-miles-production" }] } });
  it("lists projects and checks the ref (and warns when the name contradicts the stage)", async () => {
    const { fetch } = projects();
    const p = supabaseProviders[0]!;
    expect((await p.discover!("supabase.project", dctx(fetch, ["supabase"]))).map((o) => o.value)).toEqual(["abc", "def"]);
    const ok = await p.preflight!(pctx(fetch, ["supabase"], { projectRef: "abc" }));
    expect(ok.resource).toBe("Supabase-Projekt wake-miles-staging (ref abc)");
    expect(ok.findings.every((f) => f.level === "ok")).toBe(true);
    const prodForStaging = await p.preflight!(pctx(fetch, ["supabase"], { projectRef: "def" }));
    expect(prodForStaging.findings.find((f) => f.id === "stage")).toMatchObject({ level: "warn" });
    const missing = await p.preflight!(pctx(fetch, ["supabase"], { projectRef: "zzz" }));
    expect(missing.findings.find((f) => f.id === "project")).toMatchObject({ level: "fail" });
  });
  it("reads the public key only, never service_role or secret keys", async () => {
    const { fetch, calls } = routeFetch({ url: "/api-keys", reply: { body: [{ name: "service_role", type: "secret", api_key: "SERVICE-ROLE-VALUE" }, { name: "anon", type: "publishable", api_key: "PUBLIC-ANON-VALUE" }] } });
    const opt = { value: "abc", label: "wake-miles-staging" };
    expect(await readVariableField("supabase.project", "publishableKey", opt, { connections: connections("supabase"), fetch })).toBe("PUBLIC-ANON-VALUE");
    expect(calls[0]!.url).not.toContain("reveal");
    const only = routeFetch({ url: "/api-keys", reply: { body: [{ name: "service_role", type: "secret", api_key: "SERVICE-ROLE-VALUE" }] } });
    await expect(readVariableField("supabase.project", "publishableKey", opt, { connections: connections("supabase"), fetch: only.fetch })).rejects.toThrow();
    await expect(readVariableField("supabase.project", "serviceRole", opt, { connections: connections("supabase"), fetch })).rejects.toThrow();
    expect(await readVariableField("supabase.project", "url", opt, { connections: connections("supabase"), fetch })).toBe("https://abc.supabase.co");
  });
});

describe("resend discover and preflight", () => {
  const domains = () => routeFetch({ url: "/domains", reply: { body: { data: [{ id: "d1", name: "wakemiles.com", status: "verified" }, { id: "d2", name: "pineflight.com", status: "pending" }] } } });
  it("lists domains with status; the preflight names the domain and warns when not verified", async () => {
    const { fetch } = domains();
    expect((await resendProvider.discover!("resend.domain", dctx(fetch, ["resend"])))[1]).toMatchObject({ value: "d2", label: "pineflight.com", detail: "pending, d2" });
    const ok = await resendProvider.preflight!(pctx(fetch, ["resend"], { permission: "sending_access", domainId: "d1" }));
    expect(ok.resource).toBe("Key nur fuer Domain wakemiles.com");
    expect(ok.findings.every((f) => f.level === "ok")).toBe(true);
    const pending = await resendProvider.preflight!(pctx(fetch, ["resend"], { domainId: "d2" }));
    expect(pending.findings.find((f) => f.id === "verified")).toMatchObject({ level: "warn" });
    expect((await resendProvider.preflight!(pctx(fetch, ["resend"], { domainId: "nope" }))).findings.some((f) => f.level === "fail")).toBe(true);
    const full = await resendProvider.preflight!(pctx(fetch, ["resend"], { permission: "full_access" }));
    expect(full.resource).toBe("Key mit vollem Zugriff (alle Domains)");
  });
});

describe("grafana discover and preflight", () => {
  it("checks the address, reachability and the service account", async () => {
    const { fetch } = routeFetch({ url: "/api/health", reply: { body: { database: "ok" } } }, { url: "/api/serviceaccounts/search", reply: { body: { serviceAccounts: [{ id: 7, name: "secret-desk", login: "sa-secret-desk", role: "Admin" }] } } });
    expect((await grafanaProvider.discover!("grafana.serviceAccount", dctx(fetch, ["grafana"], { baseUrl: "https://acme.grafana.net" })))[0]).toMatchObject({ value: 7, label: "secret-desk" });
    const ok = await grafanaProvider.preflight!(pctx(fetch, ["grafana"], { baseUrl: "https://acme.grafana.net", serviceAccountId: 7 }));
    expect(ok.resource).toBe("Grafana-Service-Account secret-desk (https://acme.grafana.net)");
    const bad = await grafanaProvider.preflight!(pctx(fetch, ["grafana"], { baseUrl: "https://evil.example.com", serviceAccountId: 7 }));
    expect(bad.findings[0]).toMatchObject({ level: "fail" });
    const gone = await grafanaProvider.preflight!(pctx(fetch, ["grafana"], { baseUrl: "https://acme.grafana.net", serviceAccountId: 99 }));
    expect(gone.findings.find((f) => f.id === "serviceAccount")).toMatchObject({ level: "fail" });
  });
});

describe("stripe", () => {
  it("declares url and events as required", () => {
    expect(stripeWebhookProvider.params!.filter((s) => s.required).map((s) => s.key)).toEqual(["url", "events"]);
    expect(CONN_TOKEN).toBeTruthy();
  });
});
