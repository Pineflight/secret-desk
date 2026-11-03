import { redact } from "@secret-desk/core";
import type { BrowserDriver } from "./driver.js";
import { IDP_FLOWS, idpHostAllowed, type IdpFlow } from "./idp.js";
import { hostAllowed, type Condition, type LoginForm, type LoginMethodId, type Recipe } from "./recipe.js";
import { resolveCondition } from "./run.js";
import { describeSelector, pickSelector } from "./selector.js";
import { renderTemplate } from "./template.js";
import { WaitAbortedError, WaitTimeoutError, conditionMet, pollCondition } from "./wait.js";

/**
 * Guided sign-in: the human typed email and password in the portal for this run; the recipe's `login.form` describes where
 * they go. The credentials live in the `creds` object for the duration of the run only and are wiped at the end. They are
 * typed only into pages on the recipe's hosts, and they appear in no event, error, return value or screenshot (this module
 * takes no screenshots at all).
 */

/** What the provider waits for from the human. */
export type LoginNeed = "mfa-code" | "approval" | "consent";

export type LoginErrorKind =
  /** Cancelled by the human. */
  | "abort"
  /** The time limit ran out (also while waiting for a code or an approval). */
  | "timeout"
  /** The browser was on a host outside the recipe: nothing was typed there. */
  | "host"
  /** A step of the recipe did not work (page changed, element missing). */
  | "step"
  /** A page could not be loaded at all (offline, refused, blocked), before any step ran. */
  | "page"
  /** The provider refused the sign-in (the recipe's `failure` list matched). */
  | "rejected"
  /** The one-time code was asked for too often. */
  | "code"
  /** The provider shows a CAPTCHA or other bot check that stays: the script cannot solve it and the human is not sent to the browser. */
  | "captcha"
  /** The recipe cannot do this (no login.form, no way to ask for a code). */
  | "unsupported";

export class LoginError extends Error {
  readonly kind: LoginErrorKind;
  /** English text for the portal's English interface (kind rejected: the recipe's messageEn). */
  readonly messageEn: string | undefined;
  constructor(kind: LoginErrorKind, message: string, messageEn?: string) {
    super(message);
    this.name = "LoginError";
    this.kind = kind;
    this.messageEn = messageEn;
  }
}

/** Credentials of one run. The fields are cleared when the run ends. */
export interface LoginCredentials {
  username: string;
  password: string;
}

export type LoginEvent =
  | { type: "opening" }
  | { type: "entered"; field: "username" | "password" }
  | { type: "submitted" }
  | { type: "needs"; need: LoginNeed; message?: string; messageEn?: string; /** The number an approval shows, or the scopes of a consent. */ detail?: string }
  | { type: "resumed"; need: LoginNeed }
  | { type: "signed-in"; url: string };

export interface LoginHooks {
  onEvent?(event: LoginEvent): void;
  /**
   * The provider asks for a one-time code. Resolves with the code the human typed, rejects (any error) when the human gives up.
   * The code is typed once and dropped.
   */
  requestCode?(): Promise<string>;
  /** The provider asks for an authorization (OAuth consent). Resolves true when the human confirmed it in the portal, false when declined. */
  requestConfirm?(scopes: string): Promise<boolean>;
}

export interface LoginOptions {
  /** The sign-in method: `email` (login.form, default) or an identity provider declared in login.methods. */
  method?: LoginMethodId;
  /** How long a CAPTCHA may stay before the run fails, default 4 s. */
  captchaGraceMs?: number;
  /** Whole run including waits for a code or an approval. Default 10. */
  timeoutMinutes?: number;
  signal?: AbortSignal;
  /** Poll interval, default 500 ms. */
  pollMs?: number;
  /** Pause after typing a code before the code field counts again, default 2500 ms. */
  settleMs?: number;
  /** Codes the human may type in one run, default 3. */
  maxCodeAttempts?: number;
  /**
   * How long to wait after opening the sign-in page until it shows either the signed-in state or the form, default 30 s.
   * Providers often load the sign-in page first and redirect a signed-in browser a few seconds later.
   */
  landingMs?: number;
}

