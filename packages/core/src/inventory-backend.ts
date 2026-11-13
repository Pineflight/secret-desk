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
