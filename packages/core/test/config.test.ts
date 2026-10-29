import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "../src/config.js";

const BASE = { inventory: "./inventory.yaml", github: { owner: "acme", auth: { type: "pat" } } };

describe("configuration: automation", () => {
  it("has safe defaults without input", () => {
    const c = ConfigSchema.parse(BASE);
    expect(c.automation).toEqual({ enabled: true, loginTimeoutMinutes: 10, allowExternalRecipes: false });
  });

  it("accepts all fields", () => {
    const c = ConfigSchema.parse({ ...BASE, automation: { enabled: false, chromePath: "/usr/bin/chromium", profileDir: "~/p", loginTimeoutMinutes: 3, slowMoMs: 150, recipesDirs: ["rezepte", "~/mehr"], allowExternalRecipes: true } });
    expect(c.automation).toEqual({ enabled: false, chromePath: "/usr/bin/chromium", profileDir: "~/p", loginTimeoutMinutes: 3, slowMoMs: 150, recipesDirs: ["rezepte", "~/mehr"], allowExternalRecipes: true });
  });

  it("rejects nonsensical values", () => {
    expect(ConfigSchema.safeParse({ ...BASE, automation: { loginTimeoutMinutes: 0 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { slowMoMs: -1 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { chromePath: "" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...BASE, automation: { recipesDirs: [""] } }).success).toBe(false);
  });

  it("is read from the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cfg-"));
    const file = join(dir, "c.yaml");
    await writeFile(file, "inventory: ./i.yaml\ngithub:\n  owner: P\n  auth: { type: pat }\nautomation:\n  loginTimeoutMinutes: 2\n");
    expect((await loadConfig(file)).automation.loginTimeoutMinutes).toBe(2);
  });
});

describe("configuration: compare", () => {
  it("ignoreRepos defaults to the organization repositories and accepts own lists", () => {
    expect(ConfigSchema.parse(BASE).compare).toEqual({ ignoreRepos: [".github", ".github-private"] });
    expect(ConfigSchema.parse({ ...BASE, compare: { ignoreRepos: ["status"] } }).compare.ignoreRepos).toEqual(["status"]);
    expect(ConfigSchema.parse({ ...BASE, compare: {} }).compare.ignoreRepos).toEqual([".github", ".github-private"]);
    expect(ConfigSchema.safeParse({ ...BASE, compare: { ignoreRepos: [""] } }).success).toBe(false);
  });
});
