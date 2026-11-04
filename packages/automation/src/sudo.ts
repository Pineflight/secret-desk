import type { BrowserDriver } from "./driver.js";
import type { Selector } from "./selector.js";
import { WaitAbortedError } from "./wait.js";

/**
 * Built-in confirmations that a provider asks for in the middle of a recipe ("Confirm access" at GitHub, also called sudo mode).
 * A recipe step `confirmAccess` triggers one. The human answers in the portal, never in the browser window: the portal asks
 * how to confirm (GitHub Mobile, authenticator code, password), this module clicks and types, and it hands the number GitHub
 * Mobile shows back to the portal.
 *
 * A passkey cannot work in the remote browser and is not offered. Every selector and text here is NOT VERIFIED against the live
 * page except what the 2026-11-03 survey of the page lists (see docs/BROWSER-AUTOMATION.md): each step waits for its element, so
 * a wrong guess fails visibly instead of clicking something else. The password and the code are typed once, never logged, never
 * part of an event or an error, and the fields are masked in screenshots.
 */

export type SudoMethod = "mobile" | "code" | "password";
export const SUDO_FLOW_IDS = ["github-sudo", "stripe-verify", "generic-verify"] as const;
export type SudoFlowId = (typeof SUDO_FLOW_IDS)[number];

/** Why the portal asks again: GitHub Mobile was not approved in time, the code or password was refused, the way is not offered. */
export type SudoProblem = "timeout" | "rejected" | "unavailable";

export interface SudoAsk {
  methods: readonly SudoMethod[];
  /** 1-based number of this question in the run. */
  attempt: number;
  maxAttempts: number;
  problem?: SudoProblem;
}

export type SudoAnswer = { method: "mobile" } | { method: "code"; code: string } | { method: "password"; password: string };

export type SudoEvent =
  /** The portal has to ask the human how to confirm (and shows `ask.problem` if the last way failed). */
  | { type: "choose"; ask: SudoAsk }
  /** GitHub Mobile waits for the tap. `number` is what the page shows ("" if it could not be read). */
  | { type: "mobile"; number: string }
  /** A code or a password was sent; the page is being checked. */
  | { type: "checking"; method: SudoMethod }
  | { type: "confirmed" };

export interface SudoHooks {
  /** Resolves with the human's choice; rejects (any error) when the human gives up. */
  request(ask: SudoAsk): Promise<SudoAnswer>;
  onEvent?(event: SudoEvent): void;
}

/** How one way is done on the page: where to type and what to click afterwards. */
export interface SudoWay {
  /** Click to open the view of this way (GitHub shows one way at a time). Flows that show the field at once leave it out. */
  switchTo?: Selector;
  field: Selector;
  /** The first visible one is clicked. */
  submit: readonly Selector[];
}

/** One way to recognize the page: the text (when given) shows and one of the elements is visible. A flow may list several; any one counts. */
export interface SudoDetect {
  text?: string;
  anyVisible: readonly Selector[];
}

export interface SudoFlow {
  id: SudoFlowId;
  /** Name of the provider in messages. A flow for unknown providers says "The provider". */
  provider: string;
  /** Order of the ways offered; the first is the default. With `discover`, the ways whose field is visible. */
  methods: readonly SudoMethod[];
  /** The page is a confirmation when the text shows (plain text or `/pattern/flags`) and one of the elements is visible (the first view). */
  detect: SudoDetect | readonly SudoDetect[];
  /** What stays on the page for as long as the confirmation is open: a text, or elements (open while any is visible). */
  present: string | readonly Selector[];
  /** Clicks made once before the first question (for example choosing a way to verify); each waits for its element. */
  prepare?: readonly Selector[];
  mobile?: { start: Selector; waiting: string; area: readonly Selector[] };
  code?: SudoWay;
  password?: SudoWay;
  /**
   * Ask only for the ways whose field is visible now, and follow a page that goes on to a further factor after an answer was
   * accepted. When no field of a way shows up, the flow gives up with kind `unrecognized` (the human finishes in the browser).
   */
  discover?: boolean;
  /** Do not reload the page between tries (a dialog over the page would be lost). */
  keepPage?: boolean;
  /** Questions to the human in one confirmation; default 3. */
  maxAttempts?: number;
  /** Masked in every screenshot. */
  masks: readonly Selector[];
  /** What the human is told when the recipe waits without a portal to answer in. */
  humanHint: string;
}

