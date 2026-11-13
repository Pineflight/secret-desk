import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryStore } from "../src/inventory.js";
import { InventoryConflictError } from "../src/inventory-errors.js";
import { MemoryInventoryBackend, type InventoryBackend } from "../src/inventory-backend.js";
import { FileInventoryBackend } from "../src/inventory-file-backend.js";
import { INVENTORY_YAML } from "./fixtures.js";

// One suite, two backends. Everything that must hold for any backend is here; what only one of them can do (lock file,
// file modes, directory watch) stays in inventory-file-backend.test.ts and inventory-sync.test.ts.

interface Harness {
  store: InventoryStore;
  /** What the backend runs: lock holders entered, the most at the same time, and successful writes. */
  stats: { locks: number; active: number; maxActive: number; writes: number };
  /** Another writer replaces the stored text. */
  writeExternally(text: string): Promise<void>;
  /** The text that is stored right now; null = nothing stored yet. */
  stored(): Promise<string | null>;
}

interface Adapter {
  /** `stored: false` = the store starts with unwritten initial text and nothing exists in the backend yet. */
  make(text: string, options: { stored: boolean }): Promise<Harness>;
}

/** Wraps `withWriteLock` so the test can see how many writers ran and how many at once. */
function trackStats(backend: InventoryBackend): Harness["stats"] {
  const stats = { locks: 0, active: 0, maxActive: 0, writes: 0 };
  const original = backend.withWriteLock.bind(backend);
  backend.withWriteLock = <T>(fn: Parameters<InventoryBackend["withWriteLock"]>[0]): Promise<T> => {
    stats.locks += 1;
    return original<T>(async (tx) => {
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        return (await fn({
          read: () => tx.read(),
          write: async (text, expected) => {
            const result = await tx.write(text, expected);
            if (result.written) stats.writes += 1;
            return result;
          },
        })) as T;
      } finally {
        stats.active -= 1;
      }
    });
  };
  return stats;
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const fileAdapter: Adapter = {
  async make(text, { stored }) {
    const dir = await mkdtemp(join(tmpdir(), "sd-inv-contract-"));
    dirs.push(dir);
    const file = join(dir, "inventory.yaml");
    if (stored) await writeFile(file, text, { mode: 0o600 });
    const backend = new FileInventoryBackend(file);
    const stats = trackStats(backend);
    let externalWrites = 0;
    return {
      store: stored ? InventoryStore.withBackend(backend) : InventoryStore.withBackend(backend, text),
      stats,
      // A same-length replacement keeps size and inode, so the stat stamp would depend on the file system's mtime
      // resolution. Each external write therefore gets its own, clearly different mtime.
      writeExternally: async (next) => {
        await writeFile(file, next);
        externalWrites += 1;
        const stamp = new Date(Date.UTC(2001, 0, 1) + externalWrites * 60_000);
        await utimes(file, stamp, stamp);
      },
      stored: () => readFile(file, "utf8").catch(() => null),
    };
  },
};

const memoryAdapter: Adapter = {
  async make(text, { stored }) {
    const backend = new MemoryInventoryBackend(stored ? text : undefined);
    const stats = trackStats(backend);
    return {
      store: stored ? InventoryStore.withBackend(backend) : InventoryStore.withBackend(backend, text),
      stats,
      writeExternally: async (next) => backend.replaceExternally(next),
      stored: async () => backend.text,
    };
  },
};

const adapters: Array<[string, Adapter]> = [
  ["FileInventoryBackend", fileAdapter],
  ["MemoryInventoryBackend", memoryAdapter],
];

const load = (adapter: Adapter, text = INVENTORY_YAML): Promise<Harness> => adapter.make(text, { stored: true });

/** Moves the clock the store sees (only Date is faked), so refresh gating and the grace period pass without waiting. */
const advance = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms);
};

