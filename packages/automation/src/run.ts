import { SecretValue, redact } from "@secret-desk/core";
import type { BrowserDriver, ResolvedCondition } from "./driver.js";
import { hostAllowed, paramValueProblem, resolveRecipe, type CaptureValue, type Condition, type Recipe, type Step, type When } from "./recipe.js";
import { describeSelector, pickSelector, type Selector } from "./selector.js";
import { SUDO_FLOWS, SudoError, confirmAccess, sudoPageShown, type SudoHooks } from "./sudo.js";
import { renderTemplate } from "./template.js";
import { WaitAbortedError, WaitTimeoutError, conditionMet } from "./wait.js";

export interface HumanWait {
  /** login: the sign-in is missing. pause: a step of the recipe waits for the human (for example a password confirmation). */
  kind: "login" | "pause";
  reason: string;
  /** Adresse ohne Query und Fragment. */
  url: string;
}

export interface RunHooks {
  /** Der Mensch muss im Browserfenster etwas tun (Anmeldung, 2FA, Bestaetigung). */
  onWaitingForHuman?(info: HumanWait): void | Promise<void>;
  onResumed?(): void;
  onProgress?(info: { index: number; total: number; label: string }): void;
  /**
   * The portal answers confirmations the provider asks for in the middle of a run (`confirmAccess` steps, for example GitHub's
   * "Confirm access"): how to confirm, the code or password, the number to tap. Without it such a step waits for the human in
   * the browser window (`onWaitingForHuman`, kind `pause`).
   */
  access?: SudoHooks;
  /**
   * The browser is signed out when the recipe needs it (`login.expect` does not hold after the first `goto`) and the recipe has
   * a guided sign-in (`login.form`): signs in on the same open driver, asking the portal for the credentials. Resolves once
   * signed in. Without it the run waits for the human in the browser window (kind `login`). Its errors end the run unchanged.
   */
  signIn?(driver: BrowserDriver): Promise<void>;
}

export interface RunOptions {
  /** Wie lange auf den Menschen gewartet wird. Standard 10. */
  loginTimeoutMinutes?: number;
  signal?: AbortSignal;
  /** Abstand der Pruefungen beim Warten, Standard 250 ms. */
  pollMs?: number;
  /** Timing of `confirmAccess` steps (tests shorten it): how long GitHub Mobile may take, how long a code or password is checked, tries. */
  access?: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
}

/** A hook's own error: it ends the run as it is, not as "action not possible". */
class HookFailure extends Error {
  constructor(readonly original: unknown) {
    super("hook failed");
  }
}

export interface Screenshot {
  name: string;
  png: Buffer;
}

export interface RunResult {
  /** The new token (kind create) or the value the entry picks (kind read). */
  value: SecretValue;
  /** kind read: every value read in the run, by name (the picked one included). */
  values?: Record<string, SecretValue>;
  externalId?: string;
  /** JJJJ-MM-TT */
  expiresAt?: string;
  screenshots: Screenshot[];
  /** Name, unter dem beim Anbieter ein Token angelegt wurde. */
  createdName?: string;
}

/** `unsupported`: the account or page does not offer what the recipe needs (a `fail` step marked `unsupported`), not a broken recipe. */
export type RunErrorKind = "abort" | "timeout" | "host" | "step" | "capture" | "params" | "unsupported";

export class RecipeRunError extends Error {
  readonly kind: RunErrorKind;
  /** Beim Anbieter vermutlich schon angelegter Name: der Mensch muss ihn dort loeschen. */
  readonly createdName: string | undefined;
  constructor(kind: RunErrorKind, message: string, createdName?: string) {
    super(createdName ? `${message} Beim Anbieter kann schon ein Token namens "${createdName}" angelegt sein: dort pruefen und loeschen.` : message);
    this.name = "RecipeRunError";
    this.kind = kind;
    this.createdName = createdName;
  }
}

export interface DryRunResult {
  /** Zahl der ausgefuehrten Schritte vor dem Erzeugen. */
  executed: number;
  screenshots: Screenshot[];
}

type Vars = Record<string, string>;

/**
 * Checks the values of the recipe's declared parameters. A missing required value or one outside pattern/options is an
 * error that names the key (never the value), thrown before any browser is opened.
 */
