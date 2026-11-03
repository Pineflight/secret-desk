import { describe, expect, it } from "vitest";
import { browserSignInOf, chosenMethod, clock, codeValid, connectButtonState, consentItems, defaultMethod, dialogView, methodsOf, signInButtonState, countsText, elapsedSeconds, failureText, isFinished, isRunning, remainingSeconds, signInValid, stepsOf, type FacadeInfo, type FacadeState } from "../src/lib/facade";
import { messages } from "../src/messages";

const base: FacadeState = { secretId: "facade:revenuecat", providerId: "revenuecat", status: "running", text: "", startedAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" };
const at = "2026-11-02T10:00:00.000Z";
const t = (key: string, vars?: Record<string, string | number>) => {
  const text = messages.de[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_m, n: string) => String(vars[n])) : text;
};

describe("stepsOf", () => {
  it("shows the fixed phases and hides the optional ones nobody asked for", () => {
    const s = stepsOf({ ...base, timeline: [{ phase: "opening", state: "active", at }] });
    expect(s.map((x) => x.phase)).toEqual(["opening", "username", "password", "signed-in", "key", "stored", "testing", "connected"]);
    expect(s[0]).toMatchObject({ state: "active" });
    expect(s.slice(1).every((x) => x.state === "pending")).toBe(true);
  });

  it("adds a phase the provider asked for and marks it waiting while the human has to act", () => {
    const s = stepsOf({
      ...base,
      status: "waiting-human",
      needs: "mfa-code",
      timeline: [
        { phase: "opening", state: "done", at },
        { phase: "username", state: "done", at },
        { phase: "password", state: "done", at },
        { phase: "code", state: "active", at },
      ],
    });
    expect(s.map((x) => `${x.phase}:${x.state}`)).toEqual(["opening:done", "username:done", "password:done", "code:waiting", "signed-in:pending", "key:pending", "stored:pending", "testing:pending", "connected:pending"]);
  });

  it("marks the failed phase and leaves nothing spinning once the run ended", () => {
    const failed = stepsOf({ ...base, status: "failed", timeline: [{ phase: "opening", state: "done", at }, { phase: "username", state: "done", at }, { phase: "password", state: "failed", at }] });
    expect(failed.find((x) => x.phase === "password")?.state).toBe("failed");
    const stuck = stepsOf({ ...base, status: "cancelled", timeline: [{ phase: "approval", state: "active", at }] });
    expect(stuck.find((x) => x.phase === "approval")?.state).toBe("failed");
    const done = stepsOf({ ...base, status: "done", timeline: [{ phase: "connected", state: "active", at }] });
    expect(done.find((x) => x.phase === "connected")?.state).toBe("done");
  });

  it("a connect run (browser already signed in) skips the sign-in phases", () => {
    const s = stepsOf({ ...base, kind: "connect", timeline: [{ phase: "signed-in", state: "done", at }, { phase: "key", state: "active", at }] });
    expect(s.map((x) => x.phase)).toEqual(["signed-in", "key", "stored", "testing", "connected"]);
  });

  it("copes with no state at all", () => {
    expect(stepsOf(null)).toHaveLength(8);
    expect(stepsOf(undefined).every((x) => x.state === "pending")).toBe(true);
  });
});

describe("status and time", () => {
  it("tells running from finished", () => {
    expect([isRunning({ status: "running" }), isRunning({ status: "waiting-human" }), isRunning({ status: "done" }), isRunning(null)]).toEqual([true, true, false, false]);
    expect([isFinished({ status: "done" }), isFinished({ status: "failed" }), isFinished({ status: "cancelled" }), isFinished({ status: "idle" })]).toEqual([true, true, true, false]);
  });
  it("counts elapsed and remaining time", () => {
    const now = Date.parse("2026-11-02T10:01:05.900Z");
    expect(elapsedSeconds(base.startedAt, now)).toBe(65);
    expect(elapsedSeconds("", now)).toBe(0);
    expect(elapsedSeconds("2030-01-01T00:00:00Z", now)).toBe(0);
    expect(remainingSeconds("2026-11-02T10:10:00.000Z", now)).toBe(535);
    expect(remainingSeconds(null, now)).toBeNull();
    expect(remainingSeconds("2026-11-02T10:00:00Z", now)).toBe(0);
    expect([clock(0), clock(65), clock(600), clock(-3)]).toEqual(["0:00", "1:05", "10:00", "0:00"]);
  });
});

