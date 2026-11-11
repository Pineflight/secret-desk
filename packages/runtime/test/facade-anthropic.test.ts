import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError, SecretValue } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { checkConnection } from "../src/connection-check.js";
import { FACADES, getFacadeState, listFacades, startFacadeConnect, startFacadeSignIn, submitFacadeCode } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const ADMIN_KEY = "sk-ant-admin01-A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const API_KEY = "sk-ant-usr-Z9y8X7w6V5u4T3s2R1q0P9o8N7m6Z9y8X7w6V5u4T3s2R1q0";
const CODE = "424242";
const human = { kind: "human", name: "alice" } as const;
const FIELD = 'css input[type="email"], input[name="email"]';
const CODE_FIELD = 'css input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]';
const NAME_FIELD = "css [role=dialog] input[type=text] >> nth=0";
const CREATE_BUTTON = "css [role=dialog] button[type=submit]";
const DIALOG_KEY = "css [role=dialog] input[readonly], [role=dialog] code";
const PERSONAL_KEY = "testid admin-api-key";
const READ_ONLY_NAME = "css [role=dialog] input[readonly]";

interface Site {
  signedIn: boolean;
  keyName: string | null;
  apiStatus: number;
  /** false: an individual organization, whose Admin keys page has no create button. */
  organization: boolean;
  /** The recipe of the Personal way runs (Settings, API keys) instead of the Admin keys page. */
  personal: boolean;
  /** The expiry option the recipe clicked in the key dialog, e.g. `option "90 days (...)"`; null when it kept the default. */
  expiryOption: string | null;
  /** The name typed into the key dialog of the Personal way. */
  personalKeyName: string | null;
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
        if (e.key.endsWith("/settings/keys") && site.signedIn && site.personal) drv.visible.add('button "Create key"');
        if (e.key.endsWith("/login")) {
          drv.url = site.signedIn ? "https://platform.claude.com/settings/keys" : e.key;
          if (!site.signedIn) drv.visible.add(FIELD);
        } else if (e.key.includes("/admin-keys")) {
          if (!site.signedIn) drv.url = "https://platform.claude.com/login";
          else if (site.organization) drv.visible.add('button "Admin-Schlüssel erstellen"');
        }
        return;
      }
      if (e.key === 'button "Continue with email"') {
        drv.visible.add(CODE_FIELD);
        drv.visible.add('css button[type="submit"]');
      }
      if (e.key === 'css button[type="submit"]') {
        drv.visible.delete(CODE_FIELD);
        drv.visible.delete(FIELD);
        site.signedIn = true;
        drv.visible.delete('button "Continue with email"');
        drv.url = "https://platform.claude.com/settings/keys";
        return;
      }
      // The key dialog of the Personal way: the intro dialog, then name, expiry (30 days by default) and the submit button.
      if (e.action === "click" && e.key === 'button "Create key"') drv.visible.add('button "Continue with an API key"');
      if (e.action === "click" && e.key === 'button "Continue with an API key"') {
        drv.visible.add('Platzhalter "my-secret-key"');
        drv.visible.add(CREATE_BUTTON);
      }
      if (e.action === "click" && e.key.startsWith("option ")) site.expiryOption = e.key;
      if (e.action === "click" && e.key === 'button "Admin-Schlüssel erstellen"') { drv.visible.add("css [role=dialog] input[type=text]"); drv.visible.add(NAME_FIELD); drv.visible.add(CREATE_BUTTON); }
      if (e.action === "click" && e.key === CREATE_BUTTON) {
        site.keyName = drv.filled.get(NAME_FIELD) ?? drv.filled.get('Platzhalter "my-secret-key"') ?? "";
        site.personalKeyName = drv.filled.get('Platzhalter "my-secret-key"') ?? null;
        // While the key is created the form stays open with its name field read-only; that field must not be mistaken for the key.
        drv.visible.add(READ_ONLY_NAME);
        drv.visible.add(site.personal ? PERSONAL_KEY : DIALOG_KEY);
        drv.texts.set(site.personal ? PERSONAL_KEY : DIALOG_KEY, site.personal ? API_KEY : ADMIN_KEY);
      }
    },
  });
}

