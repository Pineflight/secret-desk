import { discardIssuance, type IssuanceDeps, type PendingIssuance } from "@secret-desk/core";

/**
 * Ausgestellte, noch nicht bestaetigte Werte. Nur im Arbeitsspeicher. Abgelaufene werden beim naechsten Zugriff
 * (und vom Portal im Takt) verworfen: Der neue Wert wird dann beim Anbieter wieder geloescht.
 */
export class IssuanceQueue {
  readonly #items = new Map<string, PendingIssuance>();

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
    for (const p of expired) {
      this.delete(p.id);
      await discardIssuance(p, deps, { by: "system", why: "expired" }).catch(() => undefined);
    }
    return expired.map((p) => p.id);
  }
}
