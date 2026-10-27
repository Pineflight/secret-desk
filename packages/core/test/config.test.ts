import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "../src/config.js";

const BASE = { inventory: "./inventory.yaml", github: { owner: "Pineflight", auth: { type: "pat" } } };

describe("Konfiguration: automation", () => {
  it("hat ohne Angabe sichere Vorgaben", () => {
    const c = ConfigSchema.parse(BASE);
    expect(c.automation).toEqual({ enabled: true, loginTimeoutMinutes: 10 });
  });

  it("nimmt alle Felder an", () => {
    const c = ConfigSchema.parse({ ...BASE, automation: { enabled: false, chromePath: "/usr/bin/chromium", profileDir: "~/p", loginTimeoutMinutes: 3, slowMoMs: 150, recipesDirs: ["rezepte", "~/mehr"] } });
    expect(c.automation).toEqual({ enabled: false, chromePath: "/usr/bin/chromium", profileDir: "~/p", loginTimeoutMinutes: 3, slowMoMs: 150, recipesDirs: ["rezepte", "~/mehr"] });
  });

  it("lehnt unsinnige Werte ab", () => {
    expect(ConfigSchema.safeParse({ ...BASE, automation: { loginTimeoutMinutes: 0 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { slowMoMs: -1 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { chromePath: "" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { recipesDirs: [""] } }).success).toBe(false);
  });

  it("wird aus der Datei gelesen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cfg-"));
    const file = join(dir, "c.yaml");
    await writeFile(file, "inventory: ./i.yaml\ngithub:\n  owner: P\n  auth: { type: pat }\nautomation:\n  loginTimeoutMinutes: 2\n");
    expect((await loadConfig(file)).automation.loginTimeoutMinutes).toBe(2);
  });
});
