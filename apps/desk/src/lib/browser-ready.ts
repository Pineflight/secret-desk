/**
 * Is the remote browser still signed in at a provider? Provider sessions are short-lived (often about a day), so an old answer
 * is not an answer: a check or a successful recipe run counts only while it is younger than the configured age
 * (`automation.signInFreshHours`). Pure functions, no clock of their own.
 */

/** The server's memory of the last sign-in state of one recipe host. */
export interface SignInCheckRow {
  host: string;
  signedIn: boolean;
  /** ISO time of the check or of the successful recipe run. */
  checkedAt: string;
}

/** The server's measurement of how long sign-ins at one recipe host lasted. */
export interface SessionLifetimeRow {
  host: string;
  averageMinutes: number;
}

/** How long sign-ins lasted at these hosts, in whole hours (at least 1): the average of the hosts' averages. Null without a measurement. */
export function sessionHoursOf(lifetimes: readonly SessionLifetimeRow[], hosts: readonly string[]): number | null {
  const rows = lifetimes.filter((l) => hosts.includes(l.host) && Number.isFinite(l.averageMinutes) && l.averageMinutes >= 0);
  if (rows.length === 0) return null;
  const minutes = rows.reduce((a, l) => a + l.averageMinutes, 0) / rows.length;
  return Math.max(1, Math.round(minutes / 60));
}

/** `ready`: signed in and fresh. `signed-out`: fresh answer, signed out. `unknown`: no answer, an unreadable one, or one that is too old. */
export type ReadinessState = "ready" | "signed-out" | "unknown";

export interface Readiness {
  state: ReadinessState;
  /** Time of the answer that was used, null when there is none. Kept for "checked 3 hours ago" even when it is stale. */
  checkedAt: string | null;
  /** Whole minutes since `checkedAt` (never negative), null when there is none. */
  ageMinutes: number | null;
  /** There was an answer, but it is older than the allowed age. */
  stale: boolean;
}

export const DEFAULT_FRESH_HOURS = 12;

const NONE: Readiness = { state: "unknown", checkedAt: null, ageMinutes: null, stale: false };

/** The newest check among several (a vendor can have recipes on more than one host). */
export function newestCheck(checks: readonly SignInCheckRow[], hosts: readonly string[]): SignInCheckRow | undefined {
  let best: SignInCheckRow | undefined;
  let bestAt = -Infinity;
  for (const c of checks) {
    if (!hosts.includes(c.host)) continue;
    const at = Date.parse(c.checkedAt);
    if (Number.isNaN(at)) continue;
    if (at > bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Readiness of the browser sign-in from the last known answer. A time in the future (clock skew) counts as "just now"; an
 * unreadable time or a missing answer is unknown. `freshHours` must be positive; anything else falls back to the default.
 */
export function browserReadiness(check: SignInCheckRow | undefined, now: Date, freshHours: number = DEFAULT_FRESH_HOURS): Readiness {
  if (!check) return NONE;
  const at = Date.parse(check.checkedAt);
  if (Number.isNaN(at)) return NONE;
  const limit = (Number.isFinite(freshHours) && freshHours > 0 ? freshHours : DEFAULT_FRESH_HOURS) * 3_600_000;
  const age = Math.max(0, now.getTime() - at);
  const ageMinutes = Math.floor(age / 60_000);
  if (age > limit) return { state: "unknown", checkedAt: check.checkedAt, ageMinutes, stale: true };
  return { state: check.signedIn ? "ready" : "signed-out", checkedAt: check.checkedAt, ageMinutes, stale: false };
}

export interface AgeParts {
  unit: "now" | "minutes" | "hours" | "days";
  count: number;
}

/** "just now" under a minute, then whole minutes, hours (from 60 minutes) and days (from 48 hours). */
export function ageParts(ageMinutes: number): AgeParts {
  const m = Math.max(0, Math.floor(ageMinutes));
  if (m < 1) return { unit: "now", count: 0 };
  if (m < 60) return { unit: "minutes", count: m };
  const hours = Math.floor(m / 60);
  if (hours < 48) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.floor(hours / 24) };
}
