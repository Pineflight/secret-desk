import type { InventoryBackend } from "../inventory-backend.js";
import { InventoryConflictError } from "../inventory-errors.js";
import { InventoryStoreCore } from "../inventory-store.js";
import { contractTest, withMade, type Cleanup, type ContractFramework, type ContractOptions } from "./framework.js";
import { INVENTORY_CONTRACT_YAML } from "./inventory-fixture.js";

/**
 * Behaviour every `InventoryBackend` must show when `InventoryStoreCore` runs on it. Everything that only one backend
 * can do (a lock file, file modes, a directory watch) is not part of the contract. This module is portable: no Node
 * built-ins, no `Buffer`, no file system.
 */

/** One backend under test plus the two things the suite needs from outside the backend interface. */
export interface InventoryBackendHarness extends Cleanup {
  backend: InventoryBackend;
  /**
   * Another writer replaces the stored text. The backend must see a changed revision and a changed stamp afterwards
   * (a file backend whose stamp is size and mtime has to make the change visible there, for example by setting a clearly
   * different mtime).
   */
  writeExternally(text: string): Promise<void> | void;
  /** The text that is stored right now; null = nothing stored yet. */
  stored(): Promise<string | null> | string | null;
}

/**
 * Builds a fresh backend for one test. `initial` is the text that is already stored; `null` = nothing stored yet. Must
 * not share state with backends made for other tests.
 */
export type MakeInventoryBackend = (initial: string | null) => Promise<InventoryBackendHarness> | InventoryBackendHarness;

/** What the backend ran: lock holders entered, the most at the same time, and successful writes. */
interface Stats {
  locks: number;
  active: number;
  maxActive: number;
  writes: number;
}