async function setup(opts: { signedIn?: boolean; apiStatus?: number; modelsStatus?: number; organization?: boolean; personal?: boolean } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? true, keyName: null, apiStatus: opts.apiStatus ?? 200, organization: opts.organization ?? true, personal: opts.personal ?? false, expiryOption: null, personalKeyName: null };
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
    if (String(url).startsWith("https://api.anthropic.com/v1/models")) return new Response(JSON.stringify({ data: [] }), { status: opts.modelsStatus ?? 200 });
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
    expect(f.recipeStatus).toMatch(/sign-in verified live 2026-11-04/);
    expect(f.recipeStatus).toMatch(/NOT verified/);
    // The sentences belong to the ways to connect; nothing is chosen for the human.
    expect(f.promise).toBeNull();
    expect(f.variants).toEqual([
      { id: "team", label: "facade.variant.anthropic.team", promise: "facade.promise.anthropic.team" },
      { id: "personal", label: "facade.variant.anthropic.personal", promise: "facade.promise.anthropic.personal" },
    ]);
    expect(f.methods.map((m) => m.id)).toEqual(["email", "google"]);
    expect((await listFacades(rt, human)).filter((x) => x.id !== "anthropic").every((x) => x.passwordless === false)).toBe(true);
    expect((await listFacades(rt, human)).map((x) => [x.id, x.issuesKeysByApi])).toEqual([["revenuecat", false], ["openai", true], ["anthropic", false], ["grafana", true], ["stripe", true]]);
  });

  it("creates the admin key in the signed-in browser, stores it as the anthropic connection and tests it with x-api-key", async () => {
    const { rt, site, calls } = await setup();
    startFacadeConnect(rt, human, "anthropic", { variant: "team" });
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

  it("ends as ready (browser) instead of failing when the account has no admin keys (individual organization)", async () => {
    const { rt, site, calls } = await setup({ organization: false });
    startFacadeConnect(rt, human, "anthropic", { variant: "team" });
    // the recipe waits several seconds for a create button that never shows up
    await until(() => finished(rt), 15_000);
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.failure).toBeUndefined();
    expect(end.status).toBe("done");
    expect(end.text).toMatch(/no admin keys.*API keys are created in the browser.*Choose Personal/);
    expect(end.result).toMatchObject({ connected: false, browserOnly: true, connectionId: "anthropic", keyName: "", counts: {} });
    // nothing was created, stored or called
    expect(site.keyName).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await rt.connections.status("anthropic")).connected).toBe(false);
    expect((await listFacades(rt, human)).find((x) => x.id === "anthropic")!.connected).toBe(false);
    // the browser counts as signed in, so the card shows "Ready (browser)"
    expect(rt.automation.info().signInChecks).toMatchObject([{ host: "platform.claude.com", signedIn: true }]);
  }, 20_000);

  it("signs in by email code and still finishes as ready (browser) on an individual organization", async () => {
    const { rt, site } = await setup({ signedIn: false, organization: false });
    startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", variant: "team" });
    await until(() => getFacadeState(rt, human, "anthropic").needs === "mfa-code");
    submitFacadeCode(rt, human, "anthropic", { code: CODE });
    await until(() => finished(rt), 15_000);
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.failure).toBeUndefined();
    expect(end.status).toBe("done");
    expect(end.result).toMatchObject({ connected: false, browserOnly: true });
    expect(site.keyName).toBeNull();
  }, 20_000);

  it("reports a rejected admin key (401) as a failed connection test", async () => {
    const { rt } = await setup({ apiStatus: 401 });
    startFacadeConnect(rt, human, "anthropic", { variant: "team" });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "test" });
    const check = await checkConnection(rt, "anthropic");
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.id === "token")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(check)).not.toContain(ADMIN_KEY);
  });

  it("tests a stored admin key: 200 connected, 403 rejected, and says what the key can do", async () => {
    const ok = await setup();
    ok.rt.connections.session.set("anthropic", ADMIN_KEY);
    const good = await checkConnection(ok.rt, "anthropic");
    expect(good).toMatchObject({ ok: true });
    expect(good.checks.find((c) => c.id === "kind")).toMatchObject({ status: "info" });
    expect(good.checks.find((c) => c.id === "workspaces")).toBeUndefined();
    const denied = await setup({ apiStatus: 403 });
    denied.rt.connections.session.set("anthropic", ADMIN_KEY);
    expect(await checkConnection(denied.rt, "anthropic")).toMatchObject({ ok: false });
    const limited = await setup({ apiStatus: 429 });
    limited.rt.connections.session.set("anthropic", ADMIN_KEY);
    expect((await checkConnection(limited.rt, "anthropic")).checks.find((c) => c.id === "token")).toMatchObject({ status: "warn" });
    const odd = await setup({ apiStatus: 500 });
    odd.rt.connections.session.set("anthropic", ADMIN_KEY);
    expect((await checkConnection(odd.rt, "anthropic")).checks.find((c) => c.id === "token")).toMatchObject({ status: "fail" });
  });

  it("tests a stored normal API key with GET /v1/models; workspaces and deactivation are info, not failures", async () => {
    const ok = await setup({ modelsStatus: 200 });
    ok.rt.connections.session.set("anthropic", API_KEY);
    const r = await checkConnection(ok.rt, "anthropic");
    expect(r.ok).toBe(true);
    expect(ok.calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/models?limit=1"]);
    expect(ok.calls[0]!.headers).toMatchObject({ "x-api-key": API_KEY, "anthropic-version": "2023-06-01" });
    expect("Authorization" in ok.calls[0]!.headers).toBe(false);
    expect(r.checks.find((c) => c.id === "kind")).toMatchObject({ status: "info" });
    expect(r.checks.find((c) => c.id === "token")).toMatchObject({ status: "pass" });
    expect(r.checks.find((c) => c.id === "workspaces")).toMatchObject({ status: "info", detail: expect.stringMatching(/Team/) });
    expect(r.checks.find((c) => c.id === "deactivate")).toMatchObject({ status: "info", detail: expect.stringMatching(/Team/) });
    expect(r.checks.some((c) => c.status === "fail")).toBe(false);
    expect(JSON.stringify(r)).not.toContain(API_KEY);
    for (const [status, want] of [[401, "fail"], [403, "fail"], [429, "warn"], [500, "fail"]] as const) {
      const t = await setup({ modelsStatus: status });
      t.rt.connections.session.set("anthropic", API_KEY);
      const res = await checkConnection(t.rt, "anthropic");
      expect(res.checks.find((c) => c.id === "token")).toMatchObject({ status: want });
      expect(JSON.stringify(res)).not.toContain(API_KEY);
    }
  });

  it("a stored value of neither kind fails without a request, and the text names both prefixes", async () => {
    const wrong = await setup();
    wrong.rt.connections.session.set("anthropic", "not-an-anthropic-key-value");
    const r = await checkConnection(wrong.rt, "anthropic");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "prefix")).toMatchObject({ status: "fail", detail: expect.stringMatching(/sk-ant-admin.*sk-ant-api/) });
    expect(wrong.calls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("not-an-anthropic-key-value");
  });

  it("signs in by email code without a password: only the email is typed, the code is asked for", async () => {
    const { rt, site, drivers } = await setup({ signedIn: false });
    startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", variant: "team" });
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
    expect(() => startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", method: "google", variant: "team" })).toThrow(/password is missing/);
    expect(drivers).toHaveLength(0);
  });

  it("requires a password for a provider whose email sign-in is not passwordless", async () => {
    const { rt } = await setup();
    expect(() => startFacadeSignIn(rt, human, "openai", { username: "a@b.test" })).toThrow(/password is missing/);
  });
});

