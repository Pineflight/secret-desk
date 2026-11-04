import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError, IssuanceError } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import { cancelRecipeSignIn, checkRecipeSession, getRecipeSignInState, startRecipeSignIn, submitRecipeCode, submitRecipeConfirm } from "../src/facade.js";
import { createRuntime } from "../src/runtime.js";

const EMAIL = "alice.typed@example.test";
const PW = "typed-value-for-this-run-only";
const CODE = "135790";
const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

type Outcome = "ok" | "wrong" | "mfa" | "approval";

interface SiteSpec {
  /** Hosts the browser holds a session for. */
  signedIn: Set<string>;
  outcome: Outcome;
}

const MFA_FIELD = 'css input[autocomplete="one-time-code"]';

/**
 * A fake portal for the three recipes the tests use: Supabase (email and password, one-time code, refusal text), GitHub (approval
 * on the phone) and Peecho (two portals, each with its own session). The session lives in `site`, shared by every driver.
 */
function driverFor(site: SiteSpec): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    on: (e, d) => {
      if (e.action === "goto") {
        d.url = e.key;
        const host = new URL(e.key).hostname;
        const home = host === "supabase.com" ? "https://supabase.com/dashboard/account/tokens" : host === "github.com" ? "https://github.com/settings/profile" : `https://${host}/dashboard/orders`;
        if (site.signedIn.has(host)) {
          d.url = home;
          return;
        }
        for (const v of ['css input[type="email"]', 'css input[type="password"]', "css #login_field", "css #password", 'css input[type="email"] >> visible=true', 'css input[type="password"] >> visible=true', 'button "Sign In"', 'css input[type=submit][value="Sign in"]', 'css button[type="submit"] >> visible=true']) d.visible.add(v);
        return;
      }
      if (e.action !== "click") return;
      const host = new URL(d.url).hostname;
      const submit = e.key === 'button "Sign In"' || e.key === 'css input[type=submit][value="Sign in"]' || e.key === 'css button[type="submit"] >> visible=true';
      if (submit) {
        const landed = host === "supabase.com" ? "https://supabase.com/dashboard/account/tokens" : host === "github.com" ? "https://github.com/settings/profile" : `https://${host}/dashboard/orders`;
        if (site.outcome === "ok") {
          site.signedIn.add(host);
          d.url = landed;
        } else if (site.outcome === "wrong") d.pageText.add("Invalid login credentials");
        else if (site.outcome === "mfa") {
          d.visible.add(MFA_FIELD);
          d.visible.add('css button[type="submit"]');
        }
        else d.pageText.add("GitHub Mobile");
        return;
      }
      if (e.key === 'css button[type="submit"]' && d.visible.has(MFA_FIELD)) {
        d.visible.delete(MFA_FIELD);
        site.signedIn.add(host);
        d.url = "https://supabase.com/dashboard/account/tokens";
      }
    },
  });
}

