import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, SecretValue, type IssueContext, type Provider } from "@secret-desk/core";
import { ANTHROPIC_DEFAULT_ROTATION_DAYS, isAnthropicAdminKey, isAnthropicApiKey, withAnthropicAdmin } from "../src/index.js";
import { ProviderError } from "../src/http.js";
import { ADMIN_TOKEN, ISSUED, LEAK, byId, connections, expectNoLeak, issueCtx, mockFetch, revokeCtx, routeFetch, verifyCtx } from "./helpers.js";

/** Stands in for the browser provider of the recipe: it issues a value without an expiry and has its own revoke. */
function browserBase(): Provider & { issued: IssueContext[]; revoked: string[] } {
  const issued: IssueContext[] = [];
  const revoked: string[] = [];
  return {
    id: "anthropic-api-key-browser",
    label: "Anthropic API Key (Browser)",
    kind: "automatic",
    params: [{ key: "workspace", label: "Workspace", labelEn: "Workspace", type: "string", required: false, help: "", helpEn: "", defaultValue: "Default" }],
    async issue(ctx) {
      issued.push(ctx);
      return { value: new SecretValue(ISSUED), externalId: ctx.label, expiresAt: null };
    },
    async revoke(ctx) {
      revoked.push(ctx.externalId);
    },
    issued,
    revoked,
  };
}

const KEY = "key-name-2026-11-01";
const p = withAnthropicAdmin(browserBase());
const base = browserBase();
const ext = withAnthropicAdmin(base);

describe("anthropic provider extras", () => {
  it("keeps the browser provider's id and puts it under the anthropic connection", () => {
    expect(ext).toMatchObject({ id: "anthropic-api-key-browser", kind: "automatic", connection: "anthropic" });
    const spec = ext.params!.find((s) => s.key === "workspace")!;
    expect(spec).toMatchObject({ required: false, discover: "anthropic.workspace", defaultValue: "Default" });
    expect(ext.params!.filter((s) => s.key === "workspace")).toHaveLength(1);
  });

  it("fills the expiry from ttlDays, else from the 90-day rotation horizon", async () => {
    const none = await p.issue!(issueCtx(mockFetch().fetch, {}));
    expect(ANTHROPIC_DEFAULT_ROTATION_DAYS).toBe(90);
    expect(none.expiresAt).toBe("2027-01-30T10:00:00Z");
    expect(none.value.reveal()).toBe(ISSUED);
    const thirty = await p.issue!(issueCtx(mockFetch().fetch, {}, { ttlDays: 30 }));
    expect(thirty.expiresAt).toBe("2026-12-01T10:00:00Z");
  });

  it("does not call Anthropic when it issues (the browser makes the key)", async () => {
    const m = mockFetch();
    await ext.issue!(issueCtx(m.fetch, {}));
    expect(m.calls).toHaveLength(0);
    expect(base.issued).toHaveLength(1);
  });

  it("verify: 200 pass, 401 fail, 500 warn, with the issued key in x-api-key", async () => {
    const m = mockFetch({ body: { data: [] } });
    const run = (f: typeof fetch) => ext.verify!(verifyCtx(f, {}));
    expect(byId(await run(m.fetch))["works"]).toBe("pass");
    expect(m.calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(m.calls[0]!.headers).toMatchObject({ "x-api-key": ISSUED, "anthropic-version": "2023-06-01" });
    expect(m.calls[0]!.headers).not.toHaveProperty("Authorization");
    const f = await run(mockFetch({ status: 401, body: LEAK }).fetch);
    expect(byId(f)["works"]).toBe("fail");
    expectNoLeak(f);
    expect(byId(await run(mockFetch({ status: 500 }).fetch))["works"]).toBe("warn");
  });

  it("has a review checklist of 2 to 5 items", () => {
    const items = ext.reviewChecklist!(verifyCtx(mockFetch().fetch, {}).secret);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.length).toBeLessThanOrEqual(5);
  });
});

