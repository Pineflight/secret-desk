import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDORS, vendorOfProvider, vendorOfRecipe } from "@secret-desk/core";
import { FACADES, createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: bot
    name: BOT_TOKEN
    stage: staging
    service: x
    provider: telegram-bot
    expiry: none
    places: [{ repo: acme-app, scope: environment, environment: staging }]
  - id: pg
    name: DB_PASSWORD
    stage: staging
    service: x
    provider: supabase-db-password
    expiry: none
    places: [{ repo: acme-app, scope: environment, environment: staging }]
  - id: plain
    name: PLAIN_VALUE
    stage: staging
    service: x
    provider: manual
    expiry: none
    places: [{ repo: acme-app, scope: environment, environment: staging }]
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-vendors-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv, fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { rt, deps };
}

const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, path: string): Request => new Request(`${base}/api/ui/${path}`, { method: "GET", headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf } });
const get = async (deps: RouterDeps, path: string) => (await (await route(ui(deps, path), deps)).json()) as any;

describe("vendor catalog over the API", () => {
  it("lists categories in order and the vendors with their ways in", async () => {
    const { deps } = await setup();
    const body = await get(deps, "vendors");
    expect(body.categories).toEqual(["code", "hosting", "database", "payments", "messaging", "observability", "ai", "data", "print", "other"]);
    expect(body.vendors.map((v: { id: string }) => v.id)).toEqual(VENDORS.map((v) => v.id));
    expect(body.vendors.find((v: { id: string }) => v.id === "stripe")).toMatchObject({ category: "payments", legacyConnections: ["stripe", "stripe-test", "stripe-live"], connectionPrefixes: ["stripe:"] });
  });

  it("marks every vendor that has a guided sign-in", async () => {
    const { deps } = await setup();
    const flagged = (await get(deps, "vendors")).vendors.filter((v: { facade: boolean }) => v.facade).map((v: { id: string }) => v.id).sort();
    expect(flagged).toEqual(FACADES.map((f) => f.id).sort());
    expect(flagged).toContain("anthropic");
  });

  it("is static data: ids and labels only, no state", async () => {
    const { deps } = await setup();
    const keys = new Set((await get(deps, "vendors")).vendors.flatMap((v: object) => Object.keys(v)));
    expect([...keys].sort()).toEqual(["category", "connectionPrefixes", "connections", "facade", "icon", "id", "label", "legacyConnections", "optionalConnections", "providers", "recipes", "signInPlanned"]);
  });

  it("names the vendor on every connection row, and no row carries a value", async () => {
    const { deps, rt } = await setup();
    rt.connections.session.set("stripe:acct_1AbC:sandbox", "rk_test_" + "A".repeat(24), null);
    const text = JSON.stringify(await get(deps, "connections"));
    expect(text).not.toContain("rk_test_AAAA");
    const rows = JSON.parse(text) as { id: string; vendor: string | null; role: string }[];
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row("github-app-key")).toMatchObject({ vendor: "github", role: "optional" });
    expect(row("cloudflare-turnstile")).toMatchObject({ vendor: "cloudflare", role: "optional" });
    expect(row("stripe-test")).toMatchObject({ vendor: "stripe", role: "legacy" });
    expect(row("stripe-live")).toMatchObject({ vendor: "stripe", role: "legacy" });
    expect(row("stripe")).toMatchObject({ vendor: "stripe", role: "legacy" });
    expect(row("stripe:acct_1AbC:sandbox")).toMatchObject({ vendor: "stripe", role: "primary" });
    expect(row("revenuecat")).toMatchObject({ vendor: "revenuecat", role: "primary" });
    expect(rows.filter((r) => r.vendor === null)).toEqual([]);
  });

  it("names the vendor on provider rows and on entries, so recipe entries count for their provider", async () => {
    const { deps } = await setup();
    const providers = (await get(deps, "providers")) as { id: string; vendor: string | null }[];
    expect(providers.find((p) => p.id === "telegram-bot")?.vendor).toBe("telegram");
    expect(providers.find((p) => p.id === "stripe-restricted-key")?.vendor).toBe("stripe");
    expect(providers.find((p) => p.id === "random-hex")?.vendor).toBeNull();
    const secrets = (await get(deps, "secrets")) as { id: string; vendor: string | null }[];
    expect(Object.fromEntries(secrets.map((s) => [s.id, s.vendor]))).toEqual({ bot: "telegram", pg: "supabase", plain: null });
  });
});

describe("the catalog covers what is built in", () => {
  it("assigns every registry provider that needs a connection or a guide, and every bundled recipe, to a vendor", async () => {
    const { rt } = await setup();
    const unassigned = rt.providers.list().filter((p) => (p.connection || p.guide) && !vendorOfProvider(p.id)).map((p) => p.id);
    expect(unassigned).toEqual([]);
    expect(rt.automation.recipes.length).toBeGreaterThan(0);
    const loose = rt.automation.recipes.filter((r) => !vendorOfRecipe(r.id)).map((r) => r.id);
    expect(loose).toEqual([]);
    for (const r of rt.automation.recipes) expect(vendorOfProvider(r.providerId)?.id).toBe(vendorOfRecipe(r.id)?.id);
  });
});
