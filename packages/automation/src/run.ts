import { SecretValue, redact } from "@secret-desk/core";
import type { BrowserDriver, ResolvedCondition } from "./driver.js";
import { hostAllowed, type Condition, type Recipe, type Step } from "./recipe.js";
import { describeSelector, pickSelector, type Selector } from "./selector.js";
import { renderTemplate } from "./template.js";
import { WaitAbortedError, WaitTimeoutError, conditionMet } from "./wait.js";

export interface HumanWait {
  reason: string;
  /** Adresse ohne Query und Fragment. */
  url: string;
}

export interface RunHooks {
  /** Der Mensch muss im Browserfenster etwas tun (Anmeldung, 2FA, Bestaetigung). */
  onWaitingForHuman?(info: HumanWait): void | Promise<void>;
  onResumed?(): void;
  onProgress?(info: { index: number; total: number; label: string }): void;
}

export interface RunOptions {
  /** Wie lange auf den Menschen gewartet wird. Standard 10. */
  loginTimeoutMinutes?: number;
  signal?: AbortSignal;
  /** Abstand der Pruefungen beim Warten, Standard 250 ms. */
  pollMs?: number;
}

export interface Screenshot {
  name: string;
  png: Buffer;
}

export interface RunResult {
  value: SecretValue;
  externalId?: string;
  /** JJJJ-MM-TT */
  expiresAt?: string;
  screenshots: Screenshot[];
  /** Name, unter dem beim Anbieter ein Token angelegt wurde. */
  createdName?: string;
}

export type RunErrorKind = "abort" | "timeout" | "host" | "step" | "capture";

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

const TIMEOUT_DEFAULT_S = 30;

