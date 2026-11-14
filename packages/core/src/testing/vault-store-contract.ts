import { Vault, type KeySource, type VaultDocument, type VaultEntry, type VaultStore } from "../vault-core.js";
import { contractTest, withMade, type Cleanup, type ContractFramework, type ContractOptions } from "./framework.js";

/**
 * Behaviour every `VaultStore` must show: a missing document is an empty vault, a written document comes back
 * unchanged, writes replace the whole document, stored and returned values are copies, and a `Vault` works on top of
 * it. This module is portable: no Node built-ins, no `Buffer`, no file system.
 */

/** One empty store under test. Must not share state with stores made for other tests (or for the same test). */
export interface VaultStoreHarness extends Cleanup {
  store: VaultStore;
}

/** Builds a fresh, empty store. Called more than once in the isolation test: every call must give an independent store. */
export type MakeVaultStore = () => Promise<VaultStoreHarness> | VaultStoreHarness;

/** An obviously fake key; the suite never needs a real one. */
const FAKE_KEY = new Uint8Array(32).fill(7);
const keySource: KeySource = { label: "contract-test-key", key: async () => FAKE_KEY };

/** All 256 byte values as Base64: covers `+`, `/` and `=`, so a store that mangles Base64 text shows up. */
function allBytesBase64(): string {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const entry = (over: Partial<VaultEntry> = {}): VaultEntry => ({ iv: "aXY=", tag: "dGFn", ct: "Y3Q=", savedAt: "2026-03-01T10:00:00.000Z", fingerprint: "0123456789ab", ...over });
const doc = (entries: Record<string, VaultEntry>): VaultDocument => ({ version: 1, entries });

/** Registers the vault store contract as `describe("vault store contract: <name>")`. */
export function vaultStoreContract(framework: ContractFramework, name: string, make: MakeVaultStore, options: ContractOptions = {}): void {
  const { expect } = framework;

  const test = (title: string, body: (store: VaultStore) => Promise<void>): void => {
    contractTest(framework, options, title, () => withMade(make, ({ store }) => body(store)));
  };

  framework.describe(`vault store contract: ${name}`, () => {
    test("has a label and reads a store that was never written as an empty vault", async (store) => {
      expect(typeof store.label).toBe("string");
      expect(store.label.length).toBeGreaterThan(0);
      expect(await store.read()).toEqual({ version: 1, entries: {} });
    });

    test("reads back what was written", async (store) => {
      const written = doc({ "acme-app": entry(), "acme-app-staging": entry({ ct: "b3RoZXI=", expires: "2027-01-21" }) });
      await store.write(written);
      expect(await store.read()).toEqual(written);
      expect(await store.read()).toEqual(written);
    });

    test("keeps the difference between no expiry, never expires and a date", async (store) => {
      await store.write(doc({ unspecified: entry(), never: entry({ expires: null }), dated: entry({ expires: "2027-01-21" }) }));
      const read = await store.read();
      expect(read.entries["unspecified"]).not.toHaveProperty("expires");
      expect(read.entries["never"]!.expires).toBeNull();
      expect(read.entries["dated"]!.expires).toBe("2027-01-21");
    });

    test("a write replaces the whole document", async (store) => {
      await store.write(doc({ first: entry(), second: entry() }));
      await store.write(doc({ third: entry({ ct: "bmV3" }) }));
      expect(Object.keys((await store.read()).entries)).toEqual(["third"]);
      await store.write(doc({}));
      expect(await store.read()).toEqual({ version: 1, entries: {} });
    });

    test("is binary safe: Base64 of every byte value, and unusual ids, come back exactly", async (store) => {
      const all = allBytesBase64();
      const ids = ["über-key", "a/b", "dot.dot", "with space", "emoji-\u{1F511}"];
      const entries: Record<string, VaultEntry> = {};
      for (const id of ids) entries[id] = entry({ iv: all, tag: all, ct: all + all });
      await store.write(doc(entries));
      const read = await store.read();
      expect(Object.keys(read.entries).sort()).toEqual([...ids].sort());
      for (const id of ids) {
        expect(read.entries[id]!.iv).toBe(all);
        expect(read.entries[id]!.tag).toBe(all);
        expect(read.entries[id]!.ct).toBe(all + all);
      }
    });

    test("stored state cannot be changed through the written or the returned document", async (store) => {
      const written = doc({ a: entry() });
      await store.write(written);
      written.entries["a"]!.ct = "changed-after-write";
      written.entries["b"] = entry();
      const read = await store.read();
      expect(read.entries["a"]!.ct).toBe("Y3Q=");
      expect(Object.keys(read.entries)).toEqual(["a"]);
      read.entries["a"]!.ct = "changed-after-read";
      delete read.entries["a"];
      expect((await store.read()).entries["a"]!.ct).toBe("Y3Q=");
    });

    test("serves the latest write to every read, one after the other", async (store) => {
      for (let i = 1; i <= 5; i++) {
        const entries: Record<string, VaultEntry> = {};
        for (let n = 0; n < i; n++) entries[`id-${n}`] = entry({ ct: btoa(`value-${n}`) });
        await store.write(doc(entries));
        expect(Object.keys((await store.read()).entries)).toHaveLength(i);
      }
    });

    contractTest(framework, options, "two stores from the factory do not see each other", () =>
      withMade(make, ({ store: one }) => withMade(make, async ({ store: other }) => {
        await one.write(doc({ only: entry() }));
        expect(await other.read()).toEqual({ version: 1, entries: {} });
        await other.write(doc({ elsewhere: entry() }));
        expect(Object.keys((await one.read()).entries)).toEqual(["only"]);
        expect(Object.keys((await other.read()).entries)).toEqual(["elsewhere"]);
      })),
    );

    test("a Vault on top of it stores, lists, reads back and deletes values", async (store) => {
      const vault = new Vault({ store, keySource });
      expect(await vault.list()).toEqual([]);
      expect(await vault.get("acme-app")).toBeNull();
      await vault.set("acme-app", "example-value-ünï-\u{1F511}", "2027-01-21", new Date("2026-03-01T10:00:00Z"));
      await vault.set("acme-app-staging", "other-example-value");
      expect(await vault.has("acme-app")).toBe(true);
      expect((await vault.get("acme-app"))!.reveal()).toBe("example-value-ünï-\u{1F511}");
      expect((await vault.get("acme-app-staging"))!.reveal()).toBe("other-example-value");
      const info = (await vault.info("acme-app"))!;
      expect(info.savedAt).toBe("2026-03-01T10:00:00.000Z");
      expect(info.expires).toBe("2027-01-21");
      expect((await vault.list()).map((i) => i.id).sort()).toEqual(["acme-app", "acme-app-staging"]);
      await vault.set("acme-app", "replaced-example-value");
      expect((await vault.get("acme-app"))!.reveal()).toBe("replaced-example-value");
      await vault.delete("acme-app");
      expect(await vault.has("acme-app")).toBe(false);
      expect((await vault.get("acme-app-staging"))!.reveal()).toBe("other-example-value");
    });

    test("the stored document holds no plain text of a value", async (store) => {
      await new Vault({ store, keySource }).set("acme-app", "plain-example-value");
      expect(JSON.stringify(await store.read())).not.toContain("plain-example-value");
    });
  });
}
