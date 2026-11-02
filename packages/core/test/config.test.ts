import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig, parseCdpEndpoint, redactCdpEndpoint } from "../src/config.js";

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

  it("accepts a remote browser endpoint (http, https, ws, wss) and rejects everything else", () => {
    for (const ok of ["http://browser:9222", "https://b.example/path", "ws://127.0.0.1:9222/devtools/browser/x", "wss://b:1"]) {
      expect(ConfigSchema.parse({ ...BASE, automation: { cdpEndpoint: ok } }).automation.cdpEndpoint).toBe(ok);
    }
    for (const bad of ["", "browser:9222x y", "file:///etc/passwd", "ftp://b", "javascript:alert(1)", "not a url"]) {
      expect(ConfigSchema.safeParse({ ...BASE, automation: { cdpEndpoint: bad } }).success, bad).toBe(false);
    }
  });

  it("parses and redacts endpoints without echoing credentials", () => {
    expect(redactCdpEndpoint("http://u:p@browser:9222/?token=x#y")).toBe("http://browser:9222");
    expect(redactCdpEndpoint("ws://b:9222/devtools/browser/abc")).toBe("ws://b:9222/devtools/browser/abc");
    expect(() => parseCdpEndpoint("ftp://u:hunter2@b")).toThrow(/only http/);
    try {
      parseCdpEndpoint("ftp://u:hunter2@b");
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
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

describe("configuration: naming", () => {
  it("is empty by default", () => {
    expect(ConfigSchema.parse(BASE).naming).toEqual({ renames: {}, keep: [] });
  });
  it("accepts renames and keep, and rejects a new name that is not upper snake case", () => {
    expect(ConfigSchema.parse({ ...BASE, naming: { renames: { MAIL_API_KEY: "RESEND_API_KEY" }, keep: ["LEGACY_KEY"] } }).naming).toEqual({ renames: { MAIL_API_KEY: "RESEND_API_KEY" }, keep: ["LEGACY_KEY"] });
    expect(ConfigSchema.safeParse({ ...BASE, naming: { renames: { MAIL_API_KEY: "resend-key" } } }).success).toBe(false);
  });
});