describe("anthropic workspace discovery", () => {
  const dctx = (f: typeof fetch, conns = ["anthropic"]) => ({ connections: connections(...conns), fetch: f, params: {}, hint: { repos: [] as string[] } });

  it("lists the default workspace first, then active ones across pages, and skips archived ones", async () => {
    const { fetch, calls } = routeFetch(
      { url: "after_id=wrkspc_2", reply: { body: { data: [{ id: "wrkspc_3", name: "Old", archived_at: "2026-01-01T00:00:00Z" }, { id: "wrkspc_4", name: "Four" }], has_more: false, last_id: "wrkspc_4" } } },
      { url: "/v1/organizations/workspaces?limit=100", reply: { body: { data: [{ id: "wrkspc_1", name: "One" }, { id: "wrkspc_2", name: "Two", archived_at: null }], has_more: true, last_id: "wrkspc_2" } } },
    );
    const o = await ext.discover!("anthropic.workspace", dctx(fetch));
    expect(o).toEqual([{ value: "Default", label: "Default" }, { value: "One", label: "One", detail: "wrkspc_1" }, { value: "Two", label: "Two", detail: "wrkspc_2" }, { value: "Four", label: "Four", detail: "wrkspc_4" }]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": ADMIN_TOKEN, "anthropic-version": "2023-06-01" });
    expect(calls[0]!.headers).not.toHaveProperty("Authorization");
  });

  it("does not list the default workspace twice", async () => {
    const m = mockFetch({ body: { data: [{ id: "wrkspc_0", name: "Default" }, { id: "wrkspc_1", name: "One" }], has_more: false } });
    expect((await ext.discover!("anthropic.workspace", dctx(m.fetch))).map((x) => x.value)).toEqual(["Default", "One"]);
  });

  it("stops at the page limit when the API keeps saying there is more", async () => {
    const m = mockFetch({ body: { data: [{ id: "wrkspc_1", name: "One" }], has_more: true, last_id: "wrkspc_1" } });
    await ext.discover!("anthropic.workspace", dctx(m.fetch));
    expect(m.calls).toHaveLength(20);
  });

  it("rejects an unknown kind and a missing connection", async () => {
    await expect(ext.discover!("anthropic.other", dctx(mockFetch().fetch))).rejects.toThrow();
    const m = mockFetch({ body: { data: [] } });
    await expect(ext.discover!("anthropic.workspace", dctx(m.fetch, []))).rejects.toThrow(/anthropic/);
    expect(m.calls).toHaveLength(0);
  });

  it("maps 401 to a provider error without the admin key", async () => {
    const err = (await ext.discover!("anthropic.workspace", dctx(mockFetch({ status: 401, body: LEAK }).fetch)).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(ADMIN_TOKEN);
  });
});

describe("anthropic with a normal API key (Personal)", () => {
  const PERSONAL = ["sk-ant", "api03", "PERSONAL-KEY-1234567890"].join("-");
  const personalStore = (): ConnectionStore => {
    const store = new ConnectionStore();
    store.session.set("anthropic", PERSONAL);
    return store;
  };

  it("lists only the default workspace and does not call the Admin API", async () => {
    const m = mockFetch();
    const o = await ext.discover!("anthropic.workspace", { connections: personalStore(), fetch: m.fetch, params: {}, hint: { repos: [] as string[] } });
    expect(o).toEqual([{ value: "Default", label: "Default" }]);
    expect(m.calls).toHaveLength(0);
  });

  it("still fails for a missing connection and an unknown kind", async () => {
    const m = mockFetch();
    await expect(ext.discover!("anthropic.workspace", { connections: new ConnectionStore(), fetch: m.fetch, params: {}, hint: { repos: [] as string[] } })).rejects.toThrow(/anthropic/);
    expect(m.calls).toHaveLength(0);
  });

  it("revokes through the recipe's browser steps, never through the Admin API", async () => {
    const m = mockFetch();
    const local = browserBase();
    await withAnthropicAdmin(local).revoke!({ ...revokeCtx(m.fetch, {}, KEY, []), connections: personalStore() });
    expect(local.revoked).toEqual([KEY]);
    expect(m.calls).toHaveLength(0);
  });

  it("an Admin key still revokes through the Admin API (the prefix decides)", async () => {
    const local = browserBase();
    const { fetch, calls } = routeFetch({ url: "/v1/organizations/api_keys?limit=100", reply: { body: { data: [], has_more: false } } });
    await withAnthropicAdmin(local).revoke!(revokeCtx(fetch, {}, KEY, ["anthropic"]));
    expect(calls).toHaveLength(1);
    expect(local.revoked).toEqual([]);
  });
});

describe("anthropic key kinds", () => {
  it("tells admin keys from normal API keys by prefix, ignoring surrounding spaces", () => {
    expect(isAnthropicAdminKey(` ${["sk-ant", "admin01", "x"].join("-")} `)).toBe(true);
    expect(isAnthropicAdminKey(["sk-ant", "api03", "x"].join("-"))).toBe(false);
    expect(isAnthropicApiKey(` ${["sk-ant", "api03", "x"].join("-")}`)).toBe(true);
    expect(isAnthropicApiKey(["sk-ant", "usr", "x"].join("-"))).toBe(true);
    expect(isAnthropicApiKey(["sk-ant", "admin01", "x"].join("-"))).toBe(false);
    expect(isAnthropicApiKey("other")).toBe(false);
  });
});

describe("anthropic revoke", () => {
  const keys = (extra: object[] = []) => ({ data: [{ id: "apikey_other", name: "other", status: "active" }, { id: "apikey_1", name: KEY, status: "active" }, ...extra], has_more: false });

  it("deactivates the key found by its name through the Admin API, then archives it", async () => {
    const { fetch, calls } = routeFetch(
      { url: "/v1/organizations/api_keys?limit=100", reply: { body: keys() } },
      { method: "POST", url: "/v1/organizations/api_keys/apikey_1", reply: { body: {} } },
    );
    await ext.revoke!(revokeCtx(fetch, {}, KEY, ["anthropic"]));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => JSON.parse(c.body!))).toEqual([{ status: "inactive" }, { status: "archived" }]);
    expect(posts.every((c) => c.url === "https://api.anthropic.com/v1/organizations/api_keys/apikey_1")).toBe(true);
    expect(calls.every((c) => c.headers["x-api-key"] === ADMIN_TOKEN)).toBe(true);
    expect(base.revoked).toEqual([]);
  });

  it("still succeeds when the API refuses the archived status (the key is already deactivated)", async () => {
    let n = 0;
    const { fetch } = routeFetch(
      { url: "/v1/organizations/api_keys?limit=100", reply: { body: keys() } },
      { method: "POST", url: "/apikey_1", reply: () => (n++ === 0 ? { body: {} } : { status: 400, body: LEAK }) },
    );
    await expect(ext.revoke!(revokeCtx(fetch, {}, KEY, ["anthropic"]))).resolves.toBeUndefined();
  });

  it("does nothing for a key that is not listed or already archived", async () => {
    const gone = routeFetch({ url: "/api_keys?limit=100", reply: { body: { data: [{ id: "apikey_other", name: "other", status: "active" }], has_more: false } } });
    await ext.revoke!(revokeCtx(gone.fetch, {}, KEY, ["anthropic"]));
    expect(gone.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const archived = routeFetch({ url: "/api_keys?limit=100", reply: { body: keys().data.length ? { data: [{ id: "apikey_1", name: KEY, status: "archived" }], has_more: false } : {} } });
    await ext.revoke!(revokeCtx(archived.fetch, {}, KEY, ["anthropic"]));
    expect(archived.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("lets a refused Admin key through (no silent browser fallback once the connection exists)", async () => {
    const denied = mockFetch({ status: 403, body: LEAK });
    const err = (await ext.revoke!(revokeCtx(denied.fetch, {}, KEY, ["anthropic"])).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(ADMIN_TOKEN);
    expect(base.revoked).toEqual([]);
  });

  it("falls back to the recipe's browser revoke without the anthropic connection, and never calls Anthropic", async () => {
    const m = mockFetch();
    const local = browserBase();
    await withAnthropicAdmin(local).revoke!(revokeCtx(m.fetch, {}, KEY, []));
    expect(local.revoked).toEqual([KEY]);
    expect(m.calls).toHaveLength(0);
    vi.clearAllMocks();
  });
});