export interface LoginResult {
  /** Address of the page after the sign-in, without query and fragment. */
  url: string;
}

const STEP_TIMEOUT_S = 30;

const stripUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
};

function formOf(recipe: Recipe): LoginForm {
  const form = recipe.login?.form;
  if (!form) throw new LoginError("unsupported", `Recipe ${recipe.id} has no guided sign-in (login.form).`);
  return form;
}

function describeStep(step: LoginForm["steps"][number]): string {
  if ("fill" in step) return `fill ${describeSelector(pickSelector(step.fill))}`;
  if ("click" in step) return `click ${describeSelector(pickSelector(step.click))}`;
  return "waitFor";
}

/** Rejects with LoginError(abort) when the signal fires, with LoginError(timeout) at the deadline. */
function guard<T>(work: Promise<T>, deadline: number, signal: AbortSignal | undefined, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new LoginError("abort", "Cancelled.")));
    const timer = setTimeout(() => finish(() => reject(new LoginError("timeout", `Time limit reached while waiting for ${what}.`))), Math.max(1, deadline - Date.now()));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e instanceof LoginError ? e : new LoginError("abort", "Cancelled."))),
    );
  });
}

/** A step of any sign-in sequence (recipe form, provider-side single-sign-on steps, built-in identity-provider flow). */
type AnyStep = { fill: Record<string, unknown> & { value: string } } | { click: Record<string, unknown> } | { waitFor: Condition & { timeoutSeconds?: number } } | Record<string, unknown>;

/**
 * Signs in with the recipe's `login.form` (method `email`) or through an identity provider (`options.method`: the recipe's
 * provider-side steps, then the built-in flow of that provider). Opens and closes the driver itself. Resolves once
 * `login.expect` holds. Throws LoginError; messages never contain the credentials or a code.
 *
 * Credentials are typed only on the recipe's hosts (email) or on the identity provider's hosts (single sign-on). Codes, device
 * approvals and the first-use consent are asked of the human in the portal; a CAPTCHA fails the run (the script cannot solve it).
 */
