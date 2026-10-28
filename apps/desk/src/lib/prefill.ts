import type { PlaceRow } from "./places";
import { environmentOf } from "./stages";
import type { StageDefLite } from "./stages";

/** Vorbelegung der Neu-Dialoge per Link (zum Beispiel aus dem Vergleich: "Ins Inventar aufnehmen"). */
export interface Prefill {
  name: string;
  repo: string;
  stage: string;
  id: string;
  description: string;
}

export const PREFILL_KEYS = ["pf_name", "pf_repo", "pf_stage", "pf_id", "pf_desc"] as const;

/** Liest die Vorbelegung aus der Adresse; ohne Namen keine Vorbelegung. */
export function readPrefill(params: URLSearchParams): Prefill | null {
  const name = params.get("pf_name");
  if (!name) return null;
  return { name, repo: params.get("pf_repo") ?? "", stage: params.get("pf_stage") ?? "", id: params.get("pf_id") ?? "", description: params.get("pf_desc") ?? "" };
}

/** Entfernt Neu-Marke und Vorbelegung aus der Adresse. */
export function withoutPrefill(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  next.delete("neu");
  for (const k of PREFILL_KEYS) next.delete(k);
  return next;
}

/** Zielzeile: Environment der Stage, wenn sie eine hat, sonst die Repo-Ebene. */
export function prefillRow(defs: readonly StageDefLite[], p: Prefill): PlaceRow {
  return { repo: p.repo, scope: p.stage && environmentOf(defs, p.stage) ? "environment" : "repository", environment: "" };
}
