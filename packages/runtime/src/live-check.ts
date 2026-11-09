import { RecipeRunError, dryRunRecipe, recipeParamVars, type BrowserDriver, type HumanWait, type Recipe } from "@secret-desk/automation";
import { NotConnectedError } from "@secret-desk/core";
import { safeText } from "@secret-desk/providers";
import { listConnections } from "./agent-api.js";
import { checkConnection } from "./connection-check.js";
import { LIVE_CHECK_NOTIFY_CONNECTION, summarize, type LiveCheckConnection, type LiveCheckRecipe, type LiveCheckReport, type LiveCheckTrigger } from "./live-check-store.js";
import type { Runtime } from "./runtime.js";

export * from "./live-check-store.js";

/**
 * The live check: proves against the real accounts that every API integration and every browser recipe still works, so a provider
 * change shows up within a week instead of at the next renewal.
 *
 * It creates nothing at any provider and never reads, stores or logs a value:
 *  - connections: only `checkConnection` without `deep` (read-only calls; `deep` would write a probe entry at GitHub);
 *  - recipes: only `dryRunRecipe`, which stops before the first `createsToken` click and never captures. The driver is wrapped
 *    (see `liveCheckDriver`), so even a recipe that tried would get no page text and no picture;
 *  - a recipe that needs a human (signed out, MFA, "Confirm access", CAPTCHA) is not waited for and nothing is typed: the run is
 *    ended at once and reported as `needs-sign-in`;
 *  - the report holds ids, results, step labels, error kinds and short sanitized texts.
 */

/** Name used wherever a recipe asks for a token name. Obvious on sight, in case it ever shows up in a provider's form. */
export const LIVE_CHECK_PLACEHOLDER = "secret-desk-live-check";
const DEFAULT_RECIPE_TIMEOUT_SECONDS = 120;
const NOTIFY_TIMEOUT_MS = 10_000;
const RUN_KEY = "live-check";

export interface LiveCheckOptions {
  trigger: LiveCheckTrigger;
  /** One line per check, without any value. Default `console.log`. */
  log?: (line: string) => void;
  /** Per recipe: after this long the run is ended and the recipe counts as failed (kind `timeout`). Default 120. */
  recipeTimeoutSeconds?: number;
}

/** A check could not start: another one is running, or the browser is busy with something else (try again later). */
export class LiveCheckBusyError extends Error {
  readonly reason: "running" | "browser-busy";
  constructor(reason: "running" | "browser-busy") {
    super(reason === "running" ? "A live check is already running." : "A browser run is in progress. The live check waits for it.");
    this.name = "LiveCheckBusyError";
    this.reason = reason;
  }
}

const running = new WeakSet<Runtime>();

/** Is a live check running in this process right now? */
export function isLiveCheckRunning(rt: Runtime): boolean {
  return running.has(rt);
}

/** Does the live check have recipes to run in the browser? */
const hasRecipes = (rt: Runtime): boolean => rt.automation.recipes.length > 0;

/**
 * The browser as the live check lets a recipe use it: pages, clicks and waits as usual, but no page text, no attribute other than
 * a link target (the `follow` step needs it) and no picture. A dry run never captures anyway; this keeps it so by construction.
 */
export function liveCheckDriver(inner: BrowserDriver): BrowserDriver {
  const refuse = (what: string): Promise<never> => Promise.reject(new Error(`The live check does not read ${what}.`));
  return {
    open: () => inner.open(),
    goto: (url) => inner.goto(url),
    fill: (sel, value) => inner.fill(sel, value),
    select: (sel, value) => inner.select(sel, value),
    check: (sel, checked) => inner.check(sel, checked),
    click: (sel) => inner.click(sel),
    press: (key, sel) => inner.press(key, sel),
    currentUrl: () => inner.currentUrl(),
    isVisible: (sel) => inner.isVisible(sel),
    hasText: (text) => inner.hasText(text),
    readText: () => refuse("page text"),
    readAttribute: (sel, name) => (name.toLowerCase() === "href" ? inner.readAttribute(sel, name) : refuse("attributes")),
    screenshot: () => Promise.resolve(Buffer.alloc(0)),
    waitFor: (cond, timeoutMs, signal) => inner.waitFor(cond, timeoutMs, signal),
    // A browser that fails to close must not change the result of a run that worked.
    close: () => inner.close().catch(() => undefined),
  };
}

const clean = (text: string): string => safeText(text, []);

