import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { listConnections } from "../src/agent-api.js";
import { checkConnection, tokenPrefixProblem } from "../src/index.js";
import { getFacadeState, listFacades, startFacadeConnect, startFacadeSignIn } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const EMAIL = "typed.stripe@example.test";
const SIGN_IN_PW = "typed-stripe-value-for-this-run";
const ACCT = "acct_1AaAaA";
const OTHER = "acct_1ZzZzZ";
// Built from parts so secret scanners do not mistake the fakes for real keys.
const KEY_TEST = ["rk", "test", "FAKEKEYFORTESTSONLY1234567890"].join("_");
const KEY_LIVE = ["rk", "live", "FAKEKEYFORTESTSONLY1234567890"].join("_");
const human = { kind: "human", name: "alice" } as const;

const CONTINUE = 'button "Continue" (exact)';

interface Site {
  signedIn: boolean;
  /** Account the minted key belongs to (the recipe is told ACCT; the test can make it differ). */
  keyAccount: string;
  keyMade: string | null;
  /** Live mode: the dashboard asks for the password before the key is created. */
  passwordPrompt: boolean;
}

function driverFor(site: Site): FakeDriver {
  let stage = 0;
  let custom = false;
  let live = false;
  const d: FakeDriver = new FakeDriver({
    pollMs: 2,
    visible: ['button "Reject all" (exact)', 'css input[type="search"]', 'css role=group[name="Permission level"s] >> role=radio[name="Write"s]', 'Feld "Name" (exact)', 'button "Create key"', CONTINUE, 'radio "Custom permissions"', 'radio "Full access—except sensitive operations"'],
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        if (e.key.endsWith("/login") || e.key === "https://dashboard.stripe.com/") {
          if (site.signedIn) drv.url = `https://dashboard.stripe.com/${ACCT}/dashboard`;
          else {
            drv.url = "https://dashboard.stripe.com/login";
            drv.visible.add('css input[type="email"]');
          }
        } else if (e.key.includes("/apikeys/create")) {
          live = !e.key.includes("/test/");
          if (!site.signedIn) drv.url = "https://dashboard.stripe.com/login";
          else {
            drv.pageText.add("Choose how you");
            drv.visible.add('Text "Choose how you"');
          }
        }
        return;
      }
      if (e.action === "fill" && e.key === 'css input[type="email"]') {
        drv.visible.add('css input[type="password"]');
        drv.visible.add('css button[type="submit"]');
      }
      if (e.action === "click" && e.key === 'css button[type="submit"]') {
        site.signedIn = true;
        drv.url = `https://dashboard.stripe.com/${ACCT}/dashboard`;
        return;
      }
      if (e.action === "check" && e.key === 'radio "Custom permissions"') custom = true;
      if (e.action === "click" && e.key === CONTINUE) {
        stage += 1;
        drv.pageText.add(stage === 1 ? "Assign permissions to your key" : stage === 2 ? (custom ? "Select permissions" : "Name and review your key") : "Name and review your key");
        return;
      }
      if (e.action === "fill" && e.key === 'css input[type="search"]') drv.pageText.add("Webhook Endpoints, Event Destinations");
      if (e.action === "fill" && e.key === 'Feld "Name" (exact)') {
        site.keyMade = "named";
        if (live && site.passwordPrompt) drv.visible.add('css input[type="password"]');
      }
      if (e.action === "click" && e.key === 'button "Create key"') {
        drv.pageText.add("Your new secret key");
        drv.visible.add('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]');
        drv.texts.set('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]', "rk_…");
        drv.attributes.set('css text="Your new secret key" >> xpath=ancestor::*[.//*[starts-with(@aria-label,"rk_")]][1] >> [aria-label^="rk_"]@aria-label', live ? KEY_LIVE : KEY_TEST);
      }
    },
  });
  return d;
}

async function setup(site: Partial<Site> = {}, opts: { vault?: boolean } = {}) {
  void opts;
  const s: Site = { signedIn: false, keyAccount: ACCT, keyMade: null, passwordPrompt: false, ...site };
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-stripe-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const bearer: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    bearer.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u === "https://api.stripe.com/v1/account") return json({ id: s.keyAccount, business_profile: { name: "Acme Studio" } });
    if (u === "https://api.stripe.com/v1/balance") return json({ object: "balance" });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const drivers: FakeDriver[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => {
      const d = driverFor(s);
      drivers.push(d);
      return d;
    },
  });
  return { rt, site: s, drivers, bearer };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
