import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  onTmpOpen: null as null | (() => Promise<void>),
  onTmpRm: null as null | (() => Promise<void>),
  failRename: false,
  failRm: null as null | ((path: string) => boolean),
  failResolveOnce: false,
}));

// Controllable file system: another writer sneaks in right before the rename, the rename fails, the clean-up fails.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags: string, mode?: number) => {
      if (hooks.onTmpOpen && String(path).includes(".tmp-") && flags === "r+") await hooks.onTmpOpen();
      return actual.open(path, flags, mode);
    },
    rename: async (from: string, to: string) => {
      if (hooks.failRename) throw new Error("rename refused");
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: object) => {
      if (hooks.onTmpRm && String(path).includes(".tmp-")) await hooks.onTmpRm();
      if (hooks.failRm?.(String(path))) throw new Error("rm refused");
      return actual.rm(path, options);
    },
  };
});

vi.mock("../src/stages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/stages.js")>();
  return {
    ...actual,
    resolvePlaces: (...args: Parameters<typeof actual.resolvePlaces>) => {
      if (hooks.failResolveOnce) {
        hooks.failResolveOnce = false;
        throw new TypeError("not a stage error");
      }
      return actual.resolvePlaces(...args);
    },
  };
});

import { InventoryConflictError, InventoryError, InventoryStore } from "../src/inventory.js";
import { INVENTORY_YAML } from "./fixtures.js";

afterEach(() => {
  hooks.onTmpOpen = null;
  hooks.onTmpRm = null;
  hooks.failRename = false;
  hooks.failRm = null;
  hooks.failResolveOnce = false;
});

async function open() {
  const dir = await mkdtemp(join(tmpdir(), "sd-cov-invfs-"));
  const file = join(dir, "inventory.yaml");
  await writeFile(file, INVENTORY_YAML);
  return { dir, file, store: await InventoryStore.open(file) };
}

describe("InventoryStore.save under interference", () => {
  it("gives up with a clear message when another writer changes the file again and again, and keeps the other writer's content", async () => {
    const { file, store } = await open();
    let round = 0;
    hooks.onTmpOpen = async () => {
      round += 1;
      await writeFile(file, INVENTORY_YAML.replace("2027-01-21", `2027-02-${String(10 + round).padStart(2, "0")}`));
    };
    store.patchSecret("lead-token-dev", { notes: "mine" });
    const err = await store.save().catch((e: Error) => e);
    expect(err).toBeInstanceOf(InventoryConflictError);
    expect((err as Error).message).toContain("immer wieder von einem anderen Prozess geaendert");
    expect(round).toBe(6);
    expect(store.getSecret("lead-token-dev")!.notes).toBeUndefined();
  });

  it("a file that vanishes while the store gives up leaves the store as it was", async () => {
    const { file, store } = await open();
    let opens = 0;
    let removals = 0;
    hooks.onTmpOpen = async () => {
      opens += 1;
      await writeFile(file, INVENTORY_YAML.replace("2027-01-21", `2027-03-${String(10 + opens).padStart(2, "0")}`));
    };
    hooks.onTmpRm = async () => {
      removals += 1;
      if (removals === 6) await rm(file);
    };
    store.patchSecret("lead-token-dev", { notes: "mine" });
    await expect(store.save()).rejects.toBeInstanceOf(InventoryConflictError);
    expect(removals).toBe(6);
  });

  it("a store that has never written notices a file that appears right before its first write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cov-invfs-"));
    const file = join(dir, "inventory.yaml");
    const store = InventoryStore.fromText("version: 1\nsecrets: []\n", file);
    let first = true;
    hooks.onTmpOpen = async () => {
      if (!first) return;
      first = false;
      await writeFile(file, INVENTORY_YAML);
    };
    await store.save();
    expect(await readFile(file, "utf8")).toContain("lead-token-dev");
    expect(store.getSecret("lead-token-dev")).toBeDefined();
  });

  it("a failing rename is reported even when the clean-up of the temp file and of the lock fail too", async () => {
    const { store } = await open();
    hooks.failRename = true;
    hooks.failRm = (path) => path.includes(".tmp-") || path.endsWith(".lock");
    store.patchSecret("lead-token-dev", { notes: "mine" });
    await expect(store.save()).rejects.toThrow("rename refused");
  });
});

describe("InventoryStore.addSecret", () => {
  it("an unexpected error while resolving the places is reported as an inventory error and changes nothing", async () => {
    const { store } = await open();
    hooks.failResolveOnce = true;
    expect(() => store.addSecret({ id: "new-one", name: "NEW_ONE", stage: "dev", service: "x", provider: "manual", expiry: "none", places: [{ repo: "web", scope: "repository" }] } as never)).toThrow(new InventoryError("not a stage error"));
    expect(store.getSecret("new-one")).toBeUndefined();
  });
});