export function checkRecipeParams(recipe: Pick<Recipe, "params">, vars: Vars): void {
  for (const p of recipe.params) {
    const value = (vars[p.key] ?? "").trim();
    if (value === "") {
      if (p.required) throw new RecipeRunError("params", `Pflichtparameter ${p.key} (${p.label}) fehlt.`);
      continue;
    }
    if (paramValueProblem(p, value) === undefined) continue;
    if (p.options && !p.options.includes(value)) throw new RecipeRunError("params", `Parameter ${p.key} (${p.label}): der Wert ist nicht erlaubt (erlaubt: ${p.options.join(", ")}).`);
    throw new RecipeRunError("params", `Parameter ${p.key} (${p.label}): der Wert hat nicht das erwartete Format.`);
  }
}

/** Template variables for the recipe's declared parameters, from `params` of the inventory entry. Defaults fill gaps; numbers are stringified. */
export function recipeParamVars(recipe: Pick<Recipe, "params">, params: Record<string, unknown>): Vars {
  const out: Vars = {};
  for (const p of recipe.params) {
    const raw = params[p.key];
    const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
    out[p.key] = text !== "" ? text : (p.default ?? "");
  }
  checkRecipeParams(recipe, out);
  return out;
}

const TIMEOUT_DEFAULT_S = 30;
const OPTIONAL_TIMEOUT_S = 3;

function describeStep(step: Step): string {
  if ("goto" in step) return "goto";
  if ("follow" in step) return `follow ${describeSelector(pickSelector(step.follow))}`;
  if ("fill" in step) return `fill ${describeSelector(pickSelector(step.fill))}`;
  if ("select" in step) return `select ${describeSelector(pickSelector(step.select))}`;
  if ("check" in step) return `check ${describeSelector(pickSelector(step.check))}`;
  if ("click" in step) return `click ${describeSelector(pickSelector(step.click))}`;
  if ("press" in step) return `press ${step.press.key}`;
  if ("waitFor" in step) return "waitFor";
  if ("pause" in step) return `pause human: ${step.pause.human}`;
  if ("confirmAccess" in step) return `confirmAccess ${step.confirmAccess.flow}`;
  if ("set" in step) return `set ${step.set.var}`;
  if ("fail" in step) return "fail";
  return `screenshot ${step.screenshot}`;
}

/** Texte rendern, regulaere Ausdruecke (url) und Tasten bleiben unveraendert. */
function renderValue<T>(value: T, vars: Vars, key = ""): T {
  if (typeof value === "string") return (key === "url" || key === "key" ? value : renderTemplate(value, vars)) as T;
  if (Array.isArray(value)) return value.map((v) => renderValue(v, vars)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v, vars, k)])) as T;
  }
  return value;
}

export function resolveCondition(c: Condition & { any?: Condition[] | undefined }, vars: Vars): ResolvedCondition {
  const r = renderValue(c, vars);
  return {
    ...(r.any ? { any: r.any.map((one) => resolveCondition(one, vars)) } : {}),
    ...(r.all ? { all: r.all.map((one) => resolveCondition(one, vars)) } : {}),
    ...(r.url !== undefined ? { url: new RegExp(r.url) } : {}),
    ...(r.visible ? { visible: r.visible as Selector } : {}),
    ...(r.hidden ? { hidden: r.hidden as Selector } : {}),
    ...(r.text !== undefined ? { text: r.text } : {}),
  };
}

function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

class Runner {
  readonly screenshots: Screenshot[] = [];
  createdName: string | undefined;
  /** Zahl der ausgefuehrten Schritte. */
  executed = 0;
  readonly #known: string[] = [];
  /** The run's own copy: `set` steps change it, the caller's object stays as it was. */
  readonly vars: Vars;
  #loggedIn: boolean;
  #index = 0;
  #total = 0;

  /** The recipe for the one portal this run uses (see `resolveRecipe`): host, allowlist and sign-in follow the parameter value. */
  readonly recipe: Recipe;

