import { discardIssuance, revokeIssuedValue, SecretValue, type IssuanceDeps, type PendingIssuance } from "@secret-desk/core";

/**
 * What a `PendingStore` is given about a pending review: metadata only. Never the value, never a companion value, never the
 * report. `externalId` is the provider's identifier of the newly issued value and is present only when that value would have to
 * be deleted at the provider if the review is not confirmed (it is absent when the provider renewed the value in place).
 */
export interface PendingRecord {
  id: string;
  secretId: string;
  createdAt: string;
  expiresAt: string;
  externalId?: string;
}

/**
 * Where the records of pending reviews are kept. The default is `MemoryPendingStore`; an embedder may supply its own through
 * `RuntimeOptions.pendingStore` (for example one that survives an eviction of its process).
 *
 * The store only ever sees a `PendingRecord`: the value itself is held by the queue, in memory, in a map the store cannot reach.
 * "A store never persists the value" is therefore true by construction, and a store may return copies of its records. What a
 * persistent store buys is the way back from an eviction: a record whose value is gone (see `IssuanceQueue.orphans`) is deleted
 * at the provider by the next `Runtime.sweep` once its deadline has passed, or by `revokeOrphan`.
 */
export interface PendingStore {
  put(record: PendingRecord): void;
  get(id: string): PendingRecord | undefined;
  /** Every record the store holds. */
  list(): PendingRecord[];
  delete(id: string): void;
}

/** The default store: a map in this process. */
export class MemoryPendingStore implements PendingStore {
  readonly #items = new Map<string, PendingRecord>();

  put(record: PendingRecord): void {
    this.#items.set(record.id, { ...record });
  }

  get(id: string): PendingRecord | undefined {
    const record = this.#items.get(id);
    return record ? { ...record } : undefined;
  }

  list(): PendingRecord[] {
    return [...this.#items.values()].map((r) => ({ ...r }));
  }

  delete(id: string): void {
    this.#items.delete(id);
  }
}

/**
 * How long a review that an operation (confirm or reject) has claimed may outlive its deadline. After deadline plus this grace
 * the queue takes the review back whatever the operation is doing: the value becomes unreachable through the queue, the
 * operation's abort signal fires, and a commit that comes back later writes nothing more.
 */
export const CLAIM_GRACE_MS = 2 * 60_000;
/** How often the sweep tries to delete a new value at the provider before it gives the record up. */
export const MAX_REVOKE_TRIES = 5;
/** What `nextDeadline` reports for a record whose delete at the provider is still owed and past its deadline: look again after this. */
export const REVOKE_RETRY_MS = 60_000;

const recordOf = (p: PendingIssuance): PendingRecord => {
  const rotatedInPlace = p.report.externalId !== undefined && p.report.externalId === p.oldExternalId;
  return { id: p.id, secretId: p.secretId, createdAt: p.createdAt, expiresAt: p.expiresAt, ...(p.report.externalId && !rotatedInPlace ? { externalId: p.report.externalId } : {}) };
};

/**
 * Deletes the new value of a record whose value is gone (an evicted process) at the provider. Metadata is all it needs: the entry
 * is looked up by `secretId` in the current inventory. True when there was nothing to delete or the provider confirmed the delete;
 * false when it failed (the value stays valid at the provider and a later call may try again).
 */
export async function revokeOrphan(record: PendingRecord, deps: IssuanceDeps): Promise<boolean> {
  if (!record.externalId) return true;
  const secret = deps.inventory.getSecret(record.secretId);
  return secret ? revokeIssuedValue(secret, record.externalId, deps) : false;
}

export interface IssuanceQueueOptions {
  store?: PendingStore;
  /** The clock every deadline is checked against (default: the system clock). */
  now?: () => Date;
}

/**
 * Issued values that are not confirmed yet. Memory only, at most until `expiresAt`.
 *
 * The deadline is checked on every access (`get`, `list`, `claim`): an expired review is treated as absent and its value is
 * unreachable through the queue from then on, whether or not a sweep ran. Nothing here depends on a timer. (Strings cannot be
 * erased in this runtime: what is dropped is every reference the queue holds. A caller that kept the object keeps its value.)
 * What a read cannot do is the network call that deletes the new value at the provider: that is owed and is done by the next
 * `sweep`, which an embedder calls from a timer or an alarm (`Runtime.sweep`) and which a new issuance and a confirm run first.
 *
 * A claim is bounded too: a review claimed by an operation is hidden and left to it, but only until its deadline plus
 * `CLAIM_GRACE_MS`. Then the queue retires it whatever the operation is doing and aborts the operation's signal.
 */
export class IssuanceQueue {
  readonly #store: PendingStore;
  readonly #now: () => Date;
  /** The values, by id. Private to the queue: a store never sees them. */
  readonly #values = new Map<string, PendingIssuance>();
  /** Items an operation (confirm or reject) is working on, with a signal that fires when the queue takes the item back. */
  readonly #claims = new Map<string, { controller: AbortController }>();
  /** Items whose deadline passed and whose value is unreachable; the provider-side delete (and the evidence note) is still owed. */
  readonly #retired = new Map<string, PendingIssuance>();
  /** Failed provider-side deletes, by id. */
  readonly #tries = new Map<string, number>();
  /** Records a sweep is working on right now. */
  readonly #settling = new Set<string>();

