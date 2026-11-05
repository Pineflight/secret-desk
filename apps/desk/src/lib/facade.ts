/** Pure helpers for the guided sign-in (provider facade). No network, no React. */

export type FacadeNeed = "mfa-code" | "approval" | "consent";
export type FacadeStatus = "idle" | "running" | "waiting-human" | "done" | "failed" | "cancelled";

/** A recipe parameter the human chooses for each run (Stripe: account and mode). */
export interface FacadeInput {
  param: string;
  label: string;
  labelEn: string;
  options: string[] | null;
  pattern: string | null;
  help: string | null;
}

export interface FacadeInfo {
  id: string;
  label: string;
  recipeId: string;
  connectionId: string;
  available: boolean;
  reason: string | null;
  recipeStatus: string | null;
  host: string | null;
  /** A recipe with several portals: the parameter that picks one and the host of each value. */
  hostBy?: string | null;
  hosts?: { value: string; host: string }[];
  connected: boolean;
  needsProject: boolean;
  inputs: FacadeInput[];
  timeoutMinutes: number;
  /** The ways to sign in: the provider's own form (email) first, then the identity providers its recipe offers. */
  methods: FacadeMethod[];
  /** Catalog key of the sentence about the key this flow creates, or null (nothing is shown). */
  promise: string | null;
  /** The email sign-in has no password (a one-time code is sent); only the email is asked for. Absent = false. */
  passwordless?: boolean;
}

export type FacadeMethodId = "email" | "google" | "apple" | "microsoft" | "github";
export interface FacadeMethod {
  id: FacadeMethodId;
  label: string | null;
  labelEn: string | null;
}

export interface FacadeTimelineEntry {
  phase: string;
  state: "active" | "done" | "failed";
  at: string;
}

export interface FacadeFailure {
  code: string;
  message: string;
  messageEn: string;
}

export interface FacadeCheckItem {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail?: string;
}

export interface FacadeResult {
  connected: boolean;
  /** The connection that received the key (a Stripe account has its own). */
  connectionId?: string;
  storedIn: "vault" | "session";
  keyName: string;
  projectId: string | null;
  check: { id: string; ok: boolean; checks: FacadeCheckItem[]; expires?: string | null; scopes?: string[] } | null;
  counts: Record<string, number>;
  /** The sign-in worked, but this account cannot create the integration key (keys come from the browser). Nothing is stored. */
  browserOnly?: boolean;
}

/** The state the server reports for a sign-in run. It never contains a typed value. */
export interface FacadeState {
  secretId: string;
  providerId: string;
  status: FacadeStatus;
  text: string;
  startedAt: string;
  updatedAt: string;
  kind?: "signin" | "connect";
  needs?: FacadeNeed | null;
  /** The number an approval shows, or the access an authorization asks for (consent). Never a credential. */
  detail?: string;
  phase?: string;
  timeline?: FacadeTimelineEntry[];
  timeoutAt?: string | null;
  failure?: FacadeFailure;
  createdName?: string;
  result?: FacadeResult;
  /** Runs that sign in and confirm through the portal (team token): the question to answer now. */
  ask?: RunAsk | null;
}

export type SudoMethodId = "mobile" | "code" | "password";
export type RunAsk =
  | { type: "credentials"; methods: FacadeMethod[] }
  | { type: "access"; stage: "choose"; methods: SudoMethodId[]; attempt: number; maxAttempts: number; problem?: "timeout" | "rejected" | "unavailable" }
  | { type: "access"; stage: "mobile"; number: string }
  | { type: "access"; stage: "checking"; method: SudoMethodId };

/** The order the portal shows the phases in. */
export const PHASES = ["opening", "username", "password", "code", "approval", "consent", "signed-in", "key", "stored", "testing", "connected"] as const;
/** Shown only when the provider asks for them. */
const OPTIONAL = new Set<string>(["code", "approval", "consent"]);
/** A connect run starts after the sign-in. */
const SIGN_IN_ONLY = new Set<string>(["opening", "username", "password"]);

