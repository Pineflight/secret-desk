import type { LoginCredentials, LoginMethodId, SudoAnswer } from "@secret-desk/automation";
// Types only: the automation package is not part of the portable entry (no value is imported from it).

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
    super("Time limit reached while waiting for your answer.");
    this.name = "WaitExpiredError";
  }
}

/** The longest any single question may stay open. */
export const DEFAULT_WAIT_MS = 15 * 60_000;

/**
 * How long a person has to answer each kind of question, counted from the moment it is asked (never from the start of the run:
 * a long sign-in must not leave the next question expired before it is asked). None is longer than `DEFAULT_WAIT_MS`.
 */
export const WAIT_WINDOWS_MS = { credentials: 15 * 60_000, access: 10 * 60_000, code: 10 * 60_000, confirm: 10 * 60_000 } as const;

export interface Waiter<T> {
  resolve: (answer: T) => void;
  reject: (err: Error) => void;
  /** The run this question belongs to (its signal): an answer is only taken for the run that asked. */
  run: AbortSignal;
  /** Epoch milliseconds after which the wait cannot be satisfied. */
  deadline: number;
}

/** Pending questions of one kind, one per key (a provider id or a run key). */
export class WaiterBook<T> {
  readonly #items = new Map<string, Waiter<T>>();

  /**
   * Registers a question. A question it replaces is rejected (a run asks one question of a kind at a time). A run that has been
   * cancelled can no longer ask: its question is rejected at once and nothing is registered.
   */
  set(key: string, waiter: Waiter<T>): void {
    if (waiter.run.aborted) {
      waiter.reject(new Error("cancelled"));
      return;
    }
    const old = this.#items.get(key);
    this.#items.set(key, waiter);
    old?.reject(new Error("replaced"));
  }

  /** The live wait for `key` that belongs to the run `run`, or undefined: an answer meant for another run (or none) finds nothing. */
  answerable(key: string, now: Date, run: AbortSignal | undefined): Waiter<T> | undefined {
    const waiter = this.get(key, now);
    return waiter && run !== undefined && waiter.run === run && !run.aborted ? waiter : undefined;
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

  /** Forgets the question for `key`, but only when it belongs to the run that asks (a run never removes another run's question). */
  delete(key: string, run: AbortSignal | undefined): void {
    if (this.#items.get(key)?.run === run) this.#items.delete(key);
  }

  /** Forgets whatever question is open for `key`: for the answer path, which has just taken it. */
  discard(key: string): void {
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

/** The deadline of a question asked now: the window of its kind from this moment (epoch milliseconds). */
export function waitDeadline(now: Date, kind: keyof typeof WAIT_WINDOWS_MS): number {
  return now.getTime() + Math.min(WAIT_WINDOWS_MS[kind], DEFAULT_WAIT_MS);
}
