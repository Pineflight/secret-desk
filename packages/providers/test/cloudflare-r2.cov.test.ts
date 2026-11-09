import { afterEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError } from "@secret-desk/core";
import { cloudflareR2Provider as provider } from "../src/cloudflare-r2.js";
import { connections, issueCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const BASE = "https://api.cloudflare.com/client/v4";
const TOKENS = `${BASE}/user/tokens`;
const GROUPS = {
  result: [
    { id: "g-r", name: "Workers R2 Storage Bucket Item Read" },
    { id: "g-w", name: "Workers R2 Storage Bucket Item Write" },
    { id: "g-ar", name: "Workers R2 Storage Read" },
    { id: "g-aw", name: "Workers R2 Storage Write" },
  ],
};
const params = { accountId: "acc1", access: "write", buckets: ["app-data"], value: "secretAccessKey", companionEntry: "r2-key-id" };
const issue = (f: typeof fetch, p: Record<string, unknown>) => provider.issue!(issueCtx(f, p, { conns: ["cloudflare"] }));
const groupsRoute: Route = { url: "/tokens/permission_groups", reply: { body: GROUPS } };

afterEach(() => {
  vi.useRealTimers();
});

describe("cloudflare-r2: parameter validation on issue", () => {
  it("rejects an unknown access level, jurisdiction and value half before any call", async () => {
    const m = routeFetch(groupsRoute);
    await expect(issue(m.fetch, { ...params, access: "root" })).rejects.toThrow('Parameter "access" muss read, write oder admin sein');
    await expect(issue(m.fetch, { ...params, jurisdiction: "mars" })).rejects.toThrow('Parameter "jurisdiction" muss default, eu oder fedramp sein');
    await expect(issue(m.fetch, { ...params, value: "both" })).rejects.toThrow('Parameter "value" muss accessKeyId oder secretAccessKey sein');
    expect(m.calls).toHaveLength(0);
  });
});

describe("cloudflare-r2: permission groups and resources", () => {
  it("rejects a permission group answer that is not a list", async () => {
    const m = routeFetch({ url: "/tokens/permission_groups", reply: { body: { result: {} } } });
    await expect(issue(m.fetch, params)).rejects.toThrow("Unerwartete Antwort");
    const none = routeFetch({ url: "/tokens/permission_groups", reply: { body: {} } });
    await expect(issue(none.fetch, params)).rejects.toThrow("Unerwartete Antwort");
  });
  it("keeps the first id of a duplicated group name and ignores malformed entries", async () => {
    const m = routeFetch(
      { url: "/tokens/permission_groups", reply: { body: { result: [{ id: "dup-1", name: "Workers R2 Storage Bucket Item Read" }, { id: "dup-2", name: "Workers R2 Storage Bucket Item Read" }, { name: 5, id: "x" }, { name: "No Id" }, { id: "g-w", name: "Workers R2 Storage Bucket Item Write" }] } } },
      { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok1", value: "v-0123456789" } } } },
    );
    await issue(m.fetch, params);
    const body = JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
    expect(body.policies[0].permission_groups).toEqual([{ id: "dup-1" }, { id: "g-w" }]);
  });
  it("scopes the token to the whole account when no bucket is named", async () => {
    const m = routeFetch(groupsRoute, { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok1", value: "v-0123456789" } } } });
    await issue(m.fetch, { ...params, buckets: undefined });
    expect(JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).policies[0].resources).toEqual({ "com.cloudflare.api.account.acc1": "*" });
  });
  it("scopes an admin token to the account", async () => {
    const m = routeFetch(groupsRoute, { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok1", value: "v-0123456789" } } } });
    await issue(m.fetch, { ...params, access: "admin", buckets: [] });
    expect(JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).policies[0].resources).toEqual({ "com.cloudflare.api.account.acc1": "*" });
  });
  it("fails on an answer with a value but no id, or with no result at all", async () => {
    const noId = routeFetch(groupsRoute, { method: "POST", url: TOKENS, reply: { body: { result: { value: "v-0123456789" } } } });
    await expect(issue(noId.fetch, params)).rejects.toThrow("Unerwartete Antwort");
    const empty = routeFetch(groupsRoute, { method: "POST", url: TOKENS, reply: { body: {} } });
    await expect(issue(empty.fetch, params)).rejects.toThrow("Unerwartete Antwort");
  });
  it("uses the expiry Cloudflare returns over the requested one", async () => {
    const m = routeFetch(groupsRoute, { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok1", value: "v-0123456789", expires_on: "2027-02-02T00:00:00Z" } } } });
    expect((await issue(m.fetch, params)).expiresAt).toBe("2027-02-02T00:00:00Z");
  });
});

describe("cloudflare-r2: discover and preflight", () => {
  const pctx = (f: typeof fetch, p: Record<string, unknown>, conns = connections("cloudflare")) => ({ connections: conns, fetch: f, params: p, hint: { repos: [] as string[] } }) as never;
  const accounts: Route = { url: "/accounts?", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } };
  it("discovers accounts through the shared Cloudflare discovery", async () => {
    const m = routeFetch(accounts);
    const opts = await provider.discover!("cloudflare.account", { connections: connections("cloudflare"), fetch: m.fetch, params: {}, hint: { repos: [] } });
    expect(opts.map((o) => o.value)).toEqual(["acc1"]);
  });
  it("preflight is ok when every permission group exists and admin has no buckets", async () => {
    const m = routeFetch(accounts, groupsRoute);
    const r = await provider.preflight!(pctx(m.fetch, { ...params, access: "admin", buckets: [] }));
    expect(r.findings.find((f) => f.id === "permissions")).toMatchObject({ level: "ok", label: "Alle R2-Berechtigungsgruppen existieren" });
    expect(r.findings.some((f) => f.id === "buckets")).toBe(false);
  });
  it("preflight reports an invalid access parameter as unreadable permission groups", async () => {
    const m = routeFetch(accounts);
    const r = await provider.preflight!(pctx(m.fetch, { ...params, access: "root" }));
    expect(r.findings.find((f) => f.id === "permissions")).toMatchObject({ level: "fail", label: "Die R2-Berechtigungsgruppen sind nicht lesbar" });
  });
  it("preflight reports a non-Error failure generically and rethrows a missing connection", async () => {
    const m = routeFetch(accounts, groupsRoute);
    const fail = (thrown: unknown) => {
      const store = connections("cloudflare");
      let calls = 0;
      const real = store.token.bind(store);
      store.token = (async (id: string) => {
        if (++calls >= 2) throw thrown;
        return real(id);
      }) as typeof store.token;
      return store;
    };
    const r = await provider.preflight!(pctx(m.fetch, params, fail("boom")));
    expect(r.findings.find((f) => f.id === "permissions")).toMatchObject({ level: "fail", detail: "Fehler" });
    await expect(provider.preflight!(pctx(m.fetch, params, fail(new NotConnectedError("cloudflare"))))).rejects.toThrow(NotConnectedError);
  });
});

describe("cloudflare-r2: verify", () => {
  const run = (f: typeof fetch, p: Record<string, unknown>, opts: Parameters<typeof verifyCtx>[2] = {}) => provider.verify!(verifyCtx(f, p, { conns: ["cloudflare"], ...opts }));
  const statusOf = (checks: { id: string; status: string }[], id: string) => checks.find((c) => c.id === id)?.status;

  it("warns on both checks when the account id and token id are missing or not text", async () => {
    const m = routeFetch();
    const checks = await run(m.fetch, { ...params, accountId: 7, value: 3 });
    expect(checks.map((c) => `${c.id}:${c.status}`)).toEqual(["token:warn", "s3:warn"]);
    expect(m.calls).toHaveLength(0);
    const noToken = await run(m.fetch, params, {});
    expect(statusOf(noToken, "token")).toBe("warn");
    expect(statusOf(noToken, "s3")).toBe("info");
  });
  it("warns when the token cannot be read", async () => {
    const m = routeFetch({ url: `${TOKENS}/tok1`, reply: { status: 500, body: "x" } });
    const checks = await run(m.fetch, params, { externalId: "tok1" });
    expect(checks.find((c) => c.id === "token")).toMatchObject({ status: "warn", detail: "Token konnte nicht gelesen werden (HTTP 500)" });
    const noResult = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: "x" } } });
    expect(statusOf(await run(noResult.fetch, params, { externalId: "tok1" }), "token")).toBe("warn");
    const notRecord = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: [] } });
    expect(statusOf(await run(notRecord.fetch, params, { externalId: "tok1" }), "token")).toBe("warn");
  });
  it("fails an inactive token and reports an unknown status", async () => {
    const off = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: "disabled" } } } });
    expect(await run(off.fetch, { ...params, buckets: [] }, { externalId: "tok1" })).toContainEqual(expect.objectContaining({ id: "token", status: "fail", actual: "disabled" }));
    const unknown = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: 5 } } } });
    expect(await run(unknown.fetch, { ...params, buckets: [] }, { externalId: "tok1" })).toContainEqual(expect.objectContaining({ id: "token", status: "fail", actual: "unbekannt" }));
  });
  it("retries the S3 check with growing pauses and fails after the last 401", async () => {
    vi.useFakeTimers();
    const m = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: "active" } } } }, { url: "r2.cloudflarestorage.com", reply: { status: 401, body: "<Error/>" } });
    const pending = run(m.fetch, params, { externalId: "tok1", value: "s" });
    await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 12_000);
    const checks = await pending;
    expect(checks.find((c) => c.id === "s3")).toMatchObject({ status: "fail", actual: "HTTP 401" });
    expect(m.calls.filter((c) => c.url.includes("r2.cloudflarestorage.com"))).toHaveLength(4);
  });
  it("signs with the wall clock when the context has no usable now", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T10:00:00Z") });
    const m = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: "active" } } } }, { url: "r2.cloudflarestorage.com", reply: { status: 200, body: "<ListBucketResult/>" } });
    const ctx = { ...verifyCtx(m.fetch, params, { conns: ["cloudflare"], externalId: "tok1", value: "s" }), now: undefined as never };
    const checks = await provider.verify!(ctx);
    expect(checks.find((c) => c.id === "s3")!.status).toBe("pass");
    expect(m.calls.find((c) => c.url.includes("r2.cloudflarestorage.com"))!.headers["x-amz-date"]).toBe("20261101T100000Z");
  });
});

describe("cloudflare-r2: review checklist", () => {
  it("names access, buckets and the other half when set", () => {
    const list = provider.reviewChecklist!(secretEntry({ ttlDays: 7, params }));
    expect(list).toContain("Zugriff ist write");
    expect(list).toContain("Nur diese Buckets sind freigegeben: app-data");
    expect(list).toContain("Die andere Haelfte des Schluesselpaars geht an den Eintrag r2-key-id und an keinen anderen");
    expect(list).toContain("Ablauf ist 7 Tage nach heute");
  });
  it("falls back to generic lines, and says so for admin on the whole account", () => {
    const generic = provider.reviewChecklist!(secretEntry());
    expect(generic).toContain("Zugriff entspricht dem, was der Dienst braucht");
    expect(generic).toContain("Der Schluessel gilt fuer alle Buckets des Kontos");
    expect(generic).toContain("Die andere Haelfte geht an den vorgesehenen Eintrag");
    expect(generic).toContain("Ablauf ist 90 Tage nach heute");
    expect(provider.reviewChecklist!(secretEntry({ params: { access: "admin" } }))).toContain("Der Schluessel gilt fuer das ganze Konto (admin)");
  });
});