const css = (c: string): Selector => ({ css: c });

const DIALOG = css("[role=dialog]");
const first = (c: string): Selector => ({ css: c, first: true });
const BUTTON_NAME = "name=/^(Continue|Verify|Submit|Confirm)$/i";
const DIALOG_CONTINUE: Selector = first(`[role=dialog] >> role=button[name="Continue"s]`);
const DIALOG_SUBMIT: Selector = first(`[role=dialog] >> role=button[${BUTTON_NAME}]`);
const PAGE_SUBMIT: Selector = first(`role=button[${BUTTON_NAME}]`);
const DIALOG_CODE_FIELD = first('[role=dialog] input[autocomplete="one-time-code"], [role=dialog] input[inputmode="numeric"]');
const DIALOG_OTP_FIELD = first('[role=dialog] input[autocomplete="one-time-code"], [role=dialog] input[inputmode="numeric"]');
const DIALOG_PASSWORD_FIELD = first('[role=dialog] input[type="password"]');
const CODE_FIELD = first('input[autocomplete="one-time-code"], [role=dialog] input[inputmode="numeric"]');
const PASSWORD_FIELD = first('input[type="password"]');

export const SUDO_FLOWS: Readonly<Record<SudoFlowId, SudoFlow>> = {
  // The page text and the field names come from the 2026-11-03 survey; the "Confirm" and "Verify" buttons and the place of the
  // digits are not verified.
  "github-sudo": {
    id: "github-sudo",
    provider: "GitHub",
    methods: ["mobile", "code", "password"],
    detect: {
      text: "Confirm access",
      anyVisible: [{ role: "button", name: "Use GitHub Mobile" }, css('input[name="sudo_app_otp"]'), css('input[name="sudo_password"]'), { text: "Use your password" }],
    },
    present: "Confirm access",
    mobile: {
      start: { role: "button", name: "Use GitHub Mobile" },
      waiting: "Enter the digits shown below",
      area: [css("main"), css("body")],
    },
    code: { switchTo: { text: "Use your authenticator app" }, field: css('input[name="sudo_app_otp"]'), submit: [{ role: "button", name: "Verify", exact: true }] },
    password: { switchTo: { text: "Use your password" }, field: css('input[name="sudo_password"]'), submit: [{ role: "button", name: "Confirm", exact: true }] },
    masks: [css('input[name="sudo_password"]'), css('input[name="sudo_app_otp"]')],
    humanHint: "GitHub asks to confirm access (Confirm access). Confirm it in the browser window.",
  },
  // The "Verification required" dialog of the Stripe dashboard (seen on 2026-11-04 after "Create key" in live mode): the title and the
  // text of the two option cards come from that sighting. Everything after the click on the email option is NOT VERIFIED: the code
  // field, the buttons and a further factor ("+ more verification") are guesses scoped to the dialog. A passkey cannot work in the
  // remote browser and is never offered.
  "stripe-verify": {
    id: "stripe-verify",
    provider: "Stripe",
    methods: ["code", "password"],
    detect: { text: "Verification required", anyVisible: [{ text: "Verify by email + more verification" }] },
    present: [DIALOG],
    prepare: [{ text: "Verify by email + more verification" }, DIALOG_CONTINUE],
    code: { field: DIALOG_CODE_FIELD, submit: [DIALOG_SUBMIT] },
    password: { field: DIALOG_PASSWORD_FIELD, submit: [DIALOG_SUBMIT] },
    discover: true,
    keepPage: true,
    maxAttempts: 5,
    masks: [css("[role=dialog] input"), css('input[type="password"]'), css('input[autocomplete="one-time-code"]')],
    humanHint: "Stripe asks to verify your identity (Verification required). Finish it in the browser window.",
  },
  // For providers whose re-verification page is not known yet: a visible password or one-time-code field together with a text that
  // talks about verifying. NOT VERIFIED anywhere; every selector is a guess that fails visibly (the human then finishes it in the
  // browser window). A password field outside a dialog counts too, so recipes use it only right after a click that may ask.
  "generic-verify": {
    id: "generic-verify",
    provider: "The provider",
    methods: ["code", "password"],
    // Narrow on purpose: a field inside a dialog counts on its own; a field on the page needs a tight verification wording (not the
    // bare words "password" or "code", which any sign-in or settings page has).
    detect: [
      { anyVisible: [DIALOG_PASSWORD_FIELD, DIALOG_OTP_FIELD] },
      { text: "/verif|confirm your identity|two-factor|2FA|enter the code|re-?enter your password/i", anyVisible: [PASSWORD_FIELD, CODE_FIELD] },
    ],
    present: [PASSWORD_FIELD, CODE_FIELD],
    code: { field: CODE_FIELD, submit: [DIALOG_SUBMIT, PAGE_SUBMIT] },
    password: { field: PASSWORD_FIELD, submit: [DIALOG_SUBMIT, PAGE_SUBMIT] },
    discover: true,
    keepPage: true,
    maxAttempts: 5,
    masks: [css("[role=dialog] input"), css('input[type="password"]'), css('input[autocomplete="one-time-code"]')],
    humanHint: "The provider asks to verify your identity. Finish it in the browser window.",
  },
};