async function setup(opts: { outcome?: Outcome; signedIn?: string[] } = {}) {
  const site: SiteSpec = { signedIn: new Set(opts.signedIn ?? []), outcome: opts.outcome ?? "ok" };
  const dir = await mkdtemp(join(tmpdir(), "sd-recipe-signin-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const drivers: FakeDriver[] = [];
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    persistSignIn: false,
    automationDriver: () => {
      const d = driverFor(site);
      drivers.push(d);
      return d;
    },
  });
  return { rt, site, drivers };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
type Rt = Awaited<ReturnType<typeof setup>>["rt"];
const stateOf = (rt: Rt, id: string) => getRecipeSignInState(rt, human, id);
const finished = (rt: Rt, id: string) => ["done", "failed", "cancelled"].includes(stateOf(rt, id).status);
const body = (extra: Record<string, unknown> = {}) => ({ username: EMAIL, password: PW, ...extra });
const typedBy = (drivers: FakeDriver[]): string[] => drivers.flatMap((d) => [...d.filled].map(([sel, value]) => `${sel}=${value}`));

function expectClean(label: string, text: string): void {
  for (const secret of [EMAIL, PW, CODE]) expect(text, `${label} leaks a typed value`).not.toContain(secret);
}

describe("recipe sign-in: the plain sign-in of a browser-only vendor", () => {
  it("signs in, creates nothing and remembers the sign-in at the host as a connect", async () => {
    const { rt, drivers } = await setup();
    const first = startRecipeSignIn(rt, human, "supabase-access-token", body());
    expect(first).toMatchObject({ status: "running", kind: "signin", needs: null });
    await until(() => finished(rt, "supabase-access-token"));
    const end = stateOf(rt, "supabase-access-token");
    expect(end).toMatchObject({ status: "done", text: "Signed in.", needs: null });
    expect(end.timeline?.map((x) => x.phase)).toEqual(["opening", "username", "password", "signed-in"]);
    expect(end.timeline?.every((x) => x.state === "done")).toBe(true);
    expect(end.result).toBeUndefined();
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "supabase.com", signedIn: true, source: "connect" }]);
    // No key was created and nothing was stored: only the sign-in pages were opened and typed into.
    expect(drivers.flatMap((d) => d.calls).filter((c) => c.startsWith("goto"))).toEqual(["goto https://supabase.com/dashboard/sign-in"]);
    expect((await rt.connections.status("supabase")).connected).toBe(false);
    // Typed once each; the credentials are nowhere in the state or the sign-in memory.
    expect(typedBy(drivers).filter((t) => t.includes(EMAIL))).toHaveLength(1);
    expect(typedBy(drivers).filter((t) => t.includes(PW))).toHaveLength(1);
    expectClean("state", JSON.stringify(end));
    expectClean("automation info", JSON.stringify(rt.automation.info()));
  });

  it("answers a wrong password with the provider's refusal in both languages and remembers nothing", async () => {
    const { rt } = await setup({ outcome: "wrong" });
    startRecipeSignIn(rt, human, "supabase-access-token", body());
    await until(() => finished(rt, "supabase-access-token"));
    const end = stateOf(rt, "supabase-access-token");
    expect(end.status).toBe("failed");
    expect(end.failure).toEqual({ code: "rejected", message: "Supabase hat E-Mail oder Passwort abgelehnt.", messageEn: "Supabase rejected the email or password." });
    expect(rt.automation.signInChecks()).toEqual([]);
    expectClean("state", JSON.stringify(end));
  });

  it("asks for the one-time code, types it once and goes on", async () => {
    const { rt, drivers } = await setup({ outcome: "mfa" });
    startRecipeSignIn(rt, human, "supabase-access-token", body());
    await until(() => stateOf(rt, "supabase-access-token").needs === "mfa-code");
    expect(stateOf(rt, "supabase-access-token")).toMatchObject({ status: "waiting-human", phase: "code" });
    expect(() => submitRecipeCode(rt, human, "supabase-access-token", { code: "12" })).toThrow(InventoryError);
    expectClean("state after code", JSON.stringify(submitRecipeCode(rt, human, "supabase-access-token", { code: ` ${CODE.slice(0, 3)} ${CODE.slice(3)} ` })));
    await until(() => finished(rt, "supabase-access-token"));
    const end = stateOf(rt, "supabase-access-token");
    expect(end.status).toBe("done");
    expect(end.timeline?.map((x) => x.phase)).toContain("code");
    expect(typedBy(drivers).filter((t) => t.endsWith(`=${CODE}`))).toHaveLength(1);
    expect(() => submitRecipeCode(rt, human, "supabase-access-token", { code: CODE })).toThrow(IssuanceError);
    expectClean("state", JSON.stringify(end));
  });

  it("tells the human about an approval on the device and goes on when it arrives", async () => {
    const { rt, site, drivers } = await setup({ outcome: "approval" });
    startRecipeSignIn(rt, human, "github-fine-grained-token", body());
    await until(() => stateOf(rt, "github-fine-grained-token").needs === "approval");
    expect(stateOf(rt, "github-fine-grained-token")).toMatchObject({ status: "waiting-human", phase: "approval" });
    expect(() => submitRecipeConfirm(rt, human, "github-fine-grained-token", { accept: true })).toThrow(IssuanceError);
    // The human approves elsewhere: the page moves on.
    site.signedIn.add("github.com");
    drivers[0]!.pageText.clear();
    drivers[0]!.url = "https://github.com/settings/profile";
    await until(() => finished(rt, "github-fine-grained-token"));
    expect(stateOf(rt, "github-fine-grained-token").status).toBe("done");
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "github.com", signedIn: true, source: "connect" }]);
  });

  it("cancels while the code prompt is open and remembers nothing", async () => {
    const { rt } = await setup({ outcome: "mfa" });
    startRecipeSignIn(rt, human, "supabase-access-token", body());
    await until(() => stateOf(rt, "supabase-access-token").needs === "mfa-code");
    cancelRecipeSignIn(rt, human, "supabase-access-token");
    await until(() => finished(rt, "supabase-access-token"));
    expect(stateOf(rt, "supabase-access-token")).toMatchObject({ status: "cancelled", needs: null });
    expect(() => submitRecipeCode(rt, human, "supabase-access-token", { code: CODE })).toThrow(IssuanceError);
    expect(() => cancelRecipeSignIn(rt, human, "supabase-access-token")).toThrow(IssuanceError);
    expect(rt.automation.signInChecks()).toEqual([]);
  });

  it("is one browser run at a time: a second sign-in is refused and the refused credentials are not kept", async () => {
    const { rt } = await setup({ outcome: "mfa" });
    startRecipeSignIn(rt, human, "supabase-access-token", body());
    await until(() => stateOf(rt, "supabase-access-token").needs === "mfa-code");
    const second = body({ username: "bob.second@example.test", password: "second-typed-password" });
    expect(() => startRecipeSignIn(rt, human, "github-fine-grained-token", second)).toThrow(/already in progress/);
    expect(() => startRecipeSignIn(rt, human, "supabase-access-token", body())).toThrow(IssuanceError);
    expect(stateOf(rt, "github-fine-grained-token").status).toBe("idle");
    // A sign-in check queues behind it with a stable code instead of an error.
    expect(await checkRecipeSession(rt, human, "github-fine-grained-token")).toMatchObject({ signedIn: false, failure: { code: "busy" } });
    cancelRecipeSignIn(rt, human, "supabase-access-token");
    await until(() => finished(rt, "supabase-access-token"));
  });
});

