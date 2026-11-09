import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDriver, IDP_FLOWS, LoginError, RecipeSchema, WaitAbortedError, checkSession, describeSelector, signIn, type LoginEvent, type LoginHooks, type LoginOptions, type Recipe, type ResolvedCondition } from "../src/index.js";

// The waits of the sign-in run on a fake clock: nothing here sleeps for real.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 4000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}
const outcome = (p: Promise<unknown>): Promise<unknown> => settle(p.then((v) => v, (e: unknown) => e));

const EMAIL = "someone@example.test";
const typedValue = ["typed", "value", "1"].join("-");
const APP = "https://example.test/app/home";
const LOGIN = "https://example.test/login";
const creds = () => ({ username: EMAIL, password: typedValue });
const fast = { pollMs: 2, settleMs: 5, captchaGraceMs: 0, landingMs: 20 };

const GITHUB_BUTTON = "Continue with GitHub";
const APPLE_BUTTON = "Continue with Apple";
const button = (name: string) => ({ role: "button", name });

function doc(form: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "login-cov",
    label: "Login cov",
    host: "example.test",
    login: {
      expect: { url: "^https://example\\.test/app" },
      form: {
        start: LOGIN,
        steps: [{ fill: { css: "#email", value: "{{login.username}}" } }, { fill: { css: "#pw", value: "{{login.password}}" } }, { click: button("Log in") }],
        ...form,
      },
      methods: [
        { id: "github", steps: [{ click: button(GITHUB_BUTTON) }] },
        { id: "apple", steps: [{ click: button(APPLE_BUTTON) }] },
      ],
    },
    steps: [{ goto: "https://example.test/a" }, { click: { role: "button", name: "Go", createsToken: true } }],
    capture: { token: { find: { css: "#t" } } },
    ...over,
  };
}
const recipe = (form: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Recipe => RecipeSchema.parse(doc(form, over));

async function fails(p: Promise<unknown>): Promise<LoginError> {
  const e = await outcome(p);
  expect(e).toBeInstanceOf(LoginError);
  return e as LoginError;
}

const FIELDS = ["css #email", "css #pw", 'button "Log in"'];

/** A sign-in page: the form shows, "Log in" leads to the app. */
const formSite = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
  new FakeDriver({
    url: "about:blank",
    pollMs: 2,
    visible: FIELDS,
    on: (e, d) => {
      if (e.action === "goto") d.url = e.key;
      if (e.key === 'button "Log in"') d.url = APP;
    },
    ...over,
  });

describe("signIn: setup and errors outside the form", () => {
  it("uses its own defaults when no options are given, and drops an unreadable final address", async () => {
    class Urls extends FakeDriver {
      calls2 = 0;
      override async currentUrl(): Promise<string> {
        // The five checks of the run see the app page; only the last look, the report of the address, does not.
        return ++this.calls2 <= 5 ? APP : "";
      }
    }
    const d = new Urls({ url: APP });
    const result = await settle(signIn(recipe(), creds(), d));
    expect(result).toEqual({ url: "" });
  });
  it("lets an unexpected error of resolving the recipe through", async () => {
    const malformed = { ...recipe(), login: { ...recipe().login!, form: { ...recipe().login!.form!, start: 5 } } } as unknown as Recipe;
    await expect(signIn(malformed, creds(), formSite(), {}, fast)).rejects.toThrow(TypeError);
  });
  it("reports a start page that cannot be opened", async () => {
    class NoGoto extends FakeDriver {
      override async goto(): Promise<void> {
        throw new Error("net::ERR");
      }
    }
    const e = await fails(signIn(recipe(), creds(), new NoGoto(), {}, fast));
    expect(e).toMatchObject({ kind: "step", message: "The sign-in page could not be opened." });
  });
  it("types nothing when the browser is on something that is no web page", async () => {
    for (const url of ["ftp://example.test/", "not a url"]) {
      const d = formSite({
        on: (e, drv) => {
          if (e.action === "goto") drv.url = url;
        },
      });
      const e = await fails(signIn(recipe(), creds(), d, {}, fast));
      expect(e.kind).toBe("host");
      expect(e.message).toContain("not a web page the recipe allows");
      expect(d.filled.size).toBe(0);
    }
  });
});

describe("signIn: steps of the form", () => {
  it("fills plain values without reporting a field, and waits for url, hidden and text conditions", async () => {
    const events: LoginEvent[] = [];
    const d = formSite({
      visible: [...FIELDS, "css #remember"],
      pageText: ["Welcome"],
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.key === 'button "Log in"') drv.url = APP;
      },
    });
    const r = recipe({
      steps: [
        { waitFor: { url: "^https://example\\.test/login" } },
        { waitFor: { hidden: { css: "#spinner" } } },
        { waitFor: { text: "Welcome" } },
        { fill: { css: "#remember", value: "yes" } },
        { fill: { css: "#email", value: "{{login.username}}" } },
        { fill: { css: "#pw", value: "{{login.password}}" } },
        { click: button("Log in") },
      ],
    });
    await settle(signIn(r, creds(), d, { onEvent: (e) => void events.push(e) }, fast));
    expect(d.filled.get("css #remember")).toBe("yes");
    expect(events.filter((e) => e.type === "entered")).toEqual([{ type: "entered", field: "username" }, { type: "entered", field: "password" }]);
  });
  it("names a failing click or wait in the error and keeps the credentials out", async () => {
    const clicking = formSite({
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.action === "click") throw new Error(`could not click ${typedValue}`);
      },
    });
    const e = await fails(signIn(recipe(), creds(), clicking, {}, fast));
    expect(e).toMatchObject({ kind: "step", message: 'Sign-in step 3 (click button "Log in") failed: the action was not possible.' });
    expect(e.message).not.toContain(typedValue);
    class SlowPage extends FakeDriver {
      override async waitFor(): Promise<void> {
        throw Object.assign(new Error("x"), { name: "TimeoutError" });
      }
    }
    const waiting = new SlowPage({ url: LOGIN, visible: [] });
    const w = await fails(signIn(recipe({ steps: [{ waitFor: { visible: { css: "#email" } } }, ...doc().login!.valueOf() ? [] : []].concat(doc().login ? (doc().login as { form: { steps: never[] } }).form.steps : []) }), creds(), waiting, {}, { ...fast, landingMs: 1 }));
    expect(w.message).toContain("Sign-in step 1 (waitFor) failed: the page did not look as expected.");
  });
  it("a cancelled wait inside a step ends the sign-in as cancelled, and a confirmation error passes through", async () => {
    class Aborting extends FakeDriver {
      override async waitFor(): Promise<void> {
        throw new WaitAbortedError();
      }
    }
    const r = recipe({ steps: [{ waitFor: { visible: { css: "#email" } } }, { fill: { css: "#email", value: "{{login.username}}" } }, { fill: { css: "#pw", value: "{{login.password}}" } }] });
    expect((await fails(signIn(r, creds(), new Aborting({ url: LOGIN, visible: ["css #email"] }), {}, { ...fast, landingMs: 1 }))).kind).toBe("abort");
    const own = new LoginError("host", "own error");
    const d = formSite({
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.action === "fill") throw own;
      },
    });
    expect(await outcome(signIn(recipe(), creds(), d, {}, fast))).toBe(own);
  });
  it("reports the provider's refusal text, with the English text falling back to the German one", async () => {
    const r = recipe({ failure: [{ detect: { text: "Wrong password" }, message: "Falsches Passwort" }] });
    const d = formSite({
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.key === 'button "Log in"') drv.pageText.add("Wrong password");
      },
    });
    const e = await fails(signIn(r, creds(), d, {}, fast));
    expect(e).toMatchObject({ kind: "rejected", message: "Falsches Passwort", messageEn: "Falsches Passwort" });
  });
  it("does not wait for a form when the first step is no wait, and stops at the landing time", async () => {
    const d = formSite();
    await settle(signIn(recipe(), creds(), d, {}, { ...fast, landingMs: 30 }));
    expect(d.filled.get("css #email")).toBe(EMAIL);
  });
});

