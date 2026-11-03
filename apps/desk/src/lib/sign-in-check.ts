import { failureText, type FacadeFailure } from "./facade";
import type { CheckPhase } from "./check-queue";
import type { ProviderCard } from "./provider-cards";

/** The answer of `POST facades/:id/check`. `failure` is set when the check could not be made at all. */
export interface CheckResponse {
  signedIn: boolean;
  checkedAt: string;
  failure?: FacadeFailure;
}

/** What the page remembers of the last check of one provider. */
export interface CheckOutcome {
  /** null: the check could not be made, so nothing is known. */
  signedIn: boolean | null;
  failure: FacadeFailure | null;
  /** The request itself failed (network, refused). Shown as the server's own text. */
  error: string | null;
}

export function outcomeOf(r: CheckResponse): CheckOutcome {
  return r.failure ? { signedIn: null, failure: r.failure, error: null } : { signedIn: r.signedIn, failure: null, error: null };
}

export function outcomeOfError(e: unknown): CheckOutcome {
  return { signedIn: null, failure: null, error: e instanceof Error && e.message ? e.message : "" };
}

/** The line that explains a failed check in the interface language, or null when the check worked. */
export function outcomeProblem(o: CheckOutcome | undefined, locale: "de" | "en", t: (key: string) => string): string | null {
  if (!o) return null;
  if (o.failure) return failureText(o.failure, locale, t);
  if (o.error !== null) return o.error || t("common.unknownError");
  return null;
}

export type SignInStatus = CheckPhase | "yes" | "no" | "failed" | "unchecked";

/**
 * The sign-in state a collapsed card shows. Only providers with a guided sign-in (their own or a recipe's) can be checked, so only
 * they have one; for the others the browser state cannot be known and the card says nothing.
 */
export function signInStatus(card: Pick<ProviderCard, "signIn">, phase: CheckPhase | undefined, outcome: CheckOutcome | undefined): SignInStatus | null {
  if (!card.signIn.facade && !card.signIn.checkRecipe) return null;
  if (phase) return phase;
  if (!outcome) return "unchecked";
  if (outcome.signedIn === null) return "failed";
  return outcome.signedIn ? "yes" : "no";
}

/** The route that checks the browser sign-in of a card: its guided sign-in, else the first recipe that has one. Null: not checkable. */
export function checkPathOf(card: Pick<ProviderCard, "id" | "signIn">): string | null {
  if (card.signIn.facade) return `facades/${encodeURIComponent(card.id)}/check`;
  return card.signIn.checkRecipe ? `recipes/${encodeURIComponent(card.signIn.checkRecipe)}/check` : null;
}

/** The providers whose last check answered "signed in" (feeds the card status). */
export function signedInIds(outcomes: Readonly<Record<string, CheckOutcome>>): ReadonlySet<string> {
  return new Set(Object.entries(outcomes).filter(([, o]) => o.signedIn === true).map(([id]) => id));
}
