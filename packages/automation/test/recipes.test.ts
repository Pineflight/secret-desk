import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipes, loadRecipesDetailed, loginMethodsOf } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");

describe("bundled recipes", () => {
  it("load and are valid", async () => {
    const recipes = await loadRecipes([RECIPES]);
    expect(recipes.map((r) => r.id).sort()).toEqual(["anthropic-admin-key", "anthropic-api-key", "github-fine-grained-token", "openai-admin-key", "openai-api-key", "peecho-api-keys", "revenuecat-secret-api-key", "stripe-restricted-key", "supabase-access-token", "vesselapi-api-key"]);
  });
  it("openai-admin-key has a guided sign-in, captures only an admin key and says it is unverified", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "openai-admin-key")!;
    expect(r.host).toBe("platform.openai.com");
    expect(r.login?.form?.start).toBe("https://platform.openai.com/login");
    expect(r.login?.form?.home).toBe("https://platform.openai.com/");
    expect(r.capture.token.pattern).toBe("^(sk-admin-[A-Za-z0-9_-]+)$");
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
    expect(r.steps.find((s) => "click" in s && s.click.createsToken)).toMatchObject({ click: { role: "button", name: "Create admin key", exact: true } });
    expect(r.steps.find((s) => "fill" in s)).toMatchObject({ fill: { placeholder: "My Test Key", value: "{{name}}" } });
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google", "apple", "microsoft"]);
    expect(new RegExp(r.capture.token.pattern!).test("sk-proj-abc")).toBe(false);
    expect((await readFile(join(RECIPES, "openai-admin-key.yaml"), "utf8")).split("\n")[0]).toMatch(/^# STATUS: key creation verified live on 2026-11-03/);
  });
  it("anthropic-admin-key has a passwordless email sign-in with a code step, a Google button, and captures only an admin key", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "anthropic-admin-key")!;
    expect(r.host).toBe("platform.claude.com");
    expect(r.allowHosts).toEqual(["console.anthropic.com"]);
    expect(r.login?.form).toMatchObject({ passwordless: true, start: "https://platform.claude.com/login" });
    expect(r.login?.form?.mfa).toBeDefined();
    expect(JSON.stringify(r.login?.form?.steps)).not.toContain("login.password");
    expect(loginMethodsOf(r).map((m) => m.id)).toEqual(["email", "google"]);
    expect(r.login?.methods?.find((m) => m.id === "google")?.steps?.[1]).toMatchObject({ click: { role: "button", name: "Continue with Google" } });
    const pattern = new RegExp(r.capture.token.pattern!);
    expect(pattern.test("sk-ant-admin01-AbC_d-123")).toBe(true);
    expect(pattern.test("sk-ant-api03-AbC_d-123")).toBe(false);
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
    expect(r.steps.find((s) => "click" in s && s.click.createsToken)).toBeDefined();
    expect(r.mask.length).toBeGreaterThan(0);
  });
  it("anthropic-api-key takes an optional workspace (default: Default), names the key and captures only an API key", async () => {
    const r = (await loadRecipes([RECIPES])).find((x) => x.id === "anthropic-api-key")!;
    expect(r.host).toBe("platform.claude.com");
    expect(r.params).toMatchObject([{ key: "workspace", required: false, default: "Default" }]);
    expect(r.steps.find((s) => "fill" in s)).toMatchObject({ fill: { value: "{{name}}" } });
    expect(r.steps.some((s) => "click" in s && s.click.role === "option" && s.click.name === "{{workspace}}")).toBe(true);
    expect(r.capture.externalId).toEqual({ from: "name" });
    const pattern = new RegExp(r.capture.token.pattern!);
    expect(pattern.test("sk-ant-api03-AbC_d-123")).toBe(true);
    expect(pattern.test("sk-ant-admin01-AbC_d-123")).toBe(false);
    expect(r.revoke?.steps.length).toBeGreaterThan(0);
  });
  it("the anthropic recipes say that nothing is verified live", async () => {
    for (const f of ["anthropic-admin-key.yaml", "anthropic-api-key.yaml"]) {
      expect((await readFile(join(RECIPES, f), "utf8")).split("\n")[0], f).toMatch(/^# STATUS: nothing of this recipe is verified live/);
    }
  });
  it("carry the status comment (format only: first line starts with `# STATUS:`)", async () => {
    const files = (await readdir(RECIPES)).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const first = (await readFile(join(RECIPES, f), "utf8")).split("\n")[0] ?? "";
      expect(first, f).toMatch(/^# STATUS: \S/);
    }
  });
});

