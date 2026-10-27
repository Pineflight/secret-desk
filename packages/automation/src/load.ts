import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { RecipeSchema, type Recipe } from "./recipe.js";

export interface LoadedRecipe {
  recipe: Recipe;
  file: string;
}
export interface RecipeLoadError {
  file: string;
  message: string;
}

/** Eine Rezeptdatei lesen. Fehler nennen Dateiname und Pfad im Dokument. */
export async function loadRecipeFile(file: string): Promise<Recipe> {
  let doc: unknown;
  try {
    doc = parse(await readFile(file, "utf8"), { schema: "core" });
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

/** Alle *.yaml in den Ordnern lesen, ohne bei der ersten kaputten Datei abzubrechen. Fehlende Ordner werden uebersprungen. */
export async function loadRecipesDetailed(dirs: string[]): Promise<{ recipes: LoadedRecipe[]; errors: RecipeLoadError[] }> {
  const byId = new Map<string, LoadedRecipe>();
  const errors: RecipeLoadError[] = [];
  for (const dir of dirs) {
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
        const recipe = await loadRecipeFile(file);
        byId.set(recipe.id, { recipe, file }); // spaeterer Ordner ueberstimmt (eigene Rezepte vor mitgelieferten)
      } catch (err) {
        errors.push({ file, message: (err as Error).message });
      }
    }
  }
  return { recipes: [...byId.values()], errors };
}

/** Wie loadRecipesDetailed, wirft aber bei der ersten ungueltigen Datei. */
export async function loadRecipes(dirs: string[]): Promise<Recipe[]> {
  const { recipes, errors } = await loadRecipesDetailed(dirs);
  if (errors[0]) throw new Error(errors.map((e) => e.message).join("\n"));
  return recipes.map((r) => r.recipe);
}