/** What a recipe needs to run without a real entry: the fixed placeholder for names, the recipe's own defaults for its parameters. */
function placeholderVars(recipe: Recipe, now: Date): Record<string, string> {
  // A required choice without a default takes its first option: a fixed list of the recipe itself, never account data.
  const chosen = Object.fromEntries(recipe.params.filter((p) => p.default === undefined && p.options).map((p) => [p.key, p.options![0]!]));
  return {
    name: LIVE_CHECK_PLACEHOLDER,
    owner: "",
    days: "30",
    date: now.toISOString().slice(0, 10),
    description: "",
    repos: "",
    permissions: "",
    permissionsQuery: "",
    stage: "dev",
    secretId: LIVE_CHECK_PLACEHOLDER,
    ...recipeParamVars(recipe, chosen),
  };
}

const skipped = (id: string, detail: string): LiveCheckRecipe => ({ id, result: "skipped", detail: clean(detail) });

interface RecipeContext {
  rt: Runtime;
  /** Fires when someone cancels the live check run. */
  cancel: AbortSignal;
  timeoutMs: number;
}

/** Runs the dry run of one recipe. Never throws. */
async function checkRecipe(ctx: RecipeContext, recipe: Recipe): Promise<LiveCheckRecipe> {
  const { rt } = ctx;
  const id = recipe.id;
  let vars: Record<string, string>;
  try {
    vars = placeholderVars(recipe, rt.automation.now());
  } catch (err) {
    return skipped(id, `Inputs cannot be derived: ${(err as Error).message}`);
  }
  // Steps that act on each item of a list (the repositories of a token) cannot run without real items: they are left out.
  const steps = recipe.steps.filter((s) => !("each" in s && s.each));
  const left = recipe.steps.length - steps.length;
  if (steps.length === 0) return skipped(id, "All steps work on a list of real items.");

  const controller = new AbortController();
  const onCancel = (): void => controller.abort();
  ctx.cancel.addEventListener("abort", onCancel, { once: true });
  const seen: { human: HumanWait | null; label: string | undefined } = { human: null, label: undefined };
  let driver: BrowserDriver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    driver = liveCheckDriver(await rt.automation.newDriver());
    const run = dryRunRecipe({ ...recipe, steps }, vars, driver, {
      // The run would wait for the human here (up to the sign-in timeout). It ends at once instead. No `signIn` and no `access`
      // hook is given, so nothing is typed and no code or password is asked for.
      onWaitingForHuman: (w) => {
        seen.human = w;
        controller.abort();
      },
      onProgress: (p) => {
        seen.label = p.label;
      },
    }, { signal: controller.signal });
    const outcome = await Promise.race([
      run.then((r) => ({ done: r }), (error: unknown) => ({ error })),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ctx.timeoutMs);
      }),
    ]);
    if (outcome === "timeout") {
      controller.abort();
      // A page that hangs ignores the signal; closing the browser ends the run in the background.
      await driver.close();
      return { id, result: "failed", ...(seen.label !== undefined ? { step: clean(seen.label) } : {}), kind: "timeout", detail: `No answer within ${Math.round(ctx.timeoutMs / 1000)} seconds.` };
    }
    if ("done" in outcome) return { id, result: "ok", detail: `${outcome.done.executed} steps ran${left > 0 ? `, ${left} per-item step(s) left out` : ""}; stopped before creating anything.` };
    throw outcome.error;
  } catch (err) {
    const step = seen.label !== undefined ? { step: clean(seen.label) } : {};
    if (seen.human !== null) {
      return { id, result: "needs-sign-in", ...step, detail: seen.human.kind === "login" ? "The browser is signed out at this provider." : "A step waits for a person (confirmation, code or password)." };
    }
    if (ctx.cancel.aborted) return skipped(id, "The live check was cancelled.");
    if (err instanceof RecipeRunError) {
      if (err.kind === "params" || err.kind === "unsupported") return { ...skipped(id, err.message), kind: err.kind };
      return { id, result: "failed", ...step, kind: err.kind, detail: clean(err.message) };
    }
    // Not a recipe error: the browser could not be started or reached (closing errors are ignored by the driver wrapper). A dead
    // browser is exactly what the check has to report.
    return { id, result: "failed", ...step, kind: "browser", detail: clean(`Browser not available: ${(err as Error).message}`) };
  } finally {
    clearTimeout(timer);
    ctx.cancel.removeEventListener("abort", onCancel);
  }
}

/** The failing items of a connection check, as one short text (labels and the checker's own sanitized details; never a value). */
function connectionDetail(result: Awaited<ReturnType<typeof checkConnection>>): string {
  const bad = result.checks.filter((c) => c.status === "fail");
  return clean(bad.map((c) => (c.detail ? `${c.label}: ${c.detail}` : c.label)).join("; "));
}

