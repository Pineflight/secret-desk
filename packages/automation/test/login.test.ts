import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, LoginError, RecipeSchema, checkSession, loadRecipeFile, signIn, type LoginEvent, type Recipe } from "../src/index.js";
import { sampleRecipe } from "./helpers.js";

const EMAIL = "niklas.example@example.test";
const TYPED_PW = "fake-typed-value-1";
const CODE = "424242";
const APP = "https://example.test/app/home";

const FORM = {
  start: "https://example.test/login",
  home: "https://example.test/",
  steps: [
    { waitFor: { visible: { css: "#email" }, timeoutSeconds: 0.05 } },
    { fill: { css: "#email", value: "{{login.username}}" } },
    { click: { role: "button", name: "Next" } },
    { waitFor: { visible: { css: "#pw" }, timeoutSeconds: 0.05 } },
    { fill: { css: "#pw", value: "{{login.password}}" } },
    { click: { role: "button", name: "Log in" } },
  ],
  mfa: { detect: { visible: { css: "#code" } }, field: { css: "#code" }, submit: { role: "button", name: "Verify" } },
  approval: { detect: { text: "Check your email" }, message: "Bitte bestaetigen", messageEn: "Please approve" },
  captcha: { detect: { visible: { css: "#challenge" } }, message: "CAPTCHA", messageEn: "Solve the CAPTCHA" },
  failure: [{ detect: { text: "Wrong password" }, message: "Falsches Passwort", messageEn: "Wrong password entered" }],
};

function recipe(form: Record<string, unknown> = FORM, expect: Record<string, unknown> = { url: "^https://example\\.test/app" }): Recipe {
  return sampleRecipe({ login: { expect, form } });
}

type Outcome = "ok" | "wrong" | "mfa" | "approval" | "captcha" | "foreign";

/** A fake sign-in site. `outcome` is what happens after the password step; "foreign" redirects after the email step. */
function site(outcome: Outcome, opts: { signedIn?: boolean; goodCode?: boolean } = {}): FakeDriver {
  return new FakeDriver({
    pollMs: 2,
    visible: ['button "Next"', 'button "Log in"', 'button "Verify"'],
    on: (e, d) => {
      if (e.action === "goto") {
        d.url = e.key;
        if (opts.signedIn) d.url = APP;
        else if (e.key.endsWith("/login")) d.visible.add("css #email");
        return;
      }
      if (e.key === 'button "Next"') {
        if (outcome === "foreign") d.url = "https://evil.test/login";
        d.visible.add("css #pw");
      }
      if (e.key === 'button "Log in"') {
        if (outcome === "ok") d.url = APP;
        if (outcome === "wrong") d.pageText.add("Wrong password");
        if (outcome === "mfa") d.visible.add("css #code");
        if (outcome === "approval") d.pageText.add("Check your email");
        if (outcome === "captcha") d.visible.add("css #challenge");
      }
      if (e.key === 'button "Verify"') {
        if (opts.goodCode !== false) {
          d.visible.delete("css #code");
          d.url = APP;
        }
      }
    },
  });
}

const creds = () => ({ username: EMAIL, password: TYPED_PW });
const fast = { pollMs: 2, settleMs: 5 };

async function error(p: Promise<unknown>): Promise<LoginError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LoginError);
  return e as LoginError;
}

/** Nothing the human typed may show up in this. */
function expectClean(text: string): void {
  for (const secret of [EMAIL, TYPED_PW, CODE]) expect(text).not.toContain(secret);
}

