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
export type SudoFlowId = "github-sudo";

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

export interface SudoFlow {
  id: SudoFlowId;
  /** Order of the ways offered; the first is the default. */
  methods: readonly SudoMethod[];
  /** The page is "Confirm access" when the text shows and one of the elements is visible (the first view of the page). */
  detect: { text: string; anyVisible: readonly Selector[] };
  /** Text that stays on the page for as long as the confirmation is open (also in the GitHub Mobile and the code views). */
  present: string;
  mobile: { start: Selector; waiting: string; area: readonly Selector[] };
  code: { switchTo: Selector; field: Selector; submit: Selector };
  password: { switchTo: Selector; field: Selector; submit: Selector };
  /** Masked in every screenshot. */
  masks: readonly Selector[];
  /** What the human is told when the recipe waits without a portal to answer in. */
  humanHint: string;
}

const css = (c: string): Selector => ({ css: c });

export const SUDO_FLOWS: Readonly<Record<SudoFlowId, SudoFlow>> = {
  // The page text and the field names come from the 2026-11-03 survey; the "Confirm" and "Verify" buttons and the place of the
  // digits are not verified.
  "github-sudo": {
    id: "github-sudo",
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
    code: { switchTo: { text: "Use your authenticator app" }, field: css('input[name="sudo_app_otp"]'), submit: { role: "button", name: "Verify", exact: true } },
    password: { switchTo: { text: "Use your password" }, field: css('input[name="sudo_password"]'), submit: { role: "button", name: "Confirm", exact: true } },
    masks: [css('input[name="sudo_password"]'), css('input[name="sudo_app_otp"]')],
    humanHint: "GitHub asks to confirm access (Confirm access). Confirm it in the browser window.",
  },
};

export const SUDO_FLOW_IDS = Object.keys(SUDO_FLOWS) as SudoFlowId[];

export type SudoErrorKind = "abort" | "timeout" | "failed" | "step";

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
  /** Questions to the human in one confirmation, default 3. */
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
  if (!(await driver.hasText(flow.detect.text).catch(() => false))) return false;
  for (const sel of flow.detect.anyVisible) if (await driver.isVisible(sel).catch(() => false)) return true;
  return false;
}

/**
 * Confirms access through the portal. Resolves once the "Confirm access" page is gone. Throws SudoError: `abort` (cancelled or the
 * human gave up), `timeout` (the last try ran out of time), `failed` (the page refused every try), `step` (the page did not work
 * as expected).
 */
export async function confirmAccess(flow: SudoFlow, io: SudoIo): Promise<void> {
  const { driver, hooks, signal } = io;
  const pollMs = io.pollMs ?? 500;
  const mobileMs = io.mobileTimeoutMs ?? 120_000;
  const submitMs = io.submitTimeoutMs ?? 12_000;
  const max = io.maxAttempts ?? 3;
  const emit = (e: SudoEvent): void => hooks.onEvent?.(e);
  const aborted = (): void => {
    if (signal?.aborted) throw new SudoError("abort", "Cancelled.");
  };
  const open = async (): Promise<boolean> => driver.hasText(flow.present).catch(() => true);
  const hasVisible = async (sel: Selector): Promise<boolean> => driver.isVisible(sel).catch(() => false);

  /** Waits until the confirmation page is gone. False when the time ran out. */
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
    for (const area of flow.mobile.area) {
      const text = await driver.readText(area).catch(() => "");
      const n = sudoNumberFrom(text);
      if (n) return n;
    }
    return "";
  }

  /** Opens the view of a method and types into it. Returns false when the page does not offer the way. */
  async function typeInto(way: SudoFlow["code"], value: string): Promise<boolean> {
    if (!(await hasVisible(way.field))) {
      if (!(await hasVisible(way.switchTo))) return false;
      await io.checkHost();
      await driver.click(way.switchTo);
      const until = Date.now() + 5000;
      while (!(await hasVisible(way.field))) {
        aborted();
        if (Date.now() >= until) return false;
        await sleep(Math.min(pollMs, 200), signal);
      }
    }
    await io.checkHost();
    await driver.fill(way.field, value);
    await driver.click(way.submit);
    return true;
  }

  let problem: SudoProblem | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    aborted();
    const ask: SudoAsk = { methods: flow.methods, attempt, maxAttempts: max, ...(problem ? { problem } : {}) };
    emit({ type: "choose", ask });
    let answer: SudoAnswer;
    try {
      answer = await hooks.request(ask);
    } catch {
      throw new SudoError("abort", "Cancelled.");
    }
    aborted();
    problem = undefined;
    try {
      if (answer.method === "mobile") {
        if (!(await hasVisible(flow.mobile.start))) problem = "unavailable";
        else {
          await io.checkHost();
          await driver.click(flow.mobile.start);
          await waitText(flow.mobile.waiting, 15_000);
          emit({ type: "mobile", number: await readNumber() });
          if (await gone(mobileMs)) return confirmed(emit);
          problem = "timeout";
        }
      } else {
        const secret = answer.method === "code" ? answer.code : answer.password;
        io.addSecret(secret);
        const way = answer.method === "code" ? flow.code : flow.password;
        let sent: boolean;
        try {
          sent = await typeInto(way, secret);
        } finally {
          // The value lives in this call only.
          if (answer.method === "code") answer.code = "";
          else answer.password = "";
        }
        if (!sent) problem = "unavailable";
        else {
          emit({ type: "checking", method: answer.method });
          if (await gone(submitMs)) return confirmed(emit);
          problem = "rejected";
        }
      }
    } catch (err) {
      if (err instanceof SudoError) throw err;
      if (err instanceof WaitAbortedError) throw new SudoError("abort", "Cancelled.");
      if (signal?.aborted) throw new SudoError("abort", "Cancelled.");
      throw new SudoError("step", "A step of the confirmation failed: the page did not look as expected.");
    }
    if (attempt < max) await reset(driver, io);
  }
  throw new SudoError(problem === "timeout" ? "timeout" : "failed", problem === "timeout" ? "GitHub Mobile was not approved in time." : problem === "unavailable" ? "GitHub offered none of the chosen ways to confirm access." : "GitHub did not accept the confirmation.");
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