  constructor(
    recipe: Recipe,
    vars: Vars,
    readonly driver: BrowserDriver,
    readonly hooks: RunHooks,
    readonly options: RunOptions,
  ) {
    this.vars = { ...vars };
    checkRecipeParams(recipe, vars);
    this.recipe = resolveRecipe(recipe, recipe.hostBy ? vars[recipe.hostBy] : undefined);
    this.#loggedIn = recipe.login === undefined;
  }

  addSecret(v: string): void {
    this.#known.push(v);
  }

  fail(kind: RunErrorKind, message: string, withCreated = true): never {
    throw new RecipeRunError(kind, redact(message, this.#known), withCreated ? this.createdName : undefined);
  }

  #aborted(): void {
    if (this.options.signal?.aborted) this.fail("abort", "Abgebrochen.");
  }

  /** Fuehrt Schritte aus. Mit stopAtCreate endet es vor dem ersten createsToken-Schritt und liefert true. */
  async execute(steps: Step[], stopAtCreate: boolean): Promise<boolean> {
    this.#total = steps.length;
    // Eine leere Liste (zum Beispiel keine Repos) darf nicht still dazu fuehren, dass Schritte entfallen: Fehler vor dem ersten Klick.
    for (const [i, step] of steps.entries()) {
      if ("each" in step && step.each && (this.vars[step.each] ?? "").split(",").every((s) => !s.trim())) {
        this.fail("step", `Schritt ${i + 1} (${describeStep(step)}) braucht eine Liste "${step.each}", sie ist leer.`, false);
      }
    }
    for (const [i, step] of steps.entries()) {
      this.#index = i + 1;
      this.#aborted();
      if ("when" in step && step.when) {
        let holds: boolean;
        try {
          holds = await this.#whenHolds(step.when);
        } catch (err) {
          this.#rethrow(err, i, step);
        }
        if (!holds) continue;
      }
      if (stopAtCreate && "click" in step && step.click.createsToken) return true;
      this.hooks.onProgress?.({ index: this.#index, total: this.#total, label: describeStep(step) });
      const items = "each" in step && step.each ? (this.vars[step.each] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [undefined];
      for (const item of items) {
        const vars = item === undefined ? this.vars : { ...this.vars, item };
        try {
          if (await this.#run(step, vars)) this.executed++;
        } catch (err) {
          this.#rethrow(err, i, step);
        }
      }
    }
    return false;
  }

  /** Evaluates the `when` of a step now: a variable check, an element that is (or becomes within the timeout) visible, or all of them. */
  async #whenHolds(when: NonNullable<When>): Promise<boolean> {
    if ("all" in when) {
      for (const one of when.all) if (!(await this.#whenHolds(one))) return false;
      return true;
    }
    if ("var" in when) {
      const value = (this.vars[when.var] ?? "").trim();
      return when.equals !== undefined ? value === when.equals : value !== when.notEquals;
    }
    const waitMs = (when.timeoutSeconds ?? 0) * 1000;
    if ("absent" in when) {
      const sel = pickSelector(renderValue(when.absent, this.vars));
      if (waitMs <= 0) return !(await this.driver.isVisible(sel).catch(() => false));
      try {
        await this.driver.waitFor({ visible: sel }, waitMs, this.options.signal);
        return false;
      } catch (err) {
        if (err instanceof WaitTimeoutError) return true;
        throw err;
      }
    }
    const sel = pickSelector(renderValue(when.visible, this.vars));
    if (waitMs <= 0) return this.driver.isVisible(sel).catch(() => false);
    try {
      await this.driver.waitFor({ visible: sel }, waitMs, this.options.signal);
      return true;
    } catch (err) {
      if (err instanceof WaitTimeoutError) return false;
      throw err;
    }
  }

  #rethrow(err: unknown, i: number, step: Step): never {
    if (err instanceof RecipeRunError) throw err;
    if (err instanceof HookFailure) throw err.original;
    if (err instanceof WaitAbortedError) this.fail("abort", "Abgebrochen.");
    const reason =
      err instanceof WaitTimeoutError || (err as Error).name === "TimeoutError"
        ? "Zeitueberschreitung (Element oder Seite nicht wie erwartet)"
        : (err as Error).name === "TemplateError"
          ? (err as Error).message
          : "Aktion nicht moeglich";
    return this.fail("step", `Schritt ${i + 1} (${describeStep(step)}) fehlgeschlagen: ${reason}.`);
  }

  async checkHost(): Promise<void> {
    const url = await this.driver.currentUrl();
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      host = u.hostname;
    } catch {
      return this.fail("host", "Die Seite im Browser ist keine erlaubte Webseite.");
    }
    if (!hostAllowed(host, this.recipe)) this.fail("host", `Die Seite im Browser (${host}) liegt ausserhalb von ${this.recipe.host}: Abbruch.`);
  }

  /** Runs one step. Resolves to false when an optional step found nothing to do. */
  async #run(step: Step, vars: Vars): Promise<boolean> {
    if ("click" in step && step.click.optional) {
      // An optional element (a cookie banner) is waited for briefly; absent means there is nothing to do.
      await this.checkHost();
      const sel = pickSelector(renderValue(step.click, vars));
      try {
        await this.driver.waitFor({ visible: sel }, (step.click.timeoutSeconds ?? OPTIONAL_TIMEOUT_S) * 1000, this.options.signal);
      } catch (err) {
        if (err instanceof WaitTimeoutError) return false;
        throw err;
      }
      // The element is there but cannot be acted on (covered, disabled, detached on the way): nothing to do either. The run
      // still stops for an abort and for a page outside the recipe's hosts.
      try {
        await this.#perform(step, vars);
      } catch (err) {
        if (err instanceof RecipeRunError || err instanceof WaitAbortedError || err instanceof HookFailure) throw err;
        this.#aborted();
        return false;
      }
      return true;
    }
    await this.#perform(step, vars);
    return true;
  }

  async #perform(step: Step, vars: Vars): Promise<void> {
    if ("goto" in step) return this.#open(renderTemplate(step.goto, vars, { url: true }));
    if ("follow" in step) {
      await this.checkHost();
      const href = await this.driver.readAttribute(pickSelector(renderValue(step.follow, vars)), "href").catch(() => "");
      if (href.trim() === "") return this.fail("step", "The link to follow was not found or has no address.");
      let target: string;
      try {
        target = new URL(href.trim(), await this.driver.currentUrl()).toString();
      } catch {
        return this.fail("host", "The link to follow is not a valid address.");
      }
      return this.#open(target);
    }
    if ("waitFor" in step) {
      const w = step.waitFor;
      const cond = resolveCondition(
        { ...(w.url !== undefined ? { url: w.url } : {}), ...(w.visible ? { visible: w.visible } : {}), ...(w.hidden ? { hidden: w.hidden } : {}), ...(w.text !== undefined ? { text: w.text } : {}), ...(w.any ? { any: w.any } : {}), ...(w.all ? { all: w.all } : {}) },
        vars,
      );
      return this.driver.waitFor(cond, (w.timeoutSeconds ?? TIMEOUT_DEFAULT_S) * 1000, this.options.signal);
    }
    if ("pause" in step) {
      const reason = renderValue(step.pause.human, vars);
      return this.#waitForHuman("pause", reason, resolveCondition(step.pause.until, vars));
    }
    if ("confirmAccess" in step) return this.#confirmAccess(step.confirmAccess, vars);
    if ("set" in step) {
      this.vars[step.set.var] = step.set.value;
      return;
    }
    if ("fail" in step) return this.fail(step.unsupported ? "unsupported" : "step", step.fail);
    await this.checkHost();
    if ("screenshot" in step) return this.shoot(step.screenshot);
    if ("fill" in step) return this.driver.fill(pickSelector(renderValue(step.fill, vars)), renderValue(step.fill.value, vars));
    if ("select" in step) return this.driver.select(pickSelector(renderValue(step.select, vars)), renderValue(step.select.value, vars));
    if ("check" in step) return this.driver.check(pickSelector(renderValue(step.check, vars)), step.check.checked);
    if ("press" in step) {
      const sel = pickSelector(renderValue(step.press, vars));
      return this.driver.press(step.press.key, Object.keys(sel).length ? sel : undefined);
    }
    if (step.click.createsToken) this.createdName = vars["name"];
    return this.driver.click(pickSelector(renderValue(step.click, vars)));
  }

  /** Opens a page on an allowed host (the first one also waits for the sign-in). */
  async #open(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return this.fail("host", "Adresse im Rezept ist ungueltig.");
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return this.fail("host", "Adresse im Rezept ist ungueltig.");
    if (!hostAllowed(u.hostname, this.recipe)) return this.fail("host", `Adresse ausserhalb von ${this.recipe.host}: ${u.hostname}.`);
    await this.driver.goto(url);
    if (!this.#loggedIn) {
      await this.#ensureLogin();
      // Nach der Anmeldung landet man oft woanders: Zielseite noch einmal laden.
      await this.driver.goto(url);
    }
  }

  async #ensureLogin(): Promise<void> {
    const login = this.recipe.login;
    if (!login) return;
    const cond = resolveCondition(login.expect, this.vars);
    const met = (): Promise<boolean> => conditionMet(this.driver, cond).catch(() => false);
    if (!(await met())) {
      if (this.hooks.signIn && login.form) {
        try {
          await this.hooks.signIn(this.driver);
        } catch (err) {
          throw new HookFailure(err);
        }
      }
      // Still signed out (no portal sign-in, or it left the browser elsewhere): the human does it in the browser window.
      if (!(await met())) await this.#waitForHuman("login", login.message ?? "Bitte im Browserfenster anmelden (Passwort, 2FA, Bestaetigungen).", cond);
    }
    this.#loggedIn = true;
  }

