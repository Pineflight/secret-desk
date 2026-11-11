import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, SecretValue, type Provider } from "@secret-desk/core";
import { withAnthropicAdmin } from "../src/anthropic.js";
import { openaiProvider } from "../src/openai.js";
import { revenueCatProvider } from "../src/revenuecat.js";
import { readVariableField } from "../src/variable-sources.js";
import { createDefaultRegistry } from "../src/index.js";
import { githubTokenUrl } from "../src/manual.js";
import { byId, connections, issueCtx, mockFetch, revokeCtx, routeFetch, secretEntry, verifyCtx } from "./helpers.js";

const reg = createDefaultRegistry();
const dctx = (f: typeof fetch, conn: string, params: Record<string, unknown> = {}) => ({ connections: connections(conn), fetch: f, params, hint: { repos: [] as string[] } });

describe("anthropic admin: pagination and edge cases", () => {
  const base: Provider = { id: "anthropic-api-key-browser", label: "A", kind: "automatic", issue: async () => { throw new Error("unused"); }, revoke: async () => undefined };
  const ext = withAnthropicAdmin(base);

  it("works for a base without params and adds an optional workspace spec without a default", () => {
    const spec = ext.params!.find((s) => s.key === "workspace")!;
    expect(spec).toMatchObject({ required: false, discover: "anthropic.workspace" });
    expect("defaultValue" in spec).toBe(false);
  });

  it("follows last_id, falls back to the last item id, and stops without a usable cursor", async () => {
    const urls: string[] = [];
    const pages = [
      { data: [{ id: "w1", name: "One" }], has_more: true, last_id: "cursor-a" },
      { data: [{ name: "No Id" }, { id: "w2", name: "Two" }], has_more: true },
      { data: [{ name: "Three" }], has_more: true },
    ];
    let i = 0;
    const m = routeFetch({ url: "/organizations/workspaces", reply: (c) => { urls.push(c.url); return { body: pages[i++] }; } });
    const opts = await ext.discover!("anthropic.workspace", dctx(m.fetch, "anthropic"));
    expect(opts.map((o) => o.value)).toEqual(["Default", "One", "No Id", "Two", "Three"]);
    expect(opts.find((o) => o.value === "One")).toMatchObject({ detail: "w1" });
    expect(opts.find((o) => o.value === "No Id")).not.toHaveProperty("detail");
    expect(urls[0]).toBe("https://api.anthropic.com/v1/organizations/workspaces?limit=100");
    expect(urls[1]).toContain("after_id=cursor-a");
    expect(urls[2]).toContain("after_id=w2");
    expect(urls).toHaveLength(3);
  });

  it("stops after 20 pages even when the API keeps saying has_more", async () => {
    const m = routeFetch({ url: "/organizations/workspaces", reply: { body: { data: [{ id: "w", name: "W" }], has_more: true, last_id: "w" } } });
    await ext.discover!("anthropic.workspace", dctx(m.fetch, "anthropic"));
    expect(m.calls).toHaveLength(20);
  });

  it("skips archived workspaces and workspaces without a name", async () => {
    const m = routeFetch({ url: "/organizations/workspaces", reply: { body: { data: [{ id: "a", name: "Old", archived_at: "2026-01-01T00:00:00Z" }, { id: "b" }, { id: "c", name: "Default" }] } } });
    const opts = await ext.discover!("anthropic.workspace", dctx(m.fetch, "anthropic"));
    expect(opts.map((o) => o.value)).toEqual(["Default"]);
  });

  it("lists only the default workspace for an empty answer or a bare JSON array", async () => {
    const empty = routeFetch({ url: "/organizations/workspaces", reply: { status: 204 } });
    expect((await ext.discover!("anthropic.workspace", dctx(empty.fetch, "anthropic"))).map((o) => o.value)).toEqual(["Default"]);
    const bare = routeFetch({ url: "/organizations/workspaces", reply: { body: [{ id: "w1", name: "Bare" }] } });
    expect((await ext.discover!("anthropic.workspace", dctx(bare.fetch, "anthropic"))).map((o) => o.value)).toEqual(["Default", "Bare"]);
    expect(bare.calls).toHaveLength(1);
  });

  it("rejects ttlDays 0 (not offered by the Console) instead of issuing without an expiry", async () => {
    const ctx = issueCtx(mockFetch().fetch, {});
    const noExpiry = withAnthropicAdmin({ ...base, issue: async () => ({ value: new SecretValue("v"), expiresAt: null }) });
    await expect(noExpiry.issue!({ ...ctx, secret: { ...ctx.secret, ttlDays: 0 } as typeof ctx.secret })).rejects.toMatchObject({ code: "params_invalid" });
  });

  it("keeps the expiry the base provider already set", async () => {
    const withExpiry = withAnthropicAdmin({ ...base, issue: async () => ({ value: new SecretValue("v"), expiresAt: "2030-01-01T00:00:00Z" }) });
    expect((await withExpiry.issue!(issueCtx(mockFetch().fetch, {}))).expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  const KEY = "key-name-2026-11-01";
  const listing = { data: [{ id: "k1", name: KEY, status: "active" }] };

  it("rethrows a non-4xx failure of the archive step (server error and network error)", async () => {
    const server = routeFetch(
      { url: "/organizations/api_keys?", reply: { body: listing } },
      { method: "POST", url: "/organizations/api_keys/k1", reply: (c) => (JSON.parse(c.body!).status === "inactive" ? { body: {} } : { status: 500, body: "boom" }) },
    );
    await expect(ext.revoke!(revokeCtx(server.fetch, {}, KEY, ["anthropic"]))).rejects.toThrow("HTTP 500");
    let n = 0;
    const net = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api_keys?")) return new Response(JSON.stringify(listing));
      if (n++ === 0) return new Response("{}");
      throw new Error("socket closed");
    }) as unknown as typeof fetch;
    await expect(ext.revoke!(revokeCtx(net, {}, KEY, ["anthropic"]))).rejects.toThrow("socket closed");
  });

  it("rethrows an unexpected error while checking whether the admin connection exists", async () => {
    const broken = { token: async () => { throw new Error("store exploded"); } } as unknown as ConnectionStore;
    const ctx = { ...revokeCtx(mockFetch().fetch, {}, KEY, []), connections: broken };
    await expect(ext.revoke!(ctx)).rejects.toThrow("store exploded");
  });
});

describe("openai: pagination and expiry", () => {
  const dc = (f: typeof fetch) => dctx(f, "openai");
  it("pages with the last id as cursor, skips items without id, names fall back to the id", async () => {
    const urls: string[] = [];
    const pages = [
      { data: [{ name: "no id" }, { id: "proj_1", name: "One", status: "active" }], has_more: true },
      { data: [{ id: "proj_2" }, { id: "proj_3", name: "Old", status: "archived" }], has_more: true },
      { data: [], has_more: true },
    ];
    let i = 0;
    const m = routeFetch({ url: "/organization/projects", reply: (c) => { urls.push(c.url); return { body: pages[i++] }; } });
    const opts = await openaiProvider.discover!("openai.project", dc(m.fetch));
    expect(opts).toEqual([{ value: "proj_1", label: "One", detail: "proj_1" }, { value: "proj_2", label: "proj_2", detail: "proj_2" }]);
    expect(urls[1]).toContain("after=proj_1");
    expect(urls[2]).toContain("after=proj_3");
    expect(urls).toHaveLength(3);
  });
  it("stops after 20 pages", async () => {
    const m = routeFetch({ url: "/organization/projects", reply: { body: { data: [{ id: "proj_x" }], has_more: true } } });
    await openaiProvider.discover!("openai.project", dc(m.fetch));
    expect(m.calls).toHaveLength(20);
  });
  it("rejects an unknown discovery kind", async () => {
    await expect(openaiProvider.discover!("openai.other", dc(mockFetch().fetch))).rejects.toThrow();
  });
  it("issues without an expiry when ttlDays is 0", async () => {
    const m = mockFetch({ body: { id: "svc_1", api_key: { value: "VALUE-1234567890" } } });
    const ctx = issueCtx(m.fetch, { projectId: "proj_a" }, { conns: ["openai"] });
    const r = await openaiProvider.issue!({ ...ctx, secret: { ...ctx.secret, ttlDays: 0 } as typeof ctx.secret });
    expect(r.expiresAt).toBeNull();
  });
  it("names the project in the checklist when set", () => {
    expect(openaiProvider.reviewChecklist!(secretEntry({ params: { projectId: "proj_a" } }))[0]).toContain("proj_a");
  });
  it("verify warns on other statuses", async () => {
    expect(byId(await openaiProvider.verify!(verifyCtx(mockFetch({ status: 503 }).fetch, {})))["works"]).toBe("warn");
  });
});

describe("revenuecat: pagination and field edge cases", () => {
  const dc = (f: typeof fetch, params: Record<string, unknown> = {}) => dctx(f, "revenuecat", params);
  it("handles projects and apps without ids or names, and an unknown app type", async () => {
    const m = routeFetch(
      { url: "/v2/projects/p1/apps?", reply: { body: { items: [{ id: "a1" }, { name: "x" }] } } },
      { url: "/v2/projects?", reply: { body: { items: [{ id: "p1" }, { name: "no id" }] } } },
    );
    const projects = await revenueCatProvider.discover!("revenuecat.project", dc(m.fetch));
    expect(projects).toEqual([{ value: "p1", label: "p1", detail: "p1" }]);
    const apps = await revenueCatProvider.discover!("revenuecat.app", dc(m.fetch));
    expect(apps).toEqual([{ value: "a1", label: "a1 (unknown)", detail: "a1, p1" }]);
  });
  it("uses the projectId parameter and stops without a cursor or after 20 pages", async () => {
    const m = routeFetch({ url: "/v2/projects/pz/apps?", reply: { body: { items: [{ id: "a", name: "A", type: "t" }], next_page: "https://x" } } });
    const apps = await revenueCatProvider.discover!("revenuecat.publicApiKey", dc(m.fetch, { projectId: " pz " }));
    expect(apps).toHaveLength(20);
    expect(m.calls).toHaveLength(20);
    expect(m.calls[1]!.url).toContain("starting_after=a");
    const noCursor = routeFetch({ url: "/v2/projects/pz/apps?", reply: { body: { items: [{ name: "no id" }], next_page: "https://x" } } });
    expect(await revenueCatProvider.discover!("revenuecat.app", dc(noCursor.fetch, { projectId: "pz" }))).toEqual([]);
    expect(noCursor.calls).toHaveLength(1);
  });
  it("does not page on when a page is empty even if next_page is set", async () => {
    const m = routeFetch({ url: "/v2/projects?", reply: { body: { items: [], next_page: "https://x" } } });
    expect(await revenueCatProvider.discover!("revenuecat.project", dc(m.fetch))).toEqual([]);
    expect(m.calls).toHaveLength(1);
  });
  it("does not page on when next_page is an empty string", async () => {
    const m = routeFetch({ url: "/v2/projects?", reply: { body: { items: [{ id: "p1", name: "P" }], next_page: "" } } });
    expect(await revenueCatProvider.discover!("revenuecat.project", dc(m.fetch))).toHaveLength(1);
    expect(m.calls).toHaveLength(1);
  });
  it("rejects an unknown kind", async () => {
    await expect(revenueCatProvider.discover!("revenuecat.other", dc(mockFetch().fetch))).rejects.toThrow();
  });
  it("reads app fields, picks the newest key even when timestamps are missing, and rejects bad requests", async () => {
    const keys = { items: [{ key: "K-NO-DATE", environment: "production" }, { key: "K-NEW", environment: "production", created_at: 5 }, { key: "K-OLD", environment: "production", created_at: 1 }, { key: "", environment: "production" }] };
    const m = routeFetch(
      { url: "/public_api_keys", reply: { body: keys } },
      { url: "/v2/projects/p1/apps?", reply: { body: { items: [{ id: "a1", name: "iOS", type: "app_store" }] } } },
    );
    const ctx = dc(m.fetch, { projectId: "p1" });
    const opt = { value: "a1", label: "iOS" };
    expect(await readVariableField("revenuecat.app", "name", opt, ctx)).toBe("iOS");
    expect(await readVariableField("revenuecat.app", "type", opt, ctx)).toBe("app_store");
    expect(await readVariableField("revenuecat.publicApiKey", "production", opt, ctx)).toBe("K-NEW");
    await expect(readVariableField("revenuecat.publicApiKey", "sandbox", opt, ctx)).rejects.toThrow("Kein oeffentlicher sandbox-Schluessel fuer die App a1");
    await expect(readVariableField("revenuecat.app", "name", { value: "zz", label: "z" }, ctx)).rejects.toThrow("Die App zz gibt es im Projekt nicht");
    await expect(readVariableField("revenuecat.app", "bogus", opt, ctx)).rejects.toThrow("Feld nicht erlaubt: bogus");
    expect(await readVariableField("revenuecat.project", "id", opt, ctx)).toBe("a1");
    expect(await readVariableField("revenuecat.project", "name", opt, ctx)).toBe("iOS");
  });
  it("reads app fields without a params object (all projects)", async () => {
    const m = routeFetch(
      { url: "/v2/projects/p1/apps?", reply: { body: { items: [{ id: "a1", name: "iOS", type: "app_store" }] } } },
      { url: "/v2/projects?", reply: { body: { items: [{ id: "p1", name: "P" }] } } },
    );
    const ctx = { connections: connections("revenuecat"), fetch: m.fetch };
    expect(await readVariableField("revenuecat.app", "name", { value: "a1", label: "x" }, ctx)).toBe("iOS");
  });
});

describe("manual providers", () => {
  const get = (id: string): Provider => reg.get(id)!;
  const now = new Date("2026-11-01T10:00:00Z");

  it("githubTokenUrl: optional description, default and clamped expiry, permission filter", () => {
    const plain = new URL(githubTokenUrl(secretEntry(), "acme", now));
    expect(plain.searchParams.get("description")).toBeNull();
    expect(plain.searchParams.get("expires_in")).toBe("30");
    expect(plain.searchParams.get("target_name")).toBe("acme");
    const full = new URL(githubTokenUrl(secretEntry({ description: "d".repeat(400), ttlDays: 900, params: { permissions: { contents: "read", bad: "owner", X: "read", issues: 1 } } }), "acme", now));
    expect(full.searchParams.get("description")).toHaveLength(400);
    expect(full.searchParams.get("expires_in")).toBe("366");
    expect(full.searchParams.get("contents")).toBe("read");
    expect([...full.searchParams.keys()].sort()).toEqual(["contents", "description", "expires_in", "name", "target_name"]);
    expect(new URL(githubTokenUrl(secretEntry({ params: { permissions: "read" } }), "acme", now)).searchParams.has("read")).toBe(false);
  });
  it("github guide builds its link from the owner and the date", () => {
    const url = get("github-fine-grained-token").guide!.openUrl!(secretEntry({ id: "my-token" }), { owner: "acme", now });
    expect(url).toContain("target_name=acme");
    expect(url).toContain("name=my-token-20261101");
  });
  it("checklists name the ttl and describe the stage kind", () => {
    const p = get("telegram-bot");
    const live = p.reviewChecklist!(secretEntry({ ttlDays: 14 }), { stageKind: "live" });
    expect(live).toContain("Ablauf ist 14 Tage nach heute");
    expect(live).toContain("Es ist der Zugang fuer Produktion");
    expect(p.reviewChecklist!(secretEntry(), { stageKind: "shared" })).toContain("Der Zugang passt zu allen Stages, die ihn nutzen");
    expect(p.reviewChecklist!(secretEntry(), { stageKind: "test" })).toContain("Es ist ein Test- bzw. Sandbox-Zugang, kein Produktionszugang");
  });
  it("github verify: other status warns, non-object body reports an unknown login, unparsable expiry warns", async () => {
    const run = (f: typeof fetch) => get("github-fine-grained-token").verify!(verifyCtx(f, {}));
    expect(byId(await run(mockFetch({ status: 500 }).fetch))).toEqual({ works: "warn" });
    const arr = (await run(mockFetch({ body: [1] }).fetch)).find((c) => c.id === "works")!;
    expect(arr.actual).toBe("unbekannt");
    const bad = (f: typeof fetch) => f;
    const f = bad((async () => new Response("{}", { status: 200, headers: { "github-authentication-token-expiration": "garbage" } })) as unknown as typeof fetch);
    expect(byId(await run(f))["expires"]).toBe("warn");
  });
  it("supabase token verify: other status warns, non-array body has no organizations check", async () => {
    const run = (f: typeof fetch) => get("supabase-access-token").verify!(verifyCtx(f, {}));
    expect(byId(await run(mockFetch({ status: 502 }).fetch))).toEqual({ works: "warn" });
    expect(byId(await run(mockFetch({ body: { a: 1 } }).fetch))).toEqual({ works: "pass" });
  });
});
