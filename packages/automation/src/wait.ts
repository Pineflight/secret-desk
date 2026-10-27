import type { BrowserDriver, ResolvedCondition } from "./driver.js";

export class WaitTimeoutError extends Error {
  constructor() {
    super("Zeitlimit beim Warten");
    this.name = "WaitTimeoutError";
  }
}
export class WaitAbortedError extends Error {
  constructor() {
    super("Abgebrochen");
    this.name = "WaitAbortedError";
  }
}

type Probe = Pick<BrowserDriver, "currentUrl" | "isVisible" | "hasText">;

export async function conditionMet(d: Probe, c: ResolvedCondition): Promise<boolean> {
  if (c.url) return c.url.test(await d.currentUrl());
  if (c.visible) return d.isVisible(c.visible);
  if (c.text !== undefined) return d.hasText(c.text);
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