export async function signIn(recipe: Recipe, creds: LoginCredentials, driver: BrowserDriver, hooks: LoginHooks = {}, options: LoginOptions = {}): Promise<LoginResult> {
  const form = formOf(recipe);
  const methodId: LoginMethodId = options.method ?? "email";
  const idp: IdpFlow | null = methodId === "email" ? null : IDP_FLOWS[methodId];
  const methodDef = idp ? recipe.login!.methods?.find((m) => m.id === methodId) : undefined;
  if (idp && !methodDef?.steps?.length) throw new LoginError("unsupported", `Recipe ${recipe.id} does not offer the sign-in method ${methodId}.`);
  const expect = recipe.login!.expect;
  const known: string[] = [creds.username, creds.password];
  const minutes = options.timeoutMinutes ?? 10;
  const deadline = Date.now() + minutes * 60_000;
  const pollMs = options.pollMs ?? 500;
  const settleMs = options.settleMs ?? 2500;
  const maxCodes = options.maxCodeAttempts ?? 3;
  const captchaGraceMs = options.captchaGraceMs ?? 4000;
  const { signal } = options;
  const emit = (e: LoginEvent): void => hooks.onEvent?.(e);

  const fail = (kind: LoginErrorKind, message: string, messageEn?: string): never => {
    throw new LoginError(kind, redact(message, known), messageEn === undefined ? undefined : redact(messageEn, known));
  };
  const aborted = (): void => {
    if (signal?.aborted) fail("abort", "Cancelled.");
  };
  const met = (c: Condition): Promise<boolean> => conditionMet(driver, resolveCondition(c, {})).catch(() => false);
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, Math.max(1, ms));
      function done(): void {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });

  const hostNow = async (): Promise<string | null> => {
    const url = await driver.currentUrl().catch(() => "");
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
    } catch {
      return null;
    }
  };
  const onIdp = (host: string | null): boolean => idp !== null && host !== null && idpHostAllowed(idp.id, host);

  /** Typing happens only on the recipe's hosts (email) or on the identity provider's hosts (single sign-on); browsing also on the recipe's. */
  async function hostGuard(typing = false): Promise<void> {
    const host = await hostNow();
    if (host === null) return fail("host", "The page in the browser is not a web page the recipe allows: sign-in aborted, nothing was typed.");
    const ok = idp ? (typing ? onIdp(host) : onIdp(host) || hostAllowed(host, recipe)) : hostAllowed(host, recipe);
    if (!ok) fail("host", `The browser is on ${host}, outside ${idp ? `${recipe.host} and ${idp.id}` : recipe.host}: sign-in aborted, nothing was typed there.`);
  }

  const failures = [...(idp?.failure ?? []), ...form.failure];
  async function refused(): Promise<void> {
    for (const f of failures) if (await met(f.detect)) fail("rejected", f.message, f.messageEn ?? f.message);
  }

  let need: LoginNeed | null = null;
  const setNeed = (n: LoginNeed, message?: string, messageEn?: string, detail?: string): void => {
    if (need === n) return;
    need = n;
    emit({ type: "needs", need: n, ...(message ? { message } : {}), ...(messageEn ? { messageEn } : {}), ...(detail ? { detail } : {}) });
  };
  const clearNeed = (): void => {
    if (need === null) return;
    const was = need;
    need = null;
    emit({ type: "resumed", need: was });
  };

  const vars = { "login.username": creds.username, "login.password": creds.password };

  /** Runs sign-in steps. Steps that fill credentials run only on the hosts that may receive them. */
  async function runSteps(steps: readonly AnyStep[]): Promise<void> {
    for (const [i, raw] of steps.entries()) {
      const step = raw as Record<string, any>;
      aborted();
      await hostGuard("fill" in step);
      try {
        if ("fill" in step) {
          const f = step["fill"] as Record<string, unknown>;
          // Recipe steps carry the value inside `fill`, built-in steps next to it.
          const value = String(step["value"] ?? f["value"]);
          const field = value.includes("{{login.password}}") ? "password" : value.includes("{{login.username}}") ? "username" : null;
          await driver.fill(pickSelector(f), renderTemplate(value, vars));
          if (field) emit({ type: "entered", field });
        } else if ("click" in step) {
          await driver.click(pickSelector(step["click"]));
          emit({ type: "submitted" });
        } else if ("waitFor" in step) {
          const w = step["waitFor"] as Condition & { timeoutSeconds?: number };
          const cond = resolveCondition({ ...(w.url !== undefined ? { url: w.url } : {}), ...(w.visible ? { visible: w.visible } : {}), ...(w.hidden ? { hidden: w.hidden } : {}), ...(w.text !== undefined ? { text: w.text } : {}) }, {});
          await driver.waitFor(cond, (w.timeoutSeconds ?? step["timeoutSeconds"] ?? STEP_TIMEOUT_S) * 1000, signal);
        }
      } catch (err) {
        if (err instanceof LoginError) throw err;
        if (err instanceof WaitAbortedError) return fail("abort", "Cancelled.");
        // The provider may have answered with an error page: report that instead of a generic step failure.
        await refused();
        const timedOut = err instanceof WaitTimeoutError || (err as Error).name === "TimeoutError";
        return fail("step", `Sign-in step ${i + 1} (${describeStep(step as LoginForm["steps"][number])}) failed: ${timedOut ? "the page did not look as expected" : "the action was not possible"}.`);
      }
      // A wrong password usually shows right after the click; a later step would only fail confusingly.
      await refused();
    }
  }

  async function firstMet<T>(items: readonly T[], detect: (item: T) => Condition): Promise<T | undefined> {
    for (const item of items) if (await met(detect(item))) return item;
    return undefined;
  }

  await driver.open();
  try {
    emit({ type: "opening" });
    try {
      await driver.goto(form.start);
    } catch {
      return fail("step", "The sign-in page could not be opened.");
    }
    await hostGuard();

    // A signed-in browser is often redirected from the sign-in page only after a few seconds. Wait until the page shows
    // either the signed-in state or the form (the first step's condition), so a session is never mistaken for a broken form.
    const first = (idp ? methodDef!.steps![0] : form.steps[0]) as { waitFor?: Condition } | undefined;
    const formReady = first && "waitFor" in first ? (first.waitFor as Condition) : null;
    const landingUntil = Date.now() + (options.landingMs ?? 30_000);
    let signedIn = await met(expect);
    while (!signedIn && Date.now() < landingUntil) {
      aborted();
      if (formReady && (await met(formReady))) break;
      await sleep(Math.min(pollMs, landingUntil - Date.now()));
      signedIn = await met(expect);
    }
    await hostGuard();

    // Already signed in (the browser profile keeps the session): nothing is typed.
    if (!signedIn) {
      if (idp) {
        // Provider side: only clicks, up to the identity provider's page.
        await runSteps(methodDef!.steps as readonly AnyStep[]);
        const handoverUntil = Date.now() + (options.landingMs ?? 30_000);
        while (!onIdp(await hostNow()) && !(await met(expect))) {
          aborted();
          await hostGuard();
          await refused();
          if (Date.now() >= handoverUntil) return fail("step", `The provider did not hand over to the ${idp.id} sign-in.`);
          await sleep(pollMs);
        }
        if (onIdp(await hostNow())) await runSteps(idp.steps as readonly AnyStep[]);
      } else {
        await runSteps(form.steps as readonly AnyStep[]);
      }
    }

    // Wait for the result: signed in, refused, or something the human has to do.
    const mfas = [idp?.mfa, form.mfa].filter((m): m is NonNullable<typeof m> => m !== undefined);
    const approvals = [idp?.approval, form.approval].filter((m): m is NonNullable<typeof m> => m !== undefined);
    let settleUntil = 0;
    let codes = 0;
    let captchaSince = 0;
    for (;;) {
      aborted();
      await hostGuard();
      if (await met(expect)) {
        clearNeed();
        const url = stripUrl(await driver.currentUrl().catch(() => ""));
        emit({ type: "signed-in", url });
        return { url };
      }
      await refused();
      const onIdpNow = onIdp(await hostNow());
      // Identity-provider pages: a passkey prompt (take the code fallback), the first-use consent (the human confirms in the portal).
      if (idp && onIdpNow && Date.now() >= settleUntil) {
        if (idp.passkey && (await met(idp.passkey.detect)) && (await driver.isVisible(idp.passkey.fallback).catch(() => false))) {
          await hostGuard(false);
          await driver.click(idp.passkey.fallback).catch(() => undefined);
          settleUntil = Date.now() + settleMs;
          continue;
        }
        if (idp.consent && (await met(idp.consent.detect))) {
          const scopes = (await driver.readText(idp.consent.scopes).catch(() => "")).split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ").slice(0, 600);
          if (!hooks.requestConfirm) return fail("unsupported", "The provider asks for an authorization, but this run cannot ask for it.");
          setNeed("consent", undefined, undefined, scopes);
          const yes = await guard(hooks.requestConfirm(scopes), deadline, signal, "the authorization");
          if (!yes) return fail("rejected", "Die Autorisierung wurde abgelehnt.", "The authorization was declined.");
          await hostGuard(false);
          try {
            await driver.click(idp.consent.approve);
          } catch {
            return fail("step", "The authorization could not be confirmed.");
          }
          clearNeed();
          emit({ type: "submitted" });
          settleUntil = Date.now() + settleMs;
          continue;
        }
        if (idp.trust && (await driver.isVisible(idp.trust).catch(() => false))) {
          await driver.click(idp.trust).catch(() => undefined);
          settleUntil = Date.now() + settleMs;
          continue;
        }
      }
      const mfa = Date.now() >= settleUntil ? await firstMet(mfas, (m) => m.detect) : undefined;
      if (mfa) {
        if (codes >= maxCodes) return fail("code", `The provider did not accept ${maxCodes} codes: sign-in stopped.`);
        if (!hooks.requestCode) return fail("unsupported", "The provider asks for a one-time code, but this run cannot ask for one.");
        setNeed("mfa-code");
        let code = await guard(hooks.requestCode(), deadline, signal, "the one-time code");
        codes += 1;
        known.push(code);
        try {
          await hostGuard(true);
          await driver.fill(mfa.field, code);
          await driver.click(mfa.submit);
        } catch (err) {
          if (err instanceof LoginError) throw err;
          return fail("step", "The one-time code could not be entered.");
        } finally {
          code = "";
        }
        clearNeed();
        emit({ type: "submitted" });
        settleUntil = Date.now() + settleMs;
        continue;
      }
      const approval = await firstMet(approvals, (a) => a.detect);
      if (approval) {
        // The number some providers show next to "approve on your device" (read from the page, shown in the portal).
        const number = idp && approval === idp.approval && idp.approval.number ? (await driver.readText(idp.approval.number).catch(() => "")).trim().slice(0, 20) : "";
        setNeed("approval", approval.message, approval.messageEn ?? approval.message, number);
        captchaSince = 0;
      } else if (form.captcha && (await met(form.captcha.detect))) {
        // Lowest priority: an always-present invisible challenge frame must not hide the code or approval step.
        // The script cannot solve it and the human is not sent to the browser: a challenge that stays ends the run.
        captchaSince ||= Date.now();
        if (Date.now() - captchaSince >= captchaGraceMs) return fail("captcha", form.captcha.message ?? "Der Anbieter zeigt eine Sicherheitspruefung.", form.captcha.messageEn ?? form.captcha.message ?? "The provider shows a security check.");
        clearNeed();
      } else {
        captchaSince = 0;
        clearNeed();
      }
      if (Date.now() >= deadline) {
        return fail("timeout", `The sign-in did not finish within ${minutes} minutes.`);
      }
      await sleep(Math.min(pollMs, deadline - Date.now()));
    }
  } finally {
    creds.username = "";
    creds.password = "";
    await driver.close();
  }
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export interface SessionCheck {
  signedIn: boolean;
  /** Address after loading the home page, without query and fragment ("" if unknown). */
  url: string;
}

