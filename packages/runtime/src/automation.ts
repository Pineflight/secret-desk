import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CDP_ENV,
  RecipeRunError,
  bundledRecipesDir,
  cdpEndpointFrom,
  createBrowserProvider,
  loginMethodsOf,
  hostForParams,
  loadRecipesDetailed,
  probeCdp,
  type BrowserDriver,
  type BrowserProvider,
  type HumanWait,
  type Recipe,
} from "@secret-desk/automation";
import {
  GitHubError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  ParamsInvalidError,
  RotationError,
  parseCdpEndpoint,
  redactCdpEndpoint,
  type ConnectionHost,
  type DeskConfig,
  type EvidenceStore,
  type Provider,
  type ProviderRegistry,
} from "@secret-desk/core";
import { ANTHROPIC_KEY_RECIPE, withAnthropicAdmin } from "@secret-desk/providers";
import type { AutomationBrowserInfo, AutomationInfo, AutomationPort, AutomationRecipeInfo, AutomationRunState, AutomationStatus } from "./automation-port.js";
import { HostCapabilityError, expandHomeFor, readHostEnv, type RuntimeHost } from "./host.js";
import { LiveCheckStore, type LiveCheckReport } from "./live-check-store.js";
import { SignInStore, type SessionLifetime, type SignInCheck, type SignInSource } from "./sign-in-store.js";

export type { SessionLifetime, SignInCheck, SignInSource };

// The shapes of the run state and the status, and the port that code outside this file talks to, live in `automation-port.ts` (no
// Node API, part of the portable entry). They are re-exported here, so every import of `automation.js` keeps working.
export type { AutomationBrowserInfo, AutomationInfo, AutomationPort, AutomationRecipeInfo, AutomationRunState, AutomationStatus, FacadeTimelineEntry, RunAsk } from "./automation-port.js";

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

const BROWSER_UNAVAILABLE = "A browser is not available in this environment.";

