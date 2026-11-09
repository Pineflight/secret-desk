import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  InventoryStore,
  TeamBundleError,
  TeamSyncError,
  TeamSyncSchema,
  assertTeamFileClean,
  diffBundles,
  ensureConfigFile,
  readTeamSyncState,
  textHash,
  writeTeamSyncConfig,
  writeTeamSyncState,
} from "../src/index.js";

const tmp = () => mkdtemp(join(tmpdir(), "sd-cov-sync-"));
const inv = (yaml: string) => InventoryStore.fromText(`version: 1\n${yaml}`).data;
const secret = (id: string, extra = "") => `  - { id: ${id}, name: ${id.toUpperCase().replaceAll("-", "_")}, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: web, scope: repository }]${extra} }\n`;

describe("team state file", () => {
  it("textHash is a stable SHA-256", () => {
    expect(textHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("reads defaults for a missing or unreadable file and merges a partial one", async () => {
    const dir = await tmp();
    expect(await readTeamSyncState(join(dir, "missing.json"))).toEqual(EMPTY_STATE);
    await writeFile(join(dir, "bad.json"), "{ not json");
    expect(await readTeamSyncState(join(dir, "bad.json"))).toEqual(EMPTY_STATE);
    await writeFile(join(dir, "part.json"), JSON.stringify({ remoteSha: "abc", setupDismissed: true }));
    expect(await readTeamSyncState(join(dir, "part.json"))).toEqual({ ...EMPTY_STATE, remoteSha: "abc", setupDismissed: true });
  });

  it("writes atomically with a private mode and creates the folder", async () => {
    const dir = await tmp();
    const file = join(dir, "nested", "state.json");
    await writeTeamSyncState(file, { ...EMPTY_STATE, remoteSha: "sha-1" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ remoteSha: "sha-1" });
    expect(await readdir(join(dir, "nested"))).toEqual(["state.json"]);
  });

  it("cleans up the temp file and passes the error on when the write fails", async () => {
    const dir = await tmp();
    // A directory in the place of the target makes the final rename fail.
    await mkdir(join(dir, "state.json"));
    await writeFile(join(dir, "state.json", "keep"), "x");
    await expect(writeTeamSyncState(join(dir, "state.json"), EMPTY_STATE)).rejects.toThrow();
    expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("diffBundles", () => {
  it("lists added, changed and removed ids per section, and is empty for equal inventories", () => {
    const base = inv(`secrets:\n${secret("same")}${secret("gone")}${secret("edited")}`);
    const next = inv(`secrets:\n${secret("same")}${secret("edited", ", notes: changed")}${secret("new")}\nvariables:\n  - { id: v1, name: V_ONE, stage: shared, value: x, places: [{ repo: web, scope: repository }] }\n`);
    const d = diffBundles(base, next);
    expect(d.empty).toBe(false);
    expect(d.sections.secrets).toEqual({ added: ["new"], changed: ["edited"], removed: ["gone"] });
    expect(d.sections.variables).toEqual({ added: ["v1"], changed: [], removed: [] });
    expect(diffBundles(base, base)).toMatchObject({ empty: true });
  });

  it("copes with inventories that lack whole sections", () => {
    const sparse = { secrets: [] } as never;
    expect(diffBundles(sparse, sparse).empty).toBe(true);
    expect(diffBundles(sparse, inv(`secrets:\n${secret("new")}`)).sections.secrets.added).toEqual(["new"]);
  });

  it("ignores the order of keys and the local runtime fields", () => {
    const a = inv(`secrets:\n${secret("s1", ", externalId: local-id")}`);
    const b = inv(`secrets:\n${secret("s1")}`);
    expect(diffBundles(a, b).empty).toBe(true);
  });
});

describe("assertTeamFileClean", () => {
  it("refuses runtime fields", () => {
    expect(() => assertTeamFileClean("secrets:\n  - { id: s1, externalId: x }\n")).toThrow(new TeamBundleError("Team-Datei enthaelt externalId: wird nicht hochgeladen."));
    expect(() => assertTeamFileClean("secrets:\n  - { id: s1, rotatedAt: x }\n")).toThrow(/rotatedAt/);
  });
  it("refuses a session token, but ignores very short strings", () => {
    const token = ["made", "up", "session", "token"].join("-");
    expect(() => assertTeamFileClean(`notes: ${token}\n`, [token])).toThrow(/Zugangs-Token/);
    expect(() => assertTeamFileClean("notes: abc\n", ["abc"])).not.toThrow();
  });
  it("accepts an empty file and a clean one", () => {
    expect(() => assertTeamFileClean("")).not.toThrow();
    expect(() => assertTeamFileClean("secrets: []\n")).not.toThrow();
  });
});

describe("config file", () => {
  it("leaves an existing file alone", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "c.yaml"), "x: 1\n");
    expect(await ensureConfigFile(join(dir, "c.yaml"))).toBe(false);
    expect(await readFile(join(dir, "c.yaml"), "utf8")).toBe("x: 1\n");
  });

  it("creates a minimal configuration and an empty inventory next to it (also in a new folder)", async () => {
    const dir = await tmp();
    const file = join(dir, "new", "c.yaml");
    expect(await ensureConfigFile(file)).toBe(true);
    expect(await readFile(file, "utf8")).toContain("inventory: ./inventory.yaml");
    expect(await readFile(join(dir, "new", "inventory.yaml"), "utf8")).toContain("secrets: []");
  });

  it("keeps an inventory that exists already", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets:\n  - keep\n");
    expect(await ensureConfigFile(join(dir, "c.yaml"))).toBe(true);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("keep");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a folder that cannot be written", async () => {
    const dir = await tmp();
    await chmod(dir, 0o500);
    try {
      await expect(ensureConfigFile(join(dir, "c.yaml"))).rejects.toMatchObject({ code: "unwritable" });
    } finally {
      await chmod(dir, 0o700);
    }
  });

  describe("teamSync section", () => {
    const CONFIG = "# my config\ninventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat }\n";

    it("adds the section and keeps comments; removing it restores the file", async () => {
      const dir = await tmp();
      const file = join(dir, "c.yaml");
      await writeFile(file, CONFIG);
      await writeTeamSyncConfig(file, TeamSyncSchema.parse({ repo: "acme/team" }));
      const withSync = await readFile(file, "utf8");
      expect(withSync).toContain("# my config");
      expect(withSync).toContain("teamSync:");
      expect(withSync).toContain("repo: acme/team");
      await writeTeamSyncConfig(file, null);
      expect(await readFile(file, "utf8")).not.toContain("teamSync");
    });

    it("refuses to write a configuration that would be invalid and leaves the file unchanged", async () => {
      const dir = await tmp();
      const file = join(dir, "c.yaml");
      await writeFile(file, CONFIG);
      await expect(writeTeamSyncConfig(file, { repo: "not a repo" } as never)).rejects.toBeInstanceOf(TeamSyncError);
      expect(await readFile(file, "utf8")).toBe(CONFIG);
    });
  });
});
