import type { BrowserDriver, ResolvedCondition } from "./driver.js";

// The portal's server bundle evaluates this package more than once: the runtime object, and with it the browser driver, comes
// from one copy and the recipe runner from another. A plain `instanceof` then misses an error the driver threw, so a wait that
// simply ran out looked like a broken step. These two errors cross that boundary, so they are recognised by name.
export class WaitTimeoutError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "WaitTimeoutError";
  }
  constructor() {
    super("Zeitlimit beim Warten");
    this.name = "WaitTimeoutError";
  }
}
export class WaitAbortedError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "WaitAbortedError";
  }
  constructor() {
    super("Abgebrochen");
    this.name = "WaitAbortedError";
  }
}

type Probe = Pick<BrowserDriver, "currentUrl" | "isVisible" | "hasText">;

export async function conditionMet(d: Probe, c: ResolvedCondition): Promise<boolean> {
  if (c.all) {
    for (const one of c.all) if (!(await conditionMet(d, one))) return false;
    return true;
  }
  if (c.any) {
    for (const one of c.any) if (await conditionMet(d, one).catch(() => false)) return true;
    return false;
  }
  if (c.url) return c.url.test(await d.currentUrl());
  if (c.visible) return d.isVisible(c.visible);
  if (c.text !== undefined) return d.hasText(c.text);
  if (c.hidden) return !(await d.isVisible(c.hidden));
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Fragt die Bedingung regelmaessig ab (gemeinsam fuer alle Treiber). */
export async function pollCondition(d: Probe, c: ResolvedCondition, timeoutMs: number, signal?: AbortSignal, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new WaitAbortedError();
    if (await conditionMet(d, c).catch(() => false)) return;
    if (Date.now() >= deadline) throw new WaitTimeoutError();
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  }
}
