import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretValue } from "../src/secret.js";
import { MemoryVaultStore, Vault, VaultUnavailableError, type KeySource, type VaultDocument, type VaultEntry } from "../src/vault-core.js";

const DECRYPT_MESSAGE = "Der Tresor-Eintrag laesst sich nicht entschluesseln (anderer Schluessel oder beschaedigt).";
const keySourceOf = (k: Uint8Array = randomBytes(32), counter?: { calls: number }): KeySource => ({
  label: "test-key",
  key: async () => {
    if (counter) counter.calls++;
    return k;
  },
});
const vaultOf = (store = new MemoryVaultStore(), k?: Uint8Array) => ({ store, vault: new Vault({ store, keySource: keySourceOf(k) }) });

/** The previous implementation (node:crypto), kept here to prove the stored format did not change. */
function legacyEncrypt(key: Buffer, id: string, plain: string): VaultEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), savedAt: "2026-01-01T00:00:00.000Z", fingerprint: createHash("sha256").update(plain).digest("hex").slice(0, 12) };
}

function legacyDecrypt(key: Buffer, id: string, e: VaultEntry): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAAD(Buffer.from(id));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8");
}

describe("Vault (portable core)", () => {
  it("compat: reads an entry written by the legacy node:crypto implementation", async () => {
    const key = randomBytes(32);
    const { store, vault } = vaultOf(undefined, key);
    const plain = "exämple-value-ünï-1";
    await store.write({ version: 1, entries: { "acme-app": legacyEncrypt(key, "acme-app", plain) } });
    expect((await vault.get("acme-app"))!.reveal()).toBe(plain);
  });

  it("compat: an entry written by Vault decrypts with node:crypto and has the legacy shape", async () => {
    const key = randomBytes(32);
    const { store, vault } = vaultOf(undefined, key);
    const plain = "example-value-two";
    await vault.set("acme-app", plain, "2027-01-01", new Date("2026-02-03T04:05:06Z"));
    const e = (await store.read()).entries["acme-app"]!;
    expect(legacyDecrypt(key, "acme-app", e)).toBe(plain);
    expect(Buffer.from(e.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(e.tag, "base64")).toHaveLength(16);
    expect(e.fingerprint).toBe(createHash("sha256").update(plain).digest("hex").slice(0, 12));
    expect(e).toMatchObject({ savedAt: "2026-02-03T04:05:06.000Z", expires: "2027-01-01" });
  });

  it("round-trips a SecretValue, lists metadata and handles expires variants", async () => {
    const { vault } = vaultOf();
    await vault.set("a", new SecretValue("value-a"));
    await vault.set("b", "value-b", null);
    expect((await vault.get("a"))!.reveal()).toBe("value-a");
    expect(vault.label).toBe("test-key");
    const list = await vault.list();
    expect(list.map((i) => i.id)).toEqual(["a", "b"]);
    expect(list[0]).not.toHaveProperty("expires");
    expect(list[1]).toMatchObject({ expires: null });
    expect(await vault.has("a")).toBe(true);
    expect(await vault.has("zzz")).toBe(false);
    expect(await vault.info("b")).toMatchObject({ id: "b" });
    expect(await vault.info("zzz")).toBeNull();
    expect(await vault.get("zzz")).toBeNull();
  });

  it("delete removes an entry and ignores unknown ids", async () => {
    const { store, vault } = vaultOf();
    await vault.set("a", "value-a");
    await vault.delete("a");
    await vault.delete("a");
    expect(Object.keys((await store.read()).entries)).toEqual([]);
  });

  it("wrong key, tampered tag and tampered id give the same error message", async () => {
    const key = randomBytes(32);
    const { store, vault } = vaultOf(undefined, key);
    await vault.set("a", "value-a");
    const doc = await store.read();
    const entry = doc.entries["a"]!;

    const wrongKey = new Vault({ store, keySource: keySourceOf() });
    await expect(wrongKey.get("a")).rejects.toThrow(new VaultUnavailableError(DECRYPT_MESSAGE));

    const flipped = Buffer.from(entry.tag, "base64");
    flipped[0] = flipped[0]! ^ 1;
    await store.write({ version: 1, entries: { a: { ...entry, tag: flipped.toString("base64") } } });
    await expect(vault.get("a")).rejects.toThrow(DECRYPT_MESSAGE);

    await store.write({ version: 1, entries: { other: entry } });
    await expect(vault.get("other")).rejects.toThrow(DECRYPT_MESSAGE);

    await store.write({ version: 1, entries: { a: { ...entry, iv: "!!not-base64!!" } } });
    await expect(vault.get("a")).rejects.toThrow(DECRYPT_MESSAGE);
  });

  it("fetches the key once and serialises concurrent writes", async () => {
    const counter = { calls: 0 };
    const store = new MemoryVaultStore();
    const vault = new Vault({ store, keySource: keySourceOf(undefined, counter) });
    await vault.set("a", "value-a");
    await Promise.all(["b", "c", "d"].map((id) => vault.set(id, `value-${id}`)));
    await vault.get("a");
    expect(counter.calls).toBe(1);
    expect((await vault.list()).map((i) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps working after a failed write", async () => {
    let fail = true;
    const inner = new MemoryVaultStore();
    const store = { label: "flaky", read: () => inner.read(), write: async (d: VaultDocument) => (fail ? Promise.reject(new Error("disk full")) : inner.write(d)) };
    const vault = new Vault({ store, keySource: keySourceOf() });
    await expect(vault.set("a", "value-a")).rejects.toThrow("disk full");
    fail = false;
    await vault.set("a", "value-a");
    expect(await vault.has("a")).toBe(true);
  });
});

describe("Vault key length", () => {
  const KEY_MESSAGE = "Der Tresor-Schluessel muss genau 32 Byte lang sein.";

  it.each([16, 24, 31, 33])("rejects a %i byte key for set and get", async (size) => {
    const good = randomBytes(32);
    const store = new MemoryVaultStore();
    await store.write({ version: 1, entries: { a: legacyEncrypt(good, "a", "value-a") } });
    const vault = new Vault({ store, keySource: keySourceOf(randomBytes(size)) });
    await expect(vault.set("b", "value-b")).rejects.toThrow(new VaultUnavailableError(KEY_MESSAGE));
    await expect(vault.get("a")).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(vault.get("a")).rejects.toThrow(KEY_MESSAGE);
    expect(Object.keys((await store.read()).entries)).toEqual(["a"]);
  });

  it("accepts a pooled Buffer view of exactly 32 bytes", async () => {
    const key = Buffer.allocUnsafe(32);
    randomBytes(32).copy(key);
    const { store, vault } = vaultOf(undefined, key);
    await vault.set("a", "value-a");
    expect(legacyDecrypt(key, "a", (await store.read()).entries["a"]!)).toBe("value-a");
    await store.write({ version: 1, entries: { b: legacyEncrypt(key, "b", "value-b") } });
    expect((await vault.get("b"))!.reveal()).toBe("value-b");
  });
});

describe("Vault text handling stays compatible with node:crypto", () => {
  const cases: Array<[string, string, string]> = [
    ["leading U+FEFF", "acme-app", "﻿example-value"],
    ["empty value", "acme-app", ""],
    ["multi-byte value", "acme-app", "wert-äöü-€-\u{1F600}"],
    ["non-ASCII id", "exämple-€-id", "example-value"],
  ];

  it.each(cases)("%s: round-trips and decrypts in both directions", async (_name, id, plain) => {
    const key = randomBytes(32);
    const { store, vault } = vaultOf(undefined, key);
    await vault.set(id, plain);
    expect((await vault.get(id))!.reveal()).toBe(plain);
    const written = (await store.read()).entries[id]!;
    expect(legacyDecrypt(key, id, written)).toBe(plain);
    expect(written.fingerprint).toBe(createHash("sha256").update(plain).digest("hex").slice(0, 12));
    await store.write({ version: 1, entries: { [id]: legacyEncrypt(key, id, plain) } });
    expect((await vault.get(id))!.reveal()).toBe(plain);
  });
});

describe("MemoryVaultStore", () => {
  it("starts empty and stores deep copies", async () => {
    const store = new MemoryVaultStore();
    expect(store.label).toBe("memory");
    expect(await store.read()).toEqual({ version: 1, entries: {} });
    const doc: VaultDocument = { version: 1, entries: { a: { iv: "i", tag: "t", ct: "c", savedAt: "s", fingerprint: "f" } } };
    await store.write(doc);
    doc.entries["a"]!.ct = "changed";
    const read = await store.read();
    expect(read.entries["a"]!.ct).toBe("c");
    read.entries["a"]!.ct = "changed-too";
    expect((await store.read()).entries["a"]!.ct).toBe("c");
  });
});