function describeStep(step: Step): string {
  if ("goto" in step) return "goto";
  if ("fill" in step) return `fill ${describeSelector(pickSelector(step.fill))}`;
  if ("select" in step) return `select ${describeSelector(pickSelector(step.select))}`;
  if ("check" in step) return `check ${describeSelector(pickSelector(step.check))}`;
  if ("click" in step) return `click ${describeSelector(pickSelector(step.click))}`;
  if ("press" in step) return `press ${step.press.key}`;
  if ("waitFor" in step) return "waitFor";
  if ("pause" in step) return `pause human: ${step.pause.human}`;
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

function resolveCondition(c: Condition, vars: Vars): ResolvedCondition {
  const r = renderValue(c, vars);
  return { ...(r.url !== undefined ? { url: new RegExp(r.url) } : {}), ...(r.visible ? { visible: r.visible as Selector } : {}), ...(r.text !== undefined ? { text: r.text } : {}) };
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
  #loggedIn: boolean;
  #index = 0;
  #total = 0;

  constructor(
    readonly recipe: Recipe,
    readonly vars: Vars,
    readonly driver: BrowserDriver,
    readonly hooks: RunHooks,
    readonly options: RunOptions,
  ) {
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
      if (stopAtCreate && "click" in step && step.click.createsToken) return true;
      this.hooks.onProgress?.({ index: this.#index, total: this.#total, label: describeStep(step) });
      const items = "each" in step && step.each ? (this.vars[step.each] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [undefined];
      for (const item of items) {
        const vars = item === undefined ? this.vars : { ...this.vars, item };
        try {
          await this.#run(step, vars);
          this.executed++;
        } catch (err) {
          this.#rethrow(err, i, step);
        }
      }
    }
    return false;
  }

  #rethrow(err: unknown, i: number, step: Step): never {
    if (err instanceof RecipeRunError) throw err;
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

  async #run(step: Step, vars: Vars): Promise<void> {
    if ("goto" in step) {
      const url = renderTemplate(step.goto, vars, { url: true });
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return this.fail("host", "Adresse im Rezept ist ungueltig.");
      }
      if (!hostAllowed(u.hostname, this.recipe)) return this.fail("host", `Adresse ausserhalb von ${this.recipe.host}: ${u.hostname}.`);
      await this.driver.goto(url);
      if (!this.#loggedIn) {
        await this.#ensureLogin();
        // Nach der Anmeldung landet man oft woanders: Zielseite noch einmal laden.
        await this.driver.goto(url);
      }
      return;
    }
    if ("waitFor" in step) {
      const w = step.waitFor;
      const cond = resolveCondition({ ...(w.url !== undefined ? { url: w.url } : {}), ...(w.visible ? { visible: w.visible } : {}), ...(w.text !== undefined ? { text: w.text } : {}) }, vars);
      return this.driver.waitFor(cond, (w.timeoutSeconds ?? TIMEOUT_DEFAULT_S) * 1000, this.options.signal);
    }
    if ("pause" in step) {
      const reason = renderValue(step.pause.human, vars);
      return this.#waitForHuman(reason, resolveCondition(step.pause.until, vars));
    }
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

  async #ensureLogin(): Promise<void> {
    const login = this.recipe.login;
    if (!login) return;
    const cond = resolveCondition(login.expect, this.vars);
    if (!(await conditionMet(this.driver, cond).catch(() => false))) {
      await this.#waitForHuman(login.message ?? "Bitte im Browserfenster anmelden (Passwort, 2FA, Bestaetigungen).", cond);
    }
    this.#loggedIn = true;
  }

  async #waitForHuman(reason: string, cond: ResolvedCondition): Promise<void> {
    if (await conditionMet(this.driver, cond).catch(() => false)) return;
    const minutes = this.options.loginTimeoutMinutes ?? 10;
    await this.hooks.onWaitingForHuman?.({ reason, url: stripUrl(await this.driver.currentUrl().catch(() => "")) });
    try {
      await this.driver.waitFor(cond, minutes * 60_000, this.options.signal);
    } catch (err) {
      if (err instanceof WaitAbortedError) this.fail("abort", "Abgebrochen.");
      this.fail("timeout", `Zeitlimit von ${minutes} Minuten abgelaufen: ${reason}`);
    } finally {
      this.hooks.onResumed?.();
    }
  }

  /** Screenshot mit allen Masken aus dem Rezept (plus extra). */
  async shoot(name: string, extra: Selector[] = []): Promise<void> {
    const png = await this.driver.screenshot([...this.recipe.mask, ...extra]);
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

async function readValue(r: Runner, sel: Selector, pattern: string | undefined, what: string): Promise<string> {
  let raw: string;
  try {
    raw = (await r.driver.readText(sel)).trim();
  } catch {
    return r.fail("capture", `${what} nicht lesbar (${describeSelector(sel)}).`);
  }
  if (!pattern) return raw;
  const m = new RegExp(pattern).exec(raw);
  const out = m ? (m[1] ?? m[0]) : "";
  if (!out) return r.fail("capture", `${what} passt nicht zum erwarteten Muster.`);
  return out;
}

async function capture(r: Runner, recipe: Recipe, vars: Vars, driver: BrowserDriver, options: RunOptions): Promise<RunResult> {
  const cap = recipe.capture;
  const find = cap.token.find as Selector;
  // Token nur lesen, wenn der Browser noch auf einer erlaubten Seite steht (ein Klick kann woandershin fuehren).
  await r.checkHost();
  try {
    await driver.waitFor({ visible: find }, cap.token.timeoutSeconds * 1000, options.signal);
  } catch (err) {
    if (err instanceof WaitAbortedError) return r.fail("abort", "Abgebrochen.");
    return r.fail("capture", `Token-Feld nicht gefunden (${describeSelector(find)}).`);
  }
  await r.checkHost();
  const token = await readValue(r, find, cap.token.pattern, "Token");
  if (!token) return r.fail("capture", "Token-Feld ist leer.");
  r.addSecret(token);

  let externalId: string | undefined;
  const ext = cap.externalId;
  if (ext && "from" in ext) externalId = vars[ext.from];
  else if (ext) externalId = await readValue(r, ext.find as Selector, ext.pattern, "Kennung");
  if (externalId?.includes(token)) externalId = undefined; // nie den Wert als Kennung fuehren

  let expiresAt: string | undefined;
  if (cap.expires) {
    const days = Number(vars["days"]);
    const start = Date.parse(`${vars["date"] ?? ""}T00:00:00Z`);
    if (Number.isFinite(days) && Number.isFinite(start)) expiresAt = new Date(start + days * 86_400_000).toISOString().slice(0, 10);
  }

  // Beleg nach dem Erzeugen, Wert verdeckt. Scheitert er, geht der Token trotzdem nicht verloren.
  await r.shoot("nach-erzeugen", [find]).catch(() => undefined);

  return {
    value: SecretValue.from(token),
    ...(externalId ? { externalId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    screenshots: r.screenshots,
    ...(r.createdName ? { createdName: r.createdName } : {}),
  };
}
