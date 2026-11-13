import { readFile } from "node:fs/promises";
import { InventoryStoreCore } from "./inventory-store.js";
import type { InventoryBackend } from "./inventory-backend.js";
import { FileInventoryBackend, fileRevision } from "./inventory-file-backend.js";

// The store logic lives in `inventory-store.ts` (portable). This module is the Node facade: it adds `open` and builds the
// file backend. Everything that moved is re-exported, so imports of `inventory.js` keep working.
export { InventoryError, InventoryConflictError, PATCHABLE_SECRET_KEYS, InventoryStoreCore } from "./inventory-store.js";
export type { EntryEdit, InventoryProblem } from "./inventory-store.js";

export class InventoryStore extends InventoryStoreCore {
  static async open(path: string): Promise<InventoryStore> {
    const text = await readFile(path, "utf8");
    return new InventoryStore(new FileInventoryBackend(path), text, fileRevision(text));
  }

  static override fromText(text: string, path: string | null = null): InventoryStore {
    return new InventoryStore(path ? new FileInventoryBackend(path) : null, text, null);
  }

  static override withBackend(backend: InventoryBackend, initial?: string): InventoryStore {
    const start = InventoryStoreCore.startState(backend, initial);
    return new InventoryStore(backend, start.text, start.loaded);
  }
}
