import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ordner mit den mitgelieferten Rezepten (<Repo>/recipes). Das Paket liegt in packages/automation/{src,dist};
 * die Rezepte liegen im Repo-Wurzelverzeichnis, nicht im Paket (Rezepte werden per Pull Request gepflegt).
 */
export function bundledRecipesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "recipes");
}
