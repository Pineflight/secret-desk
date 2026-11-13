import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryStore } from "../src/inventory.js";
import { InventoryConflictError, InventoryError } from "../src/inventory-errors.js";
import type { InventoryBackend, InventoryRevision, InventorySnapshot, InventoryTransaction } from "../src/inventory-backend.js";
import { INVENTORY_YAML } from "./fixtures.js";

afterEach(() => vi.useRealTimers());

/** A backend that keeps one text and a counter as revision. No file system involved. */
class FakeBackend implements InventoryBackend {
  readonly label = "fake://workspace";
  text: string | null;
  version = 0;
  /** Number of upcoming writes that another writer beats: it changes the secret's notes first, then the write reports a mismatch. */
  interfere = 0;
  expectedSeen: (InventoryRevision | null)[] = [];
  hint: (() => void) | null = null;
  stopped = 0;
  private external = 0;

  constructor(text: string | null) {
    this.text = text;
  }

  stamp(): string | null {
    return this.text === null ? null : `v${this.version}`;
  }

  read(): InventorySnapshot | null {
    return this.text === null ? null : { text: this.text, revision: `r${this.version}` };
  }

  /** Another writer replaces the stored text. */
  replaceText(text: string): void {
    this.text = text;
    this.version += 1;
  }

  withWriteLock<T>(fn: (tx: InventoryTransaction) => Promise<T>): Promise<T> {
    return fn({
      read: () => this.read(),
      write: async (text, expected) => {
        this.expectedSeen.push(expected);
        if (this.interfere > 0) {
          this.interfere -= 1;
          this.external += 1;
          this.replaceText(INVENTORY_YAML.replace("old-token-id", `external-${this.external}`));
          return { written: false };
        }
        const current = this.read();
        if (current !== null && current.revision !== expected) return { written: false };
        this.replaceText(text);
        return { written: true, revision: `r${this.version}`, stamp: this.stamp() };
      },
    });
  }
}

class WatchableBackend extends FakeBackend {
  watch(hint: () => void): () => void {
    this.hint = hint;
    return () => {
      this.stopped += 1;
    };
  }
}

describe("InventoryStore on an explicit backend", () => {
  it("reads the stored document when no initial text is given and exposes the label as path", () => {
    const backend = new FakeBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    expect(store.path).toBe("fake://workspace");
    expect(store.getSecret("lead-token-dev")).toBeDefined();
  });

  it("refuses a backend that has nothing readable and no initial text", () => {
    expect(() => InventoryStore.withBackend(new FakeBackend(null))).toThrow(new InventoryError("Inventory cannot be read from fake://workspace"));
  });

  it("starts unwritten with initial text: the first save writes it, expecting nothing stored", async () => {
    const backend = new FakeBackend(null);
    const store = InventoryStore.withBackend(backend, INVENTORY_YAML);
    expect(store.getSecret("lead-token-dev")).toBeDefined();
    await store.save();
    expect(backend.expectedSeen).toEqual([null]);
    expect(backend.text).toBe(store.toString());
    expect(backend.text).toContain("lead-token-dev");
    // Written now: another save without changes does nothing.
    await store.save();
    expect(backend.expectedSeen).toHaveLength(1);
  });

  it("detects an external change through stamp() and read(), bumps the version and tells the listeners", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const backend = new FakeBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    let calls = 0;
    store.onExternalChange(() => { calls += 1; });
    const before = store.version;
    // Same stamp: nothing is read again within the rehash window.
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("old-token-id");
    expect(calls).toBe(0);
    backend.replaceText(INVENTORY_YAML.replace("old-token-id", "new-token-id"));
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
    expect(store.version).toBeGreaterThan(before);
    expect(calls).toBe(1);
  });

  it("an unchanged revision under a new stamp is not a change", () => {
    const backend = new FakeBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    const before = store.version;
    backend.version += 1;
    backend.read = () => ({ text: INVENTORY_YAML, revision: "r0" });
    expect(store.data.secrets).toHaveLength(3);
    expect(store.version).toBe(before);
  });

  it("a mismatch on write leads to rebase and retry: the other writer's change and ours both end up stored", async () => {
    const backend = new FakeBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    backend.interfere = 1;
    await store.save();
    expect(backend.expectedSeen).toEqual(["r0", "r1"]);
    expect(backend.text).toContain("external-1");
    expect(backend.text).toContain("notes: mine");
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("external-1");
    expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
  });

  it("six mismatches in a row end in an InventoryConflictError with the existing message and drop our change", async () => {
    const backend = new FakeBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    backend.interfere = 6;
    const err = await store.save().catch((e: Error) => e);
    expect(err).toBeInstanceOf(InventoryConflictError);
    expect((err as Error).message).toBe("Die Inventar-Datei wurde waehrend des Speicherns immer wieder von einem anderen Prozess geaendert. Nichts ueberschrieben, bitte neu laden und erneut versuchen.");
    expect(backend.expectedSeen).toHaveLength(6);
    expect(store.getSecret("lead-token-dev")!.notes).toBeUndefined();
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("external-6");
  });

  it("watch is a no-op for a backend without watch support", () => {
    const store = InventoryStore.withBackend(new FakeBackend(INVENTORY_YAML));
    expect(store.watch()()).toBeUndefined();
  });

  it("watch passes the hint on and reloads after the debounce; stopping stops the backend", async () => {
    const backend = new WatchableBackend(INVENTORY_YAML);
    const store = InventoryStore.withBackend(backend);
    let calls = 0;
    store.onExternalChange(() => { calls += 1; });
    const stop = store.watch({ debounceMs: 5 });
    backend.replaceText(INVENTORY_YAML.replace("old-token-id", "hinted-token-id"));
    backend.hint!();
    await vi.waitFor(() => expect(calls).toBe(1));
    stop();
    expect(backend.stopped).toBe(1);
  });
});
