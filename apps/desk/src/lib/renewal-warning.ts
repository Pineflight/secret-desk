import type { ProviderCard } from "./provider-cards";

/**
 * Entries whose renewal needs a browser sign-in that is not there: the value is created by a recipe, the entry runs out soon,
 * and the remote browser is signed out at the provider (or nobody knows). Pure: the caller passes the entries, the provider
 * cards and the warning window (`automation.renewalWarnDays`).
 */

/** The parts of an entry this needs. */
export interface WarnableEntry {
  id: string;
  name: string;
  title?: string | null;
  /** Vendor (provider card) the entry counts for. */
  vendor: string | null;
  /** The value is created by a browser recipe. */
  browser: boolean;
  /** Day the entry expires (YYYY-MM-DD), null: never. */
  expires: string | null;
  daysLeft: number | null;
}

export interface RenewalWarning {
  secretId: string;
  /** Title of the entry, else its name. */
  title: string;
  vendorId: string;
  vendorLabel: string;
  /** Day the entry runs out and has to be renewed (YYYY-MM-DD). */
  expires: string;
  /** Days until then; zero or negative when it already ran out. */
  daysLeft: number;
  state: "signed-out" | "unknown";
}

export const DEFAULT_RENEWAL_WARN_DAYS = 7;

/** Warnings, the most urgent first. `warnDays` 0 turns them off. */
export function renewalWarnings(entries: readonly WarnableEntry[], cards: readonly ProviderCard[], warnDays: number = DEFAULT_RENEWAL_WARN_DAYS): RenewalWarning[] {
  if (!(warnDays > 0)) return [];
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const out: RenewalWarning[] = [];
  for (const e of entries) {
    if (!e.browser || !e.vendor || !e.expires || e.daysLeft === null || e.daysLeft > warnDays) continue;
    const card = byId.get(e.vendor);
    if (!card || !card.browser) continue;
    // A connected API key renews without the browser; a provider without a sign-in way cannot be helped from here.
    if (card.status === "connected" || card.signIn.state === "none" || card.signIn.state === "coming") continue;
    const state = card.browser.readiness.state;
    if (state === "ready") continue;
    out.push({ secretId: e.id, title: e.title || e.name, vendorId: card.id, vendorLabel: card.label, expires: e.expires, daysLeft: e.daysLeft, state });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title));
}

/** The warnings by entry id, for the badge on a row. */
export function warningsById(warnings: readonly RenewalWarning[]): ReadonlyMap<string, RenewalWarning> {
  return new Map(warnings.map((w) => [w.secretId, w] as const));
}

/** Where "Sign in" leads: the Integrations page, with the provider's sign-in dialog open. Never the remote browser. */
export const signInHref = (vendorId: string): string => `/connections?signin=${encodeURIComponent(vendorId)}`;

/** The vendor named by `?signin=` (letters, digits, dashes only; anything else is ignored). */
export function signInParam(value: string | null | undefined): string | null {
  return value && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
}