/**
 * Is the browser still signed in? Loads the recipe's home page (login.form.home, else the sign-in page) and waits briefly for
 * `login.expect`. Needs no credentials and types nothing.
 */
export async function checkSession(recipe: Recipe, driver: BrowserDriver, options: { timeoutSeconds?: number; signal?: AbortSignal; pollMs?: number } = {}): Promise<SessionCheck> {
  const form = formOf(recipe);
  const expect = resolveCondition(recipe.login!.expect, {});
  await driver.open();
  try {
    try {
      await driver.goto(form.home ?? form.start);
    } catch {
      // A provider that redirects (home page to dashboard or sign-in) interrupts the navigation and makes goto() throw although
      // the browser has arrived. Only a browser that did not get to an allowed page counts as "could not be opened".
      const arrived = hostOfUrl(await driver.currentUrl().catch(() => ""));
      if (!arrived || !hostAllowed(arrived, recipe)) throw new LoginError("page", "The page could not be opened.");
    }
    const url = await driver.currentUrl().catch(() => "");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* unknown */
    }
    if (!host || !hostAllowed(host, recipe)) return { signedIn: false, url: "" };
    try {
      await pollCondition(driver, expect, (options.timeoutSeconds ?? 15) * 1000, options.signal, options.pollMs ?? 250);
    } catch (err) {
      if (err instanceof WaitAbortedError) throw new LoginError("abort", "Cancelled.");
      return { signedIn: false, url: stripUrl(await driver.currentUrl().catch(() => "")) };
    }
    return { signedIn: true, url: stripUrl(await driver.currentUrl().catch(() => "")) };
  } finally {
    await driver.close();
  }
}