type Rt = Awaited<ReturnType<typeof setup>>["rt"];
const finished = (rt: Rt) => ["done", "failed", "cancelled"].includes(getFacadeState(rt, human, "stripe").status);
const body = (inputs: Record<string, string> | undefined, extra: Record<string, unknown> = {}) => ({ username: EMAIL, password: SIGN_IN_PW, ...(inputs ? { inputs } : {}), ...extra });

describe("facade: stripe per account and mode", () => {
  it("offers Stripe with the inputs account and mode from the recipe", async () => {
    const { rt } = await setup();
    const stripe = (await listFacades(rt, human)).find((f) => f.id === "stripe")!;
    expect(stripe).toMatchObject({ available: true, connectionId: "stripe", connected: false, needsProject: false, host: "dashboard.stripe.com" });
    expect(stripe.inputs.map((i) => [i.param, i.options, i.pattern])).toEqual([
      ["account", null, "^acct_[A-Za-z0-9]+$"],
      ["mode", ["sandbox", "live"], null],
    ]);
    expect(stripe.recipeStatus).toMatch(/not verified/);
  });

  it("signs in, creates the sandbox key, stores it as stripe:<acct>:sandbox, labels it and tests it", async () => {
    const { rt, site, drivers, bearer } = await setup();
    startFacadeSignIn(rt, human, "stripe", body({ account: ACCT, mode: "sandbox" }));
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "stripe");
    expect(end.status).toBe("done");
    expect(end.result).toMatchObject({ connected: true, connectionId: `stripe:${ACCT}:sandbox`, storedIn: "session", counts: {} });
    expect(String((end.result as { keyName: string }).keyName)).toMatch(/^secret-desk-test-\d{4}-\d{2}-\d{2}-\d{4}$/);
    expect(site.keyMade).toBe("named");
    expect(drivers.flatMap((d) => [...d.filled]).filter(([sel]) => sel === 'Feld "Name" (exact)').map(([, v]) => v)).toEqual([(end.result as { keyName: string }).keyName]);
    // The key belongs to exactly that connection; the general ones stay empty.
    expect((await rt.connections.token(`stripe:${ACCT}:sandbox`)).reveal()).toBe(KEY_TEST);
    expect((await rt.connections.status("stripe")).connected).toBe(false);
    expect((await rt.connections.status("stripe-test")).connected).toBe(false);
    expect(bearer.every((b) => b === `Bearer ${KEY_TEST}`)).toBe(true);
    // The connection list shows it under the account name.
    const row = (await listConnections(rt)).find((c) => c.id === `stripe:${ACCT}:sandbox`)!;
    expect(row).toMatchObject({ connected: true, label: "Stripe Acme Studio (Sandbox)" });
    expect((await listFacades(rt, human)).find((f) => f.id === "stripe")!.connected).toBe(true);
    // The sandbox address was used, the password was typed once into the password field only.
    const keyDriver = drivers.find((d) => d.calls.some((c) => c === 'click button "Create key"'))!;
    expect(keyDriver.calls).toContain(`goto https://dashboard.stripe.com/${ACCT}/test/apikeys/create`);
    expect(drivers.flatMap((d) => [...d.filled].filter(([, v]) => v === SIGN_IN_PW))).toEqual([['css input[type="password"]', SIGN_IN_PW]]);
    for (const text of [JSON.stringify(end), JSON.stringify(rt.automation.info()), JSON.stringify(await listConnections(rt)), ...drivers.map((d) => d.calls.join("\n"))]) {
      for (const secret of [EMAIL, SIGN_IN_PW, KEY_TEST]) expect(text).not.toContain(secret);
    }
  });

  it("creates the live key for the live mode under stripe:<acct>:live", async () => {
    const { rt, drivers } = await setup();
    startFacadeSignIn(rt, human, "stripe", body({ account: ACCT, mode: "live" }));
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "stripe").result).toMatchObject({ connected: true, connectionId: `stripe:${ACCT}:live` });
    expect((await rt.connections.token(`stripe:${ACCT}:live`)).reveal()).toBe(KEY_LIVE);
    expect(drivers.some((d) => d.calls.includes(`goto https://dashboard.stripe.com/${ACCT}/apikeys/create`))).toBe(true);
    expect(String((getFacadeState(rt, human, "stripe").result as { keyName: string }).keyName)).toMatch(/^secret-desk-live-/);
  });

  it("two accounts and both modes live side by side", async () => {
    const { rt } = await setup({ signedIn: true });
    for (const [account, mode] of [[ACCT, "sandbox"], [ACCT, "live"]] as const) {
      startFacadeConnect(rt, human, "stripe", { inputs: { account, mode } });
      await until(() => finished(rt));
      expect(getFacadeState(rt, human, "stripe").status).toBe("done");
    }
    const ids = (await rt.connections.ids("stripe:")).sort();
    expect(ids).toEqual([`stripe:${ACCT}:live`, `stripe:${ACCT}:sandbox`]);
  });

  it("does not store a key that belongs to another account, and names the key to expire", async () => {
    const { rt } = await setup({ keyAccount: OTHER, signedIn: true });
    startFacadeConnect(rt, human, "stripe", { inputs: { account: ACCT, mode: "sandbox" } });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "stripe");
    expect(end.status).toBe("failed");
    expect(end.failure).toMatchObject({ code: "key" });
    expect(end.failure?.messageEn).toContain(OTHER);
    expect(end.createdName).toMatch(/^secret-desk-test-/);
    expect((await rt.connections.ids("stripe:")).length).toBe(0);
    expect(JSON.stringify(end)).not.toContain(KEY_TEST);
  });

  it("the live mode ends with a portal message when it needs a confirmation only the browser can give", async () => {
    const { rt } = await setup({ signedIn: true, passwordPrompt: true });
    startFacadeConnect(rt, human, "stripe", { inputs: { account: ACCT, mode: "live" } });
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "stripe")).toMatchObject({ status: "failed", failure: { code: "captcha" } });
  });

  it("refuses missing or malformed inputs before any browser opens", async () => {
    const { rt, drivers } = await setup();
    expect(() => startFacadeSignIn(rt, human, "stripe", body(undefined))).toThrow(InventoryError);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ account: ACCT }))).toThrow(/Mode is missing/);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ account: "acct_x y", mode: "sandbox" }))).toThrow(/expected format/);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ account: ACCT, mode: "test" }))).toThrow(/not allowed/);
    expect(() => startFacadeConnect(rt, human, "stripe", { inputs: { account: ACCT } })).toThrow(InventoryError);
    expect(drivers).toHaveLength(0);
    expect(getFacadeState(rt, human, "stripe").status).toBe("idle");
  });
});