/** No browser may be started or attached to in this environment: the host offers no such capability (and no test driver was given). */
export class BrowserNotAvailableError extends AutomationError {
  readonly mode: "local" | "remote";
  constructor(mode: "local" | "remote") {
    super(mode === "remote" ? "Remote browser is not available in this environment." : "A local browser is not available in this environment.", "browser-unavailable");
    this.name = "BrowserNotAvailableError";
    this.mode = mode;
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
  /** Replaces the browser (see `RuntimeOptions.automationDriver`): available without a host; the status probe of a configured address still runs. */
  driverFactory?: () => BrowserDriver | Promise<BrowserDriver>;
  /** Nur Tests: mitgelieferter Rezeptordner. */
  bundledDir?: string | null;
  /** Tests only: shortens the waits of a "Confirm access" step. */
  access?: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
  /**
   * Where the variables SECRET_DESK_BROWSER_CDP and SECRET_DESK_BROWSER_VIEWER_URL are read (by name, through `host.env`).
   * Without a host they are not read and only the configuration (`automation.cdpEndpoint`, `automation.viewerUrl`) applies.
   */
  host?: RuntimeHost;
  /** Tests only: replaces the reachability check of the remote browser. */
  probe?: typeof probeCdp;
  now?: () => Date;
  /** File that keeps the sign-in memory across restarts. Without it the memory lives in this process only. */
  signInStateFile?: string;
  /** File that keeps the live check reports across restarts. Without it they live in this process only. */
  liveCheckStateFile?: string;
}

const VIEWER_ENV = "SECRET_DESK_BROWSER_VIEWER_URL";

/**
 * Viewer address of the remote browser: the host's environment first (only when there is a host), then configuration.
 * Only http(s) without credentials is kept.
 */
export function viewerUrlFrom(configured: string | undefined, host?: ConnectionHost): string | null {
  const raw = readHostEnv(host, VIEWER_ENV)?.trim() || configured?.trim();
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
/** Text of the `needs-sign-in` failure; the portal localizes by `failure.code`. */
const NEEDS_SIGN_IN_TEXT = "Not signed in: sign in through the portal, then run again.";

const path = (p: string, base: string, host: RuntimeHost | undefined): string => {
  const e = expandHomeFor(host, p);
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
const passThrough = (e: unknown): boolean => e instanceof ParamsInvalidError || e instanceof NotConnectedError || e instanceof IssuanceError || e instanceof RotationError || e instanceof InventoryError || e instanceof GitHubError;

/**
 * Verwaltet die Browser-Anbieter und den Zustand der Laeufe. Pro Prozess laeuft hoechstens ein Lauf (es gibt ein Browserprofil
 * und ein Fenster). Der Zustand liegt hier, nicht im Browser des Portals: Ein Neuladen der Seite verwaist den Lauf nicht.
 */
export class AutomationManager implements AutomationPort {
  readonly enabled: boolean;
  readonly profileDir: string;
  readonly loginTimeoutMinutes: number;
  readonly signInFreshHours: number;
  readonly signInCheckHours: number;
  readonly renewalWarnDays: number;
  /** Days between two live checks (`automation.liveCheckDays`, 0 = off). */
  readonly liveCheckDays: number;
  readonly #signIn: SignInStore;
  readonly #liveCheck: LiveCheckStore;
  readonly problems: { file: string; message: string }[] = [];
  readonly recipes: AutomationRecipeInfo[] = [];
  readonly #chromePath: string | undefined;
  readonly #pathError: HostCapabilityError | undefined;
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
    // `~` paths need the home folder of the host; without one they stay unresolved and only matter when a local browser would start.
    const resolved = (p: string): { value: string } | { error: HostCapabilityError } => {
      try {
        return { value: path(p, opts.configDir, opts.host) };
      } catch (err) {
        return { error: err as HostCapabilityError };
      }
    };
    const chrome = c.chromePath ? resolved(c.chromePath) : undefined;
    this.#chromePath = chrome && "value" in chrome ? chrome.value : undefined;
    const profile = resolved(c.profileDir ?? PROFILE_DEFAULT);
    this.profileDir = "value" in profile ? profile.value : "";
    this.#pathError = (chrome && "error" in chrome ? chrome.error : undefined) ?? ("error" in profile ? profile.error : undefined);
    this.#cdpEndpoint = cdpEndpointFrom(c.cdpEndpoint, { [CDP_ENV]: readHostEnv(opts.host, CDP_ENV) });
    this.#viewerUrl = viewerUrlFrom(c.viewerUrl, opts.host);
    this.loginTimeoutMinutes = c.loginTimeoutMinutes;
    this.signInFreshHours = c.signInFreshHours;
    this.signInCheckHours = c.signInCheckHours;
    this.renewalWarnDays = c.renewalWarnDays;
    this.liveCheckDays = c.liveCheckDays;
    this.#signIn = new SignInStore(opts.signInStateFile ?? null);
    this.#liveCheck = new LiveCheckStore(opts.liveCheckStateFile ?? null);
    this.#now = opts.now ?? (() => new Date());
  }

  /** Rezepte laden und je Rezept einen Browser-Anbieter `<id>-browser` registrieren. Ungueltige Rezepte landen in `problems`. */
  async load(): Promise<void> {
    // The live check also tests the API connections, so its reports exist with the browser automation off.
    await this.#liveCheck.load();
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
    for (const d of config.automation.recipesDirs ?? []) {
      try {
        dirs.push(path(d, configDir, this.opts.host));
      } catch (err) {
        this.problems.push({ file: d, message: (err as Error).message });
      }
    }
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
          // A remote browser has no window the person sits at: a signed-out run then ends with "needs sign-in" (see run()).
          return { loginTimeoutMinutes: this.loginTimeoutMinutes, ...(signal ? { signal } : {}), ...(this.#cdpEndpoint ? { signInOutsideWindow: true } : {}) };
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

  /** The stored live check reports, newest first. */
  liveCheckReports(): LiveCheckReport[] {
    return this.#liveCheck.reports();
  }

  /** Keeps a finished live check report (the last 12, also on disk when a file is configured). */
  recordLiveCheck(report: LiveCheckReport): void {
    this.#liveCheck.add(report);
  }

  /** Waits until the live check reports are on disk (tests, shutdown). */
  flushLiveCheck(): Promise<void> {
    return this.#liveCheck.flush();
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
    const host = this.opts.host;
    const slow = c.slowMoMs !== undefined ? { slowMoMs: c.slowMoMs } : {};
    if (this.#cdpEndpoint) {
      parseCdpEndpoint(this.#cdpEndpoint); // fail closed: an invalid endpoint never falls back to a local Chrome
      // The address comes from configuration or the environment of the host: a host that does not offer the capability refuses it.
      if (!host?.connectRemoteBrowser) throw new BrowserNotAvailableError("remote");
      return host.connectRemoteBrowser({ cdpEndpoint: this.#cdpEndpoint, ...slow });
    }
    if (!host?.launchLocalBrowser) throw new BrowserNotAvailableError("local");
    if (this.#pathError) throw this.#pathError;
    return host.launchLocalBrowser({ ...(this.#chromePath ? { chromePath: this.#chromePath } : {}), profileDir: this.profileDir, ...slow });
  }

  isBrowserProvider(p: Provider | undefined): p is BrowserProvider {
    return isBrowser(p) && this.#providers.has(p.id);
  }

  /** The portal host a multi-host browser provider uses for the parameters of an entry (its recipe's `hostBy` parameter), else null. */
  browserHostOf(provider: unknown, params: Record<string, unknown>): string | null {
    const recipeId = (provider as { automation?: { recipeId?: string } } | undefined)?.automation?.recipeId;
    const recipe = recipeId ? this.recipe(recipeId) : undefined;
    return recipe?.hosts ? hostForParams(recipe, params) : null;
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
      const needsSignIn = !aborted && err instanceof RecipeRunError && err.kind === "signin";
      this.#finish(secretId, {
        status: aborted ? "cancelled" : "failed",
        text: aborted && !createdName ? "Abgebrochen." : message,
        ...(createdName ? { createdName } : {}),
        ...(needsSignIn ? { signInRecipeId: provider.automation.recipeId, failure: { code: "needs-sign-in", message: NEEDS_SIGN_IN_TEXT, messageEn: NEEDS_SIGN_IN_TEXT } } : {}),
      });
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
    // No reachability probe (an outbound request) unless the host allows a remote browser.
    if (!this.enabled || !this.#cdpEndpoint || info.browser.detail) return info;
    const probe = await (this.opts.probe ?? probeCdp)(this.#cdpEndpoint);
    return { ...info, browser: { ...info.browser, reachable: probe.reachable, browser: probe.browser, detail: probe.detail } };
  }

  #browserInfo(): AutomationBrowserInfo {
    if (!this.#cdpEndpoint) return { mode: "local", endpoint: null, reachable: null, browser: null, detail: this.opts.driverFactory || this.opts.host?.launchLocalBrowser ? null : BROWSER_UNAVAILABLE, viewerUrl: null };
    try {
      const allowed = Boolean(this.opts.driverFactory || this.opts.host?.connectRemoteBrowser);
      return { mode: "remote", endpoint: redactCdpEndpoint(this.#cdpEndpoint), reachable: allowed ? null : false, browser: null, detail: allowed ? null : BROWSER_UNAVAILABLE, viewerUrl: this.#viewerUrl };
    } catch (err) {
      return { mode: "remote", endpoint: null, reachable: false, browser: null, detail: (err as Error).message, viewerUrl: this.#viewerUrl };
    }
  }

  info(): AutomationInfo {
    let chrome: AutomationInfo["chrome"];
    if (this.#cdpEndpoint) {
      chrome = { found: false, path: null, hint: "Not needed: the recipes run in the remote browser." };
    } else if (!this.opts.host?.findChrome) {
      // Without the host's local-browser capability Chrome is not looked for (no file system or environment lookup).
      chrome = { found: false, path: null, hint: BROWSER_UNAVAILABLE };
    } else {
      try {
        const found = this.opts.host.findChrome(this.#chromePath);
        chrome = found.path ? { found: true, path: found.path, hint: null } : { found: false, path: null, hint: found.hint };
      } catch (err) {
        chrome = { found: false, path: null, hint: (err as Error).message };
      }
    }
    return { enabled: this.enabled, browser: this.#browserInfo(), chrome, profileDir: this.profileDir, loginTimeoutMinutes: this.loginTimeoutMinutes, signInFreshHours: this.signInFreshHours, signInCheckHours: this.signInCheckHours, renewalWarnDays: this.renewalWarnDays, signInChecks: this.signInChecks(), signInLifetimes: this.signInLifetimes(), recipes: this.recipes, allowExternalRecipes: this.opts.config.automation.allowExternalRecipes, problems: this.problems, runs: this.runs() };
  }
}
