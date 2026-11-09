import { chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryConflictError, InventoryError, InventoryStore } from "../src/index.js";
import { INVENTORY_YAML } from "./fixtures.js";

const store = () => InventoryStore.fromText(INVENTORY_YAML);
const tmp = () => mkdtemp(join(tmpdir(), "sd-cov-inv-"));

afterEach(() => vi.useRealTimers());

describe("adding entries", () => {
  it("rejects invalid input with the problems named, and the root when the input is no object", () => {
    const s = store();
    expect(() => s.addSecret({ id: "BAD ID" } as never)).toThrow(InventoryError);
    expect(() => s.addVariable({ id: "BAD ID" } as never)).toThrow(InventoryError);
    expect(() => s.addProvider({ id: "BAD ID" } as never)).toThrow(InventoryError);
    expect(() => s.addEnvTemplate({ id: "BAD ID" } as never)).toThrow(InventoryError);
    expect(() => s.addEnvEntry("acme-web-dev", { key: "lower case" } as never)).toThrow(InventoryError);
    expect(() => s.setStages([{ id: "BAD ID" }] as never)).toThrow(InventoryError);
    expect(() => s.setResourceMap({ kind: "" } as never)).toThrow(InventoryError);
    expect(() => s.replaceData("text" as never)).toThrow(/^\(Wurzel\): /);
  });

  it("rejects duplicates and unknown parents", () => {
    const s = store();
    s.addProvider({ id: "acme", label: "Acme", url: "https://acme.example.com/tokens" });
    expect(() => s.addProvider({ id: "acme", label: "Acme", url: "https://acme.example.com/tokens" })).toThrow("Anbieter existiert schon: acme");
    expect(() => s.addEnvTemplate({ id: "acme-web-dev", repo: "web", stage: "dev", entries: [{ key: "A_KEY", from: { type: "prompt" } }] } as never)).toThrow("Vorlage existiert schon: acme-web-dev");
    expect(() => s.addEnvEntry("nope", { key: "A_KEY", from: { type: "prompt" } })).toThrow("Vorlage nicht gefunden: nope");
    expect(() => s.addEnvEntry("acme-web-dev", { key: "LEAD_INTAKE_TOKEN", from: { type: "prompt" } })).toThrow("Eintrag existiert schon: LEAD_INTAKE_TOKEN");
  });
});

describe("changing entries", () => {
  it("setSecretParams sets and removes parameter keys", () => {
    const s = store();
    s.setSecretParams("lead-token-dev", { a: 1, b: 2 });
    s.setSecretParams("lead-token-dev", { c: 3 }, ["a"]);
    expect(s.getSecret("lead-token-dev")!.params).toEqual({ b: 2, c: 3 });
  });

  it("unknown ids are named", () => {
    const s = store();
    expect(() => s.patchSecret("nope", { notes: "x" })).toThrow("Secret nicht gefunden: nope");
    expect(() => s.patchVariable("nope", { value: "x" })).toThrow("Variable nicht gefunden: nope");
    expect(() => s.removeVariable("nope")).toThrow("Variable nicht gefunden: nope");
    expect(() => s.applyEdits([{ kind: "secret", id: "nope", name: "X" }])).toThrow("Secret nicht gefunden: nope");
    expect(() => s.applyEdits([{ kind: "variable", id: "nope", name: "X" }])).toThrow("Variable nicht gefunden: nope");
  });

  it("a variable can be patched without a value key, with an undefined value, and removed", () => {
    const s = store();
    s.addVariable({ id: "v1", name: "SITE_URL", stage: "dev", value: "http://localhost", places: [{ repo: "web", scope: "repository" }] } as never);
    s.patchVariable("v1", { owner: "me" });
    expect(s.getVariable("v1")).toMatchObject({ value: "http://localhost", owner: "me" });
    s.patchVariable("v1", { value: undefined });
    expect(s.getVariable("v1")!.value).toBeNull();
    s.removeVariable("v1");
    expect(s.getVariable("v1")).toBeUndefined();
  });

  it("integration defaults: set, replace, and remove (also when there are none)", () => {
    const s = store();
    expect(s.setIntegrationDefaults("cloudflare", {})).toEqual({});
    expect(s.setIntegrationDefaults("cloudflare", { accountId: "a" })).toEqual({ accountId: "a" });
    expect(s.setIntegrationDefaults("github", { owner: "o" })).toEqual({ owner: "o" });
    expect(s.setIntegrationDefaults("cloudflare", {})).toEqual({});
    expect(s.data.integrationDefaults).toEqual({ github: { owner: "o" } });
    expect(s.setIntegrationDefaults("github", {})).toEqual({});
    expect(s.data.integrationDefaults).toBeUndefined();
  });

  it("a value that cannot be stored is reported as an inventory error and changes nothing", () => {
    const s = store();
    expect(() => s.setIntegrationDefaults("cloudflare", { big: 10n })).toThrow(InventoryError);
    expect(s.data.integrationDefaults).toBeUndefined();
  });

  it("resource map entries: the first one creates the list; removing the last one removes the list", () => {
    const s = store();
    expect(s.setResourceMap({ kind: "supabase.project", repo: "web", value: "p1" })).toMatchObject({ value: "p1" });
    s.setResourceMap({ kind: "supabase.project", repo: "web", value: "p2" });
    expect(s.data.resourceMap).toEqual([{ kind: "supabase.project", repo: "web", value: "p2" }]);
    expect(store().removeResourceMapEntry({ kind: "supabase.project", repo: "web" })).toBe(false);
    expect(s.removeResourceMapEntry({ kind: "supabase.project", repo: "other" })).toBe(false);
    expect(s.removeResourceMapEntry({ kind: "supabase.project", repo: "web" })).toBe(true);
    expect(s.data.resourceMap).toBeUndefined();
  });

  it("renameRepo: nothing to do for the same name, an error for an invalid one", () => {
    const s = store();
    expect(s.renameRepo("acme-app", "acme-app")).toBe(0);
    expect(() => s.renameRepo("acme-app", "a/b")).toThrow("ungueltig");
    expect(() => s.renameRepo("acme-app", "  ")).toThrow("ungueltig");
    expect(s.renameRepo("acme-app", "renamed")).toBe(1);
  });

  it("a listener can be removed again", () => {
    const s = store();
    const off = s.onExternalChange(() => undefined);
    expect(off()).toBe(true);
    expect(off()).toBe(false);
  });
});

