/** Kleiner Ereignisspeicher: Nach jeder Änderung melden sich die Zähler (Seitenleiste, Glocke) neu. */
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribeRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function refreshCounts(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

export function refreshVersion(): number {
  return version;
}
