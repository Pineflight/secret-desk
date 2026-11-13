import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryStore, InventoryStoreCore } from "../src/inventory.js";
import { InventoryConflictError, InventoryError } from "../src/inventory-errors.js";
import { MemoryInventoryBackend, type InventoryBackend, type InventoryRevision, type InventorySnapshot, type InventoryTransaction } from "../src/inventory-backend.js";
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

  it.each([
    ["a number (browsers, workers)", 7],
    ["null", null],
    ["an object without unref", {}],
  ])("watch works when the timer is %s: it does not call unref", (_name, timer) => {
    const spy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(timer as never);
    try {
      const backend = new WatchableBackend(INVENTORY_YAML);
      const stop = InventoryStore.withBackend(backend).watch({ debounceMs: 5 });
      expect(() => backend.hint!()).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("watch calls unref on a timer that has one, so a pending reload does not keep Node alive", () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockReturnValue({ unref } as never);
    try {
      const backend = new WatchableBackend(INVENTORY_YAML);
      const stop = InventoryStore.withBackend(backend).watch({ debounceMs: 5 });
      backend.hint!();
      expect(unref).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("InventoryStoreCore without the Node facade", () => {
  it("fromText is a pure memory store: it reads, changes and has no path; save does nothing", async () => {
    const store = InventoryStoreCore.fromText(INVENTORY_YAML);
    expect(store.path).toBeNull();
    store.patchSecret("lead-token-dev", { notes: "mine" });
    expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
    await store.save();
    expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
  });

  it("withBackend works on the memory backend: read, rebase on an external change, save", async () => {
    const backend = new MemoryInventoryBackend(INVENTORY_YAML);
    const store = InventoryStoreCore.withBackend(backend);
    expect(store.path).toBe("memory://inventory");
    store.patchSecret("lead-token-dev", { notes: "mine" });
    backend.replaceExternally(INVENTORY_YAML.replace("old-token-id", "new-token-id"));
    await store.save();
    expect(backend.text).toContain("notes: mine");
    expect(backend.text).toContain("new-token-id");
  });

  it("withBackend starts unwritten with initial text and refuses an empty backend without it", async () => {
    const backend = new MemoryInventoryBackend();
    expect(() => InventoryStoreCore.withBackend(backend)).toThrow(new InventoryError("Inventory cannot be read from memory://inventory"));
    await InventoryStoreCore.withBackend(backend, INVENTORY_YAML).save();
    expect(backend.text).toContain("lead-token-dev");
  });

  it("the Node facade builds the subclass and keeps the core API", () => {
    expect(InventoryStore.withBackend(new MemoryInventoryBackend(INVENTORY_YAML))).toBeInstanceOf(InventoryStore);
    expect(InventoryStore.fromText(INVENTORY_YAML)).toBeInstanceOf(InventoryStoreCore);
  });
});

describe("MemoryInventoryBackend", () => {
  it("starts empty without initial text: no stamp, nothing to read, a default label", () => {
    const backend = new MemoryInventoryBackend();
    expect(backend.label).toBe("memory://inventory");
    expect(backend.stamp()).toBeNull();
    expect(backend.read()).toBeNull();
    expect(backend.text).toBeNull();
  });

  it("starts with initial text at revision 1 and a custom label", () => {
    const backend = new MemoryInventoryBackend("a: 1\n", "memory://custom");
    expect(backend.label).toBe("memory://custom");
    expect(backend.stamp()).toBe("1");
    expect(backend.read()).toEqual({ text: "a: 1\n", revision: "1" });
    expect(backend.text).toBe("a: 1\n");
  });

  it("writes only when the expected revision is the stored one", async () => {
    const empty = new MemoryInventoryBackend();
    const results = await empty.withWriteLock(async (tx) => [
      await tx.write("a: 1\n", "5"),
      await tx.write("a: 1\n", null),
      await tx.write("a: 2\n", null),
      await tx.write("a: 3\n", "1"),
      await tx.write("a: 4\n", "1"),
    ]);
    expect(results).toEqual([{ written: false }, { written: true, revision: "1", stamp: "1" }, { written: false }, { written: true, revision: "2", stamp: "2" }, { written: false }]);
    expect(empty.text).toBe("a: 3\n");
  });

  it("an external replacement changes the revision and calls the registered hints until they stop", () => {
    const backend = new MemoryInventoryBackend("a: 1\n");
    let hints = 0;
    const stop = backend.watch(() => { hints += 1; });
    backend.replaceExternally("a: 2\n");
    expect(hints).toBe(1);
    expect(backend.read()).toEqual({ text: "a: 2\n", revision: "2" });
    stop();
    backend.replaceExternally("a: 3\n");
    expect(hints).toBe(1);
    expect(backend.stamp()).toBe("3");
  });

  it("runs writers one after the other and keeps going after a failed writer", async () => {
    const backend = new MemoryInventoryBackend("a: 1\n");
    const order: string[] = [];
    const first = backend.withWriteLock(async () => {
      order.push("first start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("first end");
      throw new Error("boom");
    });
    const second = backend.withWriteLock(async () => {
      order.push("second");
      return 42;
    });
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe(42);
    expect(order).toEqual(["first start", "first end", "second"]);
  });
});
