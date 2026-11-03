import { describe, expect, it } from "vitest";
import { cloudflareAccessProvider as provider } from "../src/cloudflare-access.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, connections, issueCtx, revokeCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const BASE = "https://api.cloudflare.com/client/v4";
const HELPER = "HELPER-TOKEN-VALUE-0123456789";
const CLIENT_ID = "made-up-client-id.access";
const CLIENT_SECRET = "made-up-client-secret-0123456789abcdef";
const GROUPS = { result: [{ id: "g-read", name: "Access: Service Tokens Read", scopes: ["com.cloudflare.api.account"] }, { id: "g-write", name: "Access: Service Tokens Write", scopes: ["com.cloudflare.api.account"] }] };
const params = { accountId: "acc1", clientIdTarget: "access-id", duration: "720h" };
const SVC = `${BASE}/accounts/acc1/access/service_tokens`;

const helperRoutes = (): Route[] => [
  { url: "/user/tokens/permission_groups", reply: { body: GROUPS } },
  { method: "POST", url: `${BASE}/user/tokens`, reply: { body: { result: { id: "helper-1", value: HELPER } } } },
  { method: "DELETE", url: `${BASE}/user/tokens/helper-1`, reply: { body: { result: { id: "helper-1" } } } },
];

function ctxWith(f: typeof fetch, p: Record<string, unknown>, externalId?: string) {
  const base = issueCtx(f, p, { conns: ["cloudflare"] });
  return externalId ? { ...base, secret: secretEntry({ externalId }) } : base;
}

