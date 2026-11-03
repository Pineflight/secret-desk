/**
 * Which provider cards (and which keys inside them) the viewer has opened on the Integrations page. Kept per browser in
 * localStorage; everything is optional: no storage, blocked storage or broken JSON simply mean "all collapsed".
 */

export const EXPANDED_STORAGE_KEY = "sd:integrations:expanded";

type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem" | "removeItem">;

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const cardKey = (providerId: string): string => `card:${providerId}`;
export const connectionKey = (connectionId: string): string => `key:${connectionId}`;

/** The stored set. Anything that is not a list of strings is ignored. */
export function readExpanded(storage: Reader | null = localStore()): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw == null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeExpanded(open: ReadonlySet<string>, storage: Writer | null = localStore()): void {
  try {
    if (open.size === 0) storage?.removeItem(EXPANDED_STORAGE_KEY);
    else storage?.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...open].sort()));
  } catch {
    /* storage blocked or full: the choice then lasts until the page is left */
  }
}

/** A new set with the key opened or closed. */
export function toggled(open: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(open);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Opens all given cards, keeping what else is open (the keys inside). */
export function expandAll(open: ReadonlySet<string>, providerIds: readonly string[]): ReadonlySet<string> {
  return new Set([...open, ...providerIds.map(cardKey)]);
}

/** Closes every card and every key. */
export const collapseAll = (): ReadonlySet<string> => new Set();

/** True when all the given cards are open (the toggle at the top then offers "Collapse all"). */
export const allExpanded = (open: ReadonlySet<string>, providerIds: readonly string[]): boolean => providerIds.length > 0 && providerIds.every((id) => open.has(cardKey(id)));
