import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryConflictError, InventoryStore } from "../src/inventory.js";
import { INVENTORY_YAML } from "./fixtures.js";

const watchState = vi.hoisted(() => ({
  listener: null as ((event: string, name: string | null) => void) | null,
  errorHandler: null as ((err: Error) => void) | null,
  path: "",
  closed: 0,
  throwOnWatch: false,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (path: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
    if (watchState.throwOnWatch) throw new Error("watch unsupported");
    watchState.path = path;
    watchState.listener = listener;
    return {
      on: (_event: string, handler: (err: Error) => void) => {
        watchState.errorHandler = handler;
      },
      close: () => {
        watchState.closed += 1;
      },
    };
  },
}));

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-inv-"));
  file = join(dir, "inventory.yaml");
  await writeFile(file, INVENTORY_YAML, { mode: 0o600 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Writes like the CLI would: a second store on the same file. */
async function externalPatch(patch: Parameters<InventoryStore["patchSecret"]>[1], id = "cf-deploy-acme-app"): Promise<void> {
  const other = await InventoryStore.open(file);
  other.patchSecret(id, patch);
  await other.save();
}

describe("InventoryStore follows the file", () => {
  it("picks up an external write on the next read", async () => {
    const store = await InventoryStore.open(file);
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-01-21");
    const v0 = store.version;
    await externalPatch({ expires: "2027-06-01", rotatedAt: "2027-03-01" });
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-06-01");
    expect(store.data.secrets[0]!.rotatedAt).toBe("2027-03-01");
    expect(store.version).toBeGreaterThan(v0);
  });

  it("picks up a rewrite with the same size and a restored mtime after the re-hash interval", async () => {
    const store = await InventoryStore.open(file);
    const before = await stat(file);
    await writeFile(file, INVENTORY_YAML.replace("2027-01-21", "2027-01-22"));
    const { utimes } = await import("node:fs/promises");
    await utimes(file, before.atime, before.mtime);
    await wait(1100);
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-01-22");
  });

  it("notifies listeners about external changes only", async () => {
    const store = await InventoryStore.open(file);
    let calls = 0;
    store.onExternalChange(() => calls++);
    store.patchSecret("lead-token-dev", { notes: "own" });
    await store.save();
    expect(store.getSecret("lead-token-dev")!.notes).toBe("own");
    expect(calls).toBe(0);
    await externalPatch({ notes: "external" }, "lead-token-dev");
    expect(store.getSecret("lead-token-dev")!.notes).toBe("external");
    expect(calls).toBe(1);
  });

  it("ignores a half written file, keeps the old state and recovers when it becomes valid", async () => {
    const store = await InventoryStore.open(file);
    await writeFile(file, "version: 1\nsecrets:\n  - id: [broken");
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-01-21");
    expect(store.problem?.persistent).toBe(false); // reported, but not yet persistent
    await wait(300);
    expect(store.data.secrets).toHaveLength(3);
    await writeFile(file, INVENTORY_YAML.replace("2027-01-21", "2027-02-02"));
    await wait(300);
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-02-02");
    expect(store.problem).toBeNull();
  });

  it("reports a problem when the file stays invalid", async () => {
    const store = await InventoryStore.open(file);
    await writeFile(file, "not: [valid");
    expect(store.data.secrets).toHaveLength(3);
    await wait(3100);
    const problem = store.problem;
    expect(problem?.persistent).toBe(true);
    expect(problem?.message).toMatch(/YAML|Inventar/);
    expect(store.data.secrets).toHaveLength(3);
  });
  describe("directory watch hints", () => {
    // fs.watch event delivery depends on the OS and on machine load (FSEvents can lag by seconds under coverage), so these
    // tests drive the listener that InventoryStore registers instead of waiting for a real event.
    const hint = (event: string, name: string | null): void => watchState.listener!(event, name);
    beforeEach(() => {
      watchState.listener = null;
      watchState.errorHandler = null;
      watchState.closed = 0;
      watchState.throwOnWatch = false;
    });

    it("reloads on a hint without any read", async () => {
      const store = await InventoryStore.open(file);
      let calls = 0;
      store.onExternalChange(() => calls++);
      const stop = store.watch({ debounceMs: 20 });
      try {
        await externalPatch({ notes: "watched" }, "lead-token-dev");
        expect(calls).toBe(0); // nothing read the store yet
        hint("rename", "inventory.yaml");
        await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      } finally {
        stop();
      }
    });

    it("watches the directory of the file and treats an event without a name as a hint too", async () => {
      const store = await InventoryStore.open(file);
      let calls = 0;
      store.onExternalChange(() => calls++);
      const stop = store.watch({ debounceMs: 20 });
      try {
        expect(watchState.path).toBe(dir);
        await externalPatch({ notes: "watched" }, "lead-token-dev");
        hint("change", null);
        await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
      } finally {
        stop();
      }
    });

    it("ignores events about other files", async () => {
      const store = await InventoryStore.open(file);
      let calls = 0;
      store.onExternalChange(() => calls++);
      const stop = store.watch({ debounceMs: 20 });
      try {
        await externalPatch({ notes: "watched" }, "lead-token-dev");
        hint("change", "other.txt");
        await wait(150);
        expect(calls).toBe(0);
      } finally {
        stop();
      }
    });

    it("several hints in a row reload once, and a file that is still half written is looked at again", async () => {
      const store = await InventoryStore.open(file);
      let calls = 0;
      store.onExternalChange(() => calls++);
      const stop = store.watch({ debounceMs: 20 });
      try {
        await writeFile(file, "version: 1\nsecrets:\n  - id: [broken");
        hint("change", "inventory.yaml");
        hint("change", "inventory.yaml");
        await wait(100);
        expect(store.problem).not.toBeNull();
        await writeFile(file, INVENTORY_YAML.replace("2027-01-21", "2027-03-03"));
        await vi.waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
        expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-03-03");
      } finally {
        stop();
      }
    });

    it("an error event of the watcher is swallowed and stop closes the watcher", async () => {
      const store = await InventoryStore.open(file);
      const stop = store.watch();
      expect(() => watchState.errorHandler!(new Error("EMFILE"))).not.toThrow();
      stop();
      expect(watchState.closed).toBe(1);
    });

    it("stop cancels a pending reload", async () => {
      const store = await InventoryStore.open(file);
      let calls = 0;
      store.onExternalChange(() => calls++);
      const stop = store.watch({ debounceMs: 50 });
      await externalPatch({ notes: "watched" }, "lead-token-dev");
      hint("change", "inventory.yaml");
      stop();
      await wait(150);
      expect(calls).toBe(0);
    });

    it("a platform that cannot watch directories still gives a stop function", async () => {
      watchState.throwOnWatch = true;
      const store = await InventoryStore.open(file);
      const stop = store.watch();
      expect(() => stop()).not.toThrow();
    });

    it("an inventory without a file has nothing to watch", () => {
      const stop = InventoryStore.fromText("version: 1\nsecrets: []\n").watch();
      expect(watchState.listener).toBeNull();
      expect(() => stop()).not.toThrow();
    });
  });
});

describe("InventoryStore never writes over a newer file", () => {
  it("re-applies its change on top of an external change made between mutation and save", async () => {
    const store = await InventoryStore.open(file);
    store.patchSecret("cf-deploy-acme-app", { notes: "from portal" });
    await externalPatch({ expires: "2027-09-09", rotatedAt: "2027-06-06" }); // CLI writes in between
    await store.save();
    const saved = await InventoryStore.open(file);
    const s = saved.getSecret("cf-deploy-acme-app")!;
    expect(s.notes).toBe("from portal");
    expect(s.expires).toBe("2027-09-09");
    expect(s.rotatedAt).toBe("2027-06-06");
    // The store itself shows the merged state as well.
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-09-09");
  });

  it("refreshes before it mutates, so a stale view does not overwrite the CLI result", async () => {
    const store = await InventoryStore.open(file);
    expect(store.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-01-21");
    await externalPatch({ expires: "2027-12-31" });
    store.patchSecret("lead-token-dev", { notes: "portal" });
    await store.save();
    const saved = await InventoryStore.open(file);
    expect(saved.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-12-31");
    expect(saved.getSecret("lead-token-dev")!.notes).toBe("portal");
  });

  it("merges every kind of mutation", async () => {
    const store = await InventoryStore.open(file);
    store.addSecret({ id: "new-one", name: "NEW_ONE", service: "x", stage: "staging", places: [{ repo: "acme-app", scope: "environment", environment: "staging" }] });
    store.setSecretParams("stripe-webhook-acme-docs-staging", { account: "acct_1" });
    store.setIntegrationDefaults("grafana", { baseUrl: "https://example.test" });
    store.setResourceMap({ kind: "grafana-stack", repo: "acme-app", stage: "staging", value: "stack-1" });
    store.renameRepo("acme-docs", "acme-docs-2");
    store.addEnvEntry("acme-web-dev", { key: "EXTRA", from: { type: "default", value: "1" } });
    await externalPatch({ expires: "2028-01-01" });
    await store.save();
    const saved = await InventoryStore.open(file);
    expect(saved.getSecret("cf-deploy-acme-app")!.expires).toBe("2028-01-01");
    expect(saved.getSecret("new-one")).toBeDefined();
    expect(saved.getSecret("stripe-webhook-acme-docs-staging")!.params["account"]).toBe("acct_1");
    expect(saved.data.integrationDefaults?.["grafana"]).toEqual({ baseUrl: "https://example.test" });
    expect(saved.data.resourceMap).toHaveLength(1);
    expect(saved.getSecret("stripe-webhook-acme-docs-staging")!.places[0]!.repo).toBe("acme-docs-2");
    expect(saved.data.envTemplates[0]!.entries.some((e) => e.key === "EXTRA")).toBe(true);
  });

  it("fails with a conflict and writes nothing when the change no longer fits", async () => {
    const store = await InventoryStore.open(file);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    // The other process adds the same id the portal is about to add.
    const other = await InventoryStore.open(file);
    other.addSecret({ id: "dup", name: "DUP", service: "x", stage: "dev", places: [] });
    await other.save();
    store.addSecret({ id: "dup-2", name: "DUP_2", service: "x", stage: "dev", places: [] });
    const other2 = await InventoryStore.open(file);
    other2.addSecret({ id: "dup-2", name: "DUP_2", service: "y", stage: "dev", places: [] });
    await other2.save();
    const before = await readFile(file, "utf8");
    await expect(store.save()).rejects.toBeInstanceOf(InventoryConflictError);
    expect(await readFile(file, "utf8")).toBe(before);
    // The store follows the file again afterwards.
    expect(store.getSecret("dup-2")!.service).toBe("y");
  });

  it("refuses to replay a full replacement over a changed file", async () => {
    const store = await InventoryStore.open(file);
    store.replaceData({ ...store.data });
    await externalPatch({ expires: "2028-05-05" });
    const before = await readFile(file, "utf8");
    await expect(store.save()).rejects.toThrow(/passt nicht mehr|ersetzt/);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("does not overwrite a file that is invalid on disk", async () => {
    const store = await InventoryStore.open(file);
    store.patchSecret("lead-token-dev", { notes: "mine" });
    await writeFile(file, "broken: [");
    await expect(store.save()).rejects.toBeInstanceOf(InventoryConflictError);
    expect(await readFile(file, "utf8")).toBe("broken: [");
  });

  it("serialises concurrent saves of two stores without losing either change", async () => {
    const a = await InventoryStore.open(file);
    const b = await InventoryStore.open(file);
    a.patchSecret("lead-token-dev", { notes: "from a" });
    b.patchSecret("cf-deploy-acme-app", { notes: "from b" });
    await Promise.all([a.save(), b.save()]);
    const saved = await InventoryStore.open(file);
    expect(saved.getSecret("lead-token-dev")!.notes).toBe("from a");
    expect(saved.getSecret("cf-deploy-acme-app")!.notes).toBe("from b");
  });

  it("does not write when there is nothing to save", async () => {
    const store = await InventoryStore.open(file);
    const before = await stat(file);
    await wait(20);
    await store.save();
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("InventoryStore writes atomically", () => {
  it("leaves no temp or lock file, keeps mode 0600 and the comments", async () => {
    const store = await InventoryStore.open(file);
    store.patchSecret("lead-token-dev", { notes: "x" });
    await store.save();
    expect(await readdir(dir)).toEqual(["inventory.yaml"]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain("# Kommentar bleibt erhalten");
  });

  it("leaves the old file intact and no temp file when the write fails", async () => {
    const store = await InventoryStore.open(file);
    store.patchSecret("lead-token-dev", { notes: "x" });
    const { chmod } = await import("node:fs/promises");
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await chmod(dir, 0o500);
    try {
      await expect(store.save()).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await readFile(file, "utf8")).toBe(INVENTORY_YAML);
    expect(await readdir(dir)).toEqual(["inventory.yaml"]);
  });

  it("breaks a stale lock", async () => {
    const { utimes } = await import("node:fs/promises");
    await writeFile(`${file}.lock`, "999999\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    const store = await InventoryStore.open(file);
    store.patchSecret("lead-token-dev", { notes: "x" });
    await store.save();
    expect((await InventoryStore.open(file)).getSecret("lead-token-dev")!.notes).toBe("x");
  });

  it("creates the file from text when it does not exist yet", async () => {
    const fresh = join(dir, "new.yaml");
    const store = InventoryStore.fromText("version: 1\nsecrets: []\n", fresh);
    await store.save();
    expect(await readFile(fresh, "utf8")).toContain("version: 1");
  });
});
