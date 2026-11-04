import type { ExpiryLevel } from "./connection-health";
import { managedExpiry, type CardStatus, type ProviderCard } from "./provider-cards";
import type { SignInStatus } from "./sign-in-check";

/**
 * What a collapsed provider card says: one status badge and at most ONE meta line. A problem always wins over the neutral line;
 * everything else (counts of keys and variables, how sign-in works, per-account lines) belongs to the expanded card.
 */

/** Days after which a key counts as "expires soon" (same limit as the expiry traffic light). */
export const EXPIRY_WARN_DAYS = 14;

export type BadgeKind = "connected" | "ready" | "signin-needed" | "none" | "expiring" | "expired";

export interface CollapsedInput {
  /** The sign-in state of the card as a whole (the last check in this page session), or null. */
  signIn: SignInStatus | null;
  /** The last connection test of one of the card's keys failed. */
  testFailed?: boolean;
  now?: Date;
}

const problemExpiry = (level: ExpiryLevel | null | undefined): level is "soon" | "critical" | "expired" => level === "soon" || level === "critical" || level === "expired";

/** The browser sign-in of a card without an API connection is missing, rejected or not known. */
function signInNeeded(card: ProviderCard, signIn: SignInStatus | null): boolean {
  // An API connection makes the browser sign-in unnecessary: its state is never a problem and never a line.
  if (card.worksWithoutBrowser || card.status === "connected") return false;
  if (card.status === "signout" || card.status === "unknown") return true;
  if (signIn === "no") return true;
  return (card.browser?.hostLines ?? []).some((l) => l.readiness.state === "signed-out");
}

/** The one badge of a collapsed card. */
export function collapsedBadge(card: ProviderCard, input: CollapsedInput): BadgeKind {
  const status: CardStatus = card.status;
  if (status === "none") return "none";
  if (signInNeeded(card, input.signIn)) return "signin-needed";
  const level = managedExpiry(card)?.level;
  if (level === "expired") return "expired";
  if (problemExpiry(level)) return "expiring";
  return status === "connected" ? "connected" : "ready";
}

export type MetaKind = "test-failed" | "signin-needed" | "expiry" | "valid";

export interface CollapsedMeta {
  kind: MetaKind;
  /** A problem line is drawn in a warning color. */
  problem: boolean;
  /** Message key and variables; the caller translates. */
  key: string;
  vars: Record<string, string | number>;
  /** Day (YYYY-MM-DD) the line talks about, for the formatter. */
  date?: string;
  days?: number;
}

const dayOf = (e: { expires: string | null | undefined; daysLeft: number }, now: Date): string => e.expires ?? new Date(now.getTime() + e.daysLeft * 86_400_000).toISOString().slice(0, 10);

/**
 * The single meta line, chosen by priority: a failed test, a sign-in that is needed, an expiry within 14 days (or past); else
 * "N secrets · valid until <date>". Null when there is nothing worth saying.
 */
export function collapsedMeta(card: ProviderCard, input: CollapsedInput): CollapsedMeta | null {
  const now = input.now ?? new Date();
  const expiry = managedExpiry(card);
  if (input.testFailed || (input.signIn === "failed" && !card.worksWithoutBrowser)) return { kind: "test-failed", problem: true, key: "providers.meta.testFailed", vars: {} };
  if (signInNeeded(card, input.signIn)) return { kind: "signin-needed", problem: true, key: "providers.meta.signInNeeded", vars: { name: card.label } };
  if (expiry && problemExpiry(expiry.level) && expiry.daysLeft <= EXPIRY_WARN_DAYS) {
    return { kind: "expiry", problem: true, key: expiry.level === "expired" ? "providers.meta.expired" : "providers.meta.expiresSoon", vars: {}, date: dayOf(expiry, now), days: expiry.daysLeft };
  }
  if (card.status === "none" && card.secrets === 0) return null;
  if (card.secrets > 0 && expiry) return { kind: "valid", problem: false, key: "providers.meta.secretsUntil", vars: { count: card.secrets }, date: dayOf(expiry, now), days: expiry.daysLeft };
  if (card.secrets > 0) return { kind: "valid", problem: false, key: "providers.meta.secrets", vars: { count: card.secrets } };
  return null;
}

/** Buttons a collapsed card shows: "Set up" for a card that is not set up, nothing otherwise (sign-in prompts are separate). */
export type CollapsedAction = "set-up" | null;
export const collapsedAction = (card: Pick<ProviderCard, "status">): CollapsedAction => (card.status === "none" ? "set-up" : null);