describe("cloudflare-access-service-token", () => {
  it("creates a service token through a short-lived helper token and returns the client ID as companion", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, expires_at: "2026-12-01T10:00:00Z" } } } });
    const r = await provider.issue!(ctxWith(m.fetch, params));
    expect(r.value.reveal()).toBe(CLIENT_SECRET);
    expect(r.externalId).toBe("svc-1");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
    expect(r.companions).toHaveLength(1);
    expect(r.companions![0]!.entryId).toBe("access-id");
    expect(r.companions![0]!.value.reveal()).toBe(CLIENT_ID);

    const helperCreate = m.calls.find((c) => c.method === "POST" && c.url === `${BASE}/user/tokens`)!;
    expect(helperCreate.headers.Authorization).toBe(`Bearer ${CONN_TOKEN}`);
    expect(JSON.parse(helperCreate.body!)).toEqual({
      name: "test-secret-2026-11-01-helper",
      policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acc1": "*" }, permission_groups: [{ id: "g-write" }] }],
      expires_on: "2026-11-01T10:10:00Z",
    });
    const access = m.calls.find((c) => c.url === SVC)!;
    expect(access.headers.Authorization).toBe(`Bearer ${HELPER}`);
    expect(JSON.parse(access.body!)).toEqual({ name: "test-secret-2026-11-01", duration: "720h" });
    // the helper is gone again, and only the connection token ever deletes it
    const del = m.calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe(`${BASE}/user/tokens/helper-1`);
    expect(del.headers.Authorization).toBe(`Bearer ${CONN_TOKEN}`);
  });

  it("falls back to the Edit permission name and defaults the duration", async () => {
    const m = routeFetch(
      { url: "/user/tokens/permission_groups", reply: { body: { result: [{ id: "g-edit", name: "Access: Service Tokens Edit", scopes: ["com.cloudflare.api.account"] }] } } },
      ...helperRoutes().slice(1),
      { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET } } } },
    );
    const r = await provider.issue!(ctxWith(m.fetch, { accountId: "acc1", clientIdTarget: "access-id" }));
    expect(JSON.parse(m.calls.find((c) => c.url === `${BASE}/user/tokens` && c.method === "POST")!.body!).policies[0].permission_groups).toEqual([{ id: "g-edit" }]);
    expect(JSON.parse(m.calls.find((c) => c.url === SVC)!.body!).duration).toBe("8760h");
    // no expires_at in the answer: derived from the duration
    expect(r.expiresAt).toBe("2027-11-01T10:00:00Z");
  });

  it("sends no expiry for forever", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET } } } });
    const r = await provider.issue!(ctxWith(m.fetch, { ...params, duration: "forever" }));
    expect(r.expiresAt).toBeNull();
  });

  it("rotates the secret of the existing token and leaves the client ID alone", async () => {
    const m = routeFetch(...helperRoutes(), { url: `${SVC}/svc-old`, reply: { body: { result: { id: "svc-old" } } } }, { method: "POST", url: `${SVC}/svc-old/rotate`, reply: { body: { result: { id: "svc-old", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, expires_at: "2027-01-01T00:00:00Z" } } } });
    const r = await provider.issue!(ctxWith(m.fetch, params, "svc-old"));
    expect(r.externalId).toBe("svc-old");
    expect(r.companions).toBeUndefined();
    expect(r.value.reveal()).toBe(CLIENT_SECRET);
    expect(m.calls.some((c) => c.url === SVC && c.method === "POST")).toBe(false);
    expect(m.calls.find((c) => c.method === "DELETE")!.url).toBe(`${BASE}/user/tokens/helper-1`);
  });

  it("creates a new token when the old one is gone at Cloudflare", async () => {
    const m = routeFetch(...helperRoutes(), { url: `${SVC}/svc-old`, reply: { status: 404, body: "not found" } }, { method: "POST", url: SVC, reply: { body: { result: { id: "svc-2", client_id: CLIENT_ID, client_secret: CLIENT_SECRET } } } });
    const r = await provider.issue!(ctxWith(m.fetch, params, "svc-old"));
    expect(r.externalId).toBe("svc-2");
    expect(r.companions).toHaveLength(1);
    expect(m.calls.some((c) => c.url.endsWith("/rotate"))).toBe(false);
  });

  it("deletes the helper token when the Access call fails and keeps values out of the error", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { status: 403, body: JSON.stringify({ message: `denied ${HELPER} ${CONN_TOKEN}`, client_secret: CLIENT_SECRET }) } });
    const err = await provider.issue!(ctxWith(m.fetch, params)).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(403);
    for (const bad of [HELPER, CONN_TOKEN, CLIENT_SECRET]) expect(err.message).not.toContain(bad);
    expect(m.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${BASE}/user/tokens/helper-1`]);
  });

  it("still returns the issued values when deleting the helper fails (it expires within minutes)", async () => {
    const m = routeFetch(
      ...helperRoutes().filter((r) => r.method !== "DELETE"),
      { method: "DELETE", url: "/user/tokens/helper-1", reply: { status: 500, body: "boom" } },
      { method: "POST", url: SVC, reply: { body: { result: { id: "svc-1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET } } } },
    );
    const r = await provider.issue!(ctxWith(m.fetch, params));
    expect(r.externalId).toBe("svc-1");
  });

  it("names a possibly orphaned service token when the values are missing", async () => {
    const m = routeFetch(...helperRoutes(), { method: "POST", url: SVC, reply: { body: { result: { id: "svc-9" } } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow(/svc-9/);
    expect(m.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("fails clearly without the permission group and creates nothing", async () => {
    const m = routeFetch({ url: "/user/tokens/permission_groups", reply: { body: { result: [{ id: "x", name: "Something Else", scopes: ["com.cloudflare.api.account"] }] } } });
    await expect(provider.issue!(ctxWith(m.fetch, params))).rejects.toThrow(/Service Tokens Write/);
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("revokes by deleting the service token through a helper token; an already deleted token counts as revoked", async () => {
    const m = routeFetch(...helperRoutes(), { method: "DELETE", url: `${SVC}/svc-1`, reply: { body: { result: { id: "svc-1" } } } });
    const rc = revokeCtx(m.fetch, { accountId: "acc1" }, "svc-1", ["cloudflare"]);
    await provider.revoke!(rc);
    const call = m.calls.find((c) => c.url === `${SVC}/svc-1`)!;
    expect(call.method).toBe("DELETE");
    expect(call.headers.Authorization).toBe(`Bearer ${HELPER}`);
    const gone = routeFetch(...helperRoutes(), { method: "DELETE", url: `${SVC}/svc-1`, reply: { status: 404, body: "gone" } });
    await expect(provider.revoke!(revokeCtx(gone.fetch, { accountId: "acc1" }, "svc-1", ["cloudflare"]))).resolves.toBeUndefined();
  });

  it("preflight checks the helper-token permission without creating a token", async () => {
    const m = routeFetch({ url: "/accounts?per_page", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } }, { url: "/user/tokens/permission_groups", reply: { body: GROUPS } });
    const r = await provider.preflight!({ secret: secretEntry(), params, stage: "dev", connections: connections("cloudflare"), fetch: m.fetch });
    expect(r.findings.map((f) => `${f.id}:${f.level}`)).toEqual(["account:ok", "helper-token:ok"]);
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
    const bad = routeFetch({ url: "/accounts?per_page", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } }, { url: "/user/tokens/permission_groups", reply: { status: 403, body: "no" } });
    const r2 = await provider.preflight!({ secret: secretEntry(), params, stage: "dev", connections: connections("cloudflare"), fetch: bad.fetch });
    expect(r2.findings.find((f) => f.id === "helper-token")!.level).toBe("fail");
  });

  it("the plan names rotation or a new token, and no check holds a value", async () => {
    const f = routeFetch().fetch;
    const rotated = await provider.verify!({ ...verifyCtx(f, params, { externalId: "svc-old", value: CLIENT_SECRET }), secret: secretEntry({ externalId: "svc-old" }) });
    expect(rotated.find((c) => c.id === "mode")).toMatchObject({ status: "warn" });
    const fresh = await provider.verify!({ ...verifyCtx(f, params, { externalId: "svc-new", value: CLIENT_SECRET }), secret: secretEntry({ externalId: "svc-old" }) });
    expect(fresh.find((c) => c.id === "mode")).toMatchObject({ status: "info" });
    const s = JSON.stringify([rotated, fresh, provider.reviewChecklist!(secretEntry({ params }))]);
    for (const bad of [CLIENT_SECRET, CONN_TOKEN, HELPER]) expect(s).not.toContain(bad);
  });

  it("declares the companion parameter and requires it", () => {
    expect(provider.companionParams).toEqual(["clientIdTarget"]);
    expect(provider.params!.find((p) => p.key === "clientIdTarget")!.required).toBe(true);
    expect(provider.params!.find((p) => p.key === "duration")!.options!.map((o) => o.value)).toEqual(["8760h", "720h", "2160h", "forever"]);
  });
});