describe("signIn", () => {
  it("types email and password into the recipe's fields and reports each step", async () => {
    const d = site("ok");
    const events: LoginEvent[] = [];
    const c = creds();
    const r = await signIn(recipe(), c, d, { onEvent: (e) => events.push(e) }, fast);
    expect(r.url).toBe("https://example.test/app/home");
    expect(d.filled.get("css #email")).toBe(EMAIL);
    expect(d.filled.get("css #pw")).toBe(TYPED_PW);
    expect(events.map((e) => (e.type === "entered" ? `entered:${e.field}` : e.type))).toEqual(["opening", "entered:username", "submitted", "entered:password", "submitted", "signed-in"]);
    expect(d.opened && d.closed).toBe(true);
    expectClean(JSON.stringify({ events, r }));
  });

  it("wipes the credentials from the object when the run ends", async () => {
    const c = creds();
    await signIn(recipe(), c, site("ok"), {}, fast);
    expect(c).toEqual({ username: "", password: "" });
    const c2 = creds();
    await error(signIn(recipe(), c2, site("wrong"), {}, fast));
    expect(c2).toEqual({ username: "", password: "" });
  });

  it("takes no screenshots and leaves the credentials out of the driver calls other than fill", async () => {
    const d = site("ok");
    await signIn(recipe(), creds(), d, {}, fast);
    expect(d.shots).toHaveLength(0);
    expectClean(d.calls.join("\n"));
  });

  it("does not type anything when the browser is already signed in", async () => {
    const d = site("ok", { signedIn: true });
    const events: LoginEvent[] = [];
    await signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e) }, fast);
    expect(d.filled.size).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["opening", "signed-in"]);
  });

  it("waits for a delayed redirect of a signed-in browser instead of failing on the missing form", async () => {
    const d = new FakeDriver({
      pollMs: 2,
      on: (e, drv) => {
        if (e.action === "goto") setTimeout(() => (drv.url = APP), 20);
      },
    });
    const events: LoginEvent[] = [];
    await signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e) }, { ...fast, landingMs: 2000 });
    expect(d.filled.size).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["opening", "signed-in"]);
  });

  it("goes on with the form as soon as it shows up, without waiting for the landing time", async () => {
    const d = site("ok");
    const started = Date.now();
    await signIn(recipe(), creds(), d, {}, { ...fast, landingMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d.filled.size).toBe(2);
  });

  it("reports the provider's refusal with its own text and no credentials", async () => {
    const e = await error(signIn(recipe(), creds(), site("wrong"), {}, fast));
    expect(e.kind).toBe("rejected");
    expect(e.message).toBe("Falsches Passwort");
    expect(e.messageEn).toBe("Wrong password entered");
    expectClean(`${e.message} ${e.messageEn} ${e.stack}`);
  });

  it("asks for the one-time code once, types it and drops it", async () => {
    const d = site("mfa");
    const events: LoginEvent[] = [];
    let asked = 0;
    const r = await signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e), requestCode: async () => (asked += 1, CODE) }, fast);
    expect(asked).toBe(1);
    expect(d.filled.get("css #code")).toBe(CODE);
    expect(r.url).toBe("https://example.test/app/home");
    expect(events.filter((e) => e.type === "needs" || e.type === "resumed")).toEqual([
      { type: "needs", need: "mfa-code" },
      { type: "resumed", need: "mfa-code" },
    ]);
    expectClean(JSON.stringify(events));
  });

  it("stops after too many codes without repeating the password", async () => {
    const d = site("mfa", { goodCode: false });
    let asked = 0;
    const e = await error(signIn(recipe(), creds(), d, { requestCode: async () => (asked += 1, CODE) }, { ...fast, maxCodeAttempts: 2 }));
    expect(asked).toBe(2);
    expect(e.kind).toBe("code");
    expect(d.calls.filter((c) => c.startsWith("fill css #pw"))).toHaveLength(1);
    expectClean(e.message);
  });

  it("fails when a code is needed but nobody can be asked", async () => {
    const e = await error(signIn(recipe(), creds(), site("mfa"), {}, fast));
    expect(e.kind).toBe("unsupported");
  });

  it("gives up when the human cancels the code prompt", async () => {
    const e = await error(signIn(recipe(), creds(), site("mfa"), { requestCode: () => Promise.reject(new Error("no")) }, fast));
    expect(e.kind).toBe("abort");
  });

  it("waits for an approval and continues when it arrives", async () => {
    const d = site("approval");
    const events: LoginEvent[] = [];
    const run = signIn(recipe(), creds(), d, { onEvent: (e) => events.push(e) }, fast);
    await new Promise((r) => setTimeout(r, 40));
    expect(events.some((e) => e.type === "needs" && e.need === "approval")).toBe(true);
    d.url = APP;
    await run;
    expect(events.map((e) => e.type)).toContain("resumed");
    expect(events.at(-1)?.type).toBe("signed-in");
    const needs = events.find((e) => e.type === "needs");
    expect(needs).toMatchObject({ message: "Bitte bestaetigen", messageEn: "Please approve" });
  });

  it("fails on a CAPTCHA that stays, without sending the human to the browser", async () => {
    const e = await error(signIn(recipe(), creds(), site("captcha"), {}, { ...fast, captchaGraceMs: 20 }));
    expect(e.kind).toBe("captcha");
    expect(e.messageEn).toBe("Solve the CAPTCHA");
  });

  it("does not fail on a challenge frame that goes away again", async () => {
    const d = site("captcha");
    const run = signIn(recipe(), creds(), d, {}, { ...fast, captchaGraceMs: 500 });
    await new Promise((r) => setTimeout(r, 40));
    d.visible.delete("css #challenge");
    d.url = APP;
    await run;
  });

  it("times out while waiting for an approval", async () => {
    const e = await error(signIn(recipe(), creds(), site("approval"), {}, { ...fast, timeoutMinutes: 0.0005 }));
    expect(e.kind).toBe("timeout");
    expectClean(e.message);
  });

  it("can be cancelled while waiting", async () => {
    const ctl = new AbortController();
    const d = site("approval");
    const run = error(signIn(recipe(), creds(), d, {}, { ...fast, signal: ctl.signal }));
    await new Promise((r) => setTimeout(r, 30));
    ctl.abort();
    expect((await run).kind).toBe("abort");
    expect(d.closed).toBe(true);
  });

  it("aborts when the page leaves the recipe's host and never types the password there", async () => {
    const d = site("foreign");
    const e = await error(signIn(recipe(), creds(), d, {}, fast));
    expect(e.kind).toBe("host");
    expect(e.message).toContain("evil.test");
    expect(d.filled.has("css #pw")).toBe(false);
    expect(d.calls.some((c) => c.includes("#pw") && c.startsWith("fill"))).toBe(false);
    expectClean(e.message);
  });

  it("aborts at once when the sign-in page itself redirects away", async () => {
    const d = new FakeDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = "https://evil.test/")) });
    const e = await error(signIn(recipe(), creds(), d, {}, fast));
    expect(e.kind).toBe("host");
    expect(d.filled.size).toBe(0);
  });

  it("does not leak the credentials through a failing step", async () => {
    // The password field never shows up: the step error names the step, not the value.
    const d = new FakeDriver({
      visible: ['button "Next"'],
      on: (e, dd) => {
        if (e.action === "goto") dd.url = e.key;
        if (e.action === "goto") dd.visible.add("css #email");
      },
    });
    const e = await error(signIn(recipe(), creds(), d, {}, fast));
    expect(e.kind).toBe("step");
    expect(e.message).toMatch(/Sign-in step 4/);
    expectClean(`${e.message} ${d.calls.join("\n").replace(/fill css #email/, "")}`);
  });

  it("redacts the credentials if a step error would contain them", async () => {
    const d = site("ok");
    const original = d.fill.bind(d);
    d.fill = async (sel, value) => {
      await original(sel, value);
      if (value === TYPED_PW) throw new Error(`fill("${TYPED_PW}") timed out`);
    };
    const e = await error(signIn(recipe(), creds(), d, {}, fast));
    expect(e.kind).toBe("step");
    expectClean(e.message);
  });

  it("rejects a recipe without a guided sign-in", async () => {
    const e = await error(signIn(sampleRecipe(), creds(), site("ok"), {}, fast));
    expect(e.kind).toBe("unsupported");
  });
});

