import { hostListOf, type Recipe } from "@secret-desk/automation";
import { authorizeSystem } from "./agent-api.js";
import { checkRecipeSessionScheduled } from "./facade.js";
import type { Runtime } from "./runtime.js";

/**
 * Background checks of the browser sign-in. Provider sessions expire (some after about a day), so the portal looks at each
 * recipe host now and then instead of waiting for a human to press "Check sign-in". It uses the one browser queue: a check runs
 * only when no other browser run is active, one at a time. It reads no value and types nothing.
 */

export interface SignInSchedulerOptions {
  /** How often the scheduler looks for hosts that are due. Default one minute. */
  intervalMs?: number;
  /** A host whose check failed (browser unreachable, page did not open) is tried again after this many minutes. Default 30. */
  retryMinutes?: number;
  /** One line per result, without any value. Default `console.log`. */
  log?: (line: string) => void;
  /** How long a check waits for the signed-in page. Default 15 (the same as a human's check). */
  timeoutSeconds?: number;
}

export interface SignInTick {
  /** Why nothing was checked: automation or the schedule is off, the browser is busy, or the previous tick is still running. */
  skipped: "off" | "busy" | "running" | null;
  /** Hosts checked in this tick. */
  checked: { host: string; result: "signed-in" | "signed-out" | "failed" }[];
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RETRY_MINUTES = 30;

/** One recipe per host that can be checked (a recipe with several hosts once per host), oldest answer first (hosts without an answer come first). */
export function dueSignInChecks(rt: Runtime, now: Date, attempts: ReadonlyMap<string, number> = new Map(), retryMinutes = DEFAULT_RETRY_MINUTES): { host: string; recipe: Recipe }[] {
  const hours = rt.automation.signInCheckHours;
  if (!rt.automation.enabled || !(hours > 0)) return [];
  const known = new Map(rt.automation.signInChecks().map((c) => [c.host, Date.parse(c.checkedAt)] as const));
  const seen = new Set<string>();
  const due: { host: string; recipe: Recipe; at: number }[] = [];
  for (const info of rt.automation.recipes) {
    if (!info.canCheckSignIn) continue;
    const recipe = rt.automation.recipe(info.id);
    if (!recipe) continue;
    for (const host of hostListOf(recipe)) {
      if (seen.has(host)) continue;
      seen.add(host);
      const at = known.get(host);
      const stale = at === undefined || Number.isNaN(at) || now.getTime() - at >= hours * 3_600_000;
      const tried = attempts.get(host);
      const coolingDown = tried !== undefined && now.getTime() - tried < retryMinutes * 60_000;
      if (stale && !coolingDown) due.push({ host, recipe, at: at === undefined || Number.isNaN(at) ? -Infinity : at });
    }
  }
  return due.sort((a, b) => a.at - b.at).map(({ host, recipe }) => ({ host, recipe }));
}

export class SignInScheduler {
  readonly #rt: Runtime;
  readonly #interval: number;
  readonly #retry: number;
  readonly #log: (line: string) => void;
  readonly #timeoutSeconds: number | undefined;
  readonly #attempts = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(rt: Runtime, options: SignInSchedulerOptions = {}) {
    this.#rt = rt;
    this.#interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#retry = options.retryMinutes ?? DEFAULT_RETRY_MINUTES;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#timeoutSeconds = options.timeoutSeconds;
  }

  /** One pass: checks every due host, one after the other, and stops as soon as another browser run takes the browser. */
  async tick(): Promise<SignInTick> {
    const automation = this.#rt.automation;
    if (!automation.enabled || !(automation.signInCheckHours > 0)) return { skipped: "off", checked: [] };
    if (this.#running) return { skipped: "running", checked: [] };
    if (automation.isBusy()) return { skipped: "busy", checked: [] };
    this.#running = true;
    const checked: SignInTick["checked"] = [];
    try {
      for (const { host, recipe } of dueSignInChecks(this.#rt, automation.now(), this.#attempts, this.#retry)) {
        if (automation.isBusy()) return { skipped: checked.length === 0 ? "busy" : null, checked };
        this.#attempts.set(host, automation.now().getTime());
        // A check opens the browser, so it is `automation.run` for the system actor `sign-in-scheduler`. A refused host is skipped
        // and tried again after the retry time like a failed one; the other hosts and the timer go on.
        if (!(await authorizeSystem(this.#rt, "sign-in-scheduler", "automation.run", { connectionId: recipe.id }))) {
          this.#log(`secret-desk: scheduled sign-in check ${host}: not allowed by the authorisation hook`);
          continue;
        }
        const r = await checkRecipeSessionScheduled(this.#rt, recipe, { host, ...(this.#timeoutSeconds === undefined ? {} : { timeoutSeconds: this.#timeoutSeconds }) });
        const result = r.failure ? "failed" : r.signedIn ? "signed-in" : "signed-out";
        checked.push({ host, result });
        this.#log(`secret-desk: scheduled sign-in check ${host}: ${r.failure ? `failed (${r.failure.code})` : r.signedIn ? "signed in" : "signed out"}`);
      }
      return { skipped: null, checked };
    } finally {
      this.#running = false;
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), this.#interval);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** Starts the background checks for a long-running process (the portal). */
export function startSignInScheduler(rt: Runtime, options: SignInSchedulerOptions = {}): SignInScheduler {
  const s = new SignInScheduler(rt, options);
  s.start();
  return s;
}
