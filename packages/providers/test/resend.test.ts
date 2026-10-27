import { describe, expect, it } from "vitest";
import { resendProvider as p } from "../src/resend.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, issueCtx, mockFetch, revokeCtx } from "./helpers.js";

describe("resend-api-key", () => {
  it("erzeugt einen Schluessel (Standard sending_access)", async () => {
    const m = mockFetch({ body: { id: "r1", token: ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, {}, { conns: ["resend"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.resend.com/api-keys", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: "test-secret-2026-11-01", permission: "sending_access" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("r1");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("sendet domain_id nur wenn gesetzt", async () => {
    const m = mockFetch({ body: { id: "r1", token: ISSUED } });
    await p.issue!(issueCtx(m.fetch, { permission: "full_access", domainId: "d1" }, { conns: ["resend"] }));
    expect(JSON.parse(m.calls[0]!.body!)).toMatchObject({ permission: "full_access", domain_id: "d1" });
  });
  it("lehnt ungueltige Berechtigung ab", async () => {
    await expect(p.issue!(issueCtx(mockFetch().fetch, { permission: "root" }, { conns: ["resend"] }))).rejects.toThrow(ProviderError);
  });
  it("widerruft per DELETE", async () => {
    const m = mockFetch({ status: 200, body: {} });
    await p.revoke!(revokeCtx(m.fetch, {}, "r1", ["resend"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.resend.com/api-keys/r1", method: "DELETE" });
  });
  it("Fehler 403 ohne Werte", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await p.issue!(issueCtx(m.fetch, {}, { conns: ["resend"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
});