export type StepState = "pending" | "active" | "waiting" | "done" | "failed";
export interface StepView {
  phase: string;
  state: StepState;
}

export const isRunning = (s: Pick<FacadeState, "status"> | null | undefined): boolean => s?.status === "running" || s?.status === "waiting-human";
export const isFinished = (s: Pick<FacadeState, "status"> | null | undefined): boolean => s?.status === "done" || s?.status === "failed" || s?.status === "cancelled";

/** The phases after the sign-in: a run that only signs in (no key is created) does not show them. */
const AFTER_SIGN_IN = new Set<string>(["key", "stored", "testing", "connected"]);

/**
 * The steps of the stepper: every fixed phase, plus the optional ones the provider asked for, with their state.
 * `signInOnly`: the run only signs in, so the steps that create, store and test a key are left out.
 */
export function stepsOf(state: FacadeState | null | undefined, options: { signInOnly?: boolean } = {}): StepView[] {
  const timeline = state?.timeline ?? [];
  const seen = new Map(timeline.map((e) => [e.phase, e.state]));
  const connectRun = state?.kind === "connect";
  const out: StepView[] = [];
  for (const phase of PHASES) {
    if (OPTIONAL.has(phase) && !seen.has(phase)) continue;
    if (connectRun && SIGN_IN_ONLY.has(phase)) continue;
    if (options.signInOnly && AFTER_SIGN_IN.has(phase)) continue;
    const s = seen.get(phase);
    let st: StepState = "pending";
    if (s === "done") st = "done";
    else if (s === "failed") st = "failed";
    else if (s === "active") st = state?.status === "waiting-human" ? "waiting" : "active";
    out.push({ phase, state: st });
  }
  // A finished run leaves no step spinning.
  return isFinished(state) ? out.map((x) => (x.state === "active" || x.state === "waiting" ? { ...x, state: state?.status === "done" ? "done" : "failed" } : x)) : out;
}

/** Whole seconds from an ISO time to `nowMs` (0 if unknown or in the future). */
export function elapsedSeconds(startedAt: string | undefined, nowMs: number): number {
  const t = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : 0;
}

/** Whole seconds until the run gives up, or null if there is no limit. */
export function remainingSeconds(timeoutAt: string | null | undefined, nowMs: number): number | null {
  const t = timeoutAt ? Date.parse(timeoutAt) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : null;
}

/** m:ss */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Codes whose technical detail is worth showing next to the translated text. */
const DETAIL_CODES = new Set(["step", "host", "key", "store", "browser", "unsupported"]);

/**
 * The failure as text for the interface language. The provider's own refusal text comes from the recipe (German and English);
 * everything else uses the portal's catalog, with the server's technical detail appended where it helps.
 */
export function failureText(f: FacadeFailure, locale: "de" | "en", t: (key: string) => string): string {
  if (locale === "en") return f.messageEn;
  if (f.code === "rejected") return f.message;
  const key = `facade.fail.${f.code}`;
  const text = t(key);
  if (text === key) return f.message;
  return DETAIL_CODES.has(f.code) && f.messageEn ? `${text} (${f.messageEn})` : text;
}

/** "1 project, 3 apps" from the counts of the result, using the catalog (`facade.count.<key>`, plural forms one/other). */
export function countsText(counts: Record<string, number>, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return Object.entries(counts)
    .map(([key, count]) => {
      const k = `facade.count.${key}`;
      const text = t(k, { count });
      return text === k ? `${count} ${key}` : text;
    })
    .join(", ");
}

/** The one-time code field accepts what the server accepts (4 to 16 letters, digits or dashes; spaces are ignored). */
export function codeValid(code: string): boolean {
  return /^[A-Za-z0-9-]{4,16}$/.test(code.replace(/\s+/g, ""));
}

