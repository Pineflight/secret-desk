import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { describe, expect, it } from "vitest";
import { checkConnection } from "../src/connection-check.js";
import { getFacadeState, listFacades, startFacadeConnect, startFacadeSignIn, submitFacadeCode } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const ADMIN_KEY = "sk-ant-admin01-A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const API_KEY = "sk-ant-api03-Z9y8X7w6V5u4T3s2R1q0P9o8N7m6";
const CODE = "424242";
const human = { kind: "human", name: "alice" } as const;
const FIELD = 'css input[type="email"], input[name="email"]';
const CODE_FIELD = 'css input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]';
const NAME_FIELD = "css [role=dialog] input[type=text] >> nth=0";
const CREATE_BUTTON = 'css [role=dialog] button:has-text("Create")';
const DIALOG_KEY = "css [role=dialog] input[readonly], [role=dialog] code";

interface Site {
  signedIn: boolean;
  keyName: string | null;
  apiStatus: number;
}

function driverFor(site: Site): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    visible: ['button "Continue with email"', 'button "Reject all cookies"'],
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        // The sign-in buttons are on the page only while signed out.
        if (site.signedIn) drv.visible.delete('button "Continue with email"');
        else drv.visible.add('button "Continue with email"');
        if (e.key.endsWith("/login")) {
          drv.url = site.signedIn ? "https://platform.claude.com/settings/keys" : e.key;
          if (!site.signedIn) drv.visible.add(FIELD);
        } else if (e.key.includes("/admin-keys")) {
          if (!site.signedIn) drv.url = "https://platform.claude.com/login";
          else drv.visible.add('button "Create Admin Key"');
        }
        return;
      }
      if (e.key === 'button "Continue with email"') {
        drv.visible.add(CODE_FIELD);
        drv.visible.add('css button[type="submit"]');
      }
      if (e.key === 'css button[type="submit"]') {
        drv.visible.delete(CODE_FIELD);
        site.signedIn = true;
        drv.visible.delete('button "Continue with email"');
        drv.url = "https://platform.claude.com/settings/keys";
        return;
      }
      if (e.action === "click" && e.key === 'button "Create Admin Key"') { drv.visible.add("css [role=dialog] input[type=text]"); drv.visible.add(NAME_FIELD); drv.visible.add(CREATE_BUTTON); }
      if (e.action === "click" && e.key.includes('[role=dialog] button:has-text("Create")')) {
        site.keyName = drv.filled.get(NAME_FIELD) ?? "";
        drv.visible.add(DIALOG_KEY);
        drv.texts.set(DIALOG_KEY, ADMIN_KEY);
      }
    },
  });
}

async function setup(opts: { signedIn?: boolean; apiStatus?: number } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? true, keyName: null, apiStatus: opts.apiStatus ?? 200 };
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-anthropic-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const drivers: FakeDriver[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    if (String(url).startsWith("https://api.anthropic.com/v1/organizations/workspaces")) {
      return new Response(JSON.stringify({ data: [{ id: "wrkspc_1", name: "One" }, { id: "wrkspc_2", name: "Two" }], has_more: false }), { status: site.apiStatus });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => {
      const d = driverFor(site);
      drivers.push(d);
      return d;
    },
  });
  return { rt, site, calls, drivers };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (rt: Awaited<ReturnType<typeof setup>>["rt"]) => ["done", "failed", "cancelled"].includes(getFacadeState(rt, human, "anthropic").status);

