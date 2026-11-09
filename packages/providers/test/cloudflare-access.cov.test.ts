import { describe, expect, it } from "vitest";
import { ConnectionStore, NotConnectedError } from "@secret-desk/core";
import { cloudflareAccessProvider as provider } from "../src/cloudflare-access.js";
import { connections, issueCtx, revokeCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const BASE = "https://api.cloudflare.com/client/v4";
const HELPER = "HELPER-TOKEN-VALUE-0123456789";
const SECRET_VALUE = "made-up-client-secret-0123456789abcdef";
const GROUPS = { result: [{ id: "g-write", name: "Access: Service Tokens Write", scopes: ["com.cloudflare.api.account"] }] };
const params = { accountId: "acc1", clientIdTarget: "access-id", duration: "720h" };
const SVC = `${BASE}/accounts/acc1/access/service_tokens`;

const helperRoutes = (): Route[] => [
  { url: "/user/tokens/permission_groups", reply: { body: GROUPS } },
  { method: "POST", url: `${BASE}/user/tokens`, reply: { body: { result: { id: "helper-1", value: HELPER } } } },
  { method: "DELETE", url: `${BASE}/user/tokens/helper-1`, reply: { body: { result: { id: "helper-1" } } } },
];

function ctxWith(f: typeof fetch, p: Record<string, unknown>, externalId?: string) {
  const base = issueCtx(f, p, { conns: ["cloudflare"] });
  return externalId !== undefined ? { ...base, secret: { ...base.secret, externalId } } : base;
}

describe("cloudflare-access: unusual answers", () => {
  it("rejects a permission group list that is not a list", async () => {
    const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: { result: "nope" } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow("Unerwartete Antwort");
  });
  it("treats a permission group without scopes as account scoped", async () => {
    const m = routeFetch(
      { url: "/user/tokens/permission_groups", reply: { body: { result: [{ id: "g-write", name: "Access: Service Tokens Write" }] } } },
      ...helperRoutes().slice(1),
      { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: "cid", client_secret: SECRET_VALUE } } } },
    );
    expect((await provider.issue!(ctxWith(m.fetch, params))).externalId).toBe("svc-1");
  });
  it("fails on a helper token answer without an id and creates nothing else", async () => {
    const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: GROUPS } }, { method: "POST", url: `${BASE}/user/tokens`, reply: { body: { result: {} } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow("Unerwartete Antwort");
    expect(m.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("names the helper id when the helper answer has no value, and still deletes the helper", async () => {
    const m = routeFetch(helperRoutes()[0]!, { method: "POST", url: `${BASE}/user/tokens`, reply: { body: { result: { id: "helper-1" } } } }, helperRoutes()[2]!);
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow("Kennung helper-1");
    expect(m.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/user/tokens/helper-1"))).toBe(true);
  });
  it("fails when the new token answer has neither id nor values", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { client_id: "c", client_secret: "s" } } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow("Unerwartete Antwort");
    const none = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: {} } });
    await expect(provider.issue!(ctxWith(none.fetch, params))).rejects.toThrow("Unerwartete Antwort");
  });
  it("names an orphan when only the client id is missing", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-7", client_secret: SECRET_VALUE } } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow("Kennung svc-7");
  });
  it("derives the expiry only from hour durations", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: "cid", client_secret: SECRET_VALUE } } } });
    expect((await provider.issue!(ctxWith(m.fetch, { ...params, duration: "30d" }))).expiresAt).toBeNull();
  });
  it("ignores a blank duration and uses the default", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: "cid", client_secret: SECRET_VALUE } } } });
    await provider.issue!(ctxWith(m.fetch, { ...params, duration: "" }));
    expect(JSON.parse(m.calls.find((c) => c.url === SVC)!.body!).duration).toBe("8760h");
  });
});

