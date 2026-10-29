import { describe, expect, it } from "vitest";
import { supabaseProviders } from "../src/supabase.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, issueCtx, mockFetch, revokeCtx } from "./helpers.js";

const apiKey = supabaseProviders.find((p) => p.id === "supabase-api-key")!;
const serviceRole = supabaseProviders.find((p) => p.id === "supabase-service-role")!;

describe("supabase-api-key", () => {
  it("creates a key (default secret)", async () => {
    const m = mockFetch({ body: { id: "k1", api_key: ISSUED } });
    const r = await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys?reveal=true", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ type: "secret", name: "test-secret-2026-11-01" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("k1");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("publishable and invalid type", async () => {
    const m = mockFetch({ body: { id: "k1", api_key: ISSUED } });
    await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc", type: "publishable" }, { conns: ["supabase"] }));
    expect(JSON.parse(m.calls[0]!.body!).type).toBe("publishable");
    await expect(apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc", type: "x" }, { conns: ["supabase"] }))).rejects.toThrow(ProviderError);
  });
  it("revokes via DELETE", async () => {
    const m = mockFetch({ status: 204 });
    await apiKey.revoke!(revokeCtx(m.fetch, { projectRef: "abc" }, "k1", ["supabase"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys/k1", method: "DELETE" });
  });
  it("error 403 without values", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
  it("label marks the provider as experimental", () => {
    expect(apiKey.label).toContain("experimentell");
  });
});

describe("supabase-service-role", () => {
  it("reads the service_role key", async () => {
    const m = mockFetch({ body: [{ name: "anon", api_key: "anon-key-xxxx" }, { name: "service_role", api_key: ISSUED }] });
    const r = await serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys?reveal=true", method: "GET" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(serviceRole.revoke).toBeUndefined();
  });
  it("error when the key is missing", async () => {
    const m = mockFetch({ body: [{ name: "anon", api_key: "anon-key-xxxx" }] });
    await expect(serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow(/service_role/);
  });
  it("error 403 without token", async () => {
    const m = mockFetch({ status: 403, body: CONN_TOKEN });
    const err = await serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
});
