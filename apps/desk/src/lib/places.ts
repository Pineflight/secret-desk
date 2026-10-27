import type { Place } from "@secret-desk/core";
import { translate } from "./i18n";

export interface PlaceRow {
  repo: string;
  scope: "repository" | "environment";
  environment: string;
}

export const emptyPlaceRow = (): PlaceRow => ({ repo: "", scope: "repository", environment: "" });

/** Wandelt Formularzeilen in Ziele um. Leere Zeilen entfallen, unvollständige liefern eine Fehlermeldung. */
export function rowsToPlaces(rows: PlaceRow[]): { places: Place[]; error: string | null } {
  const places: Place[] = [];
  for (const r of rows) {
    const repo = r.repo.trim();
    const env = r.environment.trim();
    if (!repo && !env) continue;
    if (!repo) return { places: [], error: translate("meta.placeNoRepo") };
    if (r.scope === "environment") {
      if (!env) return { places: [], error: translate("meta.placeNoEnv", { repo }) };
      places.push({ repo, scope: "environment", environment: env });
    } else places.push({ repo, scope: "repository" });
  }
  return { places, error: null };
}
