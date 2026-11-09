import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Registers an `afterEach` that unmounts the page and then yields one macrotask. Components start requests right after the last
 * assertion (follow-up queries, a query that waits for the session first); once unmounted no new one starts, and the ones in
 * flight reach the fake `fetch` before setup-dom.ts restores the real one. Otherwise they would try to connect to localhost.
 * It waits for no time: it only lets queued promise callbacks run.
 */
export function drainRequestsAfterEach(): void {
  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
