import { describe, expect, it } from "vitest";
import { stripeWebhookProvider as p } from "../src/stripe.js";
import { ProviderError } from "../src/http.js";
import { ConnectionStore } from "@secret-desk/core";
import { CONN_TOKEN, ISSUED, LEAK, issueCtx, mockFetch, revokeCtx } from "./helpers.js";

const params = { url: "https://example.com/hook", events: ["checkout.session.completed", "invoice.paid"] };

describe("stripe-webhook-secret", () => {
  it("creates the endpoint via form", async () => {
    const m = mockFetch({ body: { id: "we_1", secret: "whsec_" + ISSUED } });
    const r = await p.issue!(issueCtx(m.fetch, params, { conns: ["stripe"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.stripe.com/v1/webhook_endpoints", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(m.calls[0]!.body);
    expect(form.get("url")).toBe(params.url);
    expect(form.getAll("enabled_events[]")).toEqual(params.events);
    expect(r.value.reveal()).toBe("whsec_" + ISSUED);
    expect(r.externalId).toBe("we_1");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("uses the connection from params.connection", async () => {
    const m = mockFetch({ body: { id: "we_1", secret: "whsec_x" } });
    await p.issue!(issueCtx(m.fetch, { ...params, connection: "stripe-acme-docs" }, { conns: ["stripe-acme-docs"] }));
    expect(m.calls).toHaveLength(1);
  });
  it("revokes via DELETE", async () => {
    const m = mockFetch({ body: { deleted: true } });
    await p.revoke!(revokeCtx(m.fetch, {}, "we_1", ["stripe"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.stripe.com/v1/webhook_endpoints/we_1", method: "DELETE" });
  });
  it("error 403 without values", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await p.issue!(issueCtx(m.fetch, params, { conns: ["stripe"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });

  describe("test and live separated", () => {
    const store = (...ids: string[]) => {
      const c = new ConnectionStore();
      for (const id of ids) c.session.set(id, `TOKEN-${id}`);
      return c;
    };
    const issueWith = async (ids: string[], kind: "test" | "live" | "dev" | "shared", extra: Record<string, unknown> = {}) => {
      const m = mockFetch({ body: { id: "we_1", secret: "whsec_x" } });
      const ctx = { ...issueCtx(m.fetch, { ...params, ...extra }), stage: kind === "live" ? "production" : kind === "test" ? "staging" : kind, stageKind: kind, connections: store(...ids) };
      await p.issue!(ctx);
      return m.calls[0]!.headers["Authorization"];
    };
    it("stage kind test takes stripe-test, live takes stripe-live", async () => {
      expect(await issueWith(["stripe", "stripe-test", "stripe-live"], "test")).toBe("Bearer TOKEN-stripe-test");
      expect(await issueWith(["stripe", "stripe-test", "stripe-live"], "live")).toBe("Bearer TOKEN-stripe-live");
    });
    it("dev and shared stay with stripe", async () => {
      expect(await issueWith(["stripe", "stripe-test", "stripe-live"], "dev")).toBe("Bearer TOKEN-stripe");
      expect(await issueWith(["stripe", "stripe-test", "stripe-live"], "shared")).toBe("Bearer TOKEN-stripe");
    });
    it("falls back to stripe when the separate connection is missing (backward compatible)", async () => {
      expect(await issueWith(["stripe"], "test")).toBe("Bearer TOKEN-stripe");
      expect(await issueWith(["stripe", "stripe-test"], "live")).toBe("Bearer TOKEN-stripe");
    });
    it("params.connection wins over the stage kind", async () => {
      expect(await issueWith(["stripe", "stripe-test", "stripe-live", "stripe-acme"], "live", { connection: "stripe-acme" })).toBe("Bearer TOKEN-stripe-acme");
    });
    it("revokes with the connection of the entry's stage", async () => {
      const m = mockFetch({ body: { deleted: true } });
      const ctx = { ...revokeCtx(m.fetch, {}, "we_1", []), secret: { ...revokeCtx(m.fetch, {}, "we_1", []).secret, stage: "production" }, connections: store("stripe", "stripe-live") };
      await p.revoke!(ctx);
      expect(m.calls[0]!.headers["Authorization"]).toBe("Bearer TOKEN-stripe-live");
    });
  });
});
