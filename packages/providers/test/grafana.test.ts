import { describe, expect, it } from "vitest";
import { grafanaProvider as p } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, issueCtx, mockFetch, revokeCtx } from "./helpers.js";

const params = { baseUrl: "https://example.grafana.net/", serviceAccountId: 7 };

describe("grafana-service-account-token", () => {
  it("erzeugt einen Token mit Laufzeit", async () => {
    const m = mockFetch({ body: { id: 42, key: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"], ttlDays: 30 }));
    expect(m.calls[0]).toMatchObject({ url: "https://example.grafana.net/api/serviceaccounts/7/tokens", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: "test-secret-2026-11-01", secondsToLive: 30 * 86400 });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("42");
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("sendet kein secondsToLive ohne ttlDays", async () => {
    const m = mockFetch({ body: { id: 1, key: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] }));
    expect(JSON.parse(m.calls[0]!.body!)).not.toHaveProperty("secondsToLive");
    expect(r.expiresAt).toBeNull();
  });
  it("lehnt http-Adressen ab", async () => {
    await expect(p.issue!(issueCtx(mockFetch().fetch, { ...params, baseUrl: "http://x.example" }, { conns: ["grafana"] }))).rejects.toThrow(ProviderError);
  });
  it("widerruft per DELETE", async () => {
    const m = mockFetch({ body: { message: "ok" } });
    await p.revoke!(revokeCtx(m.fetch, params, "42", ["grafana"]));
    expect(m.calls[0]).toMatchObject({ url: "https://example.grafana.net/api/serviceaccounts/7/tokens/42", method: "DELETE" });
  });
  it("Fehler 403 ohne Werte", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
});
