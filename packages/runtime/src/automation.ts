import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  PlaywrightDriver,
  RecipeRunError,
  bundledRecipesDir,
  cdpEndpointFrom,
  chromeInstallHint,
  createBrowserProvider,
  findChrome,
  loginMethodsOf,
  hostForParams,
  loadRecipesDetailed,
  probeCdp,
  type BrowserDriver,
  type BrowserProvider,
  type HumanWait,
  type LoginMethodInfo,
  type LoginNeed,
  type Recipe,
  type SudoMethod,
  type SudoProblem,
} from "@secret-desk/automation";
import {
  GitHubError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  RotationError,
  expandHome,
  parseCdpEndpoint,
  redactCdpEndpoint,
  type DeskConfig,
  type EvidenceStore,
  type Provider,
  type ProviderRegistry,
} from "@secret-desk/core";
import { ANTHROPIC_KEY_RECIPE, withAnthropicAdmin } from "@secret-desk/providers";
import { SignInStore, type SessionLifetime, type SignInCheck, type SignInSource } from "./sign-in-store.js";

export type { SessionLifetime, SignInCheck, SignInSource };

/**
 * What the portal has to ask the human right now in a run that signs in and confirms through the portal (team token). Never holds
 * a credential: the answer goes to its own route and is not kept.
 */
export type RunAsk =
  /** The browser is signed out: the sign-in method, email and password. */
  | { type: "credentials"; methods: LoginMethodInfo[] }
  /** The provider asks to confirm access ("Confirm access"): choose the way. */
  | { type: "access"; stage: "choose"; methods: SudoMethod[]; attempt: number; maxAttempts: number; problem?: SudoProblem }
  /** GitHub Mobile waits for the tap; `number` is what the page shows ("" if unknown). */
  | { type: "access"; stage: "mobile"; number: string }
  /** A code or password was sent and is being checked. */
  | { type: "access"; stage: "checking"; method: SudoMethod };

export type AutomationStatus = "idle" | "running" | "waiting-human" | "done" | "failed" | "cancelled";

/** Zustand eines Browser-Laufs. Enthaelt nie einen Wert: nur Status, Text, Adress-Host, Schrittzaehler und ids. */
export interface AutomationRunState {
  secretId: string;
  providerId: string;
  status: AutomationStatus;
  text: string;
  /** Nur der Host der Seite, auf der der Mensch etwas tun soll. */
  host: string | null;
  step: { index: number; total: number } | null;
  startedAt: string;
  updatedAt: string;
  /** Pruefung, die der Lauf erzeugt hat (nur bei done). */
  issuanceId?: string;
  /** Name, unter dem beim Anbieter schon ein Token angelegt sein kann (bei failed/cancelled). */
  createdName?: string;
  /** Guided sign-in (facade) runs only, see facade.ts: */
  kind?: "signin" | "connect";
  /** What the provider waits for from the human right now. */
  needs?: LoginNeed | null;
  /** The number an approval shows, or the scopes an authorization asks for (consent). Never a credential. */
  detail?: string;
  /** Current phase of the run. */
  phase?: string;
  /** Phases reached so far, with their state, oldest first. */
  timeline?: FacadeTimelineEntry[];
  /** When the run gives up waiting (ISO time). */
  timeoutAt?: string | null;
  /** Why the run failed: a code, plus the text in both interface languages. Never contains a value. */
  failure?: { code: string; message: string; messageEn: string };
  /** The outcome of a finished connect run. */
  result?: unknown;
  /** Runs that sign in and confirm through the portal: the question the human has to answer (null when none). */
  ask?: RunAsk | null;
}

export interface FacadeTimelineEntry {
  phase: string;
  state: "active" | "done" | "failed";
  at: string;
}

export interface AutomationRecipeInfo {
  id: string;
  providerId: string;
  label: string;
  /** The recipe's host; with several `hosts` the first one (a label only, see `hosts`). */
  host: string;
  /** A recipe with several hosts: the parameter that picks one, and the host of each value. Empty `hosts` for a single-host recipe. */
  hostBy: string | null;
  hosts: { value: string; host: string }[];
  /** Aus dem Kommentar "# STATUS: ..." der Rezeptdatei. */
  status: string;
  file: string;
  /** SHA-256 (hex) der Rezeptdatei. */
  sha256: string;
  /** Weitere erlaubte Hosts. */
  allowHosts: string[];
  /** Mitgeliefert (true) oder extern (false). */
  bundled: boolean;
  /** The recipe has a guided sign-in (`login.form`), so the portal can check the browser session for its host. */
  canCheckSignIn: boolean;
  /** The ways to sign in at this recipe's portal (the provider's own form first); empty without a guided sign-in. */
  signInMethods: LoginMethodInfo[];
  /** The email sign-in has no password (the provider sends a one-time code). */
  signInPasswordless: boolean;
}