  /** A confirmation the provider may ask for (GitHub "Confirm access"): answered in the portal, or by the human in the browser window. */
  async #confirmAccess(spec: { flow: keyof typeof SUDO_FLOWS; until: Condition; timeoutSeconds?: number | undefined }, vars: Vars): Promise<void> {
    const flow = SUDO_FLOWS[spec.flow];
    const until = resolveCondition(spec.until, vars);
    const waitMs = (spec.timeoutSeconds ?? TIMEOUT_DEFAULT_S) * 1000;
    const pollMs = this.options.pollMs ?? 250;
    await this.checkHost();
    const deadline = Date.now() + waitMs;
    for (;;) {
      this.#aborted();
      if (await conditionMet(this.driver, until).catch(() => false)) return;
      if (await sudoPageShown(this.driver, flow)) break;
      if (Date.now() >= deadline) return this.fail("step", "Neither the expected page nor the confirmation page of the provider appeared.");
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!this.hooks.access) return this.#waitForHuman("pause", flow.humanHint, until);
    try {
      await confirmAccess(flow, {
        driver: this.driver,
        hooks: this.hooks.access,
        signal: this.options.signal,
        checkHost: () => this.checkHost(),
        addSecret: (v) => this.addSecret(v),
        pollMs,
        ...this.options.access,
      });
    } catch (err) {
      if (!(err instanceof SudoError)) throw err;
      if (err.kind === "abort") return this.fail("abort", "Abgebrochen.");
      return this.fail(err.kind === "timeout" ? "timeout" : "step", err.message);
    }
    await this.driver.waitFor(until, waitMs, this.options.signal);
  }

  async #waitForHuman(kind: HumanWait["kind"], reason: string, cond: ResolvedCondition): Promise<void> {
    if (await conditionMet(this.driver, cond).catch(() => false)) return;
    const minutes = this.options.loginTimeoutMinutes ?? 10;
    await this.hooks.onWaitingForHuman?.({ kind, reason, url: stripUrl(await this.driver.currentUrl().catch(() => "")) });
    try {
      await this.driver.waitFor(cond, minutes * 60_000, this.options.signal);
    } catch (err) {
      if (err instanceof WaitAbortedError) this.fail("abort", "Abgebrochen.");
      this.fail("timeout", `Zeitlimit von ${minutes} Minuten abgelaufen: ${reason}`);
    } finally {
      this.hooks.onResumed?.();
    }
  }

  /** Screenshot mit allen Masken aus dem Rezept (plus extra). A recipe that confirms access also masks the code and password fields. */
  async shoot(name: string, extra: Selector[] = []): Promise<void> {
    const confirms = [...this.recipe.steps, ...(this.recipe.revoke?.steps ?? [])].some((st) => "confirmAccess" in st);
    const png = await this.driver.screenshot([...this.recipe.mask.map((m) => renderValue(m, this.vars) as Selector), ...(confirms ? Object.values(SUDO_FLOWS).flatMap((f) => [...f.masks]) : []), ...extra]);
    this.screenshots.push({ name, png });
  }
}