describe("passwordless email sign-in", () => {
  const FORM_CODE = { ...FORM, passwordless: true, steps: FORM.steps.slice(0, 3) };
  const emailSite = (): FakeDriver =>
    new FakeDriver({
      pollMs: 2,
      visible: ['button "Next"', 'button "Verify"'],
      on: (e, d) => {
        if (e.action === "goto") {
          d.url = e.key;
          if (e.key.endsWith("/login")) d.visible.add("css #email");
          return;
        }
        if (e.key === 'button "Next"') d.visible.add("css #code");
        if (e.key === 'button "Verify"') {
          d.visible.delete("css #code");
          d.url = APP;
        }
      },
    });

  it("types only the email, asks for the emailed code and never fills a password", async () => {
    const d = emailSite();
    const events: LoginEvent[] = [];
    const r = await signIn(recipe(FORM_CODE), { username: EMAIL, password: "" }, d, { onEvent: (e) => events.push(e), requestCode: async () => CODE }, fast);
    expect(r.url).toBe("https://example.test/app/home");
    expect(d.filled.get("css #email")).toBe(EMAIL);
    expect(d.filled.get("css #code")).toBe(CODE);
    expect(d.filled.has("css #pw")).toBe(false);
    expect(events.filter((e) => e.type === "entered")).toEqual([{ type: "entered", field: "username" }]);
    expectClean(JSON.stringify({ events, r }));
  });
});