/** Which browser runs the recipes. In remote mode the endpoint is shown without credentials, query or fragment. */
export interface AutomationBrowserInfo {
  mode: "local" | "remote";
  endpoint: string | null;
  /** Remote mode: whether the endpoint answered (null = not checked or local mode). */
  reachable: boolean | null;
  /** Remote mode: browser product and version, when reachable. */
  browser: string | null;
  /** Remote mode: why the endpoint is invalid or not reachable. */
  detail: string | null;
  /** Remote mode: where a human sees the remote browser (noVNC), if configured. */
  viewerUrl: string | null;
}

export interface AutomationInfo {
  enabled: boolean;
  browser: AutomationBrowserInfo;
  chrome: { found: boolean; path: string | null; hint: string | null };
  profileDir: string;
  loginTimeoutMinutes: number;
  /** Hours a sign-in check counts as current (`automation.signInFreshHours`). */
  signInFreshHours: number;
  /** Hours between the scheduled sign-in checks (`automation.signInCheckHours`, 0 = off). */
  signInCheckHours: number;
  /** Days before a renewal at which a signed-out browser is flagged (`automation.renewalWarnDays`, 0 = off). */
  renewalWarnDays: number;
  /** Last known browser sign-in state per recipe host. */
  signInChecks: SignInCheck[];
  /** How long sign-ins lasted per recipe host (only hosts with at least one measurement). */
  signInLifetimes: SessionLifetime[];
  recipes: AutomationRecipeInfo[];
  /** Ob Rezepte aus eigenen Ordnern geladen werden (automation.allowExternalRecipes). */
  allowExternalRecipes: boolean;
  problems: { file: string; message: string }[];
  runs: AutomationRunState[];
}

/** Fehler eines Browser-Laufs, der dem Menschen im Portal gezeigt wird (Abbruch, Zeitlimit, Schritt gescheitert, kein Chrome). */
export class AutomationError extends Error {
  readonly kind: string;
  readonly createdName: string | undefined;
  constructor(message: string, kind = "run", createdName?: string) {
    super(message);
    this.name = "AutomationError";
    this.kind = kind;
    this.createdName = createdName;
  }
}

export interface AutomationOptions {
  config: DeskConfig;
  /** Ordner der Konfigurationsdatei (relative Pfade). */
  configDir: string;
  /** Ordner des Inventars; dort wird recipes/ zusaetzlich gelesen. */
  inventoryDir: string;
  providers: ProviderRegistry;
  evidence: EvidenceStore;
  /** Nur Tests: ersetzt den Browser. */
  driverFactory?: () => BrowserDriver | Promise<BrowserDriver>;
  /** Nur Tests: mitgelieferter Rezeptordner. */
  bundledDir?: string | null;
  /** Tests only: shortens the waits of a "Confirm access" step. */
  access?: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
  /** Environment for SECRET_DESK_BROWSER_CDP (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Tests only: replaces the reachability check of the remote browser. */
  probe?: typeof probeCdp;
  now?: () => Date;
  /** File that keeps the sign-in memory across restarts. Without it the memory lives in this process only. */
  signInStateFile?: string;
}

const VIEWER_ENV = "SECRET_DESK_BROWSER_VIEWER_URL";

