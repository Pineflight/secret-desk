import type { Place } from "@secret-desk/core";
import { translate } from "./i18n";

export interface PlaceRow {
  repo: string;
  scope: "repository" | "environment" | "cloudflare-worker";
  environment: string;
  /** Only for scope cloudflare-worker: the Cloudflare account and the deployed Worker name. */
  accountId?: string | undefined;
  script?: string | undefined;
}

export const emptyPlaceRow = (): PlaceRow => ({ repo: "", scope: "repository", environment: "" });

/** Wandelt Formularzeilen in Ziele um. Leere Zeilen entfallen, unvollständige liefern eine Fehlermeldung. */
export interface StageEnvInfo {
  stage: string;
  /** Wirksame Environment der Stage, null = keine (dev/shared). */
  environment: string | null;
}

/** Same shapes the server accepts (see WorkerPlaceSchema): a Cloudflare account id is 32 hex characters. */
export const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
export const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/**
 * Ohne `stage`: Umgebungsname Pflicht. Mit `stage`: leerer Name heisst "Environment der Stage", der Server setzt sie ein.
 * Hat die Stage keine, ist ein leerer Name ein Fehler.
 */
export function rowsToPlaces(rows: PlaceRow[], stage?: StageEnvInfo): { places: Place[]; error: string | null } {
  const places: Place[] = [];
  for (const r of rows) {
    if (r.scope === "cloudflare-worker") {
      const accountId = (r.accountId ?? "").trim();
      const script = (r.script ?? "").trim();
      if (!accountId && !script) continue;
      if (!accountId) return { places: [], error: translate("meta.placeNoAccount") };
      if (!ACCOUNT_ID_PATTERN.test(accountId)) return { places: [], error: translate("meta.placeBadAccount") };
      if (!script) return { places: [], error: translate("meta.placeNoScript") };
      if (!SCRIPT_NAME_PATTERN.test(script)) return { places: [], error: translate("meta.placeBadScript", { script }) };
      places.push({ scope: "cloudflare-worker", accountId, script });
      continue;
    }
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

/** The account a new Worker row starts with: the integration default, else the only account the token sees. */
export function defaultAccountId(res: { defaults: Record<string, unknown>; resources: Record<string, { status: string; options: { value: string | number }[] } | undefined> } | undefined): string {
  if (!res) return "";
  const d = res.defaults["accountId"];
  if (typeof d === "string" && d !== "") return d;
  const options = res.resources["cloudflare.account"];
  return options?.status === "ok" && options.options.length === 1 ? String(options.options[0]!.value) : "";
}
