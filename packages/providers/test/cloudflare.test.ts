import { describe, expect, it } from "vitest";
import { NotConnectedError } from "@secret-desk/core";
import { cloudflareProviders } from "../src/cloudflare.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, issueCtx, mockFetch, revokeCtx } from "./helpers.js";

const token = cloudflareProviders.find((p) => p.id === "cloudflare-token")!;
const turnstile = cloudflareProviders.find((p) => p.id === "cloudflare-turnstile")!;
const GROUPS = { result: [{ id: "g1", name: "Workers Scripts Write" }, { id: "g2", name: "Account Settings Read" }] };
const params = { accountId: "acc1", permissions: ["Workers Scripts Write", "Account Settings Read"] };

describe("cloudflare-token", () => {
  it("fragt Gruppen ab und erzeugt den Token mit Ablauf", async () => {
    const m = mockFetch({ body: GROUPS }, { body: { result: { id: "tok1", value: ISSUED, expires_on: "2026-12-01T10:00:00Z" } } });
    const r = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"], ttlDays: 30 }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/user/tokens/permission_groups", method: "GET" });
    expect(m.calls[1]!.url).toBe("https://api.cloudflare.com/client/v4/user/tokens");
    expect(m.calls[1]!.method).toBe("POST");
    expect(m.calls[1]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(m.calls[1]!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(m.calls[1]!.body!)).toEqual({
      name: "test-secret-2026-11-01",
      policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acc1": "*" }, permission_groups: [{ id: "g1" }, { id: "g2" }] }],
      expires_on: "2026-12-01T10:00:00Z",
    });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("tok1");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
  });
  it("sendet kein expires_on ohne ttlDays", async () => {
    const m = mockFetch({ body: GROUPS }, { body: { result: { id: "tok1", value: ISSUED } } });
    const r = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] }));
    expect(JSON.parse(m.calls[1]!.body!)).not.toHaveProperty("expires_on");
    expect(r.expiresAt).toBeNull();
  });
  it("nennt unbekannte Berechtigungsgruppen", async () => {
    const m = mockFetch({ body: GROUPS });
    await expect(token.issue!(issueCtx(m.fetch, { ...params, permissions: ["Gibt es nicht", "Auch nicht"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/Gibt es nicht, Auch nicht/);
    expect(m.calls).toHaveLength(1);
  });
  it("widerruft per DELETE", async () => {
    const m = mockFetch({ body: { result: { id: "tok1" } } });
    await token.revoke!(revokeCtx(m.fetch, {}, "tok1", ["cloudflare"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.cloudflare.com/client/v4/user/tokens/tok1", method: "DELETE" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
  });
  it("Fehler 403 enthaelt weder Verbindungs-Token noch ausgestellten Wert", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(403);
    expect(err.message).toContain("cloudflare-token");
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
  it("kuerzt lange Antworten", async () => {
    const m = mockFetch({ status: 500, body: "x".repeat(5000) });
    const err = await token.issue!(issueCtx(m.fetch, params, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err.message.length).toBeLessThan(300);
  });
  it("wirft NotConnectedError ohne Verbindung", async () => {
    await expect(token.issue!(issueCtx(mockFetch().fetch, params))).rejects.toThrow(NotConnectedError);
  });
});

describe("cloudflare-turnstile", () => {
  it("gibt das neue Secret zurueck", async () => {
    const m = mockFetch({ body: { result: { secret: ISSUED } } });
    const r = await turnstile.issue!(issueCtx(m.fetch, { accountId: "acc1", sitekey: "sk1" }, { conns: ["cloudflare"] }));
    expect(m.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/challenges/widgets/sk1/rotate_secret");
    expect(m.calls[0]!.method).toBe("POST");
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ invalidate_immediately: false });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBeUndefined();
    expect(turnstile.revoke).toBeUndefined();
    expect(turnstile.label).toContain("experimentell");
  });
  it("Fehler ohne Werte", async () => {
    const m = mockFetch({ status: 403, body: `nope ${CONN_TOKEN}` });
    const err = await turnstile.issue!(issueCtx(m.fetch, { accountId: "a", sitekey: "s" }, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
});