/** Rezept bis vor den ersten createsToken-Schritt ausfuehren (Probelauf). Erzeugt nichts. */
export async function dryRunRecipe(recipe: Recipe, vars: Vars, driver: BrowserDriver, hooks: RunHooks = {}, options: RunOptions = {}): Promise<DryRunResult> {
  const r = new Runner(recipe, vars, driver, hooks, options);
  await driver.open();
  try {
    await r.execute(recipe.steps, true);
    return { executed: r.executed, screenshots: r.screenshots };
  } finally {
    await driver.close();
  }
}

/**
 * Rezept ausfuehren und den Token lesen. Oeffnet und schliesst den Treiber selbst.
 * Der Token steht nur im Feld `value` des Ergebnisses, nie in Fehlern, Namen oder Hook-Argumenten.
 */
export async function runRecipe(recipe: Recipe, vars: Vars, driver: BrowserDriver, hooks: RunHooks = {}, options: RunOptions = {}): Promise<RunResult> {
  const r = new Runner(recipe, vars, driver, hooks, options);
  await driver.open();
  try {
    await r.execute(recipe.steps, false);
    return await capture(r, recipe, vars, driver, options);
  } finally {
    await driver.close();
  }
}

/** Widerruf per Rezept (revoke.steps). `vars` enthaelt dann externalId. */
export async function revokeRecipe(recipe: Recipe, vars: Vars, driver: BrowserDriver, hooks: RunHooks = {}, options: RunOptions = {}): Promise<void> {
  if (!recipe.revoke) throw new RecipeRunError("step", `Rezept ${recipe.id} kennt keinen Widerruf: beim Anbieter von Hand widerrufen.`);
  const r = new Runner(recipe, vars, driver, hooks, options);
  await driver.open();
  try {
    await r.execute(recipe.revoke.steps, false);
  } finally {
    await driver.close();
  }
}

