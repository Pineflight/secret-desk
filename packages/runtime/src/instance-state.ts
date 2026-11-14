import type { LoginCredentials, LoginMethodId, SudoAnswer } from "@secret-desk/automation";

/**
 * Everything a running `Runtime` keeps in memory while it waits for a person: the one-time codes, approvals and provider
 * credentials that are in transit. It lives in the runtime instance (`Runtime.instance`), never in module scope, so two runtimes
 * in one process share nothing: an answer typed for one cannot be taken by the other.
 *
 * Every wait carries a deadline. A wait whose deadline has passed is treated as absent on the next access (it is removed and its
 * promise is rejected with `WaitExpiredError`), and `sweep` removes all of them. Nothing depends on a timer for correctness.
 */

/** The wait ran out before an answer arrived. The run that waited fails like any other time-out. */
export class WaitExpiredError extends Error {
  constructor() {
    super("The time for the answer ran out.");
    this.name = "WaitExpiredError";
  }
}

/** The longest a wait may last when its run names no time-out of its own. */
export const DEFAULT_WAIT_MS = 15 * 60_000;

export interface Waiter<T> {
  resolve: (answer: T) => void;
  reject: (err: Error) => void;
  /** The run this question belongs to (its signal), when the answer must be matched to it. */
  run?: AbortSignal;
  /** Epoch milliseconds after which the wait cannot be satisfied. */
  deadline: number;
}

/** Pending questions of one kind, one per key (a provider id or a run key). */
export class WaiterBook<T> {
  readonly #items = new Map<string, Waiter<T>>();

  set(key: string, waiter: Waiter<T>): void {
    this.#items.set(key, waiter);
  }

  /** The live wait for `key`. A wait past its deadline is removed, rejected with `WaitExpiredError` and reported as absent. */
  get(key: string, now: Date): Waiter<T> | undefined {
    const waiter = this.#items.get(key);
    if (!waiter) return undefined;
    if (waiter.deadline <= now.getTime()) {
      this.#items.delete(key);
      waiter.reject(new WaitExpiredError());
      return undefined;
    }
    return waiter;
  }

  /** Like `get`, and the wait is gone afterwards: an answer is delivered once. */
  take(key: string, now: Date): Waiter<T> | undefined {
    const waiter = this.get(key, now);
    if (waiter) this.#items.delete(key);
    return waiter;
  }

  delete(key: string): void {
    this.#items.delete(key);
  }

  /** Rejects the wait for `key` as cancelled and forgets it. */
  cancel(key: string): void {
    const waiter = this.#items.get(key);
    this.#items.delete(key);
    waiter?.reject(new Error("cancelled"));
  }

  /** Removes (and rejects) every expired wait. Returns the earliest deadline that remains, in epoch milliseconds, or null. */
  sweep(now: Date): number | null {
    let next: number | null = null;
    for (const key of [...this.#items.keys()]) {
      const waiter = this.get(key, now);
      if (waiter && (next === null || waiter.deadline < next)) next = waiter.deadline;
    }
    return next;
  }

  get size(): number {
    return this.#items.size;
  }
}

/** The answers the portal can give while the team token run waits. The run exists once per runtime, so one slot per question. */
export interface TeamTokenAnswers {
  credentials: { creds: LoginCredentials; method: LoginMethodId };
  access: SudoAnswer;
  code: string;
  confirm: boolean;
}

export class InstanceState {
  /** One pending one-time code request per facade run. */
  readonly codeWaiters = new WaiterBook<string>();
  /** One pending authorization (OAuth consent) question per facade run. */
  readonly confirmWaiters = new WaiterBook<boolean>();
  /** One pending identity-verification question ("Verification required", "Confirm access") per facade run. */
  readonly accessWaiters = new WaiterBook<SudoAnswer>();
  /** The questions of the team token run, one slot per kind. */
  readonly teamToken: { [K in keyof TeamTokenAnswers]: WaiterBook<TeamTokenAnswers[K]> } = {
    credentials: new WaiterBook(),
    access: new WaiterBook(),
    code: new WaiterBook(),
    confirm: new WaiterBook(),
  };
  /** A live check is running in this runtime right now. */
  liveCheckRunning = false;

  /** Removes every expired wait. Returns the earliest deadline that remains (epoch milliseconds), or null. */
  sweepWaiters(now: Date): number | null {
    const books: WaiterBook<unknown>[] = [this.codeWaiters, this.confirmWaiters, this.accessWaiters, this.teamToken.credentials, this.teamToken.access, this.teamToken.code, this.teamToken.confirm] as WaiterBook<unknown>[];
    let next: number | null = null;
    for (const book of books) {
      const at = book.sweep(now);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }
}

/** The deadline of a wait: the time-out of its run when it has one, else `DEFAULT_WAIT_MS` from now. */
export function waitDeadline(now: Date, timeoutAt: string | null | undefined): number {
  const parsed = timeoutAt ? Date.parse(timeoutAt) : Number.NaN;
  return Number.isNaN(parsed) ? now.getTime() + DEFAULT_WAIT_MS : parsed;
}
