import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError, IssuanceError, SecretVault } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import { cancelFacade, checkFacadeSession, getFacadeState, listFacades, startFacadeConnect, startFacadeSignIn, submitFacadeCode } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const EMAIL = "niklas.typed@example.test";
const SIGN_IN_PW = "typed-value-for-this-run-only";
const CODE = "135790";
const KEY = "sk_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
const PROJECT = "proj1a2b3c";
const HOME = `https://app.revenuecat.com/projects/${PROJECT}/overview`;
const LIST = `https://app.revenuecat.com/projects/${PROJECT}/api-keys`;
const MFA_FIELD = 'css input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]';

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

type Outcome = "ok" | "wrong" | "mfa" | "approval" | "foreign";

interface Site {
  /** Whether the shared browser profile holds a session (all drivers see it). */
  signedIn: boolean;
  outcome: Outcome;
  /** Where the sign-in lands; "" means the bare dashboard address without a project. */
  landing: string;
  keyCreated: string | null;
}

/** A fake RevenueCat: sign-in page, the key form and the key list. State lives in `site`, shared by every driver. */
function driverFor(site: Site): FakeDriver {
  const d: FakeDriver = new FakeDriver({
    pollMs: 2,
    visible: ['button "Log in"'],
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = e.key;
        if (e.key.endsWith("/login") || e.key === "https://app.revenuecat.com/") {
          if (site.signedIn) drv.url = site.landing || HOME;
          else if (e.key.endsWith("/login")) drv.visible.add('css input[name="email"]');
          else drv.url = "https://app.revenuecat.com/login";
        } else if (e.key.includes("/api-keys/new")) {
          if (!site.signedIn) {
            drv.url = "https://app.revenuecat.com/login";
          } else {
            for (const v of ['css input[name="label"]', "css main [role=combobox] >> nth=0", 'option "V2"', 'button "Generate"']) drv.visible.add(v);
            for (const s of ["Project configuration", "Customer information", "Charts metrics", "Audiences", "Iam"]) drv.visible.add(`combobox "${s} permissions"`);
            for (const o of ["No access", "Read only", "Read & write"]) drv.visible.add(`option "${o}"`);
          }
        }
        return;
      }
      if (e.action === "click" && e.key === 'button "Log in"') {
        if (site.outcome === "foreign") drv.url = "https://evil.test/login";
        drv.visible.add('css input[type="password"]');
        drv.visible.add('css button[type="submit"]');
        return;
      }
      if (e.action === "click" && e.key === 'css button[type="submit"]') {
        if (drv.visible.has(MFA_FIELD)) {
          drv.visible.delete(MFA_FIELD);
          site.signedIn = true;
          drv.url = site.landing || HOME;
          return;
        }
        if (site.outcome === "ok") {
          site.signedIn = true;
          drv.url = site.landing || HOME;
        } else if (site.outcome === "wrong") drv.pageText.add("Invalid email or password");
        else if (site.outcome === "mfa") drv.visible.add(MFA_FIELD);
        else if (site.outcome === "approval") drv.pageText.add("Check your email");
        return;
      }
      if (e.action === "click" && e.key === 'button "Generate"') {
        const name = drv.filled.get('css input[name="label"]') ?? "";
        site.keyCreated = name;
        drv.url = LIST;
        const row = `css [role=row]:has-text("${name}")`;
        drv.visible.add(`${row} button[aria-label="Show key"]`);
        return;
      }
      if (e.action === "click" && e.key.endsWith('button[aria-label="Show key"]')) {
        const name = site.keyCreated ?? "";
        const display = `css [role=row]:has-text("${name}") [data-testid=api-key-display]`;
        drv.visible.add(display);
        drv.texts.set(display, KEY);
      }
    },
  });
  return d;
}

