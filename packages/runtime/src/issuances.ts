import { discardIssuance, SecretValue, type IssuanceDeps, type PendingIssuance } from "@secret-desk/core";

/**
 * Where the issued, unconfirmed values are kept. The default is `MemoryPendingStore`; an embedder may supply its own (for example
 * one that is tied to an isolated object of its platform) through `RuntimeOptions.pendingStore`.
 *
 * A store must keep the value (`PendingIssuance.value` and the companion values) in memory only and must never persist it: not in
 * a file, not in a database, not in a log. What an embedder may keep on the side is the identifier and the deadline (`id`,
 * `expiresAt`), for example to tell a person that a review is gone after the process was evicted. A store must hand back the very
 * same object it was given (the core guards against a double commit by object identity). It decides nothing about time: the queue
 * checks the deadline on every access.
 */
export interface PendingStore {
  put(pending: PendingIssuance): void;
  get(id: string): PendingIssuance | undefined;
  /** Every item the store holds, expired or not, in any order. */
  list(): PendingIssuance[];
  delete(id: string): void;
}

/** The default store: a map in this process. */
export class MemoryPendingStore implements PendingStore {
  readonly #items = new Map<string, PendingIssuance>();

  put(pending: PendingIssuance): void {
    this.#items.set(pending.id, pending);
  }

  get(id: string): PendingIssuance | undefined {
    return this.#items.get(id);
  }

  list(): PendingIssuance[] {
    return [...this.#items.values()];
  }

  delete(id: string): void {
    this.#items.delete(id);
  }
}

export interface IssuanceQueueOptions {
  store?: PendingStore;
  /** The clock every deadline is checked against (default: the system clock). */
  now?: () => Date;
}

/**
 * Issued values that are not confirmed yet. Memory only, at most until `expiresAt`.
 *
 * The deadline is checked on every access (`get`, `list`, `claim`): an expired item is treated as absent and its value is dropped
 * from memory right there, whether or not a sweep ran. Nothing here depends on a timer. What a read cannot do is the network call
 * that deletes the new value at the provider; that is owed and is done by the next `sweep`, which an embedder calls from a timer
 * or an alarm (`Runtime.sweep`) and which a new issuance and a confirm run first anyway.
 */
export class IssuanceQueue {
  readonly #store: PendingStore;
  readonly #now: () => Date;
  /** Items an operation (confirm or reject) is working on: no second operation may start on them, and the sweep leaves them alone. */
  readonly #claimed = new Set<string>();
  /** Items whose deadline passed and whose value is already dropped; deleting the new value at the provider is still owed. */
  readonly #owed: PendingIssuance[] = [];

  constructor(options: IssuanceQueueOptions = {}) {
    this.#store = options.store ?? new MemoryPendingStore();
    this.#now = options.now ?? (() => new Date());
  }

  #expired(p: PendingIssuance, at: number): boolean {
    return Date.parse(p.expiresAt) <= at;
  }

  /** Takes an expired item out of the store and drops its value. Whether the provider-side delete is still owed is up to the caller. */
  #retire(p: PendingIssuance, owed: boolean): void {
    this.#store.delete(p.id);
    // The value must not outlive its deadline, whoever still holds the object: nothing reads it again (commit refuses an expired item).
    p.value = new SecretValue("");
    for (const c of p.companions) c.value = new SecretValue("");
    if (owed) this.#owed.push(p);
  }

  /** The item when it is there and not expired. An expired, unclaimed item is retired; a claimed one is hidden and left to its operation. */
  #live(id: string): PendingIssuance | undefined {
    const p = this.#store.get(id);
    if (!p) return undefined;
    if (!this.#expired(p, this.#now().getTime())) return p;
    if (!this.#claimed.has(id)) this.#retire(p, true);
    return undefined;
  }

  /**
   * Claims an item for one operation, synchronously: true for the first caller, false for an unknown or expired item or one that is
   * already claimed. Call `release` when the operation ends or is refused before its point of no return.
   */
  claim(id: string): boolean {
    if (this.#claimed.has(id) || !this.#live(id)) return false;
    this.#claimed.add(id);
    return true;
  }

  release(id: string): void {
    this.#claimed.delete(id);
  }

  add(pending: PendingIssuance): void {
    this.#store.put(pending);
  }

  get(id: string): PendingIssuance | undefined {
    return this.#live(id);
  }

  list(): PendingIssuance[] {
    const at = this.#now().getTime();
    const live: PendingIssuance[] = [];
    for (const p of this.#store.list()) {
      if (!this.#expired(p, at)) live.push(p);
      else if (!this.#claimed.has(p.id)) this.#retire(p, true);
    }
    return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): void {
    this.#store.delete(id);
  }

  /**
   * Retires everything that expired and deletes the new values at the provider. Returns the ids. An item that is claimed (or was
   * replaced) in the meantime is left to its operation.
   */
  async sweep(deps: IssuanceDeps, now: Date = this.#now()): Promise<string[]> {
    const swept: string[] = [];
    // Items an earlier read retired: their value is gone already, the provider-side delete is what remains.
    for (const p of this.#owed.splice(0)) {
      swept.push(p.id);
      await discardIssuance(p, deps, { by: "system", why: "expired" }).catch(() => undefined);
    }
    const expired = this.#store
      .list()
      .filter((p) => this.#expired(p, now.getTime()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const p of expired) {
      // Each discard is awaited: an item that was claimed (or replaced) in the meantime is left to its operation.
      if (this.#claimed.has(p.id) || this.#store.get(p.id) !== p) continue;
      this.#retire(p, false);
      swept.push(p.id);
      await discardIssuance(p, deps, { by: "system", why: "expired" }).catch(() => undefined);
    }
    return swept;
  }

  /** The earliest deadline among the items that wait for a person (an item an operation has claimed is not counted), or null. */
  nextDeadline(): Date | null {
    let next: number | null = null;
    for (const p of this.#store.list()) {
      if (this.#claimed.has(p.id)) continue;
      const at = Date.parse(p.expiresAt);
      if (next === null || at < next) next = at;
    }
    return next === null ? null : new Date(next);
  }
}
