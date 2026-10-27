import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipes, loadRecipesDetailed } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");

describe("mitgelieferte Rezepte", () => {
  it("laden und sind gueltig", async () => {
    const recipes = await loadRecipes([RECIPES]);
    expect(recipes.map((r) => r.id).sort()).toEqual(["github-fine-grained-token", "stripe-restricted-key", "supabase-access-token"]);
  });
  it("tragen den Status-Kommentar", async () => {
    for (const f of await readdir(RECIPES)) {
      expect(await readFile(join(RECIPES, f), "utf8")).toMatch(/^# STATUS: nicht gegen die echte Seite geprueft/);
    }
  });
});

describe("loadRecipes", () => {
  it("meldet Datei und Pfad im Dokument", async () => {
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
  it("spaeterer Ordner ueberstimmt gleiche Id", async () => {
    const a = await mkdtemp(join(tmpdir(), "recipes-"));
    const b = await mkdtemp(join(tmpdir(), "recipes-"));
    const doc = (label: string) => `id: dup\nlabel: ${label}\nhost: example.test\nsteps:\n  - click: { role: button, name: Go, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
    await writeFile(join(a, "x.yaml"), doc("A"));
    await writeFile(join(b, "x.yaml"), doc("B"));
    expect((await loadRecipes([a, b]))[0]?.label).toBe("B");
  });
});

describe("Schutz mitgelieferter Rezepte", () => {
  const yaml = (id: string, host = "example.test") => `id: ${id}\nlabel: X\nhost: ${host}\nallowHosts: [cdn.example.test]\nsteps:\n  - goto: "https://${host}/t"\n  - click: { role: button, name: Create, createsToken: true }\ncapture: { token: { find: { css: '#t' } } }\n`;
  it("externe Rezepte duerfen mitgelieferte nicht ueberschreiben", async () => {
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
  it("externe Ordner werden ohne allowExternal nicht geladen", async () => {
    const bundled = await mkdtemp(join(tmpdir(), "rb-"));
    const ext = await mkdtemp(join(tmpdir(), "re-"));
    await writeFile(join(bundled, "a.yaml"), yaml("a"));
    await writeFile(join(ext, "b.yaml"), yaml("b"));
    const { recipes, skippedDirs } = await loadRecipesDetailed([bundled, ext], { bundledDirs: [bundled] });
    expect(recipes.map((r) => r.recipe.id)).toEqual(["a"]);
    expect(skippedDirs).toEqual([ext]);
  });
  it("liefert SHA-256, Host und allowHosts", async () => {
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
