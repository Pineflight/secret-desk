import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloudflareR2Provider as provider, deriveS3Credentials, R2_PERMISSIONS } from "../src/cloudflare-r2.js";
import { validateEntryParams } from "@secret-desk/core";
import { CONN_TOKEN, connections, issueCtx, revokeCtx, routeFetch, verifyCtx, type Route } from "./helpers.js";

const BASE = "https://api.cloudflare.com/client/v4";
const TOKENS = `${BASE}/user/tokens`;
const TOKEN_VALUE = "made-up-token-value-0123456789";
const GROUPS = {
  result: [
    { id: "g-r", name: "Workers R2 Storage Bucket Item Read" },
    { id: "g-w", name: "Workers R2 Storage Bucket Item Write" },
    { id: "g-ar", name: "Workers R2 Storage Read" },
    { id: "g-aw", name: "Workers R2 Storage Write" },
  ],
};
const params = { accountId: "acc1", access: "write", buckets: ["app-data"], value: "secretAccessKey", companionEntry: "r2-key-id" };
const routes = (): Route[] => [
  { url: "/tokens/permission_groups", reply: { body: GROUPS } },
  { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok1", value: TOKEN_VALUE } } } },
];
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("cloudflare-r2-credentials", () => {
  it("derives the S3 key pair like Cloudflare documents it (id = token id, secret = SHA-256 hex of the value)", () => {
    expect(deriveS3Credentials("tok1", "abc")).toEqual({ accessKeyId: "tok1", secretAccessKey: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });

  it("creates a user token for the named buckets and returns both halves", async () => {
    const m = routeFetch(...routes());
    const r = await provider.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }));
    const create = m.calls.find((c) => c.method === "POST")!;
    expect(create.headers.Authorization).toBe(`Bearer ${CONN_TOKEN}`);
    expect(JSON.parse(create.body!)).toEqual({
      name: "test-secret-2026-11-01",
      policies: [{ effect: "allow", resources: { "com.cloudflare.edge.r2.bucket.acc1_default_app-data": "*" }, permission_groups: [{ id: "g-r" }, { id: "g-w" }] }],
      expires_on: "2027-01-30T10:00:00Z",
    });
    expect(r.value.reveal()).toBe(sha(TOKEN_VALUE));
    expect(r.externalId).toBe("tok1");
    expect(r.companions).toHaveLength(1);
    expect(r.companions![0]!.entryId).toBe("r2-key-id");
    expect(r.companions![0]!.value.reveal()).toBe("tok1");
    expect(r.expiresAt).toBe("2027-01-30T10:00:00Z");
  });

  it("swaps the halves when the entry holds the access key id", async () => {
    const m = routeFetch(...routes());
    const r = await provider.issue!(issueCtx(m.fetch, { ...params, value: "accessKeyId", companionEntry: "r2-secret" }, { conns: ["cloudflare"] }));
    expect(r.value.reveal()).toBe("tok1");
    expect(r.companions![0]).toMatchObject({ entryId: "r2-secret" });
    expect(r.companions![0]!.value.reveal()).toBe(sha(TOKEN_VALUE));
  });

  it("fills the expiry from ttlDays, defaulting to 90 days", async () => {
    const m = routeFetch(...routes());
    await provider.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"], ttlDays: 30 }));
    expect(JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).expires_on).toBe("2026-12-01T10:00:00Z");
    const d = routeFetch(...routes());
    await provider.issue!(issueCtx(d.fetch, params, { conns: ["cloudflare"] }));
    expect(JSON.parse(d.calls.find((c) => c.method === "POST")!.body!).expires_on).toBe("2027-01-30T10:00:00Z");
  });

  it.each([
    ["read", ["g-r"], undefined],
    ["write", ["g-r", "g-w"], undefined],
    ["admin", ["g-ar", "g-aw"], undefined],
  ] as const)("access %s without buckets covers the account", async (access, ids) => {
    const m = routeFetch(...routes());
    await provider.issue!(issueCtx(m.fetch, { accountId: "acc1", access, value: "secretAccessKey", companionEntry: "k" }, { conns: ["cloudflare"] }));
    const body = JSON.parse(m.calls.find((c) => c.method === "POST")!.body!);
    expect(body.policies[0].resources).toEqual({ "com.cloudflare.api.account.acc1": "*" });
    expect(body.policies[0].permission_groups).toEqual(ids.map((id) => ({ id })));
    expect(R2_PERMISSIONS[access].length).toBe(ids.length);
  });

  it("scopes several buckets and honours the jurisdiction", async () => {
    const m = routeFetch(...routes());
    await provider.issue!(issueCtx(m.fetch, { ...params, access: "read", buckets: ["a", "b", "a"], jurisdiction: "eu" }, { conns: ["cloudflare"] }));
    expect(JSON.parse(m.calls.find((c) => c.method === "POST")!.body!).policies[0].resources).toEqual({ "com.cloudflare.edge.r2.bucket.acc1_eu_a": "*", "com.cloudflare.edge.r2.bucket.acc1_eu_b": "*" });
  });

  it("refuses admin with buckets and unknown permission groups before creating anything", async () => {
    const m = routeFetch(...routes());
    await expect(provider.issue!(issueCtx(m.fetch, { ...params, access: "admin" }, { conns: ["cloudflare"] }))).rejects.toThrow(/admin/);
    const none = routeFetch({ url: "/tokens/permission_groups", reply: { body: { result: [{ id: "x", name: "Other" }] } } });
    await expect(provider.issue!(issueCtx(none.fetch, params, { conns: ["cloudflare"] }))).rejects.toThrow(/Workers R2 Storage Bucket Item Read, Workers R2 Storage Bucket Item Write/);
    expect(none.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("flags an answer without the token value as a possible orphan and never leaks values", async () => {
    const m = routeFetch({ url: "/tokens/permission_groups", reply: { body: GROUPS } }, { method: "POST", url: TOKENS, reply: { body: { result: { id: "tok-orphan" } } } });
    await expect(provider.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }))).rejects.toThrow(/tok-orphan/);
    const leak = routeFetch({ url: "/tokens/permission_groups", reply: { body: GROUPS } }, { method: "POST", url: TOKENS, reply: { status: 403, body: `denied ${CONN_TOKEN}` } });
    const err = await provider.issue!(issueCtx(leak.fetch, params, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
  });

  it("revokes by deleting the token, idempotently", async () => {
    const m = routeFetch({ method: "DELETE", url: `${TOKENS}/tok1`, reply: { body: { result: { id: "tok1" } } } });
    await provider.revoke!(revokeCtx(m.fetch, { accountId: "acc1" }, "tok1", ["cloudflare"]));
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: `${TOKENS}/tok1` });
    const gone = routeFetch({ method: "DELETE", url: `${TOKENS}/tok1`, reply: { status: 404, body: "{}" } });
    await expect(provider.revoke!(revokeCtx(gone.fetch, { accountId: "acc1" }, "tok1", ["cloudflare"]))).resolves.toBeUndefined();
  });

  it("verifies with a signed ListObjectsV2 on the first bucket and the token status", async () => {
    const SECRET = sha(TOKEN_VALUE);
    const m = routeFetch(
      { url: `${TOKENS}/tok1`, reply: { body: { result: { status: "active", expires_on: "2027-01-30T10:00:00Z" } } } },
      { url: "https://acc1.r2.cloudflarestorage.com/app-data?list-type=2&max-keys=1", reply: { status: 200, body: "<ListBucketResult/>" } },
    );
    const checks = await provider.verify!(verifyCtx(m.fetch, params, { value: SECRET, externalId: "tok1", conns: ["cloudflare"], expiresAt: "2027-01-30T10:00:00Z" }));
    expect(checks.map((c) => [c.id, c.status])).toEqual([["token", "pass"], ["expires", "pass"], ["s3", "pass"]]);
    const s3 = m.calls.find((c) => c.url.includes("r2.cloudflarestorage.com"))!;
    expect(s3.headers["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=tok1\/20261101\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(checks)).not.toContain(SECRET);
  });

  it("fails the S3 check on a 403 and uses the EU endpoint for that jurisdiction", async () => {
    const m = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: "active" } } } }, { url: "https://acc1.eu.r2.cloudflarestorage.com/app-data", reply: { status: 403, body: "<Error/>" } });
    const checks = await provider.verify!(verifyCtx(m.fetch, { ...params, jurisdiction: "eu" }, { value: "s", externalId: "tok1", conns: ["cloudflare"] }));
    expect(checks.find((c) => c.id === "s3")).toMatchObject({ status: "fail", actual: "HTTP 403" });
  });

  it("only checks the token without a bucket or when the entry holds the key id", async () => {
    const tokenOnly = routeFetch({ url: `${TOKENS}/tok1`, reply: { body: { result: { status: "active" } } } });
    const a = await provider.verify!(verifyCtx(tokenOnly.fetch, { ...params, buckets: undefined }, { value: "s", externalId: "tok1", conns: ["cloudflare"] }));
    expect(a.find((c) => c.id === "s3")!.status).toBe("info");
    const b = await provider.verify!(verifyCtx(tokenOnly.fetch, { ...params, value: "accessKeyId" }, { value: "tok1", externalId: "tok1", conns: ["cloudflare"] }));
    expect(b.find((c) => c.id === "s3")!.status).toBe("info");
    expect(tokenOnly.calls.every((c) => !c.url.includes("r2.cloudflarestorage.com"))).toBe(true);
  });

  it("preflight names missing permission groups and refuses admin with buckets", async () => {
    const m = routeFetch({ url: "/accounts?", reply: { body: { result: [{ id: "acc1", name: "Acme" }] } } }, { url: "/tokens/permission_groups", reply: { body: { result: [{ id: "x", name: "Other" }] } } });
    const r = await provider.preflight!({ connections: connections("cloudflare"), fetch: m.fetch, params: { ...params, access: "admin" }, hint: { repos: [] } } as never);
    expect(r.findings.find((f) => f.id === "permissions")).toMatchObject({ level: "fail" });
    expect(r.findings.find((f) => f.id === "buckets")).toMatchObject({ level: "fail" });
  });

  it("validates its parameters", () => {
    expect(validateEntryParams(provider, { params: params }).map((p) => p.key)).toEqual([]);
    expect(validateEntryParams(provider, { params: { accountId: "a" } }).map((p) => p.key)).toEqual(["value", "companionEntry", "access"]);
    expect(provider.companionParams).toEqual(["companionEntry"]);
  });
});
