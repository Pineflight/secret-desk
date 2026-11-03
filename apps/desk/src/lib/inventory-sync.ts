"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import { notifyInventoryChange } from "./refresh";

export interface InventoryVersion {
  version: number;
  problem: { message: string; since: string; persistent: boolean } | null;
}

/** How often the version is asked while the tab is visible. The probe is a stat call on the server, so this is cheap. */
export const INVENTORY_POLL_MS = 4000;

/** True when the server reports a different version than the last one seen. The first answer is only remembered. */
export function inventoryChanged(previous: number | null, next: number): boolean {
  return previous !== null && previous !== next;
}

/**
 * Keeps the open page in step with the inventory file: asks the version on focus, when the tab becomes visible again and
 * on a modest interval while visible. A new version makes every data hook reload silently. Returns the persistent
 * problem (the file on disk cannot be read), if any. Only runs when `enabled` (a session exists).
 */
export function useInventorySync(enabled: boolean): InventoryVersion["problem"] {
  const [problem, setProblem] = useState<InventoryVersion["problem"]>(null);
  useEffect(() => {
    if (!enabled) return;
    let last: number | null = null;
    let alive = true;
    let busy = false;
    const probe = (): void => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      api<InventoryVersion>("GET", "inventory/version")
        .then((v) => {
          if (!alive) return;
          if (inventoryChanged(last, v.version)) notifyInventoryChange();
          last = v.version;
          setProblem(v.problem);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    probe();
    const timer = setInterval(probe, INVENTORY_POLL_MS);
    window.addEventListener("focus", probe);
    document.addEventListener("visibilitychange", probe);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", probe);
      document.removeEventListener("visibilitychange", probe);
    };
  }, [enabled]);
  return problem;
}
