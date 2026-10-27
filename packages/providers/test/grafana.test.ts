import { describe, expect, it } from "vitest";
import { baseUrl } from "../src/grafana.js";
import { probeWithValue } from "../src/checks.js";
import { callWithToken } from "../src/http.js";
import { grafanaProvider as p } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, connections, issueCtx, mockFetch, revokeCtx, verifyCtx } from "./helpers.js";

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

describe("F4: baseUrl ist nicht frei (Verbindungs-Token darf nicht zu fremden Hosts)", () => {
  const evil = [
    "https://evil.example",
    "https://evil.example/",
    "https://example.grafana.net.evil.example",
    "https://evil-grafana.net",
    "https://grafana.net",
    "https://example.grafana.net@evil.example/",
    "https://user:pw@example.grafana.net",
    "https://example.grafana.net:8443",
    "https://evil.example/.grafana.net",
    "http://example.grafana.net",
    "https://127.0.0.1",
  ];
  for (const url of evil) {
    it(`issue lehnt ${url} ab, ohne einen Netzaufruf`, async () => {
      const m = mockFetch({ body: { id: 1, key: ISSUED } });
      await expect(p.issue!(issueCtx(m.fetch, { ...params, baseUrl: url }, { conns: ["grafana"] }))).rejects.toThrow(ProviderError);
      expect(m.calls).toHaveLength(0);
    });
  }
  it("revoke und verify lehnen ebenfalls ab, ohne Netzaufruf", async () => {
    const m = mockFetch({ body: [] });
    await expect(p.revoke!(revokeCtx(m.fetch, { ...params, baseUrl: "https://evil.example" }, "42", ["grafana"]))).rejects.toThrow(ProviderError);
    const checks = await p.verify!(verifyCtx(m.fetch, { ...params, baseUrl: "https://evil.example" }, { conns: ["grafana"], externalId: "42" }));
    expect(checks[0]!.status).toBe("warn");
    expect(m.calls).toHaveLength(0);
  });
  it("*.grafana.net geht, auch in Gross-/Kleinschreibung; Pfadpraefix bleibt", () => {
    expect(baseUrl({ baseUrl: "https://Stack.Grafana.NET/" })).toBe("https://stack.grafana.net");
    expect(baseUrl({ baseUrl: "https://stack.grafana.net/grafana/" })).toBe("https://stack.grafana.net/grafana");
  });
  it("eigene Hosts nur ueber providers.grafana.allowedHosts, exakt", async () => {
    const cfg = { grafana: { allowedHosts: ["metrics.corp.example"] } };
    expect(baseUrl({ baseUrl: "https://metrics.corp.example" }, cfg)).toBe("https://metrics.corp.example");
    expect(() => baseUrl({ baseUrl: "https://metrics.corp.example" })).toThrow(ProviderError);
    expect(() => baseUrl({ baseUrl: "https://x.metrics.corp.example" }, cfg)).toThrow(ProviderError);
    expect(() => baseUrl({ baseUrl: "https://metrics.corp.example.evil.example" }, cfg)).toThrow(ProviderError);
    const m = mockFetch({ body: { id: 5, key: ISSUED } });
    const ctx = { ...issueCtx(m.fetch, { ...params, baseUrl: "https://metrics.corp.example" }, { conns: ["grafana"] }), providerConfig: cfg };
    await p.issue!(ctx);
    expect(m.calls[0]!.url).toBe("https://metrics.corp.example/api/serviceaccounts/7/tokens");
  });
});

describe("F4/N8: Weiterleitungen werden nie verfolgt", () => {
  it("Aufruf mit Bearer-Token: redirect manual, 3xx ist ein Fehler", async () => {
    const m = mockFetch({ status: 302 });
    const err = await p.issue!(issueCtx(m.fetch, params, { conns: ["grafana"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(m.calls[0]!.redirect).toBe("manual");
    expect(m.calls).toHaveLength(1);
  });
  it("callWithToken: redirect manual", async () => {
    const m = mockFetch({ status: 301 });
    await expect(callWithToken("x", { fetch: m.fetch, connections: connections("grafana") }, "grafana", "https://example.grafana.net/a", { method: "GET" })).rejects.toThrow(/Weiterleitung/);
    expect(m.calls[0]!.redirect).toBe("manual");
  });
  it("Pruefer mit Wert (probeWithValue, auch apikey-Kopfzeile): redirect manual, Status 3xx kommt zurueck", async () => {
    const m = mockFetch({ status: 307 });
    const r = await probeWithValue("x", verifyCtx(m.fetch, {}), "https://api.example.com/x", { apikey: "k" });
    expect(r.status).toBe(307);
    expect(m.calls[0]!.redirect).toBe("manual");
    expect(m.calls).toHaveLength(1);
  });
});
