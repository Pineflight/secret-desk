import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { RecipeSchema, type Recipe } from "./recipe.js";

export interface LoadedRecipe {
  recipe: Recipe;
  file: string;
  /** SHA-256 (hex) des Dateiinhalts: die UI zeigt ihn, damit eine Aenderung am Rezept auffaellt. */
  sha256: string;
  /** Host und weitere erlaubte Hosts, auf denen das Rezept den Browser bedient. */
  host: string;
  allowHosts: string[];
  /** Aus einem mitgelieferten Ordner (bundledDirs). */
  bundled: boolean;
}
export interface LoadOptions {
  /** Ordner mit mitgelieferten Rezepten. Ihre Ids koennen von anderen Ordnern nicht ueberschrieben werden. */
  bundledDirs?: string[];
  /** Rezepte aus anderen Ordnern laden. Gilt nur, wenn bundledDirs gesetzt ist; sonst werden alle Ordner geladen. Standard false, sobald bundledDirs gesetzt ist. */
  allowExternal?: boolean;
}
export interface RecipeLoadError {
  file: string;
  message: string;
}

/** Eine Rezeptdatei lesen. Fehler nennen Dateiname und Pfad im Dokument. */
export async function loadRecipeFile(file: string): Promise<Recipe> {
  return parseRecipeText(file, await readFile(file, "utf8"));
}

function parseRecipeText(file: string, text: string): Recipe {
  let doc: unknown;
  try {
    doc = parse(text, { schema: "core" });
  } catch (err) {
    throw new Error(`${file}: kein gueltiges YAML (${(err as Error).message.split("\n")[0]})`);
  }
  const parsed = RecipeSchema.safeParse(doc);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${file}: ${i.path.length ? i.path.join(".") : "(Dokument)"}: ${i.message}`);
    throw new Error(lines.join("\n"));
  }
  return parsed.data;
}

/**
 * Alle *.yaml in den Ordnern lesen, ohne bei der ersten kaputten Datei abzubrechen. Fehlende Ordner werden uebersprungen.
 * Mitgelieferte Rezepte (bundledDirs) werden zuerst geladen und gewinnen: ein Rezept mit gleicher Id aus einem anderen Ordner
 * wird als Fehler gemeldet und nicht geladen. Andere Ordner nur mit allowExternal.
 */
export async function loadRecipesDetailed(dirs: string[], options: LoadOptions = {}): Promise<{ recipes: LoadedRecipe[]; errors: RecipeLoadError[]; skippedDirs: string[] }> {
  const bundledDirs = options.bundledDirs ?? [];
  const guarded = bundledDirs.length > 0;
  const allowExternal = options.allowExternal ?? !guarded;
  const byId = new Map<string, LoadedRecipe>();
  const errors: RecipeLoadError[] = [];
  const skippedDirs: string[] = [];
  const isBundled = (d: string): boolean => bundledDirs.includes(d);
  const ordered = [...dirs.filter(isBundled), ...dirs.filter((d) => !isBundled(d))];
  for (const dir of ordered) {
    const bundled = isBundled(dir);
    if (guarded && !bundled && !allowExternal) {
      skippedDirs.push(dir);
      continue;
    }
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        const text = await readFile(file, "utf8");
        const recipe = parseRecipeText(file, text);
        const existing = byId.get(recipe.id);
        if (existing?.bundled && !bundled) {
          errors.push({ file, message: `${file}: Die Id "${recipe.id}" gehoert zu einem mitgelieferten Rezept und kann nicht ueberschrieben werden. Das mitgelieferte Rezept gilt.` });
          continue;
        }
        byId.set(recipe.id, { recipe, file, sha256: createHash("sha256").update(text).digest("hex"), host: recipe.host, allowHosts: recipe.allowHosts, bundled });
      } catch (err) {
        errors.push({ file, message: (err as Error).message });
      }
    }
  }
  return { recipes: [...byId.values()], errors, skippedDirs };
}

/** Wie loadRecipesDetailed, wirft aber bei der ersten ungueltigen Datei. */
export async function loadRecipes(dirs: string[], options: LoadOptions = {}): Promise<Recipe[]> {
  const { recipes, errors } = await loadRecipesDetailed(dirs, options);
  if (errors[0]) throw new Error(errors.map((e) => e.message).join("\n"));
  return recipes.map((r) => r.recipe);
}
