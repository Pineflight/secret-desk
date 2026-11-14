import { discardIssuance, issuanceStateOf, revokeIssuedValue, SecretValue, type Check, type IssuanceDeps, type PendingIssuance } from "@secret-desk/core";

/*
 * The rule behind everything that revokes in this file: revoking a value that is in use is worse than leaving an unconfirmed value
 * valid until the provider expires it. When in doubt nothing is revoked, the record is kept and the case is reported.
 */

/**
 * What a `PendingStore` is given about a pending review: metadata only. Never the value, never a companion value, never the
 * report. `externalId` is the provider's identifier of the newly issued value and is present only when that value would have to
 * be deleted at the provider if the review is not confirmed (it is absent when the provider renewed the value in place).
 * `needsDecision` is set when a commit wrote the new value to some places and stopped: only a person decides about that value.
 */
export interface PendingRecord {
  id: string;
  secretId: string;
  /** The provider of the entry when the value was issued. A revoke is refused when the entry has another provider now. */
  provider: string;
  createdAt: string;
  expiresAt: string;
  externalId?: string;
  needsDecision?: true;
}

/**
 * Where the records of pending reviews are kept. The default is `MemoryPendingStore`; an embedder may supply its own through
 * `RuntimeOptions.pendingStore` (for example one that survives an eviction of its process).
 *
 * The store only ever sees a `PendingRecord`: the value itself is held by the queue, in memory, in a map the store cannot reach.
 * "A store never persists the value" is therefore true by construction, and a store may return copies of its records. A record
 * whose value is gone (see `IssuanceQueue.orphans`) is never revoked by a sweep: revoking it is an explicit call of the embedder
 * (`IssuanceQueue.revokeOrphan`), which refuses whenever the value might be in use. A persistent store should remove the record
 * in the same step in which the embedder's inventory takes the new identifier; whatever order remains, a leftover record is harmless.
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
 * the queue takes the review back: the value becomes unreachable through the queue, the operation's abort signal fires, and a
 * commit checks that bound (the signal and the clock) before each write. A write that is already in flight is not cut off.
 */
export const CLAIM_GRACE_MS = 2 * 60_000;
/** How often the sweep tries to delete a new value at the provider before it stops trying (the record is kept). */
export const MAX_REVOKE_TRIES = 5;
/** The wait before the next try of a delete that failed, times the number of tries so far. */
export const REVOKE_RETRY_MS = 60_000;

const recordOf = (p: PendingIssuance): PendingRecord => {
  const rotatedInPlace = p.report.externalId !== undefined && p.report.externalId === p.oldExternalId;
  return {
    id: p.id,
    secretId: p.secretId,
    provider: p.issuedSecret?.provider ?? p.report.provider,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    ...(p.report.externalId && !rotatedInPlace ? { externalId: p.report.externalId } : {}),
  };
};

/** The outcome of an attempt to delete the new value of a record at the provider. A refusal says why nothing was called. */
export type OrphanResult =
  | { status: "revoked" }
  | { status: "nothing" }
  | { status: "failed" }
  | { status: "refused"; reason: "value-in-use" | "secret-gone" | "provider-changed" | "needs-decision" | "held-here" | "unknown" };

/**
 * Deletes the new value of a record at the provider, from metadata alone, and only when that cannot hit a value in use. Refused
 * without calling the provider when the record's identifier is the one the entry holds now (the value was rolled out), when the
 * entry no longer exists, when its provider is not the one the value was issued by, and (unless `acceptPartial`) when a commit
 * had written the value to some places. `nothing`: the record names no value to delete.
 */
