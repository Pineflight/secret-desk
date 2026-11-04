import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { getFacadeState, listFacades, startFacadeConnect } from "../src/facade.js";
import { checkConnection } from "../src/connection-check.js";
import { createRuntime } from "../src/runtime.js";

const TOKEN = "glc_made-up-token-A1b2C3d4E5f6G7h8I9j0";
const human = { kind: "human", name: "alice" } as const;

interface Site {
  signedIn: boolean;
  policyName: string | null;
  tokenName: string | null;
  scopes: string[];
  /** Status the fake Cloud API answers with. */
  apiStatus: number;
}

function driverFor(site: Site): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = site.signedIn || !e.key.includes("/profile/org") ? e.key : "https://grafana.com/auth/sign-in";
        if (e.key.includes("/profile/org")) {
          drv.url = site.signedIn ? "https://grafana.com/orgs/acme-org" : "https://grafana.com/auth/sign-in";
          if (site.signedIn) drv.visible.add('link "Access Policies"');
        }
        return;
      }
      if (e.action === "click" && e.key.startsWith("link")) {
        drv.url = "https://grafana.com/orgs/acme-org/access-policies";
        drv.visible.add('button "Create access policy"');
        return;
      }
      if (e.action === "click" && e.key === 'button "Create access policy"') {
        drv.visible.add('Feld "Display name"');
        for (const scope of ["accesspolicies:read", "accesspolicies:write", "stacks:read", "accesspolicies:delete"]) drv.visible.add(`checkbox "${scope}"`);
        drv.visible.add('button "Create"');
        return;
      }
      if (e.action === "fill" && e.key === 'Feld "Display name"') return;
      if (e.action === "click" && e.key.startsWith("checkbox")) {
        site.scopes.push(e.key.slice('checkbox "'.length, -1));
        return;
      }
      if (e.action === "click" && e.key === 'button "Create"') {
        site.policyName = drv.filled.get('Feld "Display name"') ?? "";
        drv.visible.add('button "Add token"');
        return;
      }
      if (e.action === "click" && e.key === 'button "Add token"') {
        drv.visible.add('Feld "Token name"');
        drv.visible.add('combobox "Expiration date"');
        drv.visible.add("css [role=dialog] button:has-text('Create'), [role=dialog] button:has-text('Add')");
        return;
      }
      if (e.action === "click" && e.key.startsWith("combobox")) {
        drv.visible.add('option "90 days"');
        return;
      }
      if (e.action === "click" && e.key.startsWith("css [role=dialog] button")) {
        site.tokenName = drv.filled.get('Feld "Token name"') ?? "";
        drv.visible.add("css [role=dialog] input[readonly]");
        drv.texts.set("css [role=dialog] input[readonly]", TOKEN);
      }
    },
  });
}

async function setup(opts: { signedIn?: boolean; apiStatus?: number } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? true, policyName: null, tokenName: null, scopes: [], apiStatus: opts.apiStatus ?? 200 };
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-grafana-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const urls: string[] = [];
  const bearer: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bearer.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
    if (String(url).startsWith("https://grafana.com/api/v1/accesspolicies")) return new Response(JSON.stringify({ items: [] }), { status: site.apiStatus });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => driverFor(site),
  });
  return { rt, site, urls, bearer };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (rt: Awaited<ReturnType<typeof setup>>["rt"]) => ["done", "failed", "cancelled"].includes(getFacadeState(rt, human, "grafana").status);

describe("facade: grafana (Cloud access policy token)", () => {
  it("is offered under the vendor id, with the Cloud connection, an unverified status and the portal sign-in methods", async () => {
    const { rt } = await setup();
    const f = (await listFacades(rt, human)).find((x) => x.id === "grafana")!;
    expect(f).toMatchObject({ id: "grafana", recipeId: "grafana-cloud-access-policy", connectionId: "grafana-cloud", available: true, connected: false, needsProject: false, host: "grafana.com", inputs: [], passwordless: false });
    expect(f.recipeStatus).toMatch(/^nothing of this recipe is verified/);
    expect(f.promise).toBe("facade.promise.grafana");
    expect(f.methods.map((m) => m.id)).toEqual(["email", "google", "github", "microsoft"]);
  });

  it("creates the policy and the token in the signed-in browser, stores the token as grafana-cloud with a 90-day expiry and tests it", async () => {
    const { rt, site, urls, bearer } = await setup();
    startFacadeConnect(rt, human, "grafana", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "grafana");
    expect(end.failure?.messageEn ?? "").toBe("");
    expect(end.status).toBe("done");
    expect(end.result).toMatchObject({ connected: true, connectionId: "grafana-cloud", storedIn: "session" });
    expect(site.policyName).toMatch(/^secret-desk-integration-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(site.tokenName).toBe(site.policyName);
    // Only the scopes the portal needs; the one the dialog does not offer (stack service accounts) is skipped, not invented.
    expect(site.scopes).toEqual(["accesspolicies:read", "accesspolicies:write", "stacks:read", "accesspolicies:delete"]);
    expect((await rt.connections.token("grafana-cloud")).reveal()).toBe(TOKEN);
    const status = await rt.connections.status("grafana-cloud");
    const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    expect(status.expires).toBe(in90);
    expect(urls[0]).toBe("https://grafana.com/api/v1/accesspolicies?region=us");
    expect(bearer.every((b) => b === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(end)).not.toContain(TOKEN);
    expect(JSON.stringify(rt.automation.info())).not.toContain(TOKEN);
    expect(rt.automation.info().signInChecks).toMatchObject([{ host: "grafana.com", signedIn: true }]);
    expect((await listFacades(rt, human)).find((x) => x.id === "grafana")!.connected).toBe(true);
  });

  it("stops with a session-lost failure and stores nothing when the browser is not signed in", async () => {
    const { rt } = await setup({ signedIn: false });
    startFacadeConnect(rt, human, "grafana", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "grafana");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "session-lost" });
    expect((await rt.connections.status("grafana-cloud")).connected).toBe(false);
  });

  it("reports a rejected token (401) as a failed connection test", async () => {
    const { rt } = await setup({ apiStatus: 401 });
    startFacadeConnect(rt, human, "grafana", {});
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "grafana").failure).toMatchObject({ code: "test" });
  });

  it("an agent cannot start it", async () => {
    const { rt } = await setup();
    expect(() => startFacadeConnect(rt, { kind: "agent", name: "claude" }, "grafana", {})).toThrow();
  });
});

describe("connection test: grafana-cloud", () => {
  it("200 connected, 401 rejected, 403 valid but not checkable, a stack token is the wrong kind; no answer carries the token", async () => {
    const run = async (status: number, token = TOKEN) => {
      const { rt } = await setup({ apiStatus: status });
      rt.connections.session.set("grafana-cloud", token);
      return checkConnection(rt, "grafana-cloud");
    };
    expect(await run(200)).toMatchObject({ ok: true });
    const rejected = await run(401);
    expect(rejected.ok).toBe(false);
    expect(rejected.checks.find((c) => c.id === "token")).toMatchObject({ status: "fail" });
    const forbidden = await run(403);
    expect(forbidden.ok).toBe(true);
    expect(forbidden.checks.find((c) => c.id === "token")).toMatchObject({ status: "info" });
    const stackToken = await run(200, "glsa_made-up-stack-token-0000");
    expect(stackToken.ok).toBe(false);
    expect(stackToken.checks.find((c) => c.id === "prefix")).toMatchObject({ status: "fail" });
    for (const r of [rejected, forbidden, stackToken]) expect(JSON.stringify(r)).not.toMatch(/made-up/);
  });
});