const withExternalId = (id: string): string => INVENTORY_YAML.replace("old-token-id", id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(adapters)("inventory store contract: %s", (_name, adapter) => {
  it("loads the stored document and reads it", async () => {
    const { store } = await load(adapter);
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("old-token-id");
    expect(store.data.secrets).toHaveLength(3);
    expect(store.problem).toBeNull();
    expect(store.path).not.toBeNull();
  });

  it("saves a change: the stored text follows and the version counts the change once", async () => {
    const { store, stored } = await load(adapter);
    const before = store.version;
    store.patchSecret("lead-token-dev", { notes: "mine" });
    expect(store.version).toBe(before + 1);
    expect(await stored()).toBe(INVENTORY_YAML);
    await store.save();
    expect(await stored()).toBe(store.toString());
    expect(await stored()).toContain("notes: mine");
    expect(store.version).toBe(before + 1);
    expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
  });

  it("detects an external change on the next read and tells the listeners", async () => {
    const { store, writeExternally } = await load(adapter);
    let calls = 0;
    store.onExternalChange(() => { calls += 1; });
    const before = store.version;
    await writeExternally(withExternalId("new-token-id"));
    advance(2000);
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
    expect(store.version).toBeGreaterThan(before);
    expect(calls).toBe(1);
  });

  it("keeps both an unsaved change and an external change (rebase)", async () => {
    const { store, writeExternally, stored } = await load(adapter);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    await writeExternally(withExternalId("new-token-id"));
    await store.save();
    const text = (await stored())!;
    expect(text).toContain("externalId: new-token-id");
    expect(text).toContain("notes: mine");
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
    expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
  });

  it("reports a conflict when an unsaved full replacement meets an external change, and follows the stored text", async () => {
    const { store, writeExternally, stored, stats } = await load(adapter);
    store.replaceData({ ...store.data, thresholds: [60, 30] });
    await writeExternally(withExternalId("new-token-id"));
    const err = await store.save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InventoryConflictError);
    expect((err as Error).message).toBe("Die Inventar-Datei wurde von einem anderen Prozess geaendert und deine Aenderung passt nicht mehr dazu (diese Aenderung ersetzt den ganzen Inhalt). Nichts ueberschrieben, bitte neu laden und erneut versuchen.");
    expect(stats.writes).toBe(0);
    expect(await stored()).toBe(withExternalId("new-token-id"));
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
    expect(store.data.thresholds).toEqual([30, 14, 7]);
  });

  it("keeps the old data while the stored document is invalid, reports it after the grace period and recovers", async () => {
    const { store, writeExternally } = await load(adapter);
    await writeExternally("not: [valid");
    expect(store.data.secrets).toHaveLength(3);
    const first = store.problem;
    expect(first).not.toBeNull();
    expect(first!.persistent).toBe(false);
    expect(first!.message).toMatch(/^Die Inventar-Datei auf der Platte ist ungueltig: Inventar ist kein gueltiges YAML: /);
    advance(3100);
    expect(store.data.secrets).toHaveLength(3);
    expect(store.problem!.persistent).toBe(true);
    expect(store.problem!.since).toBe(first!.since);
    await writeExternally(withExternalId("recovered-token-id"));
    advance(300);
    expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("recovered-token-id");
    expect(store.problem).toBeNull();
  });

  it("serialises two concurrent saves", async () => {
    const { store, stored, stats } = await load(adapter);
    store.patchSecret("lead-token-dev", { notes: "first" });
    const a = store.save();
    store.patchSecret("cf-deploy-acme-app", { notes: "second" });
    const b = store.save();
    await Promise.all([a, b]);
    expect(stats.locks).toBe(2);
    expect(stats.maxActive).toBe(1);
    const text = (await stored())!;
    expect(text).toContain("notes: first");
    expect(text).toContain("notes: second");
    expect(store.toString()).toBe(text);
  });

  it("keeps comments and the order of entries through a save", async () => {
    const { store, stored } = await load(adapter);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    await store.save();
    const text = (await stored())!;
    expect(text.startsWith("# Kommentar bleibt erhalten\n")).toBe(true);
    expect(text.indexOf("cf-deploy-acme-app")).toBeLessThan(text.indexOf("stripe-webhook-acme-docs-staging"));
    expect(text.indexOf("stripe-webhook-acme-docs-staging")).toBeLessThan(text.indexOf("lead-token-dev"));
    // Apart from the new line, the document is what the YAML library prints for the untouched input.
    const untouched = (await load(adapter)).store.toString();
    expect(text.replace(/ {4}notes: mine\n/, "")).toBe(untouched);
  });

  it("writes unwritten initial text on the first save and only then", async () => {
    const { store, stored, stats } = await adapter.make(INVENTORY_YAML, { stored: false });
    expect(await stored()).toBeNull();
    expect(store.getSecret("lead-token-dev")).toBeDefined();
    await store.save();
    expect(await stored()).toBe(store.toString());
    expect(await stored()).toContain("# Kommentar bleibt erhalten");
    expect(stats.writes).toBe(1);
    await store.save();
    expect(stats.writes).toBe(1);
  });

  it("writes nothing when there is nothing to save", async () => {
    const { store, stored, stats } = await load(adapter);
    await store.save();
    expect(stats.writes).toBe(0);
    expect(await stored()).toBe(INVENTORY_YAML);
  });
});
