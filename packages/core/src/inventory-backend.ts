/**
 * Where the inventory text lives. The store (`InventoryStore`) keeps all logic (refresh gating, rebase, retries); a
 * backend only provides the I/O primitives. This module is portable: no Node built-ins.
 */

/** Opaque version of the stored text. The file backend uses the sha256 hex of the text; another backend may use a row version. */
export type InventoryRevision = string;

export interface InventorySnapshot {
  text: string;
  revision: InventoryRevision;
}

/** The read side: synchronous, because the store answers synchronous getters from it. */
export interface InventorySource {
  /** Where the text lives, for display and diagnostics (the file path for the file backend). */
  readonly label: string;
  /** Cheap change stamp, compared by string equality; null = not available (for example the file does not exist). Never throws. */
  stamp(): string | null;
  /** Synchronous full read; null = not readable right now. */
  read(): InventorySnapshot | null;
}

export type InventoryWriteResult = { written: true; revision: InventoryRevision; stamp: string | null } | { written: false };

/** Handed to the callback of `withWriteLock`: reads and writes while the lock is held. */
export interface InventoryTransaction {
  read(): InventorySnapshot | null;
  /**
   * Writes the text only if the stored revision still equals `expected` (null = nothing stored yet); otherwise reports a
   * mismatch so the caller can rebase and retry.
   */
  write(text: string, expected: InventoryRevision | null): Promise<InventoryWriteResult>;
}

export interface InventoryBackend extends InventorySource {
  /** Runs `fn` as the only writer. Rejects with an error that explains the conflict if the lock cannot be obtained. */
  withWriteLock<T>(fn: (tx: InventoryTransaction) => Promise<T>): Promise<T>;
  /**
   * Optional: calls `hint` when the stored document may have changed (only a hint: it may fire too often or be missed).
   * Debouncing is up to the caller. Returns a stop function.
   */
  watch?(hint: () => void): () => void;
}

/**
 * The inventory text in memory: one document and a counter as revision. Models a hosted store with one row and optimistic
 * versioning: `withWriteLock` runs one writer at a time and `write` checks the expected revision. Another writer is
 * simulated with `replaceExternally`.
 */
export class MemoryInventoryBackend implements InventoryBackend {
  readonly label: string;
  #text: string | null;
  #counter = 0;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #hints = new Set<() => void>();

  /** Without `initial` nothing is stored yet (the first write expects `null`). */
  constructor(initial?: string, label = "memory://inventory") {
    this.label = label;
    this.#text = initial ?? null;
    if (initial !== undefined) this.#counter = 1;
  }

  /** The stored text, or null if nothing is stored (for tests and hosts). */
  get text(): string | null {
    return this.#text;
  }

  stamp(): string | null {
    return this.#text === null ? null : String(this.#counter);
  }

  read(): InventorySnapshot | null {
    return this.#text === null ? null : { text: this.#text, revision: String(this.#counter) };
  }

  /** Another writer replaces the stored text: the revision changes and the registered hints are called. */
  replaceExternally(text: string): void {
    this.#text = text;
    this.#counter += 1;
    for (const hint of [...this.#hints]) hint();
  }

  watch(hint: () => void): () => void {
    this.#hints.add(hint);
    return () => {
      this.#hints.delete(hint);
    };
  }

  withWriteLock<T>(fn: (tx: InventoryTransaction) => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => fn({
      read: () => this.read(),
      write: async (text, expected) => {
        const current = this.read();
        if ((current === null ? null : current.revision) !== expected) return { written: false };
        this.#text = text;
        this.#counter += 1;
        return { written: true, revision: String(this.#counter), stamp: this.stamp() };
      },
    }));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
