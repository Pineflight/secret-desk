import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryConflictError } from "../src/inventory-errors.js";
import { FileInventoryBackend, fileRevision } from "../src/inventory-file-backend.js";

let dir = "";
let file = "";
let backend: FileInventoryBackend;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-file-backend-"));
  file = join(dir, "inventory.yaml");
  backend = new FileInventoryBackend(file);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("FileInventoryBackend reading", () => {
  it("has the file path as label", () => {
    expect(backend.label).toBe(file);
  });

  it("gives no stamp and no snapshot for a missing file", () => {
    expect(backend.stamp()).toBeNull();
    expect(backend.read()).toBeNull();
  });

  it("stamp changes when the file changes and stays equal when it does not", async () => {
    await writeFile(file, "one\n");
    const first = backend.stamp();
    expect(first).toEqual(expect.any(String));
    expect(backend.stamp()).toBe(first);
    await writeFile(file, "one more line\n");
    expect(backend.stamp()).not.toBe(first);
  });

  it("read returns the text and its sha256 as revision", async () => {
    await writeFile(file, "hello: world\n");
    expect(backend.read()).toEqual({ text: "hello: world\n", revision: sha256("hello: world\n") });
    expect(fileRevision("hello: world\n")).toBe(sha256("hello: world\n"));
  });
});

describe("FileInventoryBackend writing", () => {
  it("replaces the file when the expected revision matches, and leaves no temp or lock file", async () => {
    await writeFile(file, "old\n");
    const result = await backend.withWriteLock((tx) => tx.write("new\n", sha256("old\n")));
    expect(result).toEqual({ written: true, revision: sha256("new\n"), stamp: backend.stamp() });
    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(await readdir(dir)).toEqual(["inventory.yaml"]);
  });

  it("creates the file when nothing is stored and nothing is expected", async () => {
    const result = await backend.withWriteLock((tx) => tx.write("first\n", null));
    expect(result.written).toBe(true);
    expect(await readFile(file, "utf8")).toBe("first\n");
  });

  it("reports a mismatch and leaves the file untouched when the expected revision is stale", async () => {
    await writeFile(file, "somebody else wrote this\n");
    const result = await backend.withWriteLock((tx) => tx.write("mine\n", sha256("old\n")));
    expect(result).toEqual({ written: false });
    expect(await readFile(file, "utf8")).toBe("somebody else wrote this\n");
    expect(await readdir(dir)).toEqual(["inventory.yaml"]);
  });

  it("reports a mismatch when a file exists although nothing was expected", async () => {
    await writeFile(file, "already here\n");
    const result = await backend.withWriteLock((tx) => tx.write("mine\n", null));
    expect(result).toEqual({ written: false });
    expect(await readFile(file, "utf8")).toBe("already here\n");
  });

  it("the transaction reads the stored document", async () => {
    await writeFile(file, "stored\n");
    const seen = await backend.withWriteLock(async (tx) => tx.read());
    expect(seen).toEqual({ text: "stored\n", revision: sha256("stored\n") });
  });

  it.skipIf(process.platform === "win32")("keeps the file private (mode 0600)", async () => {
    await backend.withWriteLock((tx) => tx.write("private\n", null));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes the lock file after the callback, also when it fails", async () => {
    await expect(backend.withWriteLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("FileInventoryBackend lock", () => {
  it("a held lock makes a second writer wait until it is released", async () => {
    const lock = `${file}.lock`;
    await writeFile(lock, "99999\n");
    let entered = false;
    const run = backend.withWriteLock(async () => {
      entered = true;
    });
    await wait(120);
    expect(entered).toBe(false);
    await rm(lock);
    await run;
    expect(entered).toBe(true);
  });

  it("two writers of the same file run one after the other", async () => {
    const other = new FileInventoryBackend(file);
    const order: string[] = [];
    // The second writer starts only once the first one holds the lock, so the order does not depend on which open() wins.
    let entered: () => void = () => undefined;
    const firstHoldsLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = backend.withWriteLock(async () => {
      order.push("first in");
      entered();
      await wait(80);
      order.push("first out");
    });
    await firstHoldsLock;
    const second = other.withWriteLock(async () => {
      order.push("second in");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
  });

  it("breaks a lock that is older than the stale limit", async () => {
    const lock = `${file}.lock`;
    await writeFile(lock, "99999\n");
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    let entered = false;
    await backend.withWriteLock(async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives up with the German conflict message when the lock stays held", async () => {
    await writeFile(`${file}.lock`, "99999\n");
    vi.useFakeTimers({ toFake: ["Date"] });
    const run = backend.withWriteLock(async () => "never");
    vi.setSystemTime(Date.now() + 6000);
    const err = await run.catch((e: Error) => e);
    expect(err).toBeInstanceOf(InventoryConflictError);
    expect((err as Error).message).toBe("Ein anderer Prozess speichert gerade das Inventar. Bitte gleich noch einmal versuchen.");
  });

  it("passes on other errors while creating the lock", async () => {
    const missing = new FileInventoryBackend(join(dir, "no-such-dir", "inventory.yaml"));
    await expect(missing.withWriteLock(async () => "never")).rejects.toThrow(/ENOENT/);
  });
});
