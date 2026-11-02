import { describe, expect, it } from "vitest";
import { ParamsInvalidError, looksSecret } from "@secret-desk/core";
import { createDefaultRegistry, readVariableField, revenueCatProvider } from "../src/index.js";
import { CONN_TOKEN, connections, routeFetch } from "./helpers.js";

const dctx = (f: typeof fetch, params: Record<string, unknown> = {}) => ({ connections: connections("revenuecat"), fetch: f, params, hint: { repos: [] as string[] } });
const rctx = (f: typeof fetch, params: Record<string, unknown> = {}) => ({ connections: connections("revenuecat"), fetch: f, params });

const PROJECTS = { object: "list", items: [{ id: "proj1", name: "WakeMiles" }, { id: "proj2", name: "Lupe" }], next_page: null };
const APPS1 = { object: "list", items: [{ id: "app_ios", name: "iOS", type: "app_store" }, { id: "app_web", name: "Web", type: "rc_billing" }], next_page: null };
const APPS2 = { object: "list", items: [{ id: "app_lupe", name: "Lupe", type: "play_store" }], next_page: null };
const KEYS = {
  object: "list",
  items: [
    { id: "k1", key: "appl_OLDOLDOLDOLDOLDOLDOLD", environment: "production", app_id: "app_ios", created_at: 1000 },
    { id: "k2", key: "appl_NEWNEWNEWNEWNEWNEWNEW", environment: "production", app_id: "app_ios", created_at: 2000 },
    { id: "k3", key: "appl_SANDSANDSANDSANDSAND", environment: "sandbox", app_id: "app_ios", created_at: 1500 },
  ],
  next_page: null,
};
const rc = () =>
  routeFetch(
    { url: "/v2/projects/proj1/apps/app_ios/public_api_keys", reply: { body: KEYS } },
    { url: "/v2/projects/proj1/apps?", reply: { body: APPS1 } },
    { url: "/v2/projects/proj2/apps?", reply: { body: APPS2 } },
    { url: "/v2/projects?", reply: { body: PROJECTS } },
  );