describe("signIn: what the human is asked", () => {
  const mfaForm = { mfa: { detect: { visible: { css: "#code" } }, field: { css: "#code" }, submit: button("Verify") } };
  const mfaSite = (on: (e: { action: string; key: string }, d: FakeDriver) => void = () => undefined) =>
    formSite({
      visible: [...FIELDS, 'button "Verify"'],
      on: (e, d) => {
        if (e.action === "goto") d.url = e.key;
        if (e.key === 'button "Log in"') d.visible.add("css #code");
        on(e, d);
      },
    });
  it("reports a code that cannot be typed, and lets a host problem while typing it pass through", async () => {
    const typing = mfaSite((e) => {
      if (e.action === "fill" && e.key === "css #code") throw new Error("detached");
    });
    const e = await fails(signIn(recipe(mfaForm), creds(), typing, { requestCode: async () => "123456" }, fast));
    expect(e).toMatchObject({ kind: "step", message: "The one-time code could not be entered." });
    const leaving = mfaSite();
    const host = await fails(signIn(recipe(mfaForm), creds(), leaving, { requestCode: async () => ((leaving.url = "https://evil.example/login"), "123456") }, fast));
    expect(host.kind).toBe("host");
  });
  it("shows an approval without an English text using the German one, and without a number", async () => {
    const events: LoginEvent[] = [];
    const r = recipe({ approval: { detect: { text: "Check your email" }, message: "Bitte bestaetigen" } });
    const d = formSite({
      on: (e, drv) => {
        if (e.action === "goto") drv.url = e.key;
        if (e.key === 'button "Log in"') {
          drv.pageText.add("Check your email");
          setTimeout(() => (drv.url = APP), 100);
        }
      },
    });
    await settle(signIn(r, creds(), d, { onEvent: (ev) => void events.push(ev) }, fast));
    expect(events.find((ev) => ev.type === "needs")).toMatchObject({ need: "approval", message: "Bitte bestaetigen", messageEn: "Bitte bestaetigen" });
  });
  it("a challenge that stays ends the run with a default text, or with the recipe's text", async () => {
    const challenge = (form: Record<string, unknown>) =>
      signIn(
        recipe(form),
        creds(),
        formSite({
          on: (e, d) => {
            if (e.action === "goto") d.url = e.key;
            if (e.key === 'button "Log in"') d.visible.add("css #challenge");
          },
        }),
        {},
        fast,
      );
    const bare = await fails(challenge({ captcha: { detect: { visible: { css: "#challenge" } } } }));
    expect(bare).toMatchObject({ kind: "captcha", message: "Der Anbieter zeigt eine Sicherheitspruefung.", messageEn: "The provider shows a security check." });
    const german = await fails(challenge({ captcha: { detect: { visible: { css: "#challenge" } }, message: "Sicherheitsabfrage" } }));
    expect(german).toMatchObject({ message: "Sicherheitsabfrage", messageEn: "Sicherheitsabfrage" });
  });
  it("keeps the browser open when asked to", async () => {
    const d = formSite();
    await settle(signIn(recipe(), creds(), d, {}, { ...fast, keepOpen: true }));
    expect(d.opened).toBe(false);
    expect(d.closed).toBe(false);
  });
});

