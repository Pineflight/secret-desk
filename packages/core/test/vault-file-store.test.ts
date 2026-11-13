import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SecretVault, VaultUnavailableError } from "../src/vault.js";
import { MemoryVaultStore } from "../src/vault-core.js";
import { FileVaultStore } from "../src/vault-file-store.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sd-vault-store-"));
  dirs.push(d);
  return d;
}

describe("FileVaultStore", () => {
  it("labels itself with the file, reads a missing file as empty and round-trips a document", async () => {
    const file = join(await tmp(), "nested", "vault.json");
    const store = new FileVaultStore(file);
    expect(store.label).toBe(file);
    expect(await store.read()).toEqual({ version: 1, entries: {} });
    await store.write({ version: 1, entries: {} });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, entries: {} });
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["unknown version", JSON.stringify({ version: 2, entries: {} })],
    ["entries is an array", JSON.stringify({ version: 1, entries: [] })],
  ])("%s: keeps the original, copies it as .corrupt-<time> and throws the known message", async (_name, content) => {
    const dir = await tmp();
    const file = join(dir, "vault.json");
    await writeFile(file, content);
    const store = new FileVaultStore(file);
    const err = await store.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VaultUnavailableError);
    const copies = (await readdir(dir)).filter((f) => f.startsWith("vault.json.corrupt-"));
    expect(copies).toHaveLength(1);
    const copy = join(dir, copies[0]!);
    expect((err as Error).message).toBe(`Die Tresordatei ${file} ist beschaedigt oder hat ein unbekanntes Format. Eine Kopie liegt als ${copy}; nichts wurde ueberschrieben.`);
    expect(await readFile(file, "utf8")).toBe(content);
    expect(await readFile(copy, "utf8")).toBe(content);
    // A second access fails again and reuses the same copy name.
    await expect(store.read()).rejects.toThrow(copy);
    expect((await readdir(dir)).filter((f) => f.startsWith("vault.json.corrupt-"))).toHaveLength(1);
  });

  it("an unreadable path throws the known message and does not overwrite anything", async () => {
    const dir = await tmp();
    await expect(new FileVaultStore(dir).read()).rejects.toThrow(new VaultUnavailableError(`Die Tresordatei ${dir} ist nicht lesbar. Sie wird nicht ueberschrieben.`));
  });
});

describe("SecretVault", () => {
  it("uses a given store instead of a file", async () => {
    const store = new MemoryVaultStore();
    const key = randomBytes(32);
    const vault = new SecretVault({ store, keySource: { label: "test", key: async () => key } });
    await vault.set("acme-app", "example-value");
    expect(Object.keys((await store.read()).entries)).toEqual(["acme-app"]);
    expect((await vault.get("acme-app"))!.reveal()).toBe("example-value");
  });

  it("builds a file store from the file option by default", async () => {
    const file = join(await tmp(), "vault.json");
    const vault = new SecretVault({ file, keySource: { label: "test", key: async () => randomBytes(32) } });
    expect(await vault.list()).toEqual([]);
    await vault.set("acme-app", "example-value");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).entries)).toEqual(["acme-app"]);
  });
});