describe("revenuecat discovery", () => {
  it("is registered with the connection and implements every declared kind", () => {
    const p = createDefaultRegistry().get("revenuecat-secret-key")!;
    expect(p).toBe(revenueCatProvider);
    expect(p.connection).toBe("revenuecat");
    expect(p.kind).toBe("manual");
    expect(p.issue).toBeUndefined();
  });
  it("lists projects with the bearer token and no write call", async () => {
    const { fetch, calls } = rc();
    const o = await revenueCatProvider.discover!("revenuecat.project", dctx(fetch));
    expect(o).toEqual([{ value: "proj1", label: "WakeMiles", detail: "proj1" }, { value: "proj2", label: "Lupe", detail: "proj2" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://api.revenuecat.com/v2/projects?limit=100");
    expect(calls[0]!.headers["Authorization"]).toBe(`Bearer ${CONN_TOKEN}`);
  });
  it("lists apps of one project with name and type in the label", async () => {
    const { fetch, calls } = rc();
    const o = await revenueCatProvider.discover!("revenuecat.app", dctx(fetch, { projectId: "proj1" }));
    expect(o.map((x) => [x.value, x.label])).toEqual([["app_ios", "iOS (app_store)"], ["app_web", "Web (rc_billing)"]]);
    expect(calls).toHaveLength(1);
  });
  it("lists the apps of every project when no project is named", async () => {
    const { fetch } = rc();
    const o = await revenueCatProvider.discover!("revenuecat.publicApiKey", dctx(fetch));
    expect(o.map((x) => x.value)).toEqual(["app_ios", "app_web", "app_lupe"]);
    expect(o[2]!.detail).toContain("Lupe");
  });
  it("follows pagination with starting_after and never follows the next_page URL", async () => {
    const { fetch, calls } = routeFetch(
      { url: "starting_after=proj1", reply: { body: { items: [{ id: "proj2", name: "Lupe" }], next_page: null } } },
      { url: "/v2/projects?", reply: { body: { items: [{ id: "proj1", name: "A" }], next_page: "https://evil.example/v2/projects?starting_after=proj1" } } },
    );
    const o = await revenueCatProvider.discover!("revenuecat.project", dctx(fetch));
    expect(o.map((x) => x.value)).toEqual(["proj1", "proj2"]);
    expect(calls.every((c) => c.url.startsWith("https://api.revenuecat.com/v2/"))).toBe(true);
  });
  it("rejects an unknown kind", async () => {
    const { fetch } = rc();
    await expect(revenueCatProvider.discover!("revenuecat.nope", dctx(fetch))).rejects.toThrow();
  });
  it.each([401, 403, 429])("turns HTTP %i into a ProviderError without the token", async (status) => {
    const { fetch } = routeFetch({ url: "/v2/projects", reply: { status, body: { message: `denied ${CONN_TOKEN}` } } });
    const err = await revenueCatProvider.discover!("revenuecat.project", dctx(fetch)).catch((e: unknown) => e as Error);
    expect(err.name).toBe("ProviderError");
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
  it("is not connected without a token", async () => {
    const { fetch } = rc();
    await expect(revenueCatProvider.discover!("revenuecat.project", { ...dctx(fetch), connections: connections() })).rejects.toMatchObject({ name: "NotConnectedError" });
  });
  void ParamsInvalidError;
});

describe("revenuecat variable fields", () => {
  const app = { value: "app_ios", label: "iOS (app_store)" };
  it("reads ids and names", async () => {
    const { fetch } = rc();
    expect(await readVariableField("revenuecat.project", "id", { value: "proj1", label: "WakeMiles" }, rctx(fetch))).toBe("proj1");
    expect(await readVariableField("revenuecat.project", "name", { value: "proj1", label: "WakeMiles" }, rctx(fetch))).toBe("WakeMiles");
    expect(await readVariableField("revenuecat.app", "id", app, rctx(fetch))).toBe("app_ios");
    expect(await readVariableField("revenuecat.app", "name", app, rctx(fetch, { projectId: "proj1" }))).toBe("iOS");
    expect(await readVariableField("revenuecat.app", "type", app, rctx(fetch, { projectId: "proj1" }))).toBe("app_store");
  });
  it("takes the newest public key per environment and reads only the public key list", async () => {
    const { fetch, calls } = rc();
    expect(await readVariableField("revenuecat.publicApiKey", "production", app, rctx(fetch, { projectId: "proj1" }))).toBe("appl_NEWNEWNEWNEWNEWNEWNEW");
    expect(await readVariableField("revenuecat.publicApiKey", "sandbox", app, rctx(fetch, { projectId: "proj1" }))).toBe("appl_SANDSANDSANDSANDSAND");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.includes("/public_api_keys"))).toBe(true);
  });
  it("finds the project of an app itself when no project is given", async () => {
    const { fetch } = rc();
    expect(await readVariableField("revenuecat.publicApiKey", "production", app, rctx(fetch))).toBe("appl_NEWNEWNEWNEWNEWNEWNEW");
  });
  it("fails when no key of that environment exists, and never returns a key from another environment", async () => {
    const only = routeFetch(
      { url: "/public_api_keys", reply: { body: { items: [{ id: "k1", key: "appl_PRODPRODPRODPRODPROD", environment: "production", created_at: 1 }], next_page: null } } },
      { url: "/apps?", reply: { body: APPS1 } },
    );
    await expect(readVariableField("revenuecat.publicApiKey", "sandbox", app, rctx(only.fetch, { projectId: "proj1" }))).rejects.toThrow(/sandbox/);
  });
  it("rejects fields outside the allowlist, such as a secret key", async () => {
    const { fetch } = rc();
    await expect(readVariableField("revenuecat.publicApiKey", "secret", app, rctx(fetch))).rejects.toThrow(/nicht erlaubt/);
  });
  it("fails for an app that does not exist", async () => {
    const { fetch } = rc();
    await expect(readVariableField("revenuecat.app", "name", { value: "nope", label: "x" }, rctx(fetch, { projectId: "proj1" }))).rejects.toThrow(/nope/);
  });
});

describe("secret-shape guard for RevenueCat keys", () => {
  it.each(["appl_AbCdEfGhIjKlMnOpQrStUvWx", "goog_AbCdEfGhIjKlMnOpQrStUvWx", "rcb_AbCdEfGhIjKlMnOpQrStUvWx", "rcb_sb_AbCdEfGhIjKlMnOpQrStUvWx", "strp_AbCdEfGhIjKlMnOpQrStUvWx", "amzn_AbCdEfGhIjKlMnOpQrStUvWx"])("accepts the public key %s", (v) => {
    expect(looksSecret("REVENUECAT_IOS_SDK_KEY", v)).toBeNull();
  });
  it("blocks v2 secret keys", () => {
    expect(looksSecret("REVENUECAT_SDK_KEY", "sk_AbCdEfGhIjKlMnOpQrStUvWxYz012345")?.level).toBe("block");
  });
  it("still blocks Stripe keys", () => {
    expect(looksSecret("X", ["sk", "live", "AbCdEfGhIjKlMnOpQrStUvWx"].join("_"))?.reason).toContain("Stripe");
  });
});