export type SudoErrorKind = "abort" | "timeout" | "failed" | "step" | "unrecognized";

/** Thrown by `confirmAccess`. The message never contains a code or a password. */
export class SudoError extends Error {
  readonly kind: SudoErrorKind;
  constructor(kind: SudoErrorKind, message: string) {
    super(message);
    this.name = "SudoError";
    this.kind = kind;
  }
}

/** The digits GitHub Mobile asks the human to tap: one or two digits right after "Enter the digits shown below". Else "". */
export function sudoNumberFrom(pageText: string): string {
  const m = /digits\s+shown\s+below\D{0,80}?(\d{1,2})(?!\d)/is.exec(pageText.replace(/\s+/g, " "));
  return m?.[1] ?? "";
}

export interface SudoIo {
  driver: BrowserDriver;
  hooks: SudoHooks;
  signal?: AbortSignal | undefined;
  /** Throws when the browser is not on a page the recipe allows (nothing is typed then). */
  checkHost(): Promise<void>;
  /** Registers a value the run must never print. */
  addSecret(value: string): void;
  /** How long GitHub Mobile may take, default 120 s. */
  mobileTimeoutMs?: number;
  /** How long to wait for the page to accept a code or password, default 12 s. */
  submitTimeoutMs?: number;
  /** How long a flow that discovers its fields waits for one to show, and for each click of its preparation, default 10 s. */
  discoverTimeoutMs?: number;
  /** Questions to the human in one confirmation, default: the flow's own, else 3. */
  maxAttempts?: number;
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, Math.max(1, ms));
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Is the "Confirm access" page showing in the first view (the question that starts the flow)? */
export async function sudoPageShown(driver: Pick<BrowserDriver, "hasText" | "isVisible">, flow: SudoFlow): Promise<boolean> {
  const options: readonly SudoDetect[] = Array.isArray(flow.detect) ? flow.detect : [flow.detect as SudoDetect];
  for (const d of options) {
    if (d.text !== undefined && !(await driver.hasText(d.text).catch(() => false))) continue;
    for (const sel of d.anyVisible) if (await driver.isVisible(sel).catch(() => false)) return true;
  }
  return false;
}

/**
 * Confirms access through the portal. Resolves once the confirmation is gone. Throws SudoError: `abort` (cancelled or the human gave
 * up), `timeout` (the last try ran out of time), `failed` (the page refused every try), `step` (the page did not work as expected),
 * `unrecognized` (a flow that discovers its fields found none: the human finishes it in the browser window).
 */
