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

/**
 * Inventory changes made outside the portal (CLI, scripts, team sync). The shell polls a cheap version number and
 * announces a change here; data hooks reload silently, so no page needs a manual browser reload.
 */
const inventoryListeners = new Set<Listener>();

export function subscribeInventoryChange(fn: Listener): () => void {
  inventoryListeners.add(fn);
  return () => {
    inventoryListeners.delete(fn);
  };
}

export function notifyInventoryChange(): void {
  for (const fn of [...inventoryListeners]) fn();
}