async function checkConnections(rt: Runtime): Promise<LiveCheckConnection[]> {
  const out: LiveCheckConnection[] = [];
  let list: Awaited<ReturnType<typeof listConnections>>;
  try {
    list = await listConnections(rt);
  } catch (err) {
    return [{ id: "connections", result: "failed", detail: clean(`The list of connections could not be read: ${(err as Error).message}`) }];
  }
  for (const c of list) {
    if (!c.connected) {
      out.push({ id: c.id, result: "not-connected" });
      continue;
    }
    try {
      // Never `deep`: that writes and deletes a probe entry at GitHub.
      const r = await checkConnection(rt, c.id, { deep: false });
      out.push(r.ok ? { id: c.id, result: "ok" } : { id: c.id, result: "failed", detail: connectionDetail(r) });
    } catch (err) {
      out.push({ id: c.id, result: "failed", detail: clean((err as Error).message) });
    }
  }
  return out;
}

async function checkRecipes(rt: Runtime, timeoutMs: number): Promise<LiveCheckRecipe[]> {
  // Recipes only exist while the automation is on.
  const list = rt.automation.recipes.map((info) => rt.automation.recipe(info.id)!);
  if (list.length === 0) return [];
  let signal: AbortSignal;
  try {
    signal = rt.automation.begin(RUN_KEY, RUN_KEY, { text: "Live check of the browser recipes." });
  } catch {
    // The browser was taken between the start and now.
    return list.map((r) => skipped(r.id, "The browser was busy."));
  }
  const out: LiveCheckRecipe[] = [];
  try {
    for (const recipe of list) {
      out.push(signal.aborted ? skipped(recipe.id, "The live check was cancelled.") : await checkRecipe({ rt, cancel: signal, timeoutMs }, recipe));
    }
    return out;
  } finally {
    rt.automation.end(RUN_KEY, signal.aborted ? { status: "cancelled", text: "Cancelled." } : { status: "done", text: "Live check finished." });
  }
}

