import { secretApprovalSnapshot, variableApprovalSnapshot, type ActorRef, type ApprovalSnapshot, type InventoryStoreCore } from "@secret-desk/core/portable";

/** stale = der Eintrag hat sich seit der Anfrage geaendert, die Freigabe wurde verworfen. */
export type ApprovalState = "pending" | "approved" | "denied" | "failed" | "stale";
export type ApprovalAction = "issue" | "apply-variable";

export interface Approval {
  id: string;
  action: ApprovalAction;
  /** Id des Secrets (issue) oder der Variable (apply-variable). */
  targetId: string;
  requestedBy: string;
  /** Who asked, as a reference (name and kind, plus an opaque principal id when there is one). `requestedBy` stays for compatibility. */
  requestedByRef: ActorRef;
  reason: string | null;
  createdAt: string;
  state: ApprovalState;
  /**
   * Der Inhalt, den der Mensch freigibt (Ziele, Sollwert, Stage ...), und ein Hash darueber. Beim Freigeben wird der Hash
   * neu berechnet: Hat jemand den Eintrag seit der Anfrage geaendert, wird die Freigabe verworfen.
   */
  snapshotHash: string;
  snapshot: ApprovalSnapshot["view"];
  /** Kurztext nach der Ausfuehrung, nie ein Wert. */
  result?: string;
  /** Who approved or denied (name, kind and an opaque principal id when there is one). Set when an actor resolves the request, never a value. */
  decidedBy?: ActorRef;
  decidedAt?: string;
}

/**
 * Anfragen, die ein Mensch freigeben muss (zum Beispiel ein neuer Wert in staging oder production durch einen Agenten).
 * Nur im Arbeitsspeicher: Nach einem Neustart sind offene Anfragen weg und werden neu gestellt.
 */
export class ApprovalQueue {
  readonly #items = new Map<string, Approval>();
  /** Anfragen, die gerade abgearbeitet werden: ein zweites approve/deny darf nicht noch einmal arbeiten. */
  readonly #busy = new Set<string>();
  readonly #now: () => Date;

  /** `now` is the clock that stamps `createdAt` and `decidedAt` (default: the system clock). The runtime passes its own, so every time in a runtime comes from one clock. */
  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** Markiert eine offene Anfrage atomar als "in Bearbeitung". false, wenn sie nicht offen oder schon in Bearbeitung ist. */
  begin(id: string): boolean {
    const item = this.#items.get(id);
    if (!item || item.state !== "pending" || this.#busy.has(id)) return false;
    this.#busy.add(id);
    return true;
  }

  /**
   * Called after the inventory file changed from outside (CLI, script, team sync): every open request whose entry no longer
   * has the content that was requested becomes stale right away, not only when somebody tries to approve it.
   * Returns the ids that were made stale.
   */
  revalidate(inventory: InventoryStoreCore): string[] {
    const stale: string[] = [];
    for (const a of this.#items.values()) {
      if (a.state !== "pending" || this.#busy.has(a.id)) continue;
      const target = a.action === "issue" ? inventory.getSecret(a.targetId) : inventory.getVariable(a.targetId);
      const hash = !target ? null : a.action === "issue" ? secretApprovalSnapshot(target as never).hash : variableApprovalSnapshot(target as never).hash;
      if (hash === a.snapshotHash) continue;
      a.state = "stale";
      a.result = "Der Eintrag hat sich seit der Anfrage geaendert, Freigabe verworfen.";
      stale.push(a.id);
    }
    return stale;
  }

  create(input: { action: ApprovalAction; targetId: string; requestedBy: string; requestedByRef?: ActorRef; reason?: string | null; now?: Date; snapshot: ApprovalSnapshot }): Approval {
    const open = [...this.#items.values()].find((a) => a.action === input.action && a.targetId === input.targetId && a.state === "pending");
    if (open) {
      if (open.snapshotHash === input.snapshot.hash) return open;
      // Anderer Inhalt als bei der offenen Anfrage: die alte kann nicht mehr freigegeben werden.
      open.state = "stale";
      open.result = "Der Eintrag hat sich seit der Anfrage geaendert, Freigabe verworfen.";
    }
    const approval: Approval = {
      id: globalThis.crypto.randomUUID(),
      action: input.action,
      targetId: input.targetId,
      requestedBy: input.requestedBy,
      // Without a reference the request came from the agent interface, the only caller that is asked for approval.
      requestedByRef: input.requestedByRef ? { ...input.requestedByRef } : { name: input.requestedBy, kind: "agent" },
      reason: input.reason ?? null,
      createdAt: (input.now ?? this.#now()).toISOString(),
      state: "pending",
      snapshotHash: input.snapshot.hash,
      snapshot: input.snapshot.view,
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

  resolve(id: string, state: Exclude<ApprovalState, "pending">, result?: string, decidedBy?: ActorRef): Approval {
    const item = this.#items.get(id);
    if (!item) throw new Error(`Anfrage nicht gefunden: ${id}`);
    if (item.state !== "pending") throw new Error(`Anfrage ist schon erledigt: ${item.state}`);
    this.#busy.delete(id);
    item.state = state;
    if (result) item.result = result;
    if (decidedBy) {
      item.decidedBy = { ...decidedBy };
      item.decidedAt = this.#now().toISOString();
    }
    return item;
  }
}