describe("texts", () => {
  it("uses the provider's own refusal text in German and English, the catalog for other failures", () => {
    const rejected = { code: "rejected", message: "RevenueCat hat das Passwort abgelehnt.", messageEn: "RevenueCat rejected the password." };
    expect(failureText(rejected, "de", t)).toBe("RevenueCat hat das Passwort abgelehnt.");
    expect(failureText(rejected, "en", t)).toBe("RevenueCat rejected the password.");
    const timeout = { code: "timeout", message: "The sign-in did not finish within 10 minutes.", messageEn: "The sign-in did not finish within 10 minutes." };
    expect(failureText(timeout, "de", t)).toBe(messages.de["facade.fail.timeout"]);
    expect(failureText(timeout, "en", t)).toBe("The sign-in did not finish within 10 minutes.");
    const step = { code: "step", message: "Sign-in step 3 failed.", messageEn: "Sign-in step 3 failed." };
    expect(failureText(step, "de", t)).toBe(`${messages.de["facade.fail.step"]} (Sign-in step 3 failed.)`);
    expect(failureText({ code: "unknown-code", message: "Plain", messageEn: "Plain" }, "de", t)).toBe("Plain");
  });

  it("has a German and English catalog text for every failure code, phase and count the server can report", () => {
    const codes = ["rejected", "timeout", "cancelled", "host", "step", "code", "unsupported", "browser", "project-unknown", "session-lost", "key", "store", "test", "captcha"];
    for (const lang of ["de", "en"] as const) {
      for (const c of codes) expect(messages[lang][`facade.fail.${c}`], `${lang} fail ${c}`).toBeTruthy();
      for (const p of ["opening", "username", "password", "code", "approval", "consent", "signed-in", "key", "stored", "testing", "connected"]) {
        for (const kind of ["step", "active", "done"]) expect(messages[lang][`facade.${kind}.${p}`], `${lang} ${kind} ${p}`).toBeTruthy();
      }
      for (const k of ["projects", "apps"]) {
        expect(messages[lang][`facade.count.${k}.one`], `${lang} count ${k} one`).toBeTruthy();
        expect(messages[lang][`facade.count.${k}.other`], `${lang} count ${k} other`).toBeTruthy();
      }
    }
  });

  it("builds the count sentence", () => {
    const tt = (key: string, vars?: Record<string, string | number>) => {
      const text = key === "facade.count.projects" ? `${vars?.["count"]} project` : key === "facade.count.apps" ? `${vars?.["count"]} apps` : key;
      return text;
    };
    expect(countsText({ projects: 1, apps: 3 }, tt)).toBe("1 project, 3 apps");
    expect(countsText({ mystery: 2 }, tt)).toBe("2 mystery");
    expect(countsText({}, tt)).toBe("");
  });
});

describe("input shape", () => {
  it("accepts a code with spaces and dashes, rejects short or odd ones", () => {
    expect([codeValid("123 456"), codeValid("ABCD-1234"), codeValid("12"), codeValid("12 34 56 78 90 12 34 56 78"), codeValid("12;34")]).toEqual([true, true, false, false, false]);
  });
  it("needs an email and a password", () => {
    expect([signInValid("a@b.c", "x"), signInValid(" ", "x"), signInValid("a@b.c", ""), signInValid("a@b.c", "x".repeat(1025))]).toEqual([true, false, false, false]);
  });
});

const facade = (over: Partial<FacadeInfo> = {}): FacadeInfo => ({
  id: "openai",
  label: "OpenAI",
  recipeId: "openai-admin-key",
  connectionId: "openai",
  available: true,
  reason: null,
  recipeStatus: null,
  host: "platform.openai.com",
  connected: false,
  needsProject: false,
  inputs: [],
  timeoutMinutes: 10,
  methods: [{ id: "email", label: null, labelEn: null }, { id: "apple", label: null, labelEn: null }],
  promise: "facade.promise.openai",
  ...over,
});