export async function revokeOrphanRecord(record: PendingRecord, deps: IssuanceDeps, options: { acceptPartial?: boolean } = {}): Promise<OrphanResult> {
  if (!record.externalId) return { status: "nothing" };
  const secret = deps.inventory.getSecret(record.secretId);
  if (!secret) return { status: "refused", reason: "secret-gone" };
  if (secret.provider !== record.provider) return { status: "refused", reason: "provider-changed" };
  if (secret.externalId === record.externalId) return { status: "refused", reason: "value-in-use" };
  if (record.needsDecision && !options.acceptPartial) return { status: "refused", reason: "needs-decision" };
  return (await revokeIssuedValue(secret, record.externalId, deps)) ? { status: "revoked" } : { status: "failed" };
}

/** Adds a line to the evidence report of a record, when there is one. Never throws: a note is best effort. */
async function noteEvidence(deps: IssuanceDeps, record: PendingRecord, check: Check): Promise<void> {
  try {
    const report = await deps.evidence?.get(record.secretId, record.id);
    if (!report) return;
    report.checks.push(check);
    await deps.evidence!.save(report);
  } catch {
    /* best effort */
  }
}

export interface IssuanceQueueOptions {
  store?: PendingStore;
  /** The clock every deadline is checked against (default: the system clock). The queue never decides with a time earlier than one it has seen. */
  now?: () => Date;
  /** Told (a record, never a value) when the sweep stopped trying to delete a new value at the provider. The record stays. */
  onRevokeAbandoned?: (record: PendingRecord) => void;
}

/** A delete at the provider that is still owed. `pending` is the retired item (value-free) until the first try has been made. */
interface Owed {
  record: PendingRecord;
  pending: PendingIssuance | undefined;
  tries: number;
  nextTry: number;
}

/**
 * Issued values that are not confirmed yet. Memory only, at most until `expiresAt`.
 *
 * The deadline is checked on every access (`get`, `list`, `claim`): an expired review is treated as absent and its value is
 * unreachable through the queue from then on, whether or not a sweep ran. Nothing here depends on a timer. (Strings cannot be
 * erased in this runtime: what is dropped is every reference the queue holds. A caller that kept the object keeps its value.)
 * What a read cannot do is the network call that deletes the new value at the provider: that is owed and is done by the next
 * `sweep`, which an embedder calls from a timer or an alarm (`Runtime.sweep`).
 *
 * A claim is bounded too: a review claimed by an operation is hidden and left to it, but only until its deadline plus
 * `CLAIM_GRACE_MS`. Then the queue takes it back and aborts the operation's signal.
 *
 * The sweep only deletes what this process itself retired and knows to be unconfirmed. It does not touch an item a commit is
 * working on, and it never deletes a value a commit has written to a place (that value waits for a person's decision).
 */
export class IssuanceQueue {
  readonly #store: PendingStore;
  readonly #now: () => Date;
  readonly #onAbandoned: ((record: PendingRecord) => void) | undefined;
  /** The latest time this queue has seen. */
  #seen = 0;
  /** The values, by id. Private to the queue: a store never sees them. */
  readonly #values = new Map<string, PendingIssuance>();
  /** Items an operation (confirm or reject) is working on, with a signal that fires when the queue takes the item back. */
  readonly #claims = new Map<string, { controller: AbortController }>();
  /** Deletes at the provider that are owed, with their number of tries and the time of the next one. */
  readonly #owed = new Map<string, Owed>();
  /** Records a sweep is working on right now. */
  readonly #settling = new Set<string>();

  constructor(options: IssuanceQueueOptions = {}) {
    this.#store = options.store ?? new MemoryPendingStore();
    this.#now = options.now ?? (() => new Date());
    this.#onAbandoned = options.onRevokeAbandoned;
  }

