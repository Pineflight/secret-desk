import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  PlaywrightDriver,
  RecipeRunError,
  bundledRecipesDir,
  chromeInstallHint,
  createBrowserProvider,
  findChrome,
  loadRecipesDetailed,
  type BrowserDriver,
  type BrowserProvider,
  type HumanWait,
} from "@secret-desk/automation";
import {
  GitHubError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  RotationError,
  expandHome,
  type DeskConfig,
  type EvidenceStore,
  type Provider,
  type ProviderRegistry,
} from "@secret-desk/core";

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
}

export interface AutomationRecipeInfo {
  id: string;
  providerId: string;
  label: string;
  host: string;
  /** Aus dem Kommentar "# STATUS: ..." der Rezeptdatei. */
  status: string;
  file: string;
}

export interface AutomationInfo {
  enabled: boolean;
  chrome: { found: boolean; path: string | null; hint: string | null };
  profileDir: string;
  loginTimeoutMinutes: number;
  recipes: AutomationRecipeInfo[];
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
  now?: () => Date;
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
    return "nicht geprueft";
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
  readonly problems: { file: string; message: string }[] = [];
  readonly recipes: AutomationRecipeInfo[] = [];
  readonly #chromePath: string | undefined;
  readonly #providers = new Map<string, BrowserProvider>();
  readonly #runs = new Map<string, AutomationRunState>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #now: () => Date;
  #active: string | null = null;

  constructor(private readonly opts: AutomationOptions) {
    const c = opts.config.automation;
    this.enabled = c.enabled;
    this.#chromePath = c.chromePath ? path(c.chromePath, opts.configDir) : undefined;
    this.profileDir = path(c.profileDir ?? PROFILE_DEFAULT, opts.configDir);
    this.loginTimeoutMinutes = c.loginTimeoutMinutes;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Rezepte laden und je Rezept einen Browser-Anbieter `<id>-browser` registrieren. Ungueltige Rezepte landen in `problems`. */
  async load(): Promise<void> {
    if (!this.enabled) return;
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
      loaded = await loadRecipesDetailed(dirs);
    } catch (err) {
      this.problems.push({ file: dirs.join(", "), message: `Rezepte konnten nicht gelesen werden: ${(err as Error).message.split("\n")[0]}` });
      return;
    }
    this.problems.push(...loaded.errors);
    for (const { recipe, file } of loaded.recipes) {
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
      const provider: BrowserProvider = { ...base, id: `${recipe.id}-browser`, label: `${recipe.label} (Browser)` };
      providers.register(provider);
      this.#providers.set(provider.id, provider);
      this.recipes.push({ id: recipe.id, providerId: provider.id, label: recipe.label, host: recipe.host, status: await statusComment(file), file });
    }
  }

  #driver(): BrowserDriver | Promise<BrowserDriver> {
    if (this.opts.driverFactory) return this.opts.driverFactory();
    const c = this.opts.config.automation;
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

  info(): AutomationInfo {
    let chrome: AutomationInfo["chrome"];
    try {
      const p = findChrome(this.#chromePath);
      chrome = p ? { found: true, path: p, hint: null } : { found: false, path: null, hint: chromeInstallHint() };
    } catch (err) {
      chrome = { found: false, path: null, hint: (err as Error).message };
    }
    return { enabled: this.enabled, chrome, profileDir: this.profileDir, loginTimeoutMinutes: this.loginTimeoutMinutes, recipes: this.recipes, problems: this.problems, runs: this.runs() };
  }
}
