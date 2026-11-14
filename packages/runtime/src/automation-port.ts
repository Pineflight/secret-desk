import type { BrowserDriver, BrowserProvider, LoginMethodInfo, LoginNeed, Recipe, SudoMethod, SudoProblem } from "@secret-desk/automation";
import type { Provider } from "@secret-desk/core/portable";
import type { LiveCheckReport } from "./live-check-store.js";
import type { SessionLifetime, SignInCheck, SignInSource } from "./sign-in-store.js";

// What the rest of the runtime needs to know about browser automation, without the automation package or any Node API: the shapes of
// the run state and the status, the port that code outside `automation.ts` talks to, and a default port that offers nothing. The
// manager in `automation.ts` implements the port (and re-exports these types); an embedder without browser automation uses
// `noAutomation`. Only types are imported from the automation package here, so this file is part of the portable entry.

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
  /**
   * Issuance runs only: set when the run ended because the browser is signed out at the provider and the run could not ask for the
   * sign-in (`failure.code` is then `needs-sign-in`). The recipe whose guided sign-in the portal starts (`POST recipes/:id/sign-in`,
   * a recipe with several portals also takes `host`). Never a credential.
   */
  signInRecipeId?: string;
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

/**
 * Everything the runtime outside `automation.ts` uses of browser automation (`runtime.automation`). The `AutomationManager` of the
 * local edition implements it; `noAutomation` is the port of a runtime that has no browser automation.
 */
export interface AutomationPort {
  /** Whether browser automation is switched on. */
  readonly enabled: boolean;
  readonly loginTimeoutMinutes: number;
  /** Hours between the scheduled sign-in checks (0 = off). */
  readonly signInCheckHours: number;
  /** Days between two live checks (0 = off). */
  readonly liveCheckDays: number;
  /** Timing of "Confirm access" steps (only tests change it). */
  readonly accessTiming: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
  /** Where a human sees the remote browser, if configured. */
  readonly viewerUrl: string | null;
  /** The loaded recipes. */
  readonly recipes: readonly AutomationRecipeInfo[];
  /** The clock of the automation (the scheduler follows it). */
  now(): Date;
  /** What browser automation is and does right now, without any request. */
  info(): AutomationInfo;
  /** Like `info()`, plus a reachability check of a remote browser. */
  status(): Promise<AutomationInfo>;
  /** A loaded recipe by id. */
  recipe(id: string): Recipe | undefined;
  /** The portal host a multi-host browser provider uses for the parameters of an entry, else null. */
  browserHostOf(provider: unknown, params: Record<string, unknown>): string | null;
  /** Whether this provider is one of the browser providers of this port. */
  isBrowserProvider(provider: Provider | undefined): provider is BrowserProvider;
  /** Runs `work` as the browser run for a secret (one run at a time) and keeps its state. */
  run<T>(secretId: string, provider: BrowserProvider, work: () => Promise<T>, issuanceId?: (result: T) => string): Promise<T>;
  /** Attaches the evidence of a run to a report. Never throws. */
  attach(provider: BrowserProvider, secretId: string, reportId: string): Promise<number>;
  /** The state of a run (idle when there is none). */
  state(key: string): AutomationRunState;
  /** Cancels the running run of a key; refused when none runs. */
  cancel(key: string): AutomationRunState;
  /** Starts a tracked run that is not tied to an inventory entry and returns the signal that `cancel` fires. */
  begin(key: string, providerId: string, init: Partial<AutomationRunState> & { text: string }): AbortSignal;
  /** Changes a running tracked run. */
  update(key: string, patch: Partial<AutomationRunState>): void;
  /** Ends a tracked run and releases the browser. */
  end(key: string, patch: Partial<AutomationRunState> & { status: AutomationStatus; text: string }): void;
  /** Forgets the state of a finished tracked run. */
  forget(key: string): void;
  /** The signal of the run registered under `key`, or undefined. */
  runSignal(key: string): AbortSignal | undefined;
  /** Whether a tracked run holds the browser right now. */
  isBusy(): boolean;
  /** A fresh driver for the configured browser. */
  newDriver(): BrowserDriver | Promise<BrowserDriver>;
  /** Remembers that the browser was signed in (or out) at a host just now. Never stores values. */
  noteSignIn(host: string, signedIn: boolean, source?: SignInSource): void;
  /** The last known sign-in state of every host seen so far. */
  signInChecks(): SignInCheck[];
  /** The stored live check reports, newest first. */
  liveCheckReports(): LiveCheckReport[];
  /** Keeps a finished live check report. */
  recordLiveCheck(report: LiveCheckReport): void;
  /** Waits until the live check reports are stored. */
  flushLiveCheck(): Promise<void>;
}

/** What `noAutomation` refuses with: there is no browser automation in this runtime. */
export class AutomationUnavailableError extends Error {
  readonly kind = "automation-unavailable";
  constructor() {
    super("Browser automation is not available in this runtime.");
    this.name = "AutomationUnavailableError";
  }
}

const UNAVAILABLE = "Browser automation is not available in this runtime.";

const idleState = (key: string): AutomationRunState => ({ secretId: key, providerId: "", status: "idle", text: "", host: null, step: null, startedAt: "", updatedAt: "" });

const idleInfo = (): AutomationInfo => ({
  enabled: false,
  browser: { mode: "local", endpoint: null, reachable: null, browser: null, detail: UNAVAILABLE, viewerUrl: null },
  chrome: { found: false, path: null, hint: UNAVAILABLE },
  profileDir: "",
  loginTimeoutMinutes: 0,
  signInFreshHours: 0,
  signInCheckHours: 0,
  renewalWarnDays: 0,
  signInChecks: [],
  signInLifetimes: [],
  recipes: [],
  allowExternalRecipes: false,
  problems: [],
  runs: [],
});

function refuse(): never {
  throw new AutomationUnavailableError();
}

/**
 * The port of a runtime without browser automation (the default of `createPortableRuntime`): no browser provider and no recipe,
 * the status is idle, and starting, running or cancelling anything is refused with an `AutomationUnavailableError`. Nothing is
 * stored, so it holds no state. Its clock is `now`: the builder passes the clock injected into the runtime, so a deadline the
 * automation reports follows it.
 */
export function noAutomationFor(now: () => Date): AutomationPort {
  return Object.freeze({
  enabled: false,
  loginTimeoutMinutes: 0,
  signInCheckHours: 0,
  liveCheckDays: 0,
  accessTiming: Object.freeze({}),
  viewerUrl: null,
  recipes: Object.freeze([]),
  now,
  info: idleInfo,
  status: async () => idleInfo(),
  recipe: () => undefined,
  browserHostOf: () => null,
  isBrowserProvider: (_provider: Provider | undefined): _provider is BrowserProvider => false,
  run: async () => refuse(),
  attach: async () => 0,
  state: idleState,
  cancel: refuse,
  begin: refuse,
  update: () => undefined,
  end: () => undefined,
  forget: () => undefined,
  runSignal: () => undefined,
  isBusy: () => false,
  newDriver: refuse,
  noteSignIn: () => undefined,
  signInChecks: () => [],
  liveCheckReports: () => [],
  recordLiveCheck: () => undefined,
  flushLiveCheck: async () => undefined,
  });
}

/** `noAutomationFor` with the system clock: the port a runtime gets when it was built without an injected clock. */
export const noAutomation: AutomationPort = noAutomationFor(() => new Date());