describe("connection check and prefix rules of per-account connections", () => {
  it("checks the account of the key against the account of the connection", async () => {
    const { rt } = await setup();
    rt.connections.session.set(`stripe:${ACCT}:sandbox`, KEY_TEST, null);
    const ok = await checkConnection(rt, `stripe:${ACCT}:sandbox`);
    expect(ok.ok).toBe(true);
    expect(ok.checks.find((c) => c.id === "account")).toMatchObject({ status: "pass" });
    // The name labels the connection afterwards.
    expect((await listConnections(rt)).find((c) => c.id === `stripe:${ACCT}:sandbox`)!.label).toBe("Stripe Acme Studio (Sandbox)");

    rt.connections.session.set(`stripe:${OTHER}:sandbox`, KEY_TEST, null); // the fake answers with ACCT for every key
    const wrong = await checkConnection(rt, `stripe:${OTHER}:sandbox`);
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((c) => c.id === "account")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(wrong)).not.toContain(KEY_TEST);
  });

  it("a live key in a sandbox connection (and the reverse) fails the mode check", async () => {
    const { rt } = await setup();
    rt.connections.session.set(`stripe:${ACCT}:sandbox`, KEY_LIVE, null);
    rt.connections.session.set(`stripe:${ACCT}:live`, KEY_TEST, null);
    expect((await checkConnection(rt, `stripe:${ACCT}:sandbox`)).checks.find((c) => c.id === "mode-match")).toMatchObject({ status: "fail" });
    expect((await checkConnection(rt, `stripe:${ACCT}:live`)).checks.find((c) => c.id === "mode-match")).toMatchObject({ status: "fail" });
  });

  it("an unknown id is still unknown", async () => {
    const { rt } = await setup();
    await expect(checkConnection(rt, "stripe:acct_1:test")).rejects.toThrow(/Unbekannte Verbindung/);
  });

  it("the token prefix problem covers the per-account ids", () => {
    expect(tokenPrefixProblem(`stripe:${ACCT}:sandbox`, KEY_LIVE)).toMatch(/Sandbox-Schluessel/);
    expect(tokenPrefixProblem(`stripe:${ACCT}:live`, KEY_TEST)).toMatch(/Live-Schluessel/);
    expect(tokenPrefixProblem(`stripe:${ACCT}:live`, KEY_LIVE)).toBeUndefined();
    expect(tokenPrefixProblem(`stripe:${ACCT}:sandbox`, KEY_TEST)).toBeUndefined();
  });
});