  constructor(options: IssuanceQueueOptions = {}) {
    this.#store = options.store ?? new MemoryPendingStore();
    this.#now = options.now ?? (() => new Date());
  }

  #expired(p: PendingIssuance, at: number): boolean {
    return Date.parse(p.expiresAt) <= at;
  }

  /** The hard bound of a claimed item. */
  #bound(p: PendingIssuance): number {
    return Date.parse(p.expiresAt) + CLAIM_GRACE_MS;
  }

  /** Takes an item out of the queue: its value is unreachable through it from here on. The provider-side delete stays owed. */
  #retire(p: PendingIssuance): void {
    this.#values.delete(p.id);
    // The references the queue and the report hold are replaced too; a caller's own reference to the object is its own.
    p.value = new SecretValue("");
    for (const c of p.companions) c.value = new SecretValue("");
    this.#retired.set(p.id, p);
  }

  /**
   * Looks at one item at time `at` and acts; true when it is live. An expired item is retired, except while an operation holds it
   * and its hard bound has not passed (it is hidden then). Past the bound the claim is broken: the operation's signal fires and
   * the item is retired.
   */
  #look(p: PendingIssuance, at: number): boolean {
    if (!this.#expired(p, at)) return true;
    const claim = this.#claims.get(p.id);
    if (claim && at < this.#bound(p)) return false;
    if (claim) {
      this.#claims.delete(p.id);
      claim.controller.abort();
    }
    this.#retire(p);
    return false;
  }

  #live(id: string): PendingIssuance | undefined {
    const p = this.#values.get(id);
    return p && this.#look(p, this.#now().getTime()) ? p : undefined;
  }

  /**
   * Claims an item for one operation, synchronously: true for the first caller, false for an unknown or expired item or one that is
   * already claimed. Call `release` when the operation ends or is refused before its point of no return.
   */
  claim(id: string): boolean {
    // The look comes first: it may break a claim that is past its hard bound.
    if (!this.#live(id) || this.#claims.has(id)) return false;
    this.#claims.set(id, { controller: new AbortController() });
    return true;
  }

  /** The signal of a claim: it fires when the queue takes the item back past its hard bound. An operation passes it on to what it starts. */
  signal(id: string): AbortSignal | undefined {
    return this.#claims.get(id)?.controller.signal;
  }

  release(id: string): void {
    this.#claims.delete(id);
  }

  add(pending: PendingIssuance): void {
    this.#values.set(pending.id, pending);
    this.#store.put(recordOf(pending));
  }

  get(id: string): PendingIssuance | undefined {
    return this.#live(id);
  }

  list(): PendingIssuance[] {
    const at = this.#now().getTime();
    return [...this.#values.values()].filter((p) => this.#look(p, at)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): void {
    this.#values.delete(id);
    this.#store.delete(id);
  }

  /** Records the store holds whose value this queue no longer has (retired here, or left by a process that was evicted). */
  orphans(): PendingRecord[] {
    return this.#store.list().filter((r) => !this.#values.has(r.id));
  }

  /**
   * Retires everything that expired (and every claim past its hard bound) and deletes the new values at the provider. Returns the
   * ids that are settled: the value is unreachable and the provider confirmed the delete or had nothing to delete. An id whose
   * provider call failed is not in the list; its record stays and the next sweeps try again, at most `MAX_REVOKE_TRIES` times in
   * all. An item that is claimed within its bound (or was replaced in the meantime) is left to its operation.
   */
  async sweep(deps: IssuanceDeps, now: Date = this.#now()): Promise<string[]> {
    const at = now.getTime();
    const swept: string[] = [];
    const owed = [...this.#retired.values()];
    const expired = [...this.#values.values()].filter((p) => this.#expired(p, at)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const orphans = this.orphans().filter((r) => !this.#retired.has(r.id) && Date.parse(r.expiresAt) <= at);
    // Items an earlier read retired come first, then what expires now, then the records nobody holds a value for.
    for (const p of owed) await this.#settle(p.id, p, deps, swept);
    for (const p of expired) {
      // Each step is awaited: an item that was claimed (or replaced) in the meantime is left to its operation.
      if (this.#values.get(p.id) !== p) continue;
      this.#look(p, at);
      if (this.#retired.get(p.id) === p) await this.#settle(p.id, p, deps, swept);
    }
    for (const r of orphans) await this.#settle(r.id, undefined, deps, swept);
    return swept;
  }

  async #settle(id: string, pending: PendingIssuance | undefined, deps: IssuanceDeps, swept: string[]): Promise<void> {
    // Another sweep is already on this record.
    if (this.#settling.has(id)) return;
    this.#settling.add(id);
    try {
      const record = this.#store.get(id) ?? (pending ? recordOf(pending) : undefined);
      if (!record) return;
      let revoked: boolean;
      if (pending && this.#retired.get(id) === pending) {
        this.#retired.delete(id);
        // discardIssuance also writes the evidence note. A throw means it must not (or could not) revoke: nothing to retry then.
        const result = await discardIssuance(pending, deps, { by: "system", why: "expired" }).catch(() => undefined);
        revoked = result === undefined || !record.externalId || result.revokedNew;
      } else {
        revoked = await revokeOrphan(record, deps).catch(() => false);
      }
      if (revoked) {
        this.#store.delete(id);
        this.#tries.delete(id);
        swept.push(id);
        return;
      }
      const tries = (this.#tries.get(id) ?? 0) + 1;
      if (tries >= MAX_REVOKE_TRIES) {
        // Given up: the evidence says "not revoked", the record would only keep failing.
        this.#store.delete(id);
        this.#tries.delete(id);
      } else {
        this.#tries.set(id, tries);
      }
    } finally {
      this.#settling.delete(id);
    }
  }

  /**
   * The earliest time something needs a sweep, or null: the deadline of an item that waits for a person, the hard bound of a
   * claimed item, and for an owed provider-side delete the deadline of its record or, once that has passed, a retry after
   * `REVOKE_RETRY_MS`.
   */
  nextDeadline(now: Date = this.#now()): Date | null {
    let next: number | null = null;
    const take = (t: number): void => {
      if (next === null || t < next) next = t;
    };
    for (const p of this.#values.values()) take(this.#claims.has(p.id) ? this.#bound(p) : Date.parse(p.expiresAt));
    for (const r of this.orphans()) {
      const at = Date.parse(r.expiresAt);
      take(r.externalId && at <= now.getTime() ? now.getTime() + REVOKE_RETRY_MS : at);
    }
    return next === null ? null : new Date(next);
  }
}
