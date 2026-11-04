import { ConnectionStore, stripeConnectionId, writeConnectionLabel } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/http.js";
import { stripeWebhookProvider as p } from "../src/stripe.js";
import { ISSUED, issueCtx, mockFetch, routeFetch, verifyCtx, revokeCtx, byId, expectNoLeak } from "./helpers.js";

const ACCT = "acct_1AaAaA";
const OTHER = "acct_1ZzZzZ";
const SANDBOX = stripeConnectionId(ACCT, "sandbox");
const LIVE = stripeConnectionId(ACCT, "live");
const params = { url: "https://example.com/hook", events: ["invoice.paid"], account: ACCT };

const accountRoute = (id: string) => ({ url: "/v1/account", reply: { body: { id } } });
const endpointRoute = { method: "POST", url: "/v1/webhook_endpoints", reply: { body: { id: "we_1", secret: "whsec_" + ISSUED } } };

const store = (...ids: string[]) => {
  const c = new ConnectionStore();
  for (const id of ids) c.session.set(id, `TOKEN-${id}`);
  return c;
};

describe("stripe-webhook-secret with an account", () => {
  const issue = async (conns: string[], kind: "test" | "live" | "dev" | "shared", account: string, extra: Record<string, unknown> = {}) => {
    const m = routeFetch(accountRoute(account), endpointRoute);
    const ctx = { ...issueCtx(m.fetch, { ...params, ...extra }), stage: kind === "live" ? "production" : kind === "test" ? "staging" : kind, stageKind: kind, connections: store(...conns) };
    const result = await p.issue!(ctx).catch((e: unknown) => e as Error);
    return { m, result };
  };

  it("takes the connection of the account in the mode of the stage (test -> sandbox, live -> live)", async () => {
    const t = await issue([SANDBOX, LIVE, "stripe-test", "stripe"], "test", ACCT);
    expect(t.m.calls.map((c) => c.headers["Authorization"])).toEqual([`Bearer TOKEN-${SANDBOX}`, `Bearer TOKEN-${SANDBOX}`]);
    const l = await issue([SANDBOX, LIVE, "stripe-live", "stripe"], "live", ACCT);
    expect(l.m.calls.map((c) => c.headers["Authorization"])).toEqual([`Bearer TOKEN-${LIVE}`, `Bearer TOKEN-${LIVE}`]);
    const d = await issue([SANDBOX, LIVE], "dev", ACCT);
    expect(d.m.calls[0]!.headers["Authorization"]).toBe(`Bearer TOKEN-${SANDBOX}`);
  });

  it("asks the account first and creates the endpoint only after it matched", async () => {
    const { m, result } = await issue([SANDBOX], "test", ACCT);
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://api.stripe.com/v1/account", "POST https://api.stripe.com/v1/webhook_endpoints"]);
    expect((result as { externalId: string }).externalId).toBe("we_1");
  });

  it("accepts a restricted key that may not read the account when its key id names the account", async () => {
    // Keys are assembled at run time so secret scanners do not mistake the fixtures for real keys.
    const key = (body: string) => ["rk", "test", body].join("_");
    const forbidden = { url: "/v1/account", reply: { status: 403, body: { error: { type: "invalid_request_error" } } } };
    const acct = "acct_1AbCdEfGhIjKlMn";
    const conn = stripeConnectionId(acct, "sandbox");
    const withAcct = { ...params, account: acct };
    const c = new ConnectionStore();
    c.session.set(conn, key("51AbCdEfGhIjKlMnXyz0123456789"));
    const m = routeFetch(forbidden, endpointRoute);
    const ok = await p.issue!({ ...issueCtx(m.fetch, withAcct), stage: "staging", stageKind: "test", connections: c });
    expect(ok.externalId).toBe("we_1");
    const c2 = new ConnectionStore();
    c2.session.set(conn, key("51ZyXwVuTsRqPoNmXyz0123456789"));
    const m2 = routeFetch(forbidden, endpointRoute);
    await expect(p.issue!({ ...issueCtx(m2.fetch, withAcct), stage: "staging", stageKind: "test", connections: c2 })).rejects.toThrow();
    expect(m2.calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("refuses a connection whose key belongs to another account and creates nothing", async () => {
    const { m, result } = await issue([SANDBOX], "test", OTHER);
    expect(result).toBeInstanceOf(ProviderError);
    expect((result as Error).message).toContain(OTHER);
    expect((result as Error).message).toContain(ACCT);
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("is not connected without a key for that account and mode (no fallback to stripe or stripe-test)", async () => {
    const { m, result } = await issue(["stripe", "stripe-test", LIVE], "test", ACCT);
    expect((result as Error).name).toBe("NotConnectedError");
    expect(m.calls).toHaveLength(0);
  });

  it("params.connection still overrides, and the account check still runs", async () => {
    const ok = await issue(["stripe-acme"], "live", ACCT, { connection: "stripe-acme" });
    expect(ok.m.calls[0]!.headers["Authorization"]).toBe("Bearer TOKEN-stripe-acme");
    const wrong = await issue(["stripe-acme"], "live", OTHER, { connection: "stripe-acme" });
    expect(wrong.result).toBeInstanceOf(ProviderError);
  });

  it("a shared stage has no mode: it needs an explicit connection", async () => {
    const { result } = await issue([SANDBOX, LIVE], "shared", ACCT);
    expect(result).toBeInstanceOf(ProviderError);
    expect((result as Error).message).toContain("connection");
  });

  it("rejects a malformed account", async () => {
    const m = mockFetch({ body: {} });
    const ctx = { ...issueCtx(m.fetch, { ...params, account: "not-an-account" }), connections: store("stripe") };
    await expect(p.issue!(ctx)).rejects.toThrow(/acct_/);
    expect(m.calls).toHaveLength(0);
  });

  it("without account nothing changes: one call, old connection rules", async () => {
    const m = mockFetch({ body: { id: "we_1", secret: "whsec_x" } });
    await p.issue!({ ...issueCtx(m.fetch, { url: params.url, events: params.events }, { conns: ["stripe"] }) });
    expect(m.calls).toHaveLength(1);
  });

  it("revokes with the connection of the account", async () => {
    const m = mockFetch({ body: { deleted: true } });
    const base = revokeCtx(m.fetch, params, "we_1", []);
    await p.revoke!({ ...base, secret: { ...base.secret, stage: "production" }, connections: store(SANDBOX, LIVE) });
    expect(m.calls[0]!.headers["Authorization"]).toBe(`Bearer TOKEN-${LIVE}`);
  });

  describe("preflight", () => {
    const pre = (conns: string[], account: string, kind: "test" | "live" = "test") => {
      const m = routeFetch(accountRoute(account));
      return p.preflight!({ secret: issueCtx(m.fetch, {}).secret, params, stage: kind === "live" ? "production" : "staging", stageKind: kind, connections: store(...conns), fetch: m.fetch });
    };
    it("passes when the key belongs to the account", async () => {
      const r = await pre([SANDBOX], ACCT);
      expect(r.findings).toEqual([expect.objectContaining({ id: "account", level: "ok" })]);
    });
    it("fails when it belongs to another account", async () => {
      const r = await pre([LIVE], OTHER, "live");
      expect(r.findings).toEqual([expect.objectContaining({ id: "account", level: "fail" })]);
    });
    it("has nothing to check without an account", async () => {
      const m = routeFetch();
      const r = await p.preflight!({ secret: issueCtx(m.fetch, {}).secret, params: { url: params.url }, stage: "dev", connections: store("stripe"), fetch: m.fetch });
      expect(r).toEqual({ resource: null, findings: [] });
      expect(m.calls).toHaveLength(0);
    });
  });

  describe("verify", () => {
    const verify = (have: string, kind: "test" | "live" = "test") => {
      const m = routeFetch(accountRoute(have), { url: "/v1/webhook_endpoints/we_1", reply: { body: { id: "we_1", status: "enabled", url: params.url, enabled_events: params.events, livemode: kind === "live" } } });
      return p.verify!({ ...verifyCtx(m.fetch, params, { externalId: "we_1", stageKind: kind }), connections: store(SANDBOX, LIVE) });
    };
    it("adds an account check that passes", async () => {
      const checks = await verify(ACCT);
      expect(byId(checks)["account"]).toBe("pass");
      expect(byId(checks)["status"]).toBe("pass");
      expectNoLeak(checks);
    });
    it("fails the account check for another account", async () => {
      const checks = await verify(OTHER);
      expect(byId(checks)["account"]).toBe("fail");
    });
    it("the mode check stays", async () => {
      expect(byId(await verify(ACCT, "live"))["mode"]).toBe("pass");
    });
  });

  describe("discover stripe.account", () => {
    it("lists the connected accounts with name and modes, from the store only", async () => {
      const c = store(SANDBOX, LIVE, stripeConnectionId(OTHER, "sandbox"), "stripe-test");
      await writeConnectionLabel(c, SANDBOX, "Acme Studio");
      const m = routeFetch();
      const options = await p.discover!("stripe.account", { connections: c, fetch: m.fetch, params: {}, hint: { repos: [] } });
      expect(options).toEqual([
        { value: ACCT, label: "Acme Studio", detail: `${ACCT}, Sandbox + Live` },
        { value: OTHER, label: OTHER, detail: `${OTHER}, Sandbox` },
      ]);
      expect(m.calls).toHaveLength(0);
    });
    it("rejects an unknown kind", async () => {
      await expect(p.discover!("stripe.nope", { connections: store(), fetch: mockFetch().fetch, params: {}, hint: { repos: [] } })).rejects.toThrow();
    });
    it("is declared on the account parameter", () => {
      const spec = p.params!.find((s) => s.key === "account")!;
      expect(spec).toMatchObject({ type: "string", required: false, discover: "stripe.account", pattern: "^acct_[A-Za-z0-9]+$" });
    });
  });
});