describe("loadRecipes", () => {
  it("reports file and path in the document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipes-"));
    await writeFile(join(dir, "kaputt.yaml"), "id: a\nlabel: A\nhost: example.test\nsteps:\n  - fill: { value: x }\ncapture: { token: { find: { css: '#t' } } }\n");
    await writeFile(join(dir, "yaml.yaml"), "id: [\n");
    const { recipes, errors } = await loadRecipesDetailed([dir, join(dir, "gibt-es-nicht")]);
    expect(recipes).toEqual([]);
    const msg = errors.map((e) => e.message).join("\n");
    expect(msg).toContain("kaputt.yaml");
    expect(msg).toMatch(/steps\.0\.fill/);
    expect(msg).toContain("yaml.yaml");
    await expect(loadRecipes([dir])).rejects.toThrow(/kaputt\.yaml/);
  });
  it("later folder overrides the same id", async () => {
    const a = await mkdtemp(join(tmpdir(), "recipes-"));
    const b = await mkdtemp(join(tmpdir(), "recipes-"));
    const doc = (label: string) => `id: dup\nlabel: ${label}\nhost: example.test\nsteps:\n  - click: { role: button, name: Go, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
    await writeFile(join(a, "x.yaml"), doc("A"));
    await writeFile(join(b, "x.yaml"), doc("B"));
    expect((await loadRecipes([a, b]))[0]?.label).toBe("B");
  });
});

describe("protection of bundled recipes", () => {
  const yaml = (id: string, host = "example.test") => `id: ${id}\nlabel: X\nhost: ${host}\nallowHosts: [cdn.example.test]\nsteps:\n  - goto: "https://${host}/t"\n  - click: { role: button, name: Create, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
  it("external recipes may not override bundled ones", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const ext = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(ext, "a.yaml"), yaml("a", "boese.test"));
    await writeFile(join(ext, "b.yaml"), yaml("b"));
    const { recipes, errors } = await loadRecipesDetailed([ext, bundled], { bundledDirs: [bundled], allowExternal: true });
    expect(recipes.find((r) => r.recipe.id === "a")!.host).toBe("example.test");
    expect(recipes.map((r) => r.recipe.id).sort()).toEqual(["a", "b"]);
    expect(errors.map((e) => e.message).join()).toContain("mitgelieferten");
  });
  it("external folders are not loaded without allowExternal", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const ext = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(ext, "b.yaml"), yaml("b"));
    const { recipes, skippedDirs } = await loadRecipesDetailed([bundled, ext], { bundledDirs: [bundled] });
    expect(recipes.map((r) => r.recipe.id)).toEqual(["a"]);
    expect(skippedDirs).toEqual([ext]);
  });
  it("a missing or empty external folder is not reported as skipped", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const empty = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(empty, "notes.txt"), "no recipes here");
    const { skippedDirs } = await loadRecipesDetailed([bundled, empty, join(empty, "missing")], { bundledDirs: [bundled] });
    expect(skippedDirs).toEqual([]);
  });
  it("returns SHA-256, host and allowHosts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rb-"));
    const text = yaml("a");
    await writeFile(join(dir, "a.yaml"), text);
    const [r] = (await loadRecipesDetailed([dir], { bundledDirs: [dir] })).recipes;
    expect(r!.sha256).toBe((await import("node:crypto")).createHash("sha256").update(text).digest("hex"));
    expect(r!.host).toBe("example.test");
    expect(r!.allowHosts).toEqual(["cdn.example.test"]);
    expect(r!.bundled).toBe(true);
  });
});
