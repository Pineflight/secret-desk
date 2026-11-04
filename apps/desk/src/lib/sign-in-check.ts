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
  // Several portals: each has its own line (see `hostLines`), the card as a whole says nothing.
  if (checkHostsOf(card).length > 0) return null;
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

/**
 * The key of one check. A provider with several portals (live and test, separate accounts) is checked per portal, so its key
 * names the host; the check queue and the remembered answers use this key.
 */
export const checkIdOf = (cardId: string, host?: string | null): string => (host ? `${cardId}#${host}` : cardId);

/** The provider and the portal host (null: the provider as a whole) a check key stands for. */
export function splitCheckId(id: string): { cardId: string; host: string | null } {
  const at = id.indexOf("#");
  return at < 0 ? { cardId: id, host: null } : { cardId: id.slice(0, at), host: id.slice(at + 1) };
}

/** The body of a check request: only a provider with several portals names the one to check. */
export const checkBodyOf = (host: string | null): { host: string } | undefined => (host ? { host } : undefined);

/** The portals of a card that can be checked on their own (empty: the provider has one). */
export function checkHostsOf(card: Pick<ProviderCard, "signIn">): readonly { value: string; host: string }[] {
  return card.signIn.facade ? [] : (card.signIn.checkHosts ?? []);
}

/** The providers where a check answered "signed in" (feeds the card status); one signed-in portal is enough. */
export function signedInIds(outcomes: Readonly<Record<string, CheckOutcome>>): ReadonlySet<string> {
  return new Set(Object.entries(outcomes).filter(([, o]) => o.signedIn === true).map(([id]) => splitCheckId(id).cardId));
}