/** Viewer address of the remote browser: environment first, then configuration. Only http(s) without credentials is kept. */
export function viewerUrlFrom(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[VIEWER_ENV]?.trim() || configured?.trim();
  if (!raw) return null;
  // A path on the portal's own host ("/browser/vnc.html?..."): the link then follows whichever address the portal was opened with.
  if (raw.startsWith("/") && !raw.startsWith("//")) return /^\/[^\s\\]*$/.test(raw) ? raw : null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const PROFILE_DEFAULT = "~/.secret-desk/browser-profile";
const MAX_TEXT = 400;

const path = (p: string, base: string): string => {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(base, e);
};

async function statusComment(file: string): Promise<string> {
  try {
    const m = /^#\s*STATUS:\s*(.+)$/m.exec(await readFile(file, "utf8"));
    return m?.[1]?.trim() ?? "nicht geprueft";
  } catch {
    /* v8 ignore start -- the loader just read this file; only a file removed in between gets here */
    return "nicht geprueft";
    /* v8 ignore stop */
  }
}

const isBrowser = (p: Provider | undefined): p is BrowserProvider => p !== undefined && typeof (p as Partial<BrowserProvider>).attachScreenshots === "function";

/** Fehler, die ihre eigene Behandlung im Router haben, bleiben unveraendert. */
const passThrough = (e: unknown): boolean => e instanceof NotConnectedError || e instanceof IssuanceError || e instanceof RotationError || e instanceof InventoryError || e instanceof GitHubError;

/**
 * Verwaltet die Browser-Anbieter und den Zustand der Laeufe. Pro Prozess laeuft hoechstens ein Lauf (es gibt ein Browserprofil
 * und ein Fenster). Der Zustand liegt hier, nicht im Browser des Portals: Ein Neuladen der Seite verwaist den Lauf nicht.
 */
export class AutomationManager {
  readonly enabled: boolean;
  readonly profileDir: string;
  readonly loginTimeoutMinutes: number;
  readonly signInFreshHours: number;
  readonly signInCheckHours: number;
  readonly renewalWarnDays: number;
  readonly #signIn: SignInStore;
  readonly problems: { file: string; message: string }[] = [];
  readonly recipes: AutomationRecipeInfo[] = [];
  readonly #chromePath: string | undefined;
  readonly #cdpEndpoint: string | undefined;
  readonly #viewerUrl: string | null;
  readonly #providers = new Map<string, BrowserProvider>();
  readonly #recipes = new Map<string, Recipe>();
  readonly #runs = new Map<string, AutomationRunState>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #now: () => Date;
  #active: string | null = null;

  constructor(private readonly opts: AutomationOptions) {
    const c = opts.config.automation;
    this.enabled = c.enabled;
    this.#chromePath = c.chromePath ? path(c.chromePath, opts.configDir) : undefined;
    this.#cdpEndpoint = cdpEndpointFrom(c.cdpEndpoint, opts.env ?? process.env);
    this.#viewerUrl = viewerUrlFrom(c.viewerUrl, opts.env ?? process.env);
    this.profileDir = path(c.profileDir ?? PROFILE_DEFAULT, opts.configDir);
    this.loginTimeoutMinutes = c.loginTimeoutMinutes;
    this.signInFreshHours = c.signInFreshHours;
    this.signInCheckHours = c.signInCheckHours;
    this.renewalWarnDays = c.renewalWarnDays;
    this.#signIn = new SignInStore(opts.signInStateFile ?? null);
    this.#now = opts.now ?? (() => new Date());
  }

  /** Rezepte laden und je Rezept einen Browser-Anbieter `<id>-browser` registrieren. Ungueltige Rezepte landen in `problems`. */
  async load(): Promise<void> {
    if (!this.enabled) return;
    await this.#signIn.load();
    const { config, configDir, inventoryDir, providers } = this.opts;
    const bundled = this.opts.bundledDir === undefined ? bundledRecipesDir() : this.opts.bundledDir;
    const dirs: string[] = [];
    if (bundled) {
      if (existsSync(bundled)) dirs.push(bundled);
      else this.problems.push({ file: bundled, message: "Der Ordner mit den mitgelieferten Rezepten wurde nicht gefunden." });
    }
    dirs.push(resolve(inventoryDir, "recipes"));
    for (const d of config.automation.recipesDirs ?? []) dirs.push(path(d, configDir));
    let loaded;
    try {
      loaded = await loadRecipesDetailed(dirs, { bundledDirs: bundled && existsSync(bundled) ? [bundled] : [], allowExternal: config.automation.allowExternalRecipes });
    } catch (err) {
      this.problems.push({ file: dirs.join(", "), message: `Rezepte konnten nicht gelesen werden: ${(err as Error).message.split("\n")[0]}` });
      return;
    }
    this.problems.push(...loaded.errors);
    for (const d of loaded.skippedDirs) this.problems.push({ file: d, message: "Externer Rezeptordner uebersprungen: automation.allowExternalRecipes ist aus." });
    for (const { recipe, file, sha256, allowHosts, bundled: isBundled } of loaded.recipes) {
      const base = createBrowserProvider({
        recipe,
        driverFactory: () => this.#driver(),
        hooks: (secretId) => ({
          onWaitingForHuman: (w: HumanWait) => this.#waiting(secretId, w),
          onResumed: () => this.#patch(secretId, { status: "running", text: "Der Browser macht weiter.", host: null }),
          onProgress: (p) => this.#patch(secretId, { step: { index: p.index, total: p.total } }),
        }),
        runOptions: (secretId) => {
          const signal = this.#controllers.get(secretId)?.signal;
          return { loginTimeoutMinutes: this.loginTimeoutMinutes, ...(signal ? { signal } : {}) };
        },
        evidence: this.opts.evidence,
      });
      // createBrowserProvider always defines issue; the Provider type only declares it optional.
      const issueRun = base.issue!;
      // A recipe run that created a key proves the browser was signed in at the recipe's host just now.
      const wrapped: BrowserProvider = {
        ...base,
        id: `${recipe.id}-browser`,
        label: `${recipe.label} (Browser)`,
        issue: async (ctx) => {
          const issued = await issueRun.call(base, ctx);
          const host = hostForParams(recipe, ctx.secret.params);
          /* v8 ignore start -- a recipe run that passed its parameter checks always maps to a host; null is only a type guard */
          if (host) this.noteSignIn(host, true, "run");
          /* v8 ignore stop */
          return issued;
        },
      };
      // The Anthropic key recipe also gets what the Admin API can do (workspaces, key check, revoke); see providers/anthropic.ts.
      const provider = recipe.id === ANTHROPIC_KEY_RECIPE ? withAnthropicAdmin(wrapped) : wrapped;
      providers.register(provider);
      this.#providers.set(provider.id, provider);
      this.#recipes.set(recipe.id, recipe);
      this.recipes.push({ id: recipe.id, providerId: provider.id, label: recipe.label, host: recipe.host, hostBy: recipe.hostBy ?? null, hosts: Object.entries(recipe.hosts ?? {}).map(([value, host]) => ({ value, host })), status: await statusComment(file), file, sha256, allowHosts, bundled: isBundled, canCheckSignIn: Boolean(recipe.login?.form), signInMethods: recipe.login?.form ? loginMethodsOf(recipe) : [], signInPasswordless: recipe.login?.form?.passwordless === true });
    }
  }

  /** Remembers that the browser was signed in (or out) at a host just now. Never stores values. */
  noteSignIn(host: string, signedIn: boolean, source: SignInSource = "check"): void {
    this.#signIn.note(host, signedIn, this.#now(), source);
  }

  /** The last known sign-in state of every host seen so far (also from earlier runs of the portal). */
  signInChecks(): SignInCheck[] {
    return this.#signIn.checks();
  }

  /** How long sign-ins lasted, per host with at least one measurement. */
  signInLifetimes(): SessionLifetime[] {
    return this.#signIn.lifetimes();
  }

  /** Waits until the sign-in memory is on disk (tests, shutdown). */
  flushSignIn(): Promise<void> {
    return this.#signIn.flush();
  }

  /** The clock this manager uses (the scheduler follows it, so tests can drive both). */
  now(): Date {
    return this.#now();
  }

  /** A loaded recipe by id (the guided sign-in and its key recipe live in one recipe). */
  recipe(id: string): Recipe | undefined {
    return this.#recipes.get(id);
  }

  /** A fresh driver for the configured browser (remote or local). */
  newDriver(): BrowserDriver | Promise<BrowserDriver> {
    return this.#driver();
  }

  /** Timing of "Confirm access" steps (only tests change it). */
  get accessTiming(): { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number } {
    return this.opts.access ?? {};
  }

  /** Where a human sees the remote browser (noVNC), if configured. */
  get viewerUrl(): string | null {
    return this.#cdpEndpoint ? this.#viewerUrl : null;
  }

  /**
   * Starts a tracked run that is not tied to an inventory entry (guided sign-in). Only one browser run at a time. Returns the
   * signal that cancel() fires.
   */
  /** The signal of the run now registered under `key` (its identity), or undefined when none. */
  runSignal(key: string): AbortSignal | undefined {
    return this.#controllers.get(key)?.signal;
  }

  begin(key: string, providerId: string, init: Partial<AutomationRunState> & { text: string }): AbortSignal {
    if (this.#active !== null) {
      throw new IssuanceError(this.#active === key ? "A browser run for this provider is already in progress." : "A browser run is already in progress. Wait for it or cancel it first.");
    }
    const controller = new AbortController();
    this.#active = key;
    this.#controllers.set(key, controller);
    const at = this.#now().toISOString();
    this.#runs.set(key, { secretId: key, providerId, status: "running", host: null, step: null, startedAt: at, updatedAt: at, ...init });
    return controller.signal;
  }

  /** Changes a running tracked run (ignored once it has finished). */
  update(key: string, patch: Partial<AutomationRunState>): void {
    this.#patch(key, patch);
  }

  /** Ends a tracked run and releases the browser. */
  end(key: string, patch: Partial<AutomationRunState> & { status: AutomationStatus; text: string }): void {
    this.#finish(key, patch);
  }

  /** Does a tracked run hold the browser right now? */
  isBusy(): boolean {
    return this.#active !== null;
  }

  /** Is this key the run that holds the browser right now? */
  isActive(key: string): boolean {
    return this.#active === key;
  }

  #driver(): BrowserDriver | Promise<BrowserDriver> {
    if (this.opts.driverFactory) return this.opts.driverFactory();
    const c = this.opts.config.automation;
    if (this.#cdpEndpoint) {
      parseCdpEndpoint(this.#cdpEndpoint); // fail closed: an invalid endpoint never falls back to a local Chrome
      return new PlaywrightDriver({ cdpEndpoint: this.#cdpEndpoint, ...(c.slowMoMs !== undefined ? { slowMoMs: c.slowMoMs } : {}) });
    }
    return new PlaywrightDriver({ ...(this.#chromePath ? { chromePath: this.#chromePath } : {}), profileDir: this.profileDir, ...(c.slowMoMs !== undefined ? { slowMoMs: c.slowMoMs } : {}) });
  }

  isBrowserProvider(p: Provider | undefined): p is BrowserProvider {
    return isBrowser(p) && this.#providers.has(p.id);
  }

  #waiting(secretId: string, w: HumanWait): void {
    let host: string | null = null;
    try {
      host = new URL(w.url).host;
    } catch {
      /* ohne Adresse */
    }
    this.#patch(secretId, { status: "waiting-human", text: w.reason.slice(0, MAX_TEXT), host });
  }

  #patch(secretId: string, patch: Partial<AutomationRunState>): void {
    const cur = this.#runs.get(secretId);
    if (!cur || cur.status === "done" || cur.status === "failed" || cur.status === "cancelled") return;
    this.#runs.set(secretId, { ...cur, ...patch, updatedAt: this.#now().toISOString() });
  }

  #finish(secretId: string, patch: Partial<AutomationRunState> & { status: AutomationStatus; text: string }): void {
    const cur = this.#runs.get(secretId);
    if (!cur) return;
    this.#runs.set(secretId, { ...cur, host: null, ...patch, updatedAt: this.#now().toISOString() });
    this.#controllers.delete(secretId);
    if (this.#active === secretId) this.#active = null;
  }

  /**
   * Fuehrt `work` als Browser-Lauf zu diesem Secret aus (nur einer gleichzeitig) und haelt den Zustand fest.
   * `work` erzeugt den Wert (prepareIssuance); `issuanceId` liefert die id der entstandenen Pruefung.
   */
  async run<T>(secretId: string, provider: BrowserProvider, work: () => Promise<T>, issuanceId?: (r: T) => string): Promise<T> {
    if (this.#active !== null) {
      throw new IssuanceError(this.#active === secretId ? "Fuer dieses Secret laeuft schon ein Browser-Lauf." : `Es laeuft schon ein Browser-Lauf (Secret ${this.#active}). Erst abwarten oder abbrechen.`);
    }
    const controller = new AbortController();
    this.#active = secretId;
    this.#controllers.set(secretId, controller);
    const at = this.#now().toISOString();
    this.#runs.set(secretId, { secretId, providerId: provider.id, status: "running", text: "Der Browser wird geoeffnet.", host: null, step: null, startedAt: at, updatedAt: at });
    try {
      const result = await work();
      this.#finish(secretId, { status: "done", text: "Fertig. Der Pruefbericht wartet auf Bestaetigung.", step: null, ...(issuanceId ? { issuanceId: issuanceId(result) } : {}) });
      return result;
    } catch (err) {
      const createdName = err instanceof RecipeRunError ? err.createdName : undefined;
      const aborted = controller.signal.aborted || (err instanceof RecipeRunError && err.kind === "abort");
      const message = ((err as Error).message || "Der Lauf ist fehlgeschlagen.").slice(0, MAX_TEXT * 2);
      this.#finish(secretId, { status: aborted ? "cancelled" : "failed", text: aborted && !createdName ? "Abgebrochen." : message, ...(createdName ? { createdName } : {}) });
      if (passThrough(err)) throw err;
      throw new AutomationError(message, err instanceof RecipeRunError ? err.kind : "run", createdName);
    } finally {
      // Falls der Lauf vor dem Bericht scheiterte: Belege nicht liegen lassen.
      provider.takeScreenshots(secretId);
    }
  }

  /** Haengt die Belege des Laufs an den Bericht. Ein Fehler dabei kippt die Pruefung nicht. */
  async attach(provider: BrowserProvider, secretId: string, reportId: string): Promise<number> {
    try {
      return await provider.attachScreenshots(secretId, reportId);
    } catch {
      return 0;
    }
  }

  state(secretId: string): AutomationRunState {
    return this.#runs.get(secretId) ?? { secretId, providerId: "", status: "idle", text: "", host: null, step: null, startedAt: "", updatedAt: "" };
  }

  /** Forgets the state of a finished tracked run (a new sign-in starts from a clean slate). */
  forget(key: string): void {
    const cur = this.#runs.get(key);
    if (cur && cur.status !== "running" && cur.status !== "waiting-human") this.#runs.delete(key);
  }

  /** Bricht den laufenden Lauf ab. Ohne laufenden Lauf ein Fehler. */
  cancel(secretId: string): AutomationRunState {
    const c = this.#controllers.get(secretId);
    const cur = this.#runs.get(secretId);
    if (!c || !cur || (cur.status !== "running" && cur.status !== "waiting-human")) throw new IssuanceError("Fuer dieses Secret laeuft kein Browser-Lauf.");
    c.abort();
    this.#patch(secretId, { text: "Wird abgebrochen." });
    return this.state(secretId);
  }

  runs(): AutomationRunState[] {
    return [...this.#runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Like info(), plus a reachability check of the remote browser. */
  async status(): Promise<AutomationInfo> {
    const info = this.info();
    if (!this.enabled || !this.#cdpEndpoint || info.browser.detail) return info;
    const probe = await (this.opts.probe ?? probeCdp)(this.#cdpEndpoint);
    return { ...info, browser: { ...info.browser, reachable: probe.reachable, browser: probe.browser, detail: probe.detail } };
  }

  #browserInfo(): AutomationBrowserInfo {
    if (!this.#cdpEndpoint) return { mode: "local", endpoint: null, reachable: null, browser: null, detail: null, viewerUrl: null };
    try {
      return { mode: "remote", endpoint: redactCdpEndpoint(this.#cdpEndpoint), reachable: null, browser: null, detail: null, viewerUrl: this.#viewerUrl };
    } catch (err) {
      return { mode: "remote", endpoint: null, reachable: false, browser: null, detail: (err as Error).message, viewerUrl: this.#viewerUrl };
    }
  }

  info(): AutomationInfo {
    let chrome: AutomationInfo["chrome"];
    if (this.#cdpEndpoint) {
      chrome = { found: false, path: null, hint: "Not needed: the recipes run in the remote browser." };
    } else {
      try {
        const p = findChrome(this.#chromePath);
        chrome = p ? { found: true, path: p, hint: null } : { found: false, path: null, hint: chromeInstallHint() };
      } catch (err) {
        chrome = { found: false, path: null, hint: (err as Error).message };
      }
    }
    return { enabled: this.enabled, browser: this.#browserInfo(), chrome, profileDir: this.profileDir, loginTimeoutMinutes: this.loginTimeoutMinutes, signInFreshHours: this.signInFreshHours, signInCheckHours: this.signInCheckHours, renewalWarnDays: this.renewalWarnDays, signInChecks: this.signInChecks(), signInLifetimes: this.signInLifetimes(), recipes: this.recipes, allowExternalRecipes: this.opts.config.automation.allowExternalRecipes, problems: this.problems, runs: this.runs() };
  }
}