/** Wraps `withWriteLock` so a test can see how many writers ran and how many at once. */
function trackStats(backend: InventoryBackend): Stats {
  const stats: Stats = { locks: 0, active: 0, maxActive: 0, writes: 0 };
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

const withExternalId = (id: string): string => INVENTORY_CONTRACT_YAML.replace("old-token-id", id);

/**
 * Registers the inventory backend contract as `describe("inventory store contract: <name>")`.
 * The store only reads the clock through `Date.now()`; the suite freezes `Date.now` for the length of each test and
 * moves it forward by hand, so refresh gating and the grace period pass without waiting.
 */
export function inventoryBackendContract(framework: ContractFramework, name: string, make: MakeInventoryBackend, options: ContractOptions = {}): void {
  const { expect } = framework;

  /** Builds the harness and the store, freezes the clock, and runs `body`; cleanup and clock restore always happen. */
  const scenario = (title: string, initial: string | null, body: (ctx: { store: InventoryStoreCore; harness: InventoryBackendHarness; stats: Stats; advance: (ms: number) => void }) => Promise<void>, storeInitial?: string): void => {
    contractTest(framework, options, title, () =>
      withMade(
        async () => {
          const harness = await make(initial);
          return { harness, stats: trackStats(harness.backend), cleanup: () => harness.cleanup?.() };
        },
        async ({ harness, stats }) => {
          const realNow = Date.now;
          let now = realNow.call(Date);
          Date.now = () => now;
          try {
            const store = storeInitial === undefined ? InventoryStoreCore.withBackend(harness.backend) : InventoryStoreCore.withBackend(harness.backend, storeInitial);
            await body({ store, harness, stats, advance: (ms) => void (now += ms) });
          } finally {
            Date.now = realNow;
          }
        },
      ),
    );
  };
  const loaded = (title: string, body: Parameters<typeof scenario>[2]): void => scenario(title, INVENTORY_CONTRACT_YAML, body);

  framework.describe(`inventory store contract: ${name}`, () => {
    loaded("loads the stored document and reads it", async ({ store }) => {
      expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("old-token-id");
      expect(store.data.secrets).toHaveLength(3);
      expect(store.problem).toBeNull();
      expect(store.path).not.toBeNull();
    });

    loaded("saves a change: the stored text follows and the version counts the change once", async ({ store, harness }) => {
      const before = store.version;
      store.patchSecret("lead-token-dev", { notes: "mine" });
      expect(store.version).toBe(before + 1);
      expect(await harness.stored()).toBe(INVENTORY_CONTRACT_YAML);
      await store.save();
      expect(await harness.stored()).toBe(store.toString());
      expect(await harness.stored()).toContain("notes: mine");
      expect(store.version).toBe(before + 1);
      expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
    });

    loaded("detects an external change on the next read and tells the listeners", async ({ store, harness, advance }) => {
      let calls = 0;
      store.onExternalChange(() => {
        calls += 1;
      });
      const before = store.version;
      await harness.writeExternally(withExternalId("new-token-id"));
      advance(2000);
      expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
      expect(store.version).toBeGreaterThan(before);
      expect(calls).toBe(1);
    });

    loaded("keeps both an unsaved change and an external change (rebase)", async ({ store, harness }) => {
      store.patchSecret("lead-token-dev", { notes: "mine" });
      await harness.writeExternally(withExternalId("new-token-id"));
      await store.save();
      const text = (await harness.stored())!;
      expect(text).toContain("externalId: new-token-id");
      expect(text).toContain("notes: mine");
      expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
      expect(store.getSecret("lead-token-dev")!.notes).toBe("mine");
    });

    loaded("reports a conflict when an unsaved full replacement meets an external change, and follows the stored text", async ({ store, harness, stats }) => {
      store.replaceData({ ...store.data, thresholds: [60, 30] });
      await harness.writeExternally(withExternalId("new-token-id"));
      const err = await store.save().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InventoryConflictError);
      expect((err as Error).message).toBe("Die Inventar-Datei wurde von einem anderen Prozess geaendert und deine Aenderung passt nicht mehr dazu (diese Aenderung ersetzt den ganzen Inhalt). Nichts ueberschrieben, bitte neu laden und erneut versuchen.");
      expect(stats.writes).toBe(0);
      expect(await harness.stored()).toBe(withExternalId("new-token-id"));
      expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("new-token-id");
      expect(store.data.thresholds).toEqual([30, 14, 7]);
    });

    loaded("keeps the old data while the stored document is invalid, reports it after the grace period and recovers", async ({ store, harness, advance }) => {
      await harness.writeExternally("not: [valid");
      expect(store.data.secrets).toHaveLength(3);
      const first = store.problem;
      expect(first).not.toBeNull();
      expect(first!.persistent).toBe(false);
      expect(first!.message).toMatch(/^Die Inventar-Datei auf der Platte ist ungueltig: Inventar ist kein gueltiges YAML: /);
      advance(3100);
      expect(store.data.secrets).toHaveLength(3);
      expect(store.problem!.persistent).toBe(true);
      expect(store.problem!.since).toBe(first!.since);
      await harness.writeExternally(withExternalId("recovered-token-id"));
      advance(300);
      expect(store.getSecret("cf-deploy-acme-app")!.externalId).toBe("recovered-token-id");
      expect(store.problem).toBeNull();
    });

    loaded("serialises two concurrent saves", async ({ store, harness, stats }) => {
      store.patchSecret("lead-token-dev", { notes: "first" });
      const a = store.save();
      store.patchSecret("cf-deploy-acme-app", { notes: "second" });
      const b = store.save();
      await Promise.all([a, b]);
      expect(stats.locks).toBe(2);
      expect(stats.maxActive).toBe(1);
      const text = (await harness.stored())!;
      expect(text).toContain("notes: first");
      expect(text).toContain("notes: second");
      expect(store.toString()).toBe(text);
    });

    loaded("keeps comments and the order of entries through a save", async ({ store, harness }) => {
      store.patchSecret("lead-token-dev", { notes: "mine" });
      await store.save();
      const text = (await harness.stored())!;
      expect(text.startsWith("# Kommentar bleibt erhalten\n")).toBe(true);
      expect(text.indexOf("cf-deploy-acme-app")).toBeLessThan(text.indexOf("stripe-webhook-acme-docs-staging"));
      expect(text.indexOf("stripe-webhook-acme-docs-staging")).toBeLessThan(text.indexOf("lead-token-dev"));
      // Apart from the new line, the document is what the YAML library prints for the untouched input.
      const untouched = InventoryStoreCore.fromText(INVENTORY_CONTRACT_YAML).toString();
      expect(text.replace(/ {4}notes: mine\n/, "")).toBe(untouched);
    });

    scenario(
      "writes unwritten initial text on the first save and only then",
      null,
      async ({ store, harness, stats }) => {
        expect(await harness.stored()).toBeNull();
        expect(store.getSecret("lead-token-dev")).toBeDefined();
        await store.save();
        expect(await harness.stored()).toBe(store.toString());
        expect(await harness.stored()).toContain("# Kommentar bleibt erhalten");
        expect(stats.writes).toBe(1);
        await store.save();
        expect(stats.writes).toBe(1);
      },
      INVENTORY_CONTRACT_YAML,
    );

    loaded("refuses a write whose expected revision is not the stored one and keeps the stored text", async ({ harness, stats }) => {
      const snapshot = harness.backend.read()!;
      const refused = await harness.backend.withWriteLock(async (tx) => [await tx.write("version: 1\n", "not-the-stored-revision"), await tx.write("version: 1\n", null)]);
      expect(refused).toEqual([{ written: false }, { written: false }]);
      expect(stats.writes).toBe(0);
      expect(await harness.stored()).toBe(INVENTORY_CONTRACT_YAML);
      const accepted = await harness.backend.withWriteLock((tx) => tx.write("version: 1\n", snapshot.revision));
      expect(accepted.written).toBe(true);
      expect(stats.writes).toBe(1);
      expect(await harness.stored()).toBe("version: 1\n");
    });

    loaded("writes nothing when there is nothing to save", async ({ store, harness, stats }) => {
      await store.save();
      expect(stats.writes).toBe(0);
      expect(await harness.stored()).toBe(INVENTORY_CONTRACT_YAML);
    });
  });
}