describe("facade: anthropic", () => {
  it("is offered with the admin-key recipe, an unverified status, a passwordless email sign-in and Google", async () => {
    const { rt } = await setup();
    const f = (await listFacades(rt, human)).find((x) => x.id === "anthropic")!;
    expect(f).toMatchObject({ id: "anthropic", recipeId: "anthropic-admin-key", connectionId: "anthropic", available: true, connected: false, needsProject: false, host: "platform.claude.com", inputs: [], passwordless: true });
    expect(f.recipeStatus).toMatch(/nothing of this recipe is verified live/);
    expect(f.promise).toBe("facade.promise.anthropic");
    expect(f.methods.map((m) => m.id)).toEqual(["email", "google"]);
    expect((await listFacades(rt, human)).filter((x) => x.id !== "anthropic").every((x) => x.passwordless === false)).toBe(true);
  });

  it("creates the admin key in the signed-in browser, stores it as the anthropic connection and tests it with x-api-key", async () => {
    const { rt, site, calls } = await setup();
    startFacadeConnect(rt, human, "anthropic", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.failure?.messageEn).toBeUndefined();
    expect(end.status).toBe("done");
    // the default workspace is added to the two listed ones
    expect(end.result).toMatchObject({ connected: true, connectionId: "anthropic", storedIn: "session", counts: { workspaces: 3 } });
    expect(site.keyName).toMatch(/^secret-desk-integration-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect((await rt.connections.token("anthropic")).reveal()).toBe(ADMIN_KEY);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/organizations/workspaces?limit=1");
    expect(calls.every((c) => c.headers["x-api-key"] === ADMIN_KEY && c.headers["anthropic-version"] === "2023-06-01" && !("Authorization" in c.headers))).toBe(true);
    expect(JSON.stringify(end)).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(rt.automation.info())).not.toContain(ADMIN_KEY);
    expect(rt.automation.info().signInChecks).toMatchObject([{ host: "platform.claude.com", signedIn: true }]);
    expect((await listFacades(rt, human)).find((x) => x.id === "anthropic")!.connected).toBe(true);
  });

  it("reports a rejected admin key (401) as a failed connection test", async () => {
    const { rt } = await setup({ apiStatus: 401 });
    startFacadeConnect(rt, human, "anthropic", {});
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "test" });
    const check = await checkConnection(rt, "anthropic");
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.id === "token")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(check)).not.toContain(ADMIN_KEY);
  });

  it("tests the stored key: 200 connected, 403 rejected, a regular key is the wrong kind", async () => {
    const ok = await setup();
    ok.rt.connections.session.set("anthropic", ADMIN_KEY);
    expect(await checkConnection(ok.rt, "anthropic")).toMatchObject({ ok: true });
    const denied = await setup({ apiStatus: 403 });
    denied.rt.connections.session.set("anthropic", ADMIN_KEY);
    expect(await checkConnection(denied.rt, "anthropic")).toMatchObject({ ok: false });
    const wrong = await setup();
    wrong.rt.connections.session.set("anthropic", API_KEY);
    const r = await checkConnection(wrong.rt, "anthropic");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "prefix")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });

  it("signs in by email code without a password: only the email is typed, the code is asked for", async () => {
    const { rt, site, drivers } = await setup({ signedIn: false });
    startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test" });
    await until(() => getFacadeState(rt, human, "anthropic").needs === "mfa-code");
    expect(drivers[0]!.filled.get(FIELD)).toBe("a@b.test");
    expect([...drivers[0]!.filled.keys()]).toEqual([FIELD]);
    submitFacadeCode(rt, human, "anthropic", { code: CODE });
    await until(() => finished(rt));
    expect(drivers[0]!.filled.get(CODE_FIELD)).toBe(CODE);
    expect(getFacadeState(rt, human, "anthropic").failure).toBeUndefined();
    expect(getFacadeState(rt, human, "anthropic").status).toBe("done");
    expect(site.keyName).not.toBeNull();
    expect(JSON.stringify(getFacadeState(rt, human, "anthropic"))).not.toContain(CODE);
  });

  it("still requires a password for the Google method", async () => {
    const { rt, drivers } = await setup({ signedIn: false });
    expect(() => startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", method: "google" })).toThrow(/password is missing/);
    expect(drivers).toHaveLength(0);
  });

  it("requires a password for a provider whose email sign-in is not passwordless", async () => {
    const { rt } = await setup();
    expect(() => startFacadeSignIn(rt, human, "openai", { username: "a@b.test" })).toThrow(/password is missing/);
  });
});

describe("anthropic recipes in the runtime", () => {
  it("registers the key recipe's browser provider under the anthropic connection, with workspace discovery", async () => {
    const { rt } = await setup();
    const p = rt.providers.get("anthropic-api-key-browser")!;
    expect(p).toMatchObject({ id: "anthropic-api-key-browser", connection: "anthropic", kind: "automatic" });
    expect(p.params!.find((s) => s.key === "workspace")).toMatchObject({ discover: "anthropic.workspace", required: false });
    expect(typeof p.verify).toBe("function");
    expect(rt.providers.get("anthropic-admin-key-browser")).toBeDefined();
  });
});