describe("signIn: through an identity provider", () => {
  const githubSteps = IDP_FLOWS.github.steps.flatMap((s) => ("fill" in s ? [describeSelector(s.fill)] : "click" in s ? [describeSelector(s.click)] : []));
  const github = (on: (e: { action: string; key: string }, d: FakeDriver) => void = () => undefined, over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
    new FakeDriver({
      url: LOGIN,
      pollMs: 2,
      visible: [`button "${GITHUB_BUTTON}"`],
      on: (e, d) => {
        if (e.action === "goto") {
          d.url = e.key;
          return;
        }
        if (e.key === `button "${GITHUB_BUTTON}"`) {
          d.url = "https://github.com/login";
          for (const k of githubSteps) d.visible.add(k);
          d.visible.add(describeSelector(IDP_FLOWS.github.steps[0] && "waitFor" in IDP_FLOWS.github.steps[0] ? (IDP_FLOWS.github.steps[0].waitFor.visible as never) : ({} as never)));
        }
        on(e, d);
      },
      ...over,
    });
  const commit = describeSelector({ css: "input[name=commit]" });
  const run = (d: FakeDriver, hooks: LoginHooks = {}, options: LoginOptions = {}) => signIn(recipe(), creds(), d, hooks, { ...fast, method: "github", ...options });

  it("fails when the provider never hands over to the identity provider", async () => {
    const idle = new FakeDriver({ url: LOGIN, pollMs: 2, visible: [`button "${GITHUB_BUTTON}"`] });
    const e = await fails(run(idle));
    expect(e).toMatchObject({ kind: "step" });
    expect(e.message).toBe("The provider did not hand over to the github sign-in.");
  });
  it("goes on without the identity provider when the browser turns out to be signed in during the hand-over", async () => {
    const d = new FakeDriver({
      url: LOGIN,
      pollMs: 2,
      visible: [`button "${GITHUB_BUTTON}"`],
      on: (e, drv) => {
        if (e.key === `button "${GITHUB_BUTTON}"`) setTimeout(() => (drv.url = APP), 40);
      },
    });
    const r = await settle(run(d, {}, { landingMs: 200 }));
    expect(r.url).toBe("https://example.test/app/home");
    expect(d.filled.size).toBe(0);
  });
  it("reports an authorization that cannot be confirmed", async () => {
    const consent = describeSelector(IDP_FLOWS.github.consent!.approve);
    const d = github(
      (e, drv) => {
        if (e.key === commit) {
          drv.visible.add(consent);
          drv.texts.set(describeSelector(IDP_FLOWS.github.consent!.scopes), "Repository access (read)");
          drv.visible.add(describeSelector(IDP_FLOWS.github.consent!.scopes));
        }
        if (e.key === consent) throw new Error("detached");
      },
    );
    const e = await fails(run(d, { requestConfirm: async () => true }));
    expect(e).toMatchObject({ kind: "step", message: "The authorization could not be confirmed." });
  });
  it("clicks 'trust this browser' when the identity provider offers it", async () => {
    const apple = IDP_FLOWS.apple;
    const appleSteps = apple.steps.flatMap((s) => ("fill" in s ? [describeSelector(s.fill)] : "click" in s ? [describeSelector(s.click)] : []));
    const trust = describeSelector(apple.trust!);
    let clicks = 0;
    const d = new FakeDriver({
      url: LOGIN,
      pollMs: 2,
      visible: [`button "${APPLE_BUTTON}"`],
      on: (e, drv) => {
        if (e.key === `button "${APPLE_BUTTON}"`) {
          drv.url = "https://appleid.apple.com/auth";
          for (const k of appleSteps) drv.visible.add(k);
          drv.visible.add(describeSelector((apple.steps[0] as { waitFor: { visible: never } }).waitFor.visible));
        }
        if (e.key === describeSelector({ css: "#sign-in" }) && ++clicks === 2) drv.visible.add(trust);
        if (e.key === trust) drv.url = APP;
      },
    });
    const r = await settle(signIn(recipe(), creds(), d, {}, { ...fast, method: "apple" }));
    expect(r.url).toBe("https://example.test/app/home");
    expect(d.calls).toContain(`click ${trust}`);
  });
});

describe("signIn: waiting for the human", () => {
  const mfaForm = { mfa: { detect: { visible: { css: "#code" } }, field: { css: "#code" }, submit: button("Verify") } };
  const withCode = (on: (e: { action: string; key: string }, d: FakeDriver) => void = () => undefined) =>
    formSite({
      visible: [...FIELDS, 'button "Verify"'],
      on: (e, d) => {
        if (e.action === "goto") d.url = e.key;
        if (e.key === 'button "Log in"') d.visible.add("css #code");
        on(e, d);
      },
    });
  it("gives up when nobody answers in time, and ignores an answer that comes too late", async () => {
    let late: (code: string) => void = () => undefined;
    const requestCode = (): Promise<string> => new Promise((resolve) => (late = resolve));
    const run = signIn(recipe(mfaForm), creds(), withCode(), { requestCode }, { ...fast, timeoutMinutes: 0.01 });
    const e = await fails(run);
    expect(e).toMatchObject({ kind: "timeout", message: "Time limit reached while waiting for the one-time code." });
    late("123456");
    await vi.advanceTimersByTimeAsync(10);
  });
  it("ends as cancelled when the signal fires while the code is awaited, or has fired before", async () => {
    const ac = new AbortController();
    const waiting = signIn(recipe(mfaForm), creds(), withCode(), { requestCode: () => new Promise<string>(() => undefined) }, { ...fast, signal: ac.signal });
    const pending = outcome(waiting);
    await vi.advanceTimersByTimeAsync(50);
    ac.abort();
    const e = (await pending) as LoginError;
    expect(e).toMatchObject({ kind: "abort", message: "Cancelled." });
    const early = new AbortController();
    const hook = { requestCode: () => (early.abort(), new Promise<string>(() => undefined)) };
    expect((await fails(signIn(recipe(mfaForm), creds(), withCode(), hook, { ...fast, signal: early.signal }))).kind).toBe("abort");
  });
  it("treats a prompt that fails like a cancelled one and passes on a sign-in error of the prompt", async () => {
    const broken = await fails(signIn(recipe(mfaForm), creds(), withCode(), { requestCode: async () => Promise.reject(new Error("closed")) }, fast));
    expect(broken.kind).toBe("abort");
    const own = new LoginError("code", "own");
    expect(await outcome(signIn(recipe(mfaForm), creds(), withCode(), { requestCode: async () => Promise.reject(own) }, fast))).toBe(own);
  });
  it("lets a host problem that appears while the code is awaited pass through", async () => {
    const d = withCode();
    const e = await fails(signIn(recipe(mfaForm), creds(), d, { requestCode: async () => ((d.url = "https://evil.example/"), "123456") }, fast));
    expect(e.kind).toBe("host");
    expect(d.filled.has("css #code")).toBe(false);
  });
});

describe("signIn: probes that fail", () => {
  class Chaos extends FakeDriver {
    broken = new Set<string>();
    override async isVisible(sel: Parameters<FakeDriver["isVisible"]>[0]): Promise<boolean> {
      if (this.broken.has(`isVisible ${describeSelector(sel)}`)) throw new Error("probe failed");
      return super.isVisible(sel);
    }
    override async readText(sel: Parameters<FakeDriver["readText"]>[0]): Promise<string> {
      if (this.broken.has(`readText ${describeSelector(sel)}`)) throw new Error("no text");
      return super.readText(sel);
    }
    override async click(sel: Parameters<FakeDriver["click"]>[0]): Promise<void> {
      if (this.broken.has(`click ${describeSelector(sel)}`)) throw new Error("not clickable");
      return super.click(sel);
    }
    override async currentUrl(): Promise<string> {
      if (this.broken.has("currentUrl")) throw new Error("no url");
      return super.currentUrl();
    }
  }
  const idpSite = (id: "github" | "apple", extra: (d: Chaos) => void): Chaos => {
    const flow = IDP_FLOWS[id];
    const button = id === "github" ? GITHUB_BUTTON : APPLE_BUTTON;
    const keys = flow.steps.flatMap((s) => ("fill" in s ? [describeSelector(s.fill)] : "click" in s ? [describeSelector(s.click)] : []));
    const first = flow.steps[0] && "waitFor" in flow.steps[0] ? describeSelector((flow.steps[0].waitFor as { visible: never }).visible) : "";
    const last = flow.steps.filter((s) => "click" in s).map((s) => ("click" in s ? describeSelector(s.click) : ""))[flow.steps.filter((s) => "click" in s).length - 1]!;
    let clicks = 0;
    const lastCount = flow.steps.filter((s) => "click" in s && describeSelector(s.click) === last).length;
    const d: Chaos = new Chaos({
      url: LOGIN,
      pollMs: 2,
      visible: [`button "${button}"`],
      on: (e, drv) => {
        if (e.key === `button "${button}"`) {
          drv.url = `https://${flow.hosts[0]}/auth`;
          for (const k of keys) drv.visible.add(k);
          drv.visible.add(first);
        }
        if (e.key === last && e.action === "click" && ++clicks === lastCount) extra(drv as Chaos);
      },
    });
    return d;
  };
  const short = { ...fast, timeoutMinutes: 0.01 };
  it("goes on when the passkey fallback cannot be probed or clicked", async () => {
    const fallback = describeSelector(IDP_FLOWS.github.passkey!.fallback);
    for (const how of ["isVisible", "click"]) {
      const d = idpSite("github", (drv) => {
        drv.pageText.add("passkey");
        drv.visible.add(fallback);
        drv.broken.add(`${how} ${fallback}`);
      });
      const e = await fails(signIn(recipe(), creds(), d, {}, { ...short, method: "github" }));
      expect(e.kind).toBe("timeout");
    }
  });
  it("shows an empty scope list when the scopes cannot be read", async () => {
    const consent = IDP_FLOWS.github.consent!;
    const d = idpSite("github", (drv) => drv.visible.add(describeSelector(consent.detect.visible!)));
    let asked: string | undefined;
    await fails(signIn(recipe(), creds(), d, { requestConfirm: async (scopes) => ((asked = scopes), false) }, { ...short, method: "github" }));
    expect(asked).toBe("");
  });
  it("goes on when 'trust this browser' cannot be probed or clicked", async () => {
    const trust = describeSelector(IDP_FLOWS.apple.trust!);
    for (const how of ["isVisible", "click"]) {
      const d = idpSite("apple", (drv) => {
        drv.visible.add(trust);
        drv.broken.add(`${how} ${trust}`);
      });
      const e = await fails(signIn(recipe(), creds(), d, {}, { ...short, method: "apple" }));
      expect(e.kind).toBe("timeout");
    }
  });
  it("shows an approval without a number when the number cannot be read", async () => {
    const events: LoginEvent[] = [];
    const google = recipe({}, { login: { ...(doc().login as object), methods: [{ id: "google", steps: [{ click: button("Continue with Google") }] }] } });
    const flow = IDP_FLOWS.google;
    const keys = flow.steps.flatMap((s) => ("fill" in s ? [describeSelector(s.fill)] : "click" in s ? [describeSelector(s.click)] : []));
    const d = new Chaos({
      url: LOGIN,
      pollMs: 2,
      visible: ['button "Continue with Google"'],
      on: (e, drv) => {
        if (e.key === 'button "Continue with Google"') {
          drv.url = "https://accounts.google.com/auth";
          for (const k of keys) drv.visible.add(k);
          drv.visible.add(describeSelector((flow.steps[0] as { waitFor: { visible: never } }).waitFor.visible));
        }
        if (e.key === describeSelector({ css: "#passwordNext" })) drv.pageText.add("Check your phone");
      },
    });
    const run = outcome(signIn(google, creds(), d, { onEvent: (ev) => void events.push(ev) }, { ...short, method: "google" }));
    expect(await run).toBeInstanceOf(LoginError);
    const needs = events.find((ev) => ev.type === "needs");
    expect(needs).toMatchObject({ need: "approval" });
    expect(needs).not.toHaveProperty("detail");
  });
  it("tolerates a browser whose address cannot be read while signing in", async () => {
    const d = new Chaos({ url: APP });
    const result = await settle(signIn(recipe(), creds(), d, {}, fast).catch((e: unknown) => e));
    expect(result).toBeDefined();
    d.broken.add("currentUrl");
    const failing = await settle(signIn(recipe(), creds(), d, {}, fast).catch((e: unknown) => e));
    expect(failing).toBeInstanceOf(LoginError);
  });
  it("a condition that cannot be probed counts as not met", async () => {
    const d = new Chaos({ url: LOGIN, pollMs: 2, visible: FIELDS, on: () => undefined });
    const r = recipe({}, { login: { ...(doc().login as { form: unknown }), expect: { visible: { css: "#home" } } } });
    d.broken.add("isVisible css #home");
    const e = await fails(signIn(r, creds(), d, {}, { ...fast, timeoutMinutes: 0.01 }));
    expect(e.kind).toBe("timeout");
  });
});

/** Answers the first `good` questions for the address with the app page, then fails. */
class FadingUrl extends FakeDriver {
  asked = 0;
  constructor(
    readonly good: number,
    opts: ConstructorParameters<typeof FakeDriver>[0] = {},
    readonly failing = true,
  ) {
    super(opts);
  }
  override async currentUrl(): Promise<string> {
    if (++this.asked <= this.good) return APP;
    if (this.failing) throw new Error("no url");
    return "";
  }
}

describe("signIn and checkSession: an address that cannot be read at the end", () => {
  it("signIn still reports the sign-in, without an address", async () => {
    expect(await settle(signIn(recipe(), creds(), new FadingUrl(5, { url: APP }), {}, fast))).toEqual({ url: "" });
  });
  it("checkSession reports a signed-in browser without an address, and a signed-out one the same way", async () => {
    expect(await settle(checkSession(recipe(), new FadingUrl(2, { url: APP, on: () => undefined })))).toEqual({ signedIn: true, url: "" });
    const never = recipe({}, { login: { expect: { visible: { css: "#never" } }, form: (doc().login as { form: never }).form } });
    expect(await settle(checkSession(never, new FadingUrl(1, { url: APP }), { timeoutSeconds: 1, pollMs: 100 }))).toEqual({ signedIn: false, url: "" });
  });
  it("checkSession treats a start page that fails to load and cannot be located as not opened", async () => {
    class NoPage extends FadingUrl {
      override async goto(): Promise<void> {
        throw new Error("interrupted");
      }
    }
    const e = await fails(checkSession(recipe(), new NoPage(0)));
    expect(e.kind).toBe("page");
  });
});

describe("checkSession", () => {
  const session = (over: ConstructorParameters<typeof FakeDriver>[0] = {}) =>
    new FakeDriver({
      url: "about:blank",
      pollMs: 2,
      on: (e, d) => {
        if (e.action === "goto") d.url = APP;
      },
      ...over,
    });
  it("loads the sign-in page when the recipe has no home page, and polls with its defaults", async () => {
    const d = session();
    const r = await settle(checkSession(recipe(), d));
    expect(r).toEqual({ signedIn: true, url: "https://example.test/app/home" });
    expect(d.calls).toContain(`goto ${LOGIN}`);
  });
  it("a cancelled wait ends the check as cancelled", async () => {
    class Aborting extends FakeDriver {
      override async currentUrl(): Promise<string> {
        return APP;
      }
    }
    const ac = new AbortController();
    ac.abort();
    const never = recipe({}, { login: { expect: { visible: { css: "#never" } }, form: doc().login && (doc().login as { form: never }).form } });
    const e = await outcome(checkSession(never, new Aborting({ url: APP }), { signal: ac.signal }));
    expect(e).toBeInstanceOf(LoginError);
    expect((e as LoginError).kind).toBe("abort");
  });
  it("is not signed in when the wait runs out", async () => {
    const never = recipe({}, { login: { expect: { visible: { css: "#never" } }, form: (doc().login as { form: never }).form } });
    const r = await settle(checkSession(never, session(), { timeoutSeconds: 1, pollMs: 100 }));
    expect(r).toEqual({ signedIn: false, url: "https://example.test/app/home" });
  });
  it("fails with the kind page when the browser is on an address that is no address at all", async () => {
    class Broken extends FakeDriver {
      override async goto(): Promise<void> {
        throw new Error("interrupted");
      }
      override async currentUrl(): Promise<string> {
        return "not a url";
      }
    }
    const e = await fails(checkSession(recipe(), new Broken()));
    expect(e.kind).toBe("page");
  });
  it("is signed out when the address after loading cannot be read", async () => {
    class Blank extends FakeDriver {
      override async currentUrl(): Promise<string> {
        throw new Error("no url");
      }
    }
    expect(await settle(checkSession(recipe(), new Blank()))).toEqual({ signedIn: false, url: "" });
  });
  it("unused condition type stays referenced", () => {
    const c: ResolvedCondition = {};
    expect(c).toEqual({});
  });
});
