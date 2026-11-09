import { describe, expect, it } from "vitest";
import { ConnectionStore, stripeConnectionId } from "@secret-desk/core";
import { stripeWebhookProvider as p } from "../src/stripe.js";
import { issueCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const ACCT = "acct_1AbCdEfGhIjKlMn";
const SANDBOX = stripeConnectionId(ACCT, "sandbox");
const url = "https://example.com/hook";
const events = ["invoice.paid", "charge.refunded"];
// Keys are assembled at run time so secret scanners do not mistake the fixtures for real keys.
const key = (body: string) => ["rk", "test", body].join("_");

const store = (entries: Record<string, string>) => {
  const c = new ConnectionStore();
  for (const [id, value] of Object.entries(entries)) c.session.set(id, value);
  return c;
};
const endpoint = (body: unknown, status = 200): Route => ({ url: "/v1/webhook_endpoints/we_1", reply: { status, body } });
const account = (id: string | undefined, status = 200): Route => ({ url: "/v1/account", reply: { status, body: id ? { id } : {} } });

describe("stripe issue: unexpected answers", () => {
  it("rejects an account answer without an id", async () => {
    const m = routeFetch(account(undefined));
    const ctx = { ...issueCtx(m.fetch, { url, events, account: ACCT }), stageKind: "test" as const, connections: store({ [SANDBOX]: "TOKEN-A" }) };
    await expect(p.issue!(ctx)).rejects.toThrow("Unerwartete Antwort");
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("rejects a created endpoint without a secret or id", async () => {
    const noSecret = routeFetch({ method: "POST", url: "/v1/webhook_endpoints", reply: { body: { id: "we_1" } } });
    await expect(p.issue!(issueCtx(noSecret.fetch, { url, events }, { conns: ["stripe"] }))).rejects.toThrow("Unerwartete Antwort");
    const empty = routeFetch({ method: "POST", url: "/v1/webhook_endpoints", reply: { status: 204 } });
    await expect(p.issue!(issueCtx(empty.fetch, { url, events }, { conns: ["stripe"] }))).rejects.toThrow("Unerwartete Antwort");
  });
  it("refuses an account on a shared stage without an explicit connection", async () => {
    const ctx = { ...issueCtx(routeFetch().fetch, { url, events, account: ACCT }), stageKind: "shared" as const, connections: store({ stripe: "TOKEN-A" }) };
    await expect(p.issue!(ctx)).rejects.toThrow("Stage der Art shared hat keinen Stripe-Modus");
  });
});

describe("stripe verify", () => {
  const vctx = (routes: Route[], prm: Record<string, unknown>, opts: Parameters<typeof verifyCtx>[2] = {}) => p.verify!(verifyCtx(routeFetch(...routes).fetch, prm, { conns: ["stripe"], externalId: "we_1", ...opts }));
  const get = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as { status: string; actual?: string; expected?: string; detail?: string };
  const full = { status: "enabled", url, enabled_events: events, livemode: false };

  it("checks the account: match, mismatch, unreadable, and a 403 with a key that carries the account", async () => {
    const withAcct = { url, events, account: ACCT };
    const opts = { conns: [SANDBOX], stageKind: "test" as const };
    const ok = await vctx([account(ACCT), endpoint(full)], withAcct, opts);
    expect(get(ok, "account")).toMatchObject({ status: "pass", actual: ACCT });
    const other = await vctx([account("acct_1ZzZzZ"), endpoint(full)], withAcct, opts);
    expect(get(other, "account")).toMatchObject({ status: "fail", expected: ACCT });
    expect(get(other, "account").detail).toContain("gehoert zum Stripe-Konto acct_1ZzZzZ");
    const unreadable = await vctx([account(undefined, 500), endpoint(full)], withAcct, opts);
    expect(get(unreadable, "account")).toMatchObject({ status: "warn", actual: "HTTP 500" });
    const noId = await vctx([account(undefined), endpoint(full)], withAcct, opts);
    expect(get(noId, "account").status).toBe("warn");

    const carrying = { ...verifyCtx(routeFetch(account(undefined, 403), endpoint(full)).fetch, withAcct, { stageKind: "test" }), connections: store({ [SANDBOX]: key("51AbCdEfGhIjKlMnXyz0123456789") }) };
    expect(get(await p.verify!({ ...carrying, externalId: "we_1" }), "account")).toMatchObject({ status: "pass", actual: ACCT });
    const foreign = { ...verifyCtx(routeFetch(account(undefined, 403), endpoint(full)).fetch, withAcct, { stageKind: "test" }), connections: store({ [SANDBOX]: key("51ZyXwVuTsRqPoNmXyz0123456789") }) };
    expect(get(await p.verify!({ ...foreign, externalId: "we_1" }), "account").status).toBe("warn");
  });

  it("warns without an endpoint id", async () => {
    const checks = await p.verify!(verifyCtx(routeFetch().fetch, { url, events }, { conns: ["stripe"] }));
    expect(get(checks, "status")).toMatchObject({ status: "warn", detail: "Keine Endpunkt-Kennung, nichts abrufbar" });
  });
  it("a missing endpoint fails, other errors and non-object answers warn", async () => {
    expect(get(await vctx([endpoint("x", 404)], { url, events }), "status").status).toBe("fail");
    expect(get(await vctx([endpoint("x", 500)], { url, events }), "status")).toMatchObject({ status: "warn", actual: "HTTP 500" });
    expect(get(await vctx([endpoint([1])], { url, events }), "status").status).toBe("warn");
  });
  it("reports a missing status, a different url and a non-text url", async () => {
    const noStatus = await vctx([endpoint({ url: "https://other.example", enabled_events: events, livemode: false })], { url, events });
    expect(get(noStatus, "status")).toMatchObject({ status: "fail", actual: "unbekannt" });
    expect(get(noStatus, "url")).toMatchObject({ status: "fail", actual: "https://other.example" });
    const numericUrl = await vctx([endpoint({ status: "enabled", url: 5, enabled_events: events, livemode: false })], { url, events });
    expect(get(numericUrl, "url")).toMatchObject({ status: "fail", actual: "unbekannt" });
    const noUrlParam = await vctx([endpoint(full)], { events });
    expect(noUrlParam.some((c) => c.id === "url")).toBe(false);
  });
  it("compares the event lists and warns when one side is missing", async () => {
    const diff = await vctx([endpoint({ ...full, enabled_events: ["invoice.paid", "extra.event"] })], { url, events });
    expect(get(diff, "events")).toMatchObject({ status: "fail", detail: "Zusaetzlich: extra.event; Fehlt: charge.refunded" });
    const noParam = await vctx([endpoint(full)], { url });
    expect(get(noParam, "events").status).toBe("warn");
    const noAnswer = await vctx([endpoint({ ...full, enabled_events: "all" })], { url, events });
    expect(get(noAnswer, "events").status).toBe("warn");
  });
  it("judges the mode by the stage kind", async () => {
    const run = (livemode: unknown, stageKind: "live" | "shared" | "test") => vctx([endpoint({ ...full, livemode })], { url, events }, { conns: ["stripe"], stageKind });
    expect(get(await run(true, "live"), "mode")).toMatchObject({ status: "pass", actual: "Live" });
    expect(get(await run(false, "live"), "mode")).toMatchObject({ status: "fail", actual: "Sandbox" });
    expect(get(await run(true, "shared"), "mode")).toMatchObject({ status: "info", actual: "Live" });
    expect(get(await run(true, "test"), "mode")).toMatchObject({ status: "fail", expected: "Sandbox" });
    expect(get(await run(false, "test"), "mode").status).toBe("pass");
    expect(get(await run("maybe", "test"), "mode")).toMatchObject({ status: "warn", actual: "unbekannt" });
  });
  it("checklist names account and url when set and follows the stage kind", () => {
    const withBoth = p.reviewChecklist!(secretEntry({ stage: "production", params: { account: ACCT, url } }));
    expect(withBoth).toContain(`Das Stripe-Konto ist ${ACCT}`);
    expect(withBoth).toContain("Der Endpunkt liegt im Live-Modus");
    expect(withBoth).toContain(`Endpunkt-URL ist ${url}`);
    const bare = p.reviewChecklist!(secretEntry(), { stageKind: "test" });
    expect(bare).toContain("Das Stripe-Konto ist das des richtigen Produkts");
    expect(bare).toContain("Der Endpunkt liegt in der Sandbox, nicht im Live-Modus");
    expect(bare).toContain("Endpunkt-URL stimmt mit dem Dienst ueberein");
  });
});