describe("facade: anthropic, Personal (a normal API key)", () => {
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);

  it("creates a normal API key with a 30-day expiry, stores it as the anthropic connection and checks it with /v1/models", async () => {
    const { rt, site, calls } = await setup({ personal: true });
    startFacadeConnect(rt, human, "anthropic", { variant: "personal" });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.failure?.messageEn).toBeUndefined();
    expect(end.status).toBe("done");
    // 30 days is the dialog's default: the recipe keeps it and opens no expiry list.
    expect(site.expiryOption).toBeNull();
    expect(site.personalKeyName).toMatch(/^secret-desk-integration-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(end.result).toMatchObject({ connected: true, connectionId: "anthropic", storedIn: "session", keyName: site.personalKeyName, counts: { workspaces: 1 } });
    expect((await rt.connections.token("anthropic")).reveal()).toBe(API_KEY);
    expect(rt.connections.session.expires("anthropic")).toBe(dayOf(new Date(Date.now() + 30 * 86_400_000)));
    // one call to verify the new key, one for the connection test; the Admin API is never called
    expect(calls.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/models?limit=1", "https://api.anthropic.com/v1/models?limit=1"]);
    expect(calls.every((c) => c.headers["x-api-key"] === API_KEY && !("Authorization" in c.headers))).toBe(true);
    // the summary of the facade does not fail for a Personal connection
    expect(end.result?.check?.checks.some((c) => c.status === "fail")).toBe(false);
    expect(end.result?.check?.checks.find((c) => c.id === "workspaces")?.status).toBe("info");
    expect(JSON.stringify(end)).not.toContain(API_KEY);
    expect(JSON.stringify(rt.automation.info())).not.toContain(API_KEY);
    expect((await listFacades(rt, human)).find((x) => x.id === "anthropic")!.connected).toBe(true);
  });

  it("the Team way does not touch the expiry of the dialog and stores the connection without an expiry day", async () => {
    const { rt, site } = await setup();
    startFacadeConnect(rt, human, "anthropic", { variant: "team" });
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "anthropic").status).toBe("done");
    expect(site.expiryOption).toBeNull();
    expect(rt.connections.session.expires("anthropic")).toBeNull();
  });

  it("signs in once (the shared Console sign-in) and then creates the Personal key", async () => {
    const { rt, site } = await setup({ signedIn: false, personal: true });
    startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", variant: "personal" });
    await until(() => getFacadeState(rt, human, "anthropic").needs === "mfa-code");
    submitFacadeCode(rt, human, "anthropic", { code: CODE });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.failure).toBeUndefined();
    expect(end.status).toBe("done");
    expect(site.expiryOption).toBeNull();
    expect((await rt.connections.token("anthropic")).reveal()).toBe(API_KEY);
  });

  it("does not store a key that Anthropic refuses, and says to expire it", async () => {
    const { rt } = await setup({ personal: true, modelsStatus: 401 });
    startFacadeConnect(rt, human, "anthropic", { variant: "personal" });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "anthropic");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "key" });
    expect(end.failure?.messageEn).toMatch(/did not accept the new key \(HTTP 401\).*Expire the key secret-desk-integration-/);
    expect((await rt.connections.status("anthropic")).connected).toBe(false);
    expect(JSON.stringify(end)).not.toContain(API_KEY);
  });

  describe("the key check of the Personal way", () => {
    const personal = FACADES.find((f) => f.id === "anthropic")!.variants!.find((v) => v.id === "personal")!;
    const rtWith = (fetchImpl: () => Promise<Response>) => ({ fetch: fetchImpl }) as never;

    it("accepts a working normal API key", async () => {
      expect(await personal.verifyKey!(rtWith(async () => new Response("{}", { status: 200 })), SecretValue.from(API_KEY), {})).toBeNull();
    });

    it("refuses any other kind of value without calling Anthropic", async () => {
      let called = false;
      const problem = await personal.verifyKey!(rtWith(async () => { called = true; return new Response("{}"); }), SecretValue.from(ADMIN_KEY), {});
      expect(problem).toMatch(/does not start with sk-ant-usr or sk-ant-api/);
      expect(problem).not.toContain(ADMIN_KEY);
      expect(called).toBe(false);
    });

    it("says so when the check cannot be made", async () => {
      const problem = await personal.verifyKey!(rtWith(async () => { throw new Error(`socket closed ${API_KEY}`); }), SecretValue.from(API_KEY), {});
      expect(problem).toBe("The new key could not be checked at Anthropic, so it was not stored.");
    });
  });

  describe("the chosen way is validated before anything starts", () => {
    it("refuses a missing, empty, non-text or unknown variant with a clear message (connect and sign-in)", async () => {
      const { rt, drivers } = await setup({ signedIn: false });
      for (const body of [{}, { variant: "" }, { variant: "  " }, { variant: 7 }]) {
        expect(() => startFacadeConnect(rt, human, "anthropic", body)).toThrow(/Choose how to connect Anthropic: team or personal/);
        expect(() => startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", ...body })).toThrow(InventoryError);
      }
      expect(() => startFacadeConnect(rt, human, "anthropic", { variant: "enterprise" })).toThrow(/Unknown way to connect Anthropic: enterprise\. Use team or personal/);
      expect(() => startFacadeSignIn(rt, human, "anthropic", { username: "a@b.test", variant: "x".repeat(100) })).toThrow(/Unknown way to connect Anthropic: x{40}\. Use/);
      expect(getFacadeState(rt, human, "anthropic").status).toBe("idle");
      expect(drivers).toHaveLength(0);
    });

    it("refuses a variant whose recipe is not loaded", async () => {
      const { rt } = await setup();
      const original = rt.automation.recipe.bind(rt.automation);
      const spy = vi.spyOn(rt.automation, "recipe").mockImplementation((id) => (id === "anthropic-api-key" ? undefined : original(id)));
      expect(() => startFacadeConnect(rt, human, "anthropic", { variant: "personal" })).toThrow(/The recipe anthropic-api-key is not loaded/);
      spy.mockRestore();
    });
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