describe("recipe sign-in: a recipe with several portals", () => {
  const PEECHO_TEST = "test.www.peecho.com";
  const PEECHO_LIVE = "www.peecho.com";

  it("needs the portal and opens nothing without it", async () => {
    const { rt, drivers } = await setup();
    expect(() => startRecipeSignIn(rt, human, "peecho-api-keys", body())).toThrow(/Choose the portal/);
    expect(() => startRecipeSignIn(rt, human, "peecho-api-keys", body({ host: "evil.example.com" }))).toThrow(/Choose the portal/);
    expect(drivers).toHaveLength(0);
    expect(stateOf(rt, "peecho-api-keys").status).toBe("idle");
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("signs in at the chosen portal only (by parameter value or by host) and remembers that host", async () => {
    const { rt, drivers } = await setup();
    startRecipeSignIn(rt, human, "peecho-api-keys", body({ host: "test" }));
    await until(() => finished(rt, "peecho-api-keys"));
    expect(stateOf(rt, "peecho-api-keys").status).toBe("done");
    expect(drivers.flatMap((d) => d.calls).filter((c) => c.startsWith("goto"))).toEqual([`goto https://${PEECHO_TEST}/dashboard`]);
    expect(rt.automation.signInChecks().map((c) => [c.host, c.signedIn, c.source])).toEqual([[PEECHO_TEST, true, "connect"]]);

    startRecipeSignIn(rt, human, "peecho-api-keys", body({ host: PEECHO_LIVE }));
    await until(() => finished(rt, "peecho-api-keys") && rt.automation.signInChecks().length === 2);
    expect(Object.fromEntries(rt.automation.signInChecks().map((c) => [c.host, c.signedIn]))).toEqual({ [PEECHO_TEST]: true, [PEECHO_LIVE]: true });
  });

  it("lists the sign-in methods and the portals of each recipe in the automation info", async () => {
    const { rt } = await setup();
    const info = rt.automation.info().recipes;
    expect(info.find((r) => r.id === "supabase-access-token")).toMatchObject({ canCheckSignIn: true, signInPasswordless: false, signInMethods: [{ id: "email" }, { id: "github" }] });
    expect(info.find((r) => r.id === "peecho-api-keys")).toMatchObject({ hostBy: "portal", signInMethods: [{ id: "email" }] });
    expect(info.find((r) => r.id === "openai-api-key")).toMatchObject({ canCheckSignIn: false, signInMethods: [] });
  });
});

describe("recipe sign-in: refusals", () => {
  it("is for humans: an agent is refused and nothing starts", async () => {
    const { rt, drivers } = await setup();
    expect(() => startRecipeSignIn(rt, agent, "supabase-access-token", body())).toThrow(PolicyError);
    expect(() => getRecipeSignInState(rt, agent, "supabase-access-token")).toThrow(PolicyError);
    expect(() => submitRecipeCode(rt, agent, "supabase-access-token", { code: CODE })).toThrow(PolicyError);
    expect(() => cancelRecipeSignIn(rt, agent, "supabase-access-token")).toThrow(PolicyError);
    expect(drivers).toHaveLength(0);
  });

  it("refuses an unknown recipe, one without a guided sign-in, bad input and a method the recipe does not offer", async () => {
    const { rt, drivers } = await setup();
    expect(() => startRecipeSignIn(rt, human, "nope", body())).toThrow(InventoryError);
    expect(() => startRecipeSignIn(rt, human, "openai-api-key", body())).toThrow(/no guided sign-in/);
    expect(() => startRecipeSignIn(rt, human, "supabase-access-token", { password: PW })).toThrow(InventoryError);
    expect(() => startRecipeSignIn(rt, human, "supabase-access-token", { username: EMAIL })).toThrow(InventoryError);
    expect(() => startRecipeSignIn(rt, human, "supabase-access-token", body({ method: "apple" }))).toThrow(/does not offer/);
    expect(() => getRecipeSignInState(rt, human, "nope")).toThrow(InventoryError);
    expect(drivers).toHaveLength(0);
  });

  it("is off with browser automation", async () => {
    const { rt } = await setup();
    (rt.automation as { enabled: boolean }).enabled = false;
    expect(() => startRecipeSignIn(rt, human, "supabase-access-token", body())).toThrow(/automation is off/);
  });
});