describe("connect dialog state", () => {
  it("is checking until the check answered, then follows the answer", () => {
    expect(browserSignInOf(undefined)).toBe("checking");
    expect(browserSignInOf({ signedIn: true })).toBe("signed-in");
    expect(browserSignInOf({ signedIn: false })).toBe("signed-out");
    expect(browserSignInOf({ signedIn: null })).toBe("unknown");
  });

  it("shows the checking text, the direct connect for a signed-in browser, else the sign-in methods; a run wins over all", () => {
    expect(dialogView("checking", false)).toBe("checking");
    expect(dialogView("signed-in", false)).toBe("connect");
    expect(dialogView("signed-out", false)).toBe("sign-in");
    expect(dialogView("unknown", false)).toBe("sign-in");
    for (const b of ["checking", "signed-in", "signed-out", "unknown"] as const) expect(dialogView(b, true)).toBe("run");
  });

  it("offers email first, falls back to email without methods and ignores an unknown choice", () => {
    expect(methodsOf(facade()).map((m) => m.id)).toEqual(["email", "apple"]);
    expect(methodsOf(facade({ methods: [] })).map((m) => m.id)).toEqual(["email"]);
    expect(defaultMethod(facade())).toBe("email");
    expect(chosenMethod(facade(), "apple")).toBe("apple");
    expect(chosenMethod(facade(), "github")).toBe("email");
    expect(chosenMethod(facade(), "")).toBe("email");
  });

  it("derives the button states: busy, disabled and ready", () => {
    const stripe = facade({ inputs: [{ param: "mode", label: "Modus", labelEn: "Mode", options: ["sandbox", "live"], pattern: null, help: null }] });
    expect(connectButtonState(stripe, {}, false)).toBe("disabled");
    expect(connectButtonState(stripe, { mode: "live" }, false)).toBe("ready");
    expect(connectButtonState(stripe, { mode: "live" }, true)).toBe("busy");
    expect(connectButtonState(facade({ available: false }), {}, false)).toBe("disabled");
    expect(signInButtonState(facade(), "a@b.test", "", {}, false)).toBe("disabled");
    expect(signInButtonState(facade(), "a@b.test", "pw", {}, false)).toBe("ready");
    expect(signInButtonState(facade(), "a@b.test", "pw", {}, true)).toBe("busy");
    expect(signInButtonState(facade({ available: false }), "a@b.test", "pw", {}, false)).toBe("disabled");
  });

  it("lists the access of an authorization", () => {
    expect(consentItems("Repository access (read); Email addresses (read)")).toEqual(["Repository access (read)", "Email addresses (read)"]);
    expect(consentItems(undefined)).toEqual([]);
  });

  it("has catalog texts (German and English) for every method, promise and dialog state", () => {
    for (const lang of ["de", "en"] as const) {
      for (const m of ["email", "google", "apple", "microsoft", "github"]) {
        for (const k of ["method", "methodEmail", "methodPassword"]) expect(messages[lang][`facade.${k}.${m}`], `${lang} ${k} ${m}`).toBeTruthy();
      }
      for (const k of ["promise.revenuecat", "promise.stripe", "promise.openai", "checkingBrowser", "connectSignedIn", "otherWay", "approvalWait", "consentTitle", "consentAccept", "consentDecline", "fail.captcha"]) {
        expect(messages[lang][`facade.${k}`], `${lang} ${k}`).toBeTruthy();
      }
    }
    expect(messages.en["facade.checkingBrowser"]).toBe("Checking the browser sign-in …");
    expect(messages.de["facade.connectSignedIn"]).toBe("Mit angemeldetem Browser verbinden");
    expect(messages.en["facade.promise.stripe"]).toBe("Restricted key with only the permissions of the chosen preset, for one account and mode.");
    expect(messages.en["facade.promise.openai"]).toBe("Organization admin key; secret-desk uses it only to create and delete project keys.");
  });

  it("has no viewer or browser-window text left in the normal user catalogs", () => {
    for (const lang of ["de", "en"] as const) {
      for (const [k, v] of Object.entries(messages[lang])) {
        if (!k.startsWith("facade.") && !k.startsWith("providers.")) continue;
        expect(k, lang).not.toMatch(/openBrowser|noViewer/);
        expect(v, `${lang} ${k}`).not.toMatch(/browser window|Browserfenster/i);
      }
    }
  });
});