  /** The time to decide with: the given one or the clock, but never earlier than a time seen before. */
  #t(given?: number): number {
    this.#seen = Math.max(given ?? this.#now().getTime(), this.#seen);
    return this.#seen;
  }

  #expired(p: PendingIssuance, at: number): boolean {
    return Date.parse(p.expiresAt) <= at;
  }

  /** The hard bound of a claimed item (epoch milliseconds). */
  #bound(p: PendingIssuance): number {
    return Date.parse(p.expiresAt) + CLAIM_GRACE_MS;
  }

  /** Takes an item out of the queue: its value is unreachable through it from here on. The provider-side delete is owed. */
  #retire(p: PendingIssuance): void {
    this.#values.delete(p.id);
    // The references the queue and the report hold are replaced too; a caller's own reference to the object is its own.
    p.value = new SecretValue("");
    for (const c of p.companions) c.value = new SecretValue("");
    this.#owed.set(p.id, { record: recordOf(p), pending: p, tries: 0, nextTry: 0 });
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
    return p && this.#look(p, this.#t()) ? p : undefined;
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

  /** The hard bound of a held review (epoch milliseconds), for the operation to check against the clock before it writes. */
  hardBound(id: string): number | undefined {
    const p = this.#values.get(id);
    return p ? this.#bound(p) : undefined;
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
    const at = this.#t();
    return [...this.#values.values()].filter((p) => this.#look(p, at)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Forgets a review for good (confirmed, or rejected by a person): the value, the record and anything still owed for it. */
  delete(id: string): void {
    this.#values.delete(id);
    this.#owed.delete(id);
    this.#store.delete(id);
  }

  /**
   * A person rejected a review and the provider did not confirm the delete: put it on the list of deletes that are tried again
   * (same spacing and limit as an expired review). The record stays in the store until the delete worked.
   */
  oweIfNeeded(pending: PendingIssuance, revokedNew: boolean): void {
    const record = recordOf(pending);
    if (revokedNew || !record.externalId) return;
    this.#store.put(record);
    this.#owed.set(pending.id, { record, pending: undefined, tries: 1, nextTry: this.#t() + REVOKE_RETRY_MS });
  }

  /**
   * Records the store holds whose value this queue does not have and that nothing here is trying to delete: left by a process
   * that was evicted, by a confirm whose record removal was lost, by a commit that needs a person's decision (`needsDecision`),
   * or by a delete the sweep gave up on. The sweep only lists them; `revokeOrphan` is the explicit call.
   */
  orphans(): PendingRecord[] {
    return this.#store.list().filter((r) => !this.#values.has(r.id) && !this.#owed.has(r.id));
  }

  /**
   * The explicit call to delete the new value of an orphaned record at the provider, for the embedder (or a person) to make.
   * Nothing is called when the delete could hit a value in use (see `revokeOrphanRecord`); a record that is plainly stale (the
   * value is in use, the entry is gone or has another provider) is removed without calling the provider. A record that needs
   * a person's decision stays unless `acceptPartial` says the person decided. A failed delete keeps the record.
   */
  async revokeOrphan(id: string, deps: IssuanceDeps, options: { acceptPartial?: boolean } = {}): Promise<OrphanResult> {
    const record = this.#store.get(id);
    if (!record) return { status: "refused", reason: "unknown" };
    if (this.#values.has(id) || this.#owed.has(id)) return { status: "refused", reason: "held-here" };
    const result = await revokeOrphanRecord(record, deps, options);
    if (result.status === "refused" && result.reason !== "needs-decision") {
      this.#store.delete(id);
      await noteEvidence(deps, record, { id: "orphan-dropped", label: `Verwaister Eintrag verworfen, nichts widerrufen: ${result.reason}`, status: "warn" });
    } else if (result.status === "revoked" || result.status === "nothing") {
      this.#store.delete(id);
      if (result.status === "revoked") await noteEvidence(deps, record, { id: "orphan-revoked", label: "Neuer Wert beim Anbieter widerrufen (verwaister Eintrag)", status: "pass" });
    }
    return result;
  }

  /**
   * Retires everything that expired (and every claim past its hard bound) and tries the deletes at the provider that are owed
   * and due. Returns the ids that are settled: nothing is left to delete, or it was deleted, or a commit had rolled the value
   * out and nothing may delete it. An id whose provider call failed is not in the list: the record stays and it is tried
   * again after a longer wait, at most `MAX_REVOKE_TRIES` times in all (then `onRevokeAbandoned` is told and the record stays
   * as an orphan). An item a commit is working on, or has written to a place, is not deleted. An item that is claimed within its
   * bound is left to its operation.
   */
  async sweep(deps: IssuanceDeps, now?: Date): Promise<string[]> {
    const at = this.#t(now?.getTime());
    const swept: string[] = [];
    const expired = [...this.#values.values()].filter((p) => this.#expired(p, at)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const p of expired) this.#look(p, at);
    for (const [id, owed] of [...this.#owed]) {
      if (owed.nextTry <= at && this.#owed.get(id) === owed) await this.#settle(id, owed, deps, at, swept);
    }
    return swept;
  }

  async #settle(id: string, owed: Owed, deps: IssuanceDeps, at: number, swept: string[]): Promise<void> {
    // Another sweep is already on this record.
    if (this.#settling.has(id)) return;
    this.#settling.add(id);
    const done = (): void => {
      this.#owed.delete(id);
      this.#store.delete(id);
      swept.push(id);
    };
    try {
      const state = owed.pending ? issuanceStateOf(owed.pending) : "open";
      if (state === "committing") {
        // A commit is working on it: whatever it ends in decides, so nothing is done now.
        owed.nextTry = at + REVOKE_RETRY_MS;
        return;
      }
      if (state === "partial") {
        // The new value is in use at some places: only a person decides. Kept, flagged, never revoked here.
        this.#owed.delete(id);
        this.#store.put({ ...owed.record, needsDecision: true });
        return;
      }
      if (state === "committed" || state === "discarded") return done();

      let result: OrphanResult;
      if (owed.pending) {
        // The first try goes through the item itself: it also writes the evidence note. Anything but a clean answer is a failed try.
        const discard = await discardIssuance(owed.pending, deps, { by: "system", why: "expired" }).catch(() => undefined);
        owed.pending = undefined;
        result = discard === undefined ? { status: "failed" } : !owed.record.externalId ? { status: "nothing" } : { status: discard.revokedNew ? "revoked" : "failed" };
      } else {
        result = await revokeOrphanRecord(owed.record, deps).catch(() => ({ status: "failed" }) as OrphanResult);
      }
      if (result.status !== "failed") {
        if (owed.tries > 0 && result.status === "revoked") await noteEvidence(deps, owed.record, { id: "revoke-late", label: "Neuer Wert beim Anbieter widerrufen (spaeterer Versuch)", status: "pass" });
        return done();
      }
      owed.tries += 1;
      if (owed.tries >= MAX_REVOKE_TRIES) {
        // Stopped, not settled: the record stays in the store and shows up as an orphan.
        this.#owed.delete(id);
        await noteEvidence(deps, owed.record, { id: "revoke-abandoned", label: "Neuer Wert beim Anbieter NICHT widerrufen: der Anbieter hat die Loeschung wiederholt nicht bestaetigt", status: "warn", detail: "Von Hand beim Anbieter loeschen oder verfallen lassen." });
        try {
          this.#onAbandoned?.(owed.record);
        } catch {
          /* a callback that throws changes nothing */
        }
        return;
      }
      owed.nextTry = at + REVOKE_RETRY_MS * owed.tries;
    } finally {
      this.#settling.delete(id);
    }
  }

  /**
   * The earliest time something needs a sweep, or null: the deadline of an item that waits for a person, the hard bound of a
   * claimed item, and the next try of every delete that is still owed.
   */
  nextDeadline(): Date | null {
    let next: number | null = null;
    const take = (t: number): void => {
      if (next === null || t < next) next = t;
    };
    for (const p of this.#values.values()) take(this.#claims.has(p.id) ? this.#bound(p) : Date.parse(p.expiresAt));
    for (const o of this.#owed.values()) take(o.nextTry);
    return next === null ? null : new Date(next);
  }
}
