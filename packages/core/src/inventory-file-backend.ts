import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { writePrivateFile } from "./platform.js";
import { InventoryConflictError } from "./inventory-errors.js";
import type { InventoryBackend, InventoryRevision, InventorySnapshot, InventoryTransaction, InventoryWriteResult } from "./inventory-backend.js";

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 15000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The revision the file backend gives a text: its sha256 as hex. */
export const fileRevision = (text: string): InventoryRevision => createHash("sha256").update(text).digest("hex");

interface FileStat {
  mtimeMs: number;
  size: number;
  ino: number;
}

function statOf(path: string): FileStat | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function snapshotOf(path: string): InventorySnapshot | null {
  const text = readText(path);
  return text === null ? null : { text, revision: fileRevision(text) };
}

/** Best effort: makes the rename durable. Not available everywhere (Windows), never fatal. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignore
  }
}

/**
 * Advisory lock between writers (portal, CLI, scripts) via an exclusively created file. A lock older than
 * `LOCK_STALE_MS` belongs to a crashed process and is broken. Readers never lock.
 */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = statOf(lockPath);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new InventoryConflictError("Ein anderer Prozess speichert gerade das Inventar. Bitte gleich noch einmal versuchen.");
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/** The inventory as a YAML file of the local edition: stat-based stamp, lock file next to it, atomic replace. */
export class FileInventoryBackend implements InventoryBackend {
  constructor(readonly path: string) {}

  get label(): string {
    return this.path;
  }

  stamp(): string | null {
    const st = statOf(this.path);
    return st ? `${st.mtimeMs}:${st.size}:${st.ino}` : null;
  }

  read(): InventorySnapshot | null {
    return snapshotOf(this.path);
  }

  withWriteLock<T>(fn: (tx: InventoryTransaction) => Promise<T>): Promise<T> {
    const tx: InventoryTransaction = {
      read: () => snapshotOf(this.path),
      write: (text, expected) => this.#write(text, expected),
    };
    return withFileLock(`${this.path}.lock`, () => fn(tx));
  }

  /** Observes the directory (not the file: an atomic write replaces the file). Only a hint; every read checks the file anyway. */
  watch(hint: () => void): () => void {
    const file = basename(this.path);
    let watcher: FSWatcher | null = null;
    try {
      watcher = fsWatch(dirname(this.path), { persistent: false }, (_event, name) => {
        if (name === null || name === undefined || String(name) === file) hint();
      });
      watcher.on("error", () => undefined);
    } catch {
      watcher = null;
    }
    return () => {
      watcher?.close();
    };
  }

  async #write(text: string, expected: InventoryRevision | null): Promise<InventoryWriteResult> {
    const path = this.path;
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      // Privat (0600): Die Datei kann Sollwerte, Ziele und Notizen enthalten.
      await writePrivateFile(tmp, text);
      const handle = await open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Last look right before the rename: all writers of this backend hold the lock, so this closes the race for them.
      const now = snapshotOf(path);
      if (now !== null && now.revision !== expected) {
        await rm(tmp, { force: true });
        return { written: false };
      }
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await syncDirectory(dirname(path));
    return { written: true, revision: fileRevision(text), stamp: this.stamp() };
  }
}