/** Sends the ids of the failed items and of the recipes that need a sign-in to the configured address. Failures here are logged and never fail the check. */
async function notify(rt: Runtime, report: LiveCheckReport, log: (line: string) => void): Promise<void> {
  const needsSignIn = report.recipes.filter((r) => r.result === "needs-sign-in").map((r) => r.id);
  // Recipes that could not be checked mean the browser part proved nothing: worth a message even when nothing failed.
  if ((report.ok && needsSignIn.length === 0) || !rt.config.automation.liveCheckNotify) return;
  const payload = {
    ok: report.ok,
    failedConnections: report.connections.filter((c) => c.result === "failed").map((c) => c.id),
    failedRecipes: report.recipes.filter((r) => r.result === "failed").map((r) => r.id),
    needsSignIn,
    finishedAt: report.finishedAt,
  };
  try {
    // The address may carry a token: it is read here, used once and appears in no log line and no error text.
    const url = (await rt.connections.token(LIVE_CHECK_NOTIFY_CONNECTION)).reveal();
    if (!/^https?:\/\//i.test(url.trim())) throw new Error("not an http(s) address");
    const res = await rt.fetch(url.trim(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    log(res.ok ? "secret-desk: live check notification sent" : `secret-desk: live check notification failed (HTTP ${res.status})`);
  } catch (err) {
    log(`secret-desk: live check notification failed (${err instanceof NotConnectedError ? "address not available" : "request failed"})`);
  }
}

/** Throws {@link LiveCheckBusyError} when a check must not start now. */
function assertCanStart(rt: Runtime): void {
  if (running.has(rt)) throw new LiveCheckBusyError("running");
  if (hasRecipes(rt) && rt.automation.isBusy()) throw new LiveCheckBusyError("browser-busy");
}

const names = (items: { id: string; result: string }[]): string => items.filter((i) => i.result === "failed").map((i) => i.id).join(", ");

/**
 * Runs the whole live check once: all connected integrations, then all browser recipes. Stores the report (the last 12 are kept),
 * logs one line, and tells the configured webhook about failures. Throws {@link LiveCheckBusyError} when it must not start now.
 */
export async function runLiveCheck(rt: Runtime, options: LiveCheckOptions): Promise<LiveCheckReport> {
  assertCanStart(rt);
  running.add(rt);
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const startedAt = rt.automation.now().toISOString();
    const connections = await checkConnections(rt);
    const recipes = await checkRecipes(rt, (options.recipeTimeoutSeconds ?? DEFAULT_RECIPE_TIMEOUT_SECONDS) * 1000);
    const summary = summarize(connections, recipes);
    const ok = summary.connections.failed === 0 && summary.recipes.failed === 0;
    const report: LiveCheckReport = { startedAt, finishedAt: rt.automation.now().toISOString(), ok, trigger: options.trigger, connections, recipes, summary };
    rt.automation.recordLiveCheck(report);
    const failed = [names(connections), names(recipes)].filter(Boolean).join(", ");
    log(
      `secret-desk: live check (${options.trigger}) ${ok ? "ok" : `FAILED: ${failed}`}; connections ${summary.connections.ok} ok, ${summary.connections.failed} failed, ${summary.connections.notConnected} not connected; recipes ${summary.recipes.ok} ok, ${summary.recipes.failed} failed, ${summary.recipes.needsSignIn} need sign-in, ${summary.recipes.skipped} skipped`,
    );
    await notify(rt, report, log);
    return report;
  } finally {
    running.delete(rt);
  }
}

/**
 * Starts a manual check in the background (a check takes minutes) and returns at once; the portal polls {@link getLiveCheck}.
 * Throws {@link LiveCheckBusyError} when one is running or the browser is busy, so the caller can answer 409.
 */
export function startLiveCheck(rt: Runtime, options: Omit<LiveCheckOptions, "trigger"> = {}): void {
  assertCanStart(rt);
  void runLiveCheck(rt, { ...options, trigger: "manual" }).catch(() => undefined);
}

/** Is the last stored report older than `days` days (or is there none)? */
export function liveCheckDue(rt: Runtime, now: Date = rt.automation.now()): boolean {
  const days = rt.automation.liveCheckDays;
  if (!(days > 0)) return false;
  const last = rt.automation.liveCheckReports()[0];
  return last === undefined || now.getTime() - Date.parse(last.finishedAt) >= days * 86_400_000;
}

/** The live check as the portal and the CLI show it: the stored reports, whether one runs now, and when the last is too old. */
export function getLiveCheck(rt: Runtime, now: Date = rt.automation.now()): { reports: LiveCheckReport[]; running: boolean; intervalDays: number; stale: boolean } {
  const reports = rt.automation.liveCheckReports();
  const days = rt.automation.liveCheckDays;
  const last = reports[0];
  // Older than twice the interval (or none at all while the check is on) is a warning: the schedule is not keeping up.
  const stale = days > 0 && (last === undefined || now.getTime() - Date.parse(last.finishedAt) > 2 * days * 86_400_000);
  return { reports, running: isLiveCheckRunning(rt), intervalDays: days, stale };
}

export interface LiveCheckSchedulerOptions {
  /** How often the scheduler looks whether a check is due. Default one minute. */
  intervalMs?: number;
  /** One line per check, without any value. Default `console.log`. */
  log?: (line: string) => void;
  recipeTimeoutSeconds?: number;
}

export interface LiveCheckTick {
  /** Why nothing ran: the check is off, no check is due yet, the browser is busy, or one is running already. */
  skipped: "off" | "not-due" | "busy" | "running" | null;
  report: LiveCheckReport | null;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Runs the live check when the last stored report is older than `automation.liveCheckDays`. Follows {@link SignInScheduler}. */
export class LiveCheckScheduler {
  readonly #rt: Runtime;
  readonly #interval: number;
  readonly #options: LiveCheckOptions;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(rt: Runtime, options: LiveCheckSchedulerOptions = {}) {
    this.#rt = rt;
    this.#interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#options = { trigger: "schedule", ...(options.log ? { log: options.log } : {}), ...(options.recipeTimeoutSeconds !== undefined ? { recipeTimeoutSeconds: options.recipeTimeoutSeconds } : {}) };
  }

  /** One pass. A check postponed because the browser is busy is tried again on the next tick. */
  async tick(): Promise<LiveCheckTick> {
    const rt = this.#rt;
    if (!(rt.automation.liveCheckDays > 0)) return { skipped: "off", report: null };
    if (isLiveCheckRunning(rt)) return { skipped: "running", report: null };
    if (!liveCheckDue(rt)) return { skipped: "not-due", report: null };
    try {
      return { skipped: null, report: await runLiveCheck(rt, this.#options) };
    } catch (err) {
      // "Running" was ruled out above, so what is left is a browser that is busy with something else.
      if (err instanceof LiveCheckBusyError) return { skipped: "busy", report: null };
      throw err;
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

/** Starts the weekly live check for a long-running process (the portal). */
export function startLiveCheckScheduler(rt: Runtime, options: LiveCheckSchedulerOptions = {}): LiveCheckScheduler {
  const s = new LiveCheckScheduler(rt, options);
  s.start();
  return s;
}