describe("checkSession", () => {
  it("is signed in when the home page leads to a signed-in page", async () => {
    const d = new FakeDriver({ pollMs: 2, on: (e, dd) => void (e.action === "goto" && (dd.url = APP)) });
    expect(await checkSession(recipe(), d, { timeoutSeconds: 1, pollMs: 2 })).toEqual({ signedIn: true, url: "https://example.test/app/home" });
    expect(d.closed).toBe(true);
    expect(d.calls).toContain("goto https://example.test/");
  });

  it("is signed out when the sign-in page shows up instead", async () => {
    const d = new FakeDriver({ pollMs: 2, on: (e, dd) => void (e.action === "goto" && (dd.url = "https://example.test/login")) });
    expect(await checkSession(recipe(), d, { timeoutSeconds: 0.05, pollMs: 2 })).toMatchObject({ signedIn: false });
  });

  it("treats a navigation interrupted by a redirect as arrived when the browser is on an allowed page", async () => {
    const d = new FakeDriver({ pollMs: 2, on: (e, dd) => { if (e.action === "goto") { dd.url = APP; throw new Error("page.goto: interrupted by another navigation"); } } });
    expect(await checkSession(recipe(), d, { timeoutSeconds: 1, pollMs: 2 })).toEqual({ signedIn: true, url: "https://example.test/app/home" });
  });

  it("fails with the kind page when the page does not open and the browser is nowhere useful", async () => {
    const d = new FakeDriver({ on: (e, dd) => { if (e.action === "goto") { dd.url = "chrome-error://chromewebdata/"; throw new Error("net::ERR_CONNECTION_REFUSED"); } } });
    const e = await error(checkSession(recipe(), d, { timeoutSeconds: 0.05, pollMs: 2 }));
    expect(e.kind).toBe("page");
    expect(d.closed).toBe(true);
  });

  it("is signed out on a foreign host", async () => {
    const d = new FakeDriver({ on: (e, dd) => void (e.action === "goto" && (dd.url = "https://evil.test/app")) });
    expect(await checkSession(recipe(), d, { timeoutSeconds: 0.05, pollMs: 2 })).toEqual({ signedIn: false, url: "" });
  });
});

describe("login.form schema", () => {
  const parse = (form: Record<string, unknown>) => RecipeSchema.safeParse({ ...sampleRecipe(), login: { expect: { url: "^https://example\\.test/" }, form } });
  const messages = (form: Record<string, unknown>): string => {
    const r = parse(form);
    return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
  };

  it("accepts the form used by the tests and the bundled RevenueCat recipe", async () => {
    expect(parse(FORM).success).toBe(true);
    const rc = await loadRecipeFile(resolve(import.meta.dirname, "../../../recipes/revenuecat-secret-api-key.yaml"));
    expect(rc.login?.form?.start).toBe("https://app.revenuecat.com/login");
  });

  it("allows the sign-in variables only in the value of a fill", () => {
    const step = (s: unknown) => ({ ...FORM, steps: [...FORM.steps, s] });
    expect(messages(step({ click: { css: "#{{login.password}}" } }))).toMatch(/Only the value of a fill/);
    expect(messages(step({ fill: { css: "#{{login.username}}", value: "x" } }))).toMatch(/Only the value of a fill/);
    expect(messages(step({ fill: { css: "#a", value: "{{name}}" } }))).toMatch(/Unknown variable/);
    expect(messages({ ...FORM, failure: [{ detect: { text: "{{login.password}}" }, message: "x" }] })).toMatch(/No variables/);
  });

  it("keeps the sign-in variables out of every other part of a recipe", () => {
    const r = RecipeSchema.safeParse({ ...sampleRecipe(), steps: [{ fill: { label: "Name", value: "{{login.password}}" } }, { click: { role: "button", name: "Create", createsToken: true } }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as { error: unknown }).error)).toMatch(/Unbekannte Variable/);
  });

  it("a passwordless form needs only the email variable, and must not use the password one", () => {
    const emailOnly = FORM.steps.filter((x) => !JSON.stringify(x).includes("#pw") && !JSON.stringify(x).includes("Log in"));
    expect(messages({ ...FORM, steps: emailOnly })).toMatch(/login\.password/);
    expect(parse({ ...FORM, passwordless: true, steps: emailOnly }).success).toBe(true);
    expect(messages({ ...FORM, passwordless: true })).toMatch(/passwordless sign-in must not use/);
    expect(messages({ ...FORM, passwordless: true, steps: FORM.steps.filter((x) => !JSON.stringify(x).includes("login.username")) })).toMatch(/login\.username/);
  });

  it("requires both variables, step kinds fill/click/waitFor, and addresses on the recipe's host", () => {
    expect(messages({ ...FORM, steps: FORM.steps.filter((s) => !JSON.stringify(s).includes("login.password")) })).toMatch(/login\.password/);
    expect(messages({ ...FORM, steps: [...FORM.steps, { goto: "https://example.test/x" }] })).toMatch(/fill, click or waitFor/);
    expect(messages({ ...FORM, start: "https://evil.test/login" })).toMatch(/nicht host\/allowHosts/);
    expect(messages({ ...FORM, start: "https://example.test/{{login.username}}" })).toMatch(/variables/);
    expect(messages({ ...FORM, steps: [...FORM.steps, { click: { css: "#x", createsToken: true } }] })).toMatch(/must not create a token/);
  });
});
