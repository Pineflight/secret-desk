/** Pure helpers for the guided sign-in (provider facade). No network, no React. */

export type FacadeNeed = "mfa-code" | "approval" | "captcha";
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
  connected: boolean;
  needsProject: boolean;
  inputs: FacadeInput[];
  timeoutMinutes: number;
  viewerUrl: string | null;
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
  phase?: string;
  timeline?: FacadeTimelineEntry[];
  timeoutAt?: string | null;
  failure?: FacadeFailure;
  createdName?: string;
  result?: FacadeResult;
}

/** The order the portal shows the phases in. */
export const PHASES = ["opening", "username", "password", "code", "approval", "captcha", "signed-in", "key", "stored", "testing", "connected"] as const;
/** Shown only when the provider asks for them. */
const OPTIONAL = new Set<string>(["code", "approval", "captcha"]);
/** A connect run starts after the sign-in. */
const SIGN_IN_ONLY = new Set<string>(["opening", "username", "password"]);

export type StepState = "pending" | "active" | "waiting" | "done" | "failed";
export interface StepView {
  phase: string;
  state: StepState;
}

export const isRunning = (s: Pick<FacadeState, "status"> | null | undefined): boolean => s?.status === "running" || s?.status === "waiting-human";
export const isFinished = (s: Pick<FacadeState, "status"> | null | undefined): boolean => s?.status === "done" || s?.status === "failed" || s?.status === "cancelled";

/** The steps of the stepper: every fixed phase, plus the optional ones the provider asked for, with their state. */
export function stepsOf(state: FacadeState | null | undefined): StepView[] {
  const timeline = state?.timeline ?? [];
  const seen = new Map(timeline.map((e) => [e.phase, e.state]));
  const connectRun = state?.kind === "connect";
  const out: StepView[] = [];
  for (const phase of PHASES) {
    if (OPTIONAL.has(phase) && !seen.has(phase)) continue;
    if (connectRun && SIGN_IN_ONLY.has(phase)) continue;
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