async function readValue(r: Runner, sel: Selector, pattern: string | undefined, what: string, attribute?: string): Promise<string> {
  let raw: string;
  try {
    raw = (attribute ? await r.driver.readAttribute(sel, attribute) : await r.driver.readText(sel)).trim();
  } catch {
    return r.fail("capture", `${what} nicht lesbar (${describeSelector(sel)}).`);
  }
  if (!pattern) return raw;
  const m = new RegExp(pattern).exec(raw);
  const out = m ? (m[1] ?? m[0]) : "";
  if (!out) return r.fail("capture", `${what} passt nicht zum erwarteten Muster.`);
  return out;
}

function renderTemplateSelector(sel: Selector, vars: Vars, r: Runner): Selector {
  try {
    return renderValue(sel, vars);
  } catch (err) {
    return r.fail("capture", (err as Error).message);
  }
}

/**
 * kind read: reads every declared value of the page. The first set of selectors is tried first; if one of its elements does not
 * show up in time, the fallback set (another page, reached by its own steps) is tried. A value that is missing everywhere, does not
 * match its pattern or equals the other value ends the run (fail closed). Nothing is written and nothing is created.
 */
async function captureRead(r: Runner, recipe: Recipe, vars: Vars, driver: BrowserDriver, options: RunOptions): Promise<RunResult> {
  const cap = recipe.capture;
  const primary = cap.values ?? {};
  const names = Object.keys(primary);

  const present = async (set: Record<string, CaptureValue>): Promise<boolean> => {
    await r.checkHost();
    for (const name of names) {
      const spec = set[name] as CaptureValue;
      try {
        await driver.waitFor({ visible: renderTemplateSelector(spec.find, vars, r) }, spec.timeoutSeconds * 1000, options.signal);
      } catch (err) {
        if (err instanceof WaitAbortedError) return r.fail("abort", "Abgebrochen.");
        return false;
      }
    }
    return true;
  };

  let used = primary;
  if (!(await present(primary))) {
    if (!cap.fallback) return r.fail("capture", "The values were not found on the page.");
    await r.execute(cap.fallback.steps, false);
    used = cap.fallback.values;
    if (!(await present(used))) return r.fail("capture", "The values were not found on the page.");
  }

  await r.checkHost();
  const read: Record<string, string> = {};
  for (const name of names) {
    const spec = used[name] as CaptureValue;
    const find = renderTemplateSelector(spec.find, vars, r);
    const value = await readValue(r, find, spec.pattern, `Value ${name}`, spec.attribute);
    if (!value) return r.fail("capture", `Value ${name} is empty.`);
    r.addSecret(value);
    read[name] = value;
  }
  if (new Set(Object.values(read)).size !== names.length) return r.fail("capture", "Two values read from the page are identical: the page is not as expected.");

  const pickKey = cap.pick;
  const picked = pickKey === undefined ? names[0] : (vars[pickKey] ?? "").trim();
  if (picked === undefined || !Object.hasOwn(read, picked)) return r.fail("params", "The parameter that picks the value does not name a value of the page.");

  // Evidence after reading, with every value masked. A failing screenshot does not lose the values.
  await r.shoot("nach-lesen", names.map((n) => renderTemplateSelector((used[n] as CaptureValue).find, vars, r))).catch(() => undefined);

  return {
    value: SecretValue.from(read[picked] as string),
    values: Object.fromEntries(names.map((n) => [n, SecretValue.from(read[n] as string)])),
    screenshots: r.screenshots,
  };
}

