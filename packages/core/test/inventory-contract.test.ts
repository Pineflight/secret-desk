import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryInventoryBackend } from "../src/inventory-backend.js";
import { FileInventoryBackend } from "../src/inventory-file-backend.js";
import { inventoryBackendContract } from "../src/testing/inventory-backend-contract.js";

// One suite (exported as `@secret-desk/core/testing`), two backends. Everything that must hold for any backend is in
// the suite; what only one of them can do (lock file, file modes, directory watch) stays in
// inventory-file-backend.test.ts and inventory-sync.test.ts.
const framework = { describe, it, expect };

inventoryBackendContract(framework, "FileInventoryBackend", async (initial) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-inv-contract-"));
  const file = join(dir, "inventory.yaml");
  if (initial !== null) await writeFile(file, initial, { mode: 0o600 });
  let externalWrites = 0;
  return {
    backend: new FileInventoryBackend(file),
    // A same-length replacement keeps size and inode, so the stat stamp would depend on the file system's mtime
    // resolution. Each external write therefore gets its own, clearly different mtime.
    writeExternally: async (next) => {
      await writeFile(file, next);
      externalWrites += 1;
      const stamp = new Date(Date.UTC(2001, 0, 1) + externalWrites * 60_000);
      await utimes(file, stamp, stamp);
    },
    stored: () => readFile(file, "utf8").catch(() => null),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

inventoryBackendContract(framework, "MemoryInventoryBackend", (initial) => {
  const backend = new MemoryInventoryBackend(initial ?? undefined);
  return {
    backend,
    writeExternally: (next) => backend.replaceExternally(next),
    stored: () => backend.text,
  };
});
