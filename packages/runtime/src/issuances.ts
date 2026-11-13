import { discardIssuance, type IssuanceDeps, type PendingIssuance } from "@secret-desk/core";

/**
 * Ausgestellte, noch nicht bestaetigte Werte. Nur im Arbeitsspeicher. Abgelaufene werden beim naechsten Zugriff
 * (und vom Portal im Takt) verworfen: Der neue Wert wird dann beim Anbieter wieder geloescht.
 */
export class IssuanceQueue {
  readonly #items = new Map<string, PendingIssuance>();
  /** Items an operation (confirm or reject) is working on: no second operation may start on them, and the sweep leaves them alone. */
  readonly #claimed = new Set<string>();

  /**
   * Claims an item for one operation, synchronously: true for the first caller, false for an unknown item or one that is
   * already claimed. Call `release` when the operation ends or is refused before its point of no return.
   */
  claim(id: string): boolean {
    if (!this.#items.has(id) || this.#claimed.has(id)) return false;
    this.#claimed.add(id);
    return true;
  }

  release(id: string): void {
    this.#claimed.delete(id);
  }

  add(pending: PendingIssuance): void {
    this.#items.set(pending.id, pending);
  }

  get(id: string): PendingIssuance | undefined {
    return this.#items.get(id);
  }

  list(): PendingIssuance[] {
    return [...this.#items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): void {
    this.#items.delete(id);
  }

  /** Verwirft alles, was abgelaufen ist. Liefert die ids. */
  async sweep(deps: IssuanceDeps, now: Date = new Date()): Promise<string[]> {
    const expired = this.list().filter((p) => Date.parse(p.expiresAt) <= now.getTime());
    const swept: string[] = [];
    for (const p of expired) {
      // Each discard is awaited: an item that was claimed (or replaced) in the meantime is left to its operation.
      if (this.#claimed.has(p.id) || this.#items.get(p.id) !== p) continue;
      this.delete(p.id);
      swept.push(p.id);
      await discardIssuance(p, deps, { by: "system", why: "expired" }).catch(() => undefined);
    }
    return swept;
  }
}