async function setup(opts: { outcome?: Outcome; signedIn?: boolean; landing?: string; vault?: boolean } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? false, outcome: opts.outcome ?? "ok", landing: opts.landing ?? "", keyCreated: null };
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const calls: string[] = [];
  const bearer: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    bearer.push(String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/v2/projects/") && u.includes("/apps")) return json({ items: [{ id: "app1", name: "iOS", type: "app_store" }, { id: "app2", name: "Android", type: "play_store" }, { id: "app3", name: "Web", type: "stripe" }] });
    if (u.includes("/v2/projects")) return json({ items: [{ id: PROJECT, name: "Main" }] });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const drivers: FakeDriver[] = [];
  const vault = opts.vault ? new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => randomBytes(32) } }) : null;
  const key = randomBytes(32);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: vault ? new SecretVault({ file: join(dir, "vault.json"), keySource: { label: "test", key: async () => key } }) : null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => {
      const d = driverFor(site);
      drivers.push(d);
      return d;
    },
  });
  return { rt, site, drivers, calls, bearer };
}

/** Everything any driver typed, as "selector=value". */
const typedBy = (drivers: FakeDriver[]): string[] => drivers.flatMap((d) => [...d.filled].map(([sel, value]) => `${sel}=${value}`));

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (rt: Awaited<ReturnType<typeof setup>>["rt"]) => ["done", "failed", "cancelled"].includes(getFacadeState(rt, human, "revenuecat").status);
const body = (extra: Record<string, unknown> = {}) => ({ username: EMAIL, password: SIGN_IN_PW, ...extra });

/** Nothing typed by the human may be anywhere in this. */
function expectClean(label: string, text: string): void {
  for (const secret of [EMAIL, SIGN_IN_PW, CODE, KEY]) expect(text, `${label} leaks a typed value or the key`).not.toContain(secret);
}

describe("facade: list", () => {
  it("offers RevenueCat with its verification status and the browser viewer", async () => {
    const { rt } = await setup();
    const list = await listFacades(rt, human);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "revenuecat", available: true, reason: null, connected: false, needsProject: true, host: "app.revenuecat.com", connectionId: "revenuecat" });
    expect(list[0]!.recipeStatus).toMatch(/nicht geprueft/);
  });

  it("reports why it is unavailable when automation is off", async () => {
    const { rt } = await setup();
    (rt.automation as { enabled: boolean }).enabled = false;
    const list = await listFacades(rt, human);
    expect(list[0]).toMatchObject({ available: false, reason: "Browser automation is off." });
    expect(() => startFacadeSignIn(rt, human, "revenuecat", body())).toThrow(InventoryError);
  });
});

