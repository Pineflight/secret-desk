/** Zuletzt geoeffnet / zuletzt gesucht, nur lokal im Browser (Suchbegriffe und Ids, nie Werte). Abschaltbar und loeschbar. */

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const KEYS = { items: "sd:palette:recent-items", queries: "sd:palette:recent-queries", off: "sd:palette:history-off" } as const;
const MAX = 8;

export interface History {
  items: string[];
  queries: string[];
  enabled: boolean;
}

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const readList = (s: StorageLike, key: string): string[] => safe(() => {
  const v = JSON.parse(s.getItem(key) ?? "[]") as unknown;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
}, []);

export function loadHistory(s: StorageLike | undefined): History {
  if (!s) return { items: [], queries: [], enabled: false };
  const enabled = safe(() => s.getItem(KEYS.off) !== "1", false);
  return enabled ? { items: readList(s, KEYS.items), queries: readList(s, KEYS.queries), enabled } : { items: [], queries: [], enabled };
}

const push = (list: string[], value: string): string[] => [value, ...list.filter((x) => x !== value)].slice(0, MAX);

export function recordItem(s: StorageLike | undefined, id: string): void {
  if (!s || !loadHistory(s).enabled) return;
  safe(() => s.setItem(KEYS.items, JSON.stringify(push(readList(s, KEYS.items), id))), undefined);
}

export function recordQuery(s: StorageLike | undefined, query: string): void {
  const q = query.trim();
  if (!s || q.length < 2 || !loadHistory(s).enabled) return;
  safe(() => s.setItem(KEYS.queries, JSON.stringify(push(readList(s, KEYS.queries), q))), undefined);
}

export function clearHistory(s: StorageLike | undefined): void {
  if (!s) return;
  safe(() => { s.removeItem(KEYS.items); s.removeItem(KEYS.queries); }, undefined);
}

export function setHistoryEnabled(s: StorageLike | undefined, on: boolean): void {
  if (!s) return;
  safe(() => (on ? s.removeItem(KEYS.off) : s.setItem(KEYS.off, "1")), undefined);
  if (!on) clearHistory(s);
}
