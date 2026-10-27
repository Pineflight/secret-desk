import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionStore, NotConnectedError } from "../src/connections.js";
import { InventoryStore } from "../src/inventory.js";
import { SecretVault, type KeySource } from "../src/vault.js";
import { INVENTORY_YAML } from "./fixtures.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sd-conn-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const fixedKey = (k = randomBytes(32)): KeySource => ({ label: "test", key: async () => k });

describe("H5: defekter Tresor verhindert den Rueckfall nicht", () => {
  it("Schluesselwechsel + Env-Spec: Token kommt aus der Umgebung", async () => {
    const file = join(await tmp(), "v.json");
    await new SecretVault({ file, keySource: fixedKey() }).set("github", "aus-dem-tresor");
    const store = new ConnectionStore({ vault: new SecretVault({ file, keySource: fixedKey() }), specs: { github: { type: "env", name: "GH" } }, env: { GH: "aus-der-umgebung" } });
    expect((await store.token("github")).reveal()).toBe("aus-der-umgebung");
    expect(await store.status("github")).toMatchObject({ connected: true, source: "env" });
  });
  it("Schluesselwechsel ohne Rueckfall: NotConnectedError mit klarer Meldung, status nennt den Grund", async () => {
    const file = join(await tmp(), "v.json");
    await new SecretVault({ file, keySource: fixedKey() }).set("github", "x");
    const store = new ConnectionStore({ vault: new SecretVault({ file, keySource: fixedKey() }) });
    const err = await store.token("github").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConnectedError);
    expect((err as Error).message).toContain("Tresor-Eintrag nicht lesbar");
    expect(await store.status("github")).toMatchObject({ connected: false, hint: "Tresor-Eintrag nicht lesbar" });
  });
});

describe("M7: abgelaufene Tokens", () => {
  const now = () => new Date("2026-10-27T12:00:00Z");
  it("Session-Token mit vergangenem Datum: NotConnectedError, heute gilt noch", async () => {
    const store = new ConnectionStore({ now });
    store.session.set("a", "wert", "2026-10-26");
    const err = await store.token("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConnectedError);
    expect((err as Error).message).toContain("Token abgelaufen");
    expect((await store.status("a")).connected).toBe(false);
    store.session.set("b", "wert", "2026-10-27");
    expect((await store.token("b")).reveal()).toBe("wert");
    store.session.set("c", "wert", null);
    expect((await store.token("c")).reveal()).toBe("wert");
  });
  it("Tresor-Token abgelaufen: nicht verwendet; konfigurierte Quelle springt ein", async () => {
    const vault = new SecretVault({ file: join(await tmp(), "v.json"), keySource: fixedKey() });
    await vault.set("a", "alt", "2026-01-01");
    const only = new ConnectionStore({ vault, now });
    await expect(only.token("a")).rejects.toThrow(/abgelaufen/);
    const withEnv = new ConnectionStore({ vault, now, specs: { a: { type: "env", name: "A" } }, env: { A: "neu" } });
    expect((await withEnv.token("a")).reveal()).toBe("neu");
  });
});

describe("H4: parallele save()", () => {
  it("Promise.all([save, save]) scheitert nicht und hinterlaesst keine tmp-Dateien", async () => {
    const dir = await tmp();
    const path = join(dir, "inventory.yaml");
    const s = InventoryStore.fromText(INVENTORY_YAML, path);
    s.patchSecret("cf-deploy-acme-app", { notes: "a" });
    const first = s.save();
    s.patchSecret("cf-deploy-acme-app", { notes: "b" });
    await Promise.all([first, s.save(), s.save()]);
    expect(await readFile(path, "utf8")).toContain("notes: b");
    expect(await readdir(dir)).toEqual(["inventory.yaml"]);
  });
});