describe("following the file", () => {
  async function open() {
    const dir = await tmp();
    const file = join(dir, "inventory.yaml");
    await writeFile(file, INVENTORY_YAML);
    return { dir, file, store: await InventoryStore.open(file) };
  }

  it("a deleted file leaves the loaded state as it is", async () => {
    const { file, store: s } = await open();
    await rm(file);
    expect(s.getSecret("lead-token-dev")).toBeDefined();
    expect(s.toString()).toContain("lead-token-dev");
  });

  it("a touched file with the same content only refreshes the check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { file, store: s } = await open();
    const v = s.version;
    vi.setSystemTime(Date.now() + 5000);
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    expect(s.version).toBe(v);
    expect(s.problem).toBeNull();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file that cannot be read keeps the loaded state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { file, store: s } = await open();
    await chmod(file, 0o000);
    try {
      vi.setSystemTime(Date.now() + 5000);
      expect(s.getSecret("lead-token-dev")).toBeDefined();
      expect(s.problem).toBeNull();
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("save adopts a newer file when the store has nothing of its own to write", async () => {
    const { file, store: s } = await open();
    const seen: number[] = [];
    s.onExternalChange(() => seen.push(1));
    await writeFile(file, INVENTORY_YAML.replace("2027-01-21", "2027-05-05"));
    await s.save();
    expect(seen).toEqual([1]);
    expect(s.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-05-05");
  });

  it("save with unsaved changes on top of a file that cannot be merged reports a conflict and drops them", async () => {
    const { file, store: s } = await open();
    s.replaceData({ version: 1, secrets: [], variables: [], envTemplates: [], providers: [], stages: [], thresholds: [30] } as never);
    await writeFile(file, INVENTORY_YAML.replace("2027-01-21", "2027-05-05"));
    await expect(s.save()).rejects.toBeInstanceOf(InventoryConflictError);
    expect(s.getSecret("cf-deploy-acme-app")!.expires).toBe("2027-05-05");
  });

  it("save does nothing on Windows-like platforms for the directory sync", async () => {
    const { s } = await (async () => {
      const o = await open();
      return { s: o.store };
    })();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      s.patchSecret("lead-token-dev", { notes: "saved" });
      await s.save();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(s.getSecret("lead-token-dev")!.notes).toBe("saved");
  });

  it("another writer that holds the lock for too long makes save give up with a clear message", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const { file, store: s } = await open();
    await writeFile(`${file}.lock`, "1\n");
    s.patchSecret("lead-token-dev", { notes: "waiting" });
    const saving = s.save().catch((e: Error) => e);
    for (let i = 0; i < 400; i += 1) await vi.advanceTimersByTimeAsync(25);
    expect(await saving).toBeInstanceOf(InventoryConflictError);
  });
});