/** Fields of the sign-in form are valid enough to send. Only shape, no policy. */
export function signInValid(email: string, password: string): boolean {
  return email.trim().length > 0 && email.trim().length <= 254 && password.length > 0 && password.length <= 1024;
}

/** Every input has a value that fits its options and pattern (the server checks again). */
export function inputsValid(inputs: readonly FacadeInput[], values: Record<string, string>): boolean {
  return inputs.every((i) => {
    const v = (values[i.param] ?? "").trim();
    if (!v) return false;
    if (i.options && !i.options.includes(v)) return false;
    if (i.pattern !== null && !new RegExp(i.pattern).test(v)) return false;
    return true;
  });
}

/** The inputs to send: trimmed, only the ones the facade asks for. */
export function inputsBody(inputs: readonly FacadeInput[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(inputs.map((i) => [i.param, (values[i.param] ?? "").trim()]));
}

// ------------------------------------------------------------------------------------------ connect dialog

/** What the dialog knows about the browser sign-in at the provider. */
export type BrowserSignIn = "checking" | "signed-in" | "signed-out" | "unknown";

/** The answer of a finished check (`signedIn` null: the check could not be made), or undefined while it is still queued or running. */
export function browserSignInOf(outcome: { signedIn: boolean | null } | undefined): BrowserSignIn {
  if (!outcome) return "checking";
  if (outcome.signedIn === null) return "unknown";
  return outcome.signedIn ? "signed-in" : "signed-out";
}

export type DialogView = "run" | "checking" | "connect" | "sign-in";

/**
 * Which part of the dialog is shown. A run in progress (or just finished) always wins. Otherwise the sign-in check decides:
 * while it runs the dialog only says so; a signed-in browser connects directly; a signed-out one (or one that could not be
 * checked) offers the sign-in methods.
 */
export function dialogView(browser: BrowserSignIn, hasRun: boolean): DialogView {
  if (hasRun) return "run";
  if (browser === "checking") return "checking";
  return browser === "signed-in" ? "connect" : "sign-in";
}

/** Names of the sign-in methods as the providers write them (not translated). */
export const IDP_NAMES: Readonly<Record<FacadeMethodId, string>> = { email: "email", google: "Google", apple: "Apple", microsoft: "Microsoft", github: "GitHub" };

/** The methods to offer: the recipe's list, never empty (email is the provider's own form). */
export function methodsOf(facade: Pick<FacadeInfo, "methods">): FacadeMethod[] {
  return facade.methods.length > 0 ? facade.methods : [{ id: "email", label: null, labelEn: null }];
}

/** The method the form starts with: the first one offered. */
export function defaultMethod(facade: Pick<FacadeInfo, "methods">): FacadeMethodId {
  return methodsOf(facade)[0]!.id;
}

/** The chosen method if the facade offers it, else the first one. */
export function chosenMethod(facade: Pick<FacadeInfo, "methods">, id: string | null | undefined): FacadeMethodId {
  return methodsOf(facade).find((m) => m.id === id)?.id ?? defaultMethod(facade);
}

/** Every state of the connect button: it is busy while the request runs, disabled when the provider is unusable or inputs are missing. */
export type ConnectButton = "ready" | "busy" | "disabled";
export function connectButtonState(facade: Pick<FacadeInfo, "available" | "inputs">, values: Record<string, string>, busy: boolean): ConnectButton {
  if (busy) return "busy";
  return facade.available && inputsValid(facade.inputs, values) ? "ready" : "disabled";
}

/** The sign-in form asks for a password: not for a passwordless email sign-in (single-sign-on methods still do). */
export const needsPassword = (facade: Pick<FacadeInfo, "passwordless">, method: string): boolean => !(facade.passwordless === true && method === "email");

/** The sign-in form can be sent: provider usable, credentials and inputs present, nothing running. */
export function signInButtonState(facade: Pick<FacadeInfo, "available" | "inputs" | "passwordless">, email: string, password: string, values: Record<string, string>, busy: boolean, method = "email"): ConnectButton {
  if (busy) return "busy";
  const credentials = needsPassword(facade, method) ? signInValid(email, password) : signInValid(email, "x");
  return facade.available && credentials && inputsValid(facade.inputs, values) ? "ready" : "disabled";
}

/** The access an authorization asks for, as list items (the portal shows them before the human confirms). */
export function consentItems(detail: string | undefined): string[] {
  return (detail ?? "")
    .split(/\n|;/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);
}

// ------------------------------------------------------------------------------------------ recipe sign-in

/** What the sign-in dialog of a browser-only vendor needs to know about its recipe (no key is created, so no inputs or project). */
export interface RecipeSignInSubject {
  id: string;
  available: boolean;
  methods: FacadeMethod[];
  passwordless: boolean;
  /** The portals of a recipe with several: the value of the recipe's host parameter and its host. Empty for one portal. */
  hosts: readonly { value: string; host: string }[];
}

/** The recipe row as the dialog sees it. */
export function recipeSignInSubject(recipe: { id: string; hosts?: readonly { value: string; host: string }[]; signInMethods?: readonly { id: string; label: string | null; labelEn: string | null }[]; signInPasswordless?: boolean }, available: boolean): RecipeSignInSubject {
  const known = new Set<string>(["email", "google", "apple", "microsoft", "github"]);
  const methods = (recipe.signInMethods ?? []).filter((m) => known.has(m.id)).map((m) => ({ id: m.id as FacadeMethodId, label: m.label, labelEn: m.labelEn }));
  return { id: recipe.id, available, methods, passwordless: recipe.signInPasswordless === true, hosts: recipe.hosts ?? [] };
}

/** The portal to preselect: the one asked for if the recipe has it, the only one if there is one, else none (the human chooses). */
export function initialPortal(subject: Pick<RecipeSignInSubject, "hosts">, wanted: string | null | undefined): string {
  if (wanted && subject.hosts.some((h) => h.value === wanted)) return wanted;
  return subject.hosts.length === 1 ? subject.hosts[0]!.value : "";
}

/** The sign-in form of a browser-only vendor can be sent: usable, a portal chosen if there are several, credentials present. */
export function recipeSignInButtonState(subject: Pick<RecipeSignInSubject, "available" | "passwordless" | "hosts">, portal: string, email: string, password: string, busy: boolean, method = "email"): ConnectButton {
  if (busy) return "busy";
  const portalOk = subject.hosts.length === 0 || subject.hosts.some((h) => h.value === portal);
  const credentials = needsPassword(subject, method) ? signInValid(email, password) : signInValid(email, "x");
  return subject.available && portalOk && credentials ? "ready" : "disabled";
}

/** The request body of the sign-in: the portal only for a recipe with several. The caller clears the typed values afterwards. */
export function recipeSignInBody(subject: Pick<RecipeSignInSubject, "hosts">, portal: string, method: string, email: string, password: string): { method: string; username: string; password: string; host?: string } {
  return { method, username: email.trim(), password, ...(subject.hosts.length > 0 ? { host: portal } : {}) };
}

/** A way into a guided sign-in besides the recommended one. `email`: type the provider sign-in; `key`: paste a key made by hand. */
export type OtherWay = "email" | "key";

/**
 * The ways the dialog folds under "Other ways". With a signed-in browser the only primary action is connecting with it, so the
 * typed sign-in and pasting a key are both folded; without one the sign-in form is the main path and only pasting is folded.
 * While a run is going or has finished, nothing is offered here (a failed run shows its own way out).
 */
export function otherWays(view: DialogView, hasFallback: boolean): OtherWay[] {
  if (view === "connect") return hasFallback ? ["email", "key"] : ["email"];
  if (view === "sign-in") return hasFallback ? ["key"] : [];
  return [];
}