describe("facade: sign-in, key, connection", () => {
  it("signs in, creates the read-only key, stores it, tests it and reports the counts", async () => {
    const { rt, site, drivers, calls, bearer } = await setup();
    const states: string[] = [];
    const first = startFacadeSignIn(rt, human, "revenuecat", body());
    expect(first).toMatchObject({ status: "running", kind: "signin", needs: null });
    states.push(JSON.stringify(first));
    await until(() => (states.push(JSON.stringify(getFacadeState(rt, human, "revenuecat"))), finished(rt)));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end.status).toBe("done");
    expect(end.text).toBe("Connected.");
    expect(end.phase).toBe("connected");
    expect(end.timeline?.map((x) => x.phase)).toEqual(["opening", "username", "password", "signed-in", "key", "stored", "testing", "connected"]);
    expect(end.timeline?.every((x) => x.state === "done")).toBe(true);
    expect(end.result).toMatchObject({ connected: true, storedIn: "session", projectId: PROJECT, counts: { projects: 1, apps: 3 } });
    expect(String((end.result as { keyName: string }).keyName)).toMatch(/^secret-desk-integration-\d{4}-\d{2}-\d{2}-\d{4}$/);
    // The key is stored as the provider's connection and was used for the test.
    expect((await rt.connections.token("revenuecat")).reveal()).toBe(KEY);
    expect(await rt.connections.status("revenuecat")).toMatchObject({ connected: true, source: "session", expires: null });
    expect(bearer.every((b) => b === `Bearer ${KEY}`)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // Typed exactly once each, into the sign-in fields; the key got the read-only permission.
    expect(typedBy(drivers).filter((t) => t.includes(EMAIL))).toEqual([`css input[name="email"]=${EMAIL}`]);
    expect(typedBy(drivers).filter((t) => t.includes(SIGN_IN_PW))).toEqual([`css input[type="password"]=${SIGN_IN_PW}`]);
    // Nothing the human typed, and not the key, in any state the portal can read.
    for (const s of states) expectClean("state", s);
    expectClean("automation info", JSON.stringify(rt.automation.info()));
    expectClean("facade list", JSON.stringify(await listFacades(rt, human)));
  });

  it("stores the key in the vault when there is one, without expiry", async () => {
    const { rt } = await setup({ vault: true });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "revenuecat").result).toMatchObject({ connected: true, storedIn: "vault" });
    expect(await rt.connections.status("revenuecat")).toMatchObject({ connected: true, source: "vault" });
    expect((await rt.connections.status("revenuecat")).expires).toBeNull();
  });

  it("creates the key with Project configuration read only and every other section without access", async () => {
    const { rt, drivers } = await setup();
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    const keyDriver = drivers.find((d) => d.calls.some((c) => c === 'click button "Generate"'))!;
    const picks = keyDriver.calls.filter((c) => c.startsWith("click option"));
    expect(picks).toEqual(['click option "V2"', 'click option "Read only"', 'click option "No access"', 'click option "No access"', 'click option "No access"', 'click option "No access"']);
    expect(keyDriver.calls).toContain(`goto https://app.revenuecat.com/projects/${PROJECT}/api-keys/new`);
  });

  it("wipes the credentials: they are only in the sign-in fill, not in the driver log of the key run", async () => {
    const { rt, drivers } = await setup();
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    for (const d of drivers) expectClean("driver calls", d.calls.join("\n"));
    expect(drivers.every((d) => d.shots.every((s) => s.masks.length >= 0))).toBe(true);
  });

  it("does not echo the password or the email in the request body after it was read", async () => {
    const { rt } = await setup();
    const b = body();
    startFacadeSignIn(rt, human, "revenuecat", b);
    expect(b.password).toBe("");
    await until(() => finished(rt));
  });

  it("reports a refused sign-in with the provider's text and creates no key", async () => {
    const { rt, site } = await setup({ outcome: "wrong" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end.status).toBe("failed");
    expect(end.failure).toEqual({ code: "rejected", message: "RevenueCat hat E-Mail oder Passwort abgelehnt.", messageEn: "RevenueCat rejected the email or password." });
    expect(end.timeline?.at(-1)).toMatchObject({ phase: "password", state: "failed" });
    expect(site.keyCreated).toBeNull();
    expect((await rt.connections.status("revenuecat")).connected).toBe(false);
    expectClean("state", JSON.stringify(end));
  });

  it("asks for the one-time code, types it once and continues", async () => {
    const { rt, drivers } = await setup({ outcome: "mfa" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => getFacadeState(rt, human, "revenuecat").needs === "mfa-code");
    const waiting = getFacadeState(rt, human, "revenuecat");
    expect(waiting).toMatchObject({ status: "waiting-human", phase: "code", needs: "mfa-code" });
    expect(() => submitFacadeCode(rt, human, "revenuecat", { code: "12" })).toThrow(InventoryError);
    const afterSubmit = submitFacadeCode(rt, human, "revenuecat", { code: ` ${CODE.slice(0, 3)} ${CODE.slice(3)} ` });
    expectClean("state after code", JSON.stringify(afterSubmit));
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end.status).toBe("done");
    expect(end.timeline?.map((x) => x.phase)).toContain("code");
    expect(typedBy(drivers).filter((t) => t.endsWith(`=${CODE}`))).toHaveLength(1);
    expectClean("state", JSON.stringify(end));
    // Nobody is waiting for a code any more.
    expect(() => submitFacadeCode(rt, human, "revenuecat", { code: CODE })).toThrow(IssuanceError);
  });

  it("says when the provider waits for an approval and goes on when it arrives", async () => {
    const { rt, site, drivers } = await setup({ outcome: "approval" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => getFacadeState(rt, human, "revenuecat").needs === "approval");
    const waiting = getFacadeState(rt, human, "revenuecat");
    expect(waiting).toMatchObject({ status: "waiting-human", phase: "approval" });
    expect(waiting.text).toMatch(/approval/);
    // The human approves elsewhere: the sign-in page moves on.
    site.signedIn = true;
    const signInDriver = drivers[0]!;
    signInDriver.pageText.clear();
    signInDriver.url = HOME;
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "revenuecat").status).toBe("done");
  });

  it("cancels while waiting and creates nothing", async () => {
    const { rt, site } = await setup({ outcome: "approval" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => getFacadeState(rt, human, "revenuecat").needs === "approval");
    expect(["running", "waiting-human"]).toContain(cancelFacade(rt, human, "revenuecat").status);
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end).toMatchObject({ status: "cancelled", needs: null });
    expect(end.failure?.code).toBe("cancelled");
    expect(site.keyCreated).toBeNull();
    expect(() => cancelFacade(rt, human, "revenuecat")).toThrow(IssuanceError);
  });

  it("cancels while the code prompt is open", async () => {
    const { rt } = await setup({ outcome: "mfa" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => getFacadeState(rt, human, "revenuecat").needs === "mfa-code");
    cancelFacade(rt, human, "revenuecat");
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "revenuecat").status).toBe("cancelled");
    expect(() => submitFacadeCode(rt, human, "revenuecat", { code: CODE })).toThrow(IssuanceError);
  });

  it("gives up after the time limit while waiting for an approval", async () => {
    const { rt } = await setup({ outcome: "approval" });
    (rt.automation as { loginTimeoutMinutes: number }).loginTimeoutMinutes = 0.0005;
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end).toMatchObject({ status: "failed" });
    expect(end.failure?.code).toBe("timeout");
    expectClean("state", JSON.stringify(end));
  });

  it("aborts when the sign-in leaves the provider's host and never types the password there", async () => {
    const { rt, drivers } = await setup({ outcome: "foreign" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end.status).toBe("failed");
    expect(end.failure?.code).toBe("host");
    expect(typedBy(drivers).some((t) => t.includes(SIGN_IN_PW))).toBe(false);
    expectClean("state", JSON.stringify(end));
  });

  it("runs one sign-in at a time", async () => {
    const { rt } = await setup({ outcome: "approval" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    expect(() => startFacadeSignIn(rt, human, "revenuecat", body())).toThrow(IssuanceError);
    expect(() => startFacadeConnect(rt, human, "revenuecat", {})).toThrow(IssuanceError);
    await expect(checkFacadeSession(rt, human, "revenuecat")).rejects.toThrow(IssuanceError);
    cancelFacade(rt, human, "revenuecat");
    await until(() => finished(rt));
    // The next one starts from a clean slate.
    const again = startFacadeSignIn(rt, human, "revenuecat", body());
    expect(again).toMatchObject({ status: "running", timeline: [] });
    cancelFacade(rt, human, "revenuecat");
    await until(() => finished(rt));
  });

  it("asks for the project when it cannot be read from the dashboard, and connects with it afterwards", async () => {
    // The dashboard address names a project the portal cannot use as an id (upper case letters): sign-in works, project unknown.
    const { rt, site, drivers } = await setup({ landing: "https://app.revenuecat.com/projects/Proj_Mixed/overview" });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    const first = getFacadeState(rt, human, "revenuecat");
    expect(first.status).toBe("failed");
    expect(first.failure?.code).toBe("project-unknown");
    expect(site.keyCreated).toBeNull();
    // The browser is still signed in: connect needs no credentials, only the project.
    expect(() => startFacadeConnect(rt, human, "revenuecat", { projectId: "BAD ID" })).toThrow(InventoryError);
    startFacadeConnect(rt, human, "revenuecat", { projectId: PROJECT });
    await until(() => finished(rt));
    expect(getFacadeState(rt, human, "revenuecat")).toMatchObject({ status: "done", kind: "connect" });
    expect((await rt.connections.token("revenuecat")).reveal()).toBe(KEY);
    expect(typedBy(drivers).filter((t) => t.includes(SIGN_IN_PW))).toHaveLength(1);
  });

  it("stops with a clear message when the browser did not keep the session", async () => {
    const { rt, site } = await setup();
    startFacadeConnect(rt, human, "revenuecat", { projectId: PROJECT });
    await until(() => finished(rt));
    const end = getFacadeState(rt, human, "revenuecat");
    expect(end.status).toBe("failed");
    expect(end.failure?.code).toBe("session-lost");
    expect(site.keyCreated).toBeNull();
    expect((await rt.connections.status("revenuecat")).connected).toBe(false);
  });
});

describe("facade: check sign-in", () => {
  it("tells whether the browser is signed in, without credentials", async () => {
    const { rt, site, drivers } = await setup();
    expect(await checkFacadeSession(rt, human, "revenuecat", { timeoutSeconds: 0.05 })).toMatchObject({ signedIn: false });
    site.signedIn = true;
    expect(await checkFacadeSession(rt, human, "revenuecat", { timeoutSeconds: 0.5 })).toMatchObject({ signedIn: true });
    expect(drivers.every((d) => d.filled.size === 0)).toBe(true);
    // The check does not replace the state of the last sign-in run.
    expect(getFacadeState(rt, human, "revenuecat").status).toBe("idle");
  });
});

describe("facade: input and policy", () => {
  it("rejects missing or malformed input before any browser opens", async () => {
    const { rt, drivers } = await setup();
    expect(() => startFacadeSignIn(rt, human, "revenuecat", { password: SIGN_IN_PW })).toThrow(/email is missing/);
    expect(() => startFacadeSignIn(rt, human, "revenuecat", { username: EMAIL })).toThrow(/password is missing/);
    expect(() => startFacadeSignIn(rt, human, "revenuecat", { username: "a\nb@example.test", password: SIGN_IN_PW })).toThrow(/not valid/);
    expect(() => startFacadeSignIn(rt, human, "revenuecat", body({ projectId: "has space" }))).toThrow(/expected format/);
    expect(() => startFacadeSignIn(rt, human, "nope", body())).toThrow(/Unknown provider/);
    for (const call of [() => startFacadeSignIn(rt, human, "revenuecat", { password: SIGN_IN_PW })]) {
      try {
        call();
      } catch (err) {
        expectClean("error", String((err as Error).message));
      }
    }
    expect(drivers).toHaveLength(0);
    expect(getFacadeState(rt, human, "revenuecat").status).toBe("idle");
  });

  it("is for humans only", async () => {
    const { rt } = await setup();
    await expect(listFacades(rt, agent)).rejects.toThrow(PolicyError);
    expect(() => getFacadeState(rt, agent, "revenuecat")).toThrow(PolicyError);
    expect(() => startFacadeSignIn(rt, agent, "revenuecat", body())).toThrow(PolicyError);
    expect(() => startFacadeConnect(rt, agent, "revenuecat", {})).toThrow(PolicyError);
    expect(() => submitFacadeCode(rt, agent, "revenuecat", { code: CODE })).toThrow(PolicyError);
    expect(() => cancelFacade(rt, agent, "revenuecat")).toThrow(PolicyError);
    await expect(checkFacadeSession(rt, agent, "revenuecat")).rejects.toThrow(PolicyError);
  });
});

describe("facadeConnectionForRecipe", () => {
  it("maps the RevenueCat recipe to the revenuecat integration and nothing else", async () => {
    const { facadeConnectionForRecipe } = await import("../src/facade.js");
    expect(facadeConnectionForRecipe("revenuecat-secret-api-key")).toBe("revenuecat");
    expect(facadeConnectionForRecipe("github-fine-grained-token")).toBeNull();
    expect(facadeConnectionForRecipe(undefined)).toBeNull();
  });
});
