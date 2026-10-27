import type { Place } from "@secret-desk/core";
import { translate } from "./i18n";

export interface PlaceRow {
  repo: string;
  scope: "repository" | "environment";
  environment: string;
}

export const emptyPlaceRow = (): PlaceRow => ({ repo: "", scope: "repository", environment: "" });

/** Wandelt Formularzeilen in Ziele um. Leere Zeilen entfallen, unvollständige liefern eine Fehlermeldung. */
export interface StageEnvInfo {
  stage: string;
  /** Wirksame Environment der Stage, null = keine (dev/shared). */
  environment: string | null;
}

/**
 * Ohne `stage`: Umgebungsname Pflicht. Mit `stage`: leerer Name heisst "Environment der Stage", der Server setzt sie ein.
 * Hat die Stage keine, ist ein leerer Name ein Fehler.
 */
export function rowsToPlaces(rows: PlaceRow[], stage?: StageEnvInfo): { places: Place[]; error: string | null } {
  const places: Place[] = [];
  for (const r of rows) {
    const repo = r.repo.trim();
    const env = r.environment.trim();
    if (!repo && !env) continue;
    if (!repo) return { places: [], error: translate("meta.placeNoRepo") };
    if (r.scope === "environment") {
      if (!env && !stage) return { places: [], error: translate("meta.placeNoEnv", { repo }) };
      if (!env && stage && stage.environment === null) return { places: [], error: translate("meta.placeStageNoEnv", { repo, stage: stage.stage }) };
      places.push(env ? { repo, scope: "environment", environment: env } : { repo, scope: "environment" });
    } else places.push({ repo, scope: "repository" });
  }
  return { places, error: null };
}
