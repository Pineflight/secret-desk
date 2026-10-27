import { randomUUID } from "node:crypto";

export type ApprovalState = "pending" | "approved" | "denied" | "failed";

export interface Approval {
  id: string;
  secretId: string;
  action: "rotate";
  requestedBy: string;
  reason: string | null;
  createdAt: string;
  state: ApprovalState;
  /** Kurztext nach der Ausfuehrung, nie ein Wert. */
  result?: string;
}

/**
 * Anfragen, die ein Mensch freigeben muss (zum Beispiel Rotation in staging oder production durch einen Agenten).
 * Nur im Arbeitsspeicher: Nach einem Neustart sind offene Anfragen weg und werden neu gestellt.
 */
export class ApprovalQueue {
  readonly #items = new Map<string, Approval>();

  create(input: { secretId: string; requestedBy: string; reason?: string | null; now?: Date }): Approval {
    const open = [...this.#items.values()].find((a) => a.secretId === input.secretId && a.state === "pending");
    if (open) return open;
    const approval: Approval = {
      id: randomUUID(),
      secretId: input.secretId,
      action: "rotate",
      requestedBy: input.requestedBy,
      reason: input.reason ?? null,
      createdAt: (input.now ?? new Date()).toISOString(),
      state: "pending",
    };
    this.#items.set(approval.id, approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    return this.#items.get(id);
  }

  list(state?: ApprovalState): Approval[] {
    return [...this.#items.values()].filter((a) => !state || a.state === state).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolve(id: string, state: Exclude<ApprovalState, "pending">, result?: string): Approval {
    const item = this.#items.get(id);
    if (!item) throw new Error(`Anfrage nicht gefunden: ${id}`);
    if (item.state !== "pending") throw new Error(`Anfrage ist schon erledigt: ${item.state}`);
    item.state = state;
    if (result) item.result = result;
    return item;
  }
}