export async function confirmAccess(flow: SudoFlow, io: SudoIo): Promise<void> {
  const { driver, hooks, signal } = io;
  const pollMs = io.pollMs ?? 500;
  const mobileMs = io.mobileTimeoutMs ?? 120_000;
  const submitMs = io.submitTimeoutMs ?? 12_000;
  const discoverMs = io.discoverTimeoutMs ?? 10_000;
  const max = io.maxAttempts ?? flow.maxAttempts ?? 3;
  const emit = (e: SudoEvent): void => hooks.onEvent?.(e);
  const aborted = (): void => {
    if (signal?.aborted) throw new SudoError("abort", "Cancelled.");
  };
  const hasVisible = async (sel: Selector): Promise<boolean> => driver.isVisible(sel).catch(() => false);
  const anyVisible = async (sels: readonly Selector[], onError: boolean): Promise<boolean> => {
    for (const sel of sels) if (await driver.isVisible(sel).catch(() => onError)) return true;
    return false;
  };
  const open = async (): Promise<boolean> => (typeof flow.present === "string" ? driver.hasText(flow.present).catch(() => true) : anyVisible(flow.present, true));
  const wayOf = (m: SudoMethod): SudoWay | undefined => (m === "code" ? flow.code : m === "password" ? flow.password : undefined);

  /** Waits until the confirmation is gone. False when the time ran out. */
  async function gone(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      aborted();
      await io.checkHost();
      if (!(await open())) return true;
      if (Date.now() >= until) return false;
      await sleep(Math.min(pollMs, until - Date.now()), signal);
    }
  }

  async function waitText(text: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      aborted();
      if (await driver.hasText(text).catch(() => false)) return true;
      if (Date.now() >= until) return false;
      await sleep(Math.min(pollMs, until - Date.now()), signal);
    }
  }

  async function readNumber(): Promise<string> {
    for (const area of flow.mobile?.area ?? []) {
      const text = await driver.readText(area).catch(() => "");
      const n = sudoNumberFrom(text);
      if (n) return n;
    }
    return "";
  }

  /** Waits for an element to show. False when the time ran out. */
  async function waitVisible(sel: Selector, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (!(await hasVisible(sel))) {
      aborted();
      if (Date.now() >= until) return false;
      await sleep(Math.min(pollMs, 200), signal);
    }
    return true;
  }

  /** Clicks the first of the elements that is visible. False when none shows. */
  async function clickFirst(sels: readonly Selector[]): Promise<boolean> {
    for (const sel of sels) {
      if (await hasVisible(sel)) {
        await io.checkHost();
        await driver.click(sel);
        return true;
      }
    }
    return false;
  }

  /** Opens the view of a method and types into it. Returns false when the page does not offer the way. */
  async function typeInto(way: SudoWay, value: string): Promise<boolean> {
    if (!(await hasVisible(way.field))) {
      if (!way.switchTo || !(await hasVisible(way.switchTo))) return false;
      await io.checkHost();
      await driver.click(way.switchTo);
      if (!(await waitVisible(way.field, 5000))) return false;
    }
    await io.checkHost();
    await driver.fill(way.field, value);
    return clickFirst(way.submit);
  }

  /** The ways whose field shows now (waits a moment for the page). Empty when the confirmation went away or nothing shows. */
  async function discovered(): Promise<SudoMethod[] | "gone"> {
    const until = Date.now() + discoverMs;
    for (;;) {
      aborted();
      await io.checkHost();
      const found: SudoMethod[] = [];
      for (const m of flow.methods) {
        const way = wayOf(m);
        if (way && (await hasVisible(way.field))) found.push(m);
      }
      if (found.length > 0) return found;
      if (!(await open())) return "gone";
      if (Date.now() >= until) return [];
      await sleep(Math.min(pollMs, until - Date.now()), signal);
    }
  }

  /**
   * After a code or password was sent: `gone` (accepted), `next` (the field went away and a field shows again: a further factor),
   * `rejected` (the field never left, or nothing changed in time).
   */
  async function settled(way: SudoWay, ms: number): Promise<"gone" | "next" | "rejected"> {
    const until = Date.now() + ms;
    let left = false;
    for (;;) {
      aborted();
      await io.checkHost();
      if (!(await open())) return "gone";
      if (flow.discover) {
        if (await hasVisible(way.field)) {
          if (left) return "next";
        } else if (await anyVisible(flow.methods.flatMap((m) => wayOf(m)?.field ?? []), false)) return "next";
        else left = true;
      }
      if (Date.now() >= until) return "rejected";
      await sleep(Math.min(pollMs, until - Date.now()), signal);
    }
  }

  const failedStep = (): SudoError => new SudoError("step", "A step of the confirmation failed: the page did not look as expected.");
  const rethrow = (err: unknown): never => {
    if (err instanceof SudoError) throw err;
    // The host check of the run (a RecipeRunError) ends the run as it is.
    if (err instanceof Error && err.name === "RecipeRunError") throw err;
    if (err instanceof WaitAbortedError) throw new SudoError("abort", "Cancelled.");
    if (signal?.aborted) throw new SudoError("abort", "Cancelled.");
    throw failedStep();
  };

  for (const sel of flow.prepare ?? []) {
    try {
      if (!(await waitVisible(sel, discoverMs))) throw new SudoError("unrecognized", "The verification page did not offer the expected choice.");
      await io.checkHost();
      await driver.click(sel);
    } catch (err) {
      rethrow(err);
    }
  }

  let problem: SudoProblem | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    aborted();
    let methods: readonly SudoMethod[] = flow.methods;
    if (flow.discover) {
      try {
        const found = await discovered();
        if (found === "gone") return confirmed(emit);
        if (found.length === 0) throw new SudoError("unrecognized", "The verification page shows no field this tool can fill in.");
        methods = found;
      } catch (err) {
        rethrow(err);
      }
    }
    const ask: SudoAsk = { methods, attempt, maxAttempts: max, ...(problem ? { problem } : {}) };
    emit({ type: "choose", ask });
    let answer: SudoAnswer;
    try {
      answer = await hooks.request(ask);
    } catch {
      throw new SudoError("abort", "Cancelled.");
    }
    aborted();
    problem = undefined;
    let advanced = false;
    try {
      if (answer.method === "mobile") {
        const mobile = flow.mobile;
        if (!mobile || !(await hasVisible(mobile.start))) problem = "unavailable";
        else {
          await io.checkHost();
          await driver.click(mobile.start);
          await waitText(mobile.waiting, 15_000);
          emit({ type: "mobile", number: await readNumber() });
          if (await gone(mobileMs)) return confirmed(emit);
          problem = "timeout";
        }
      } else {
        const secret = answer.method === "code" ? answer.code : answer.password;
        io.addSecret(secret);
        const way = wayOf(answer.method);
        let sent = false;
        try {
          if (way) sent = await typeInto(way, secret);
        } finally {
          // The value lives in this call only.
          if (answer.method === "code") answer.code = "";
          else answer.password = "";
        }
        if (!sent || !way) problem = "unavailable";
        else {
          emit({ type: "checking", method: answer.method });
          const outcome = await settled(way, submitMs);
          if (outcome === "gone") return confirmed(emit);
          if (outcome === "next") advanced = true;
          else problem = "rejected";
        }
      }
    } catch (err) {
      rethrow(err);
    }
    if (attempt < max && !advanced && !flow.keepPage) await reset(driver, io);
  }
  const who = flow.provider;
  throw new SudoError(
    problem === "timeout" ? "timeout" : "failed",
    problem === "timeout" ? `${who} Mobile was not approved in time.` : problem === "unavailable" ? `${who} offered none of the chosen ways to confirm access.` : `${who} did not accept the confirmation.`,
  );
}

function confirmed(emit: (e: SudoEvent) => void): void {
  emit({ type: "confirmed" });
}

/** Back to the first view of the page for the next try (the GitHub Mobile view has no way back). Stays on the same address. */
async function reset(driver: BrowserDriver, io: SudoIo): Promise<void> {
  try {
    const url = await driver.currentUrl();
    await io.checkHost();
    await driver.goto(url);
  } catch (err) {
    if (err instanceof SudoError) throw err;
    // The page could not be reloaded: the next try runs on what is there.
  }
}