describe("cloudflare-access: existing token edge cases", () => {
  const exists = { url: `${SVC}/svc-old`, reply: { body: { result: { id: "svc-old" } } } } satisfies Route;
  const renew = (reply: Route["reply"]): Route => ({ method: "POST", url: `${SVC}/svc-old/rotate`, reply });
  it("fails when the renewal answer has no secret", async () => {
    const m = routeFetch(...helperRoutes(), exists, renew({ body: { result: {} } }));
    await expect(provider.issue!(ctxWith(m.fetch, params, "svc-old"))).rejects.toThrow("Unerwartete Antwort");
    const empty = routeFetch(...helperRoutes(), exists, renew({ body: {} }));
    await expect(provider.issue!(ctxWith(empty.fetch, params, "svc-old"))).rejects.toThrow("Unerwartete Antwort");
  });
  it("derives the expiry of a renewal from the duration; forever has none", async () => {
    const reply = { body: { result: { client_secret: SECRET_VALUE } } };
    const m = routeFetch(...helperRoutes(), exists, renew(reply));
    expect((await provider.issue!(ctxWith(m.fetch, params, "svc-old"))).expiresAt).toBe("2026-12-01T10:00:00Z");
    const forever = routeFetch(...helperRoutes(), exists, renew(reply));
    expect((await provider.issue!(ctxWith(forever.fetch, { ...params, duration: "forever" }, "svc-old"))).expiresAt).toBeNull();
  });
  it("creates a new token for an empty external id", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-2", client_id: "cid", client_secret: SECRET_VALUE } } } });
    expect((await provider.issue!(ctxWith(m.fetch, params, ""))).externalId).toBe("svc-2");
    expect(m.calls.some((c) => c.url.includes("/svc-old"))).toBe(false);
  });
  it("lets a non-404 error of the existence check through (and still deletes the helper)", async () => {
    const m = routeFetch(...helperRoutes(), { url: `${SVC}/svc-old`, reply: { status: 500, body: "boom" } });
    await expect(provider.issue!(ctxWith(m.fetch, params, "svc-old"))).rejects.toThrow("HTTP 500");
    expect(m.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/helper-1"))).toBe(true);
  });
});

describe("cloudflare-access: discover, preflight, verify", () => {
  it("discovers accounts through the shared Cloudflare discovery", async () => {
    const m = routeFetch({ url: "/accounts?per_page", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } });
    const opts = await provider.discover!("cloudflare.account", { connections: connections("cloudflare"), fetch: m.fetch, params: {}, hint: { repos: [] } });
    expect(opts.map((o) => o.value)).toEqual(["acc1"]);
  });
  const pctx = (f: typeof fetch, conns: ConnectionStore) => ({ secret: secretEntry(), params, stage: "dev" as const, connections: conns, fetch: f });
  const failFrom = (store: ConnectionStore, nth: number, thrown: unknown) => {
    let calls = 0;
    const real = store.token.bind(store);
    store.token = (async (id: string) => {
      if (++calls >= nth) throw thrown;
      return real(id);
    }) as typeof store.token;
    return store;
  };
  const accounts = () => routeFetch({ url: "/accounts?per_page", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } });
  it("preflight rethrows a missing connection instead of reporting a failed helper check", async () => {
    const m = accounts();
    const store = failFrom(connections("cloudflare"), 2, new NotConnectedError("cloudflare"));
    await expect(provider.preflight!(pctx(m.fetch, store))).rejects.toThrow(NotConnectedError);
  });
  it("preflight reports a non-Error failure of the helper check as a generic message", async () => {
    const m = accounts();
    const store = failFrom(connections("cloudflare"), 2, "plain string");
    const r = await provider.preflight!(pctx(m.fetch, store));
    expect(r.findings.find((f) => f.id === "helper-token")).toMatchObject({ level: "fail", detail: "Fehler" });
  });
  it("verify: no stored external id means a new token; forever shows as unlimited, other durations as given", async () => {
    const f = routeFetch().fetch;
    const none = await provider.verify!(verifyCtx(f, { ...params, duration: "forever" }, { value: SECRET_VALUE }));
    expect(none.find((c) => c.id === "mode")).toMatchObject({ status: "info" });
    expect(none.find((c) => c.id === "duration")!.actual).toBe("unbegrenzt");
    const timed = await provider.verify!(verifyCtx(f, params, { value: SECRET_VALUE, externalId: "x" }));
    expect(timed.find((c) => c.id === "duration")!.actual).toBe("720h");
  });
  it("checklist works without a client id target", () => {
    expect(provider.reviewChecklist!(secretEntry())[1]).toBe("Die Client-ID geht an den vorgesehenen Eintrag");
  });
  it("revoke surfaces a failed delete other than 404", async () => {
    const m = routeFetch(...helperRoutes(), { method: "DELETE", url: `${SVC}/svc-1`, reply: { status: 500, body: "boom" } });
    await expect(provider.revoke!(revokeCtx(m.fetch, { accountId: "acc1" }, "svc-1", ["cloudflare"]))).rejects.toThrow("HTTP 500");
  });
});