async function capture(r: Runner, recipe: Recipe, vars: Vars, driver: BrowserDriver, options: RunOptions): Promise<RunResult> {
  if (recipe.kind === "read") return captureRead(r, recipe, vars, driver, options);
  const cap = recipe.capture as Recipe["capture"] & { token: NonNullable<Recipe["capture"]["token"]> };
  // The selectors may name the entry's own row ({{name}}), so they are rendered like a step selector. The first one that is visible
  // wins (a page that comes in more than one variant shows the token in different places).
  const candidates = [
    { find: renderTemplateSelector(cap.token.find, vars, r), attribute: cap.token.attribute },
    ...(cap.token.alternatives ?? []).map((a) => ({ find: renderTemplateSelector(a.find, vars, r), attribute: a.attribute })),
  ];
  // Token nur lesen, wenn der Browser noch auf einer erlaubten Seite steht (ein Klick kann woandershin fuehren).
  await r.checkHost();
  try {
    await driver.waitFor(candidates.length === 1 ? { visible: candidates[0]!.find } : { any: candidates.map((c) => ({ visible: c.find })) }, cap.token.timeoutSeconds * 1000, options.signal);
  } catch (err) {
    if (err instanceof WaitAbortedError) return r.fail("abort", "Abgebrochen.");
    return r.fail("capture", `Token-Feld nicht gefunden (${candidates.map((c) => describeSelector(c.find)).join(" | ")}).`);
  }
  let found = candidates[0]!;
  for (const c of candidates) {
    if (await driver.isVisible(c.find).catch(() => false)) {
      found = c;
      break;
    }
  }
  const find = found.find;
  await r.checkHost();
  const token = await readValue(r, find, cap.token.pattern, "Token", found.attribute);
  if (!token) return r.fail("capture", "Token-Feld ist leer.");
  r.addSecret(token);

  let externalId: string | undefined;
  const ext = cap.externalId;
  if (ext && "from" in ext) externalId = vars[ext.from];
  else if (ext) externalId = await readValue(r, renderTemplateSelector(ext.find, vars, r), ext.pattern, "Kennung");
  if (externalId?.includes(token)) externalId = undefined; // nie den Wert als Kennung fuehren

  let expiresAt: string | undefined;
  if (cap.expires) {
    const days = Number(vars["days"]);
    const start = Date.parse(`${vars["date"] ?? ""}T00:00:00Z`);
    if (Number.isFinite(days) && Number.isFinite(start)) expiresAt = new Date(start + days * 86_400_000).toISOString().slice(0, 10);
  }

  // Beleg nach dem Erzeugen, Wert verdeckt. Scheitert er, geht der Token trotzdem nicht verloren.
  await r.shoot("nach-erzeugen", candidates.map((c) => c.find)).catch(() => undefined);

  return {
    value: SecretValue.from(token),
    ...(externalId ? { externalId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    screenshots: r.screenshots,
    ...(r.createdName ? { createdName: r.createdName } : {}),
  };
}
