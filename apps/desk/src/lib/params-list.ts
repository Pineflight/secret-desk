import type { ParamSuggestion } from "@secret-desk/runtime";

/** Filter und Sammelvorschlag "Parameter vervollstaendigen" der Secrets-Liste. Rein; geschrieben wird nur nach Klick des Menschen. */
type ParamStatus = "ok" | "missing" | "invalid" | "none";
export interface WithParams {
  params: { status: ParamStatus; missing: string[] };
}

export const PARAM_FILTERS = ["", "missing"] as const;
export type ParamFilter = (typeof PARAM_FILTERS)[number];

/** Fehlen Pflichtparameter (oder sind welche unbrauchbar)? "none" und "ok" brauchen nichts. */
export const needsParams = (s: WithParams): boolean => s.params.status === "missing" || s.params.status === "invalid";

export function filterByParams<T extends WithParams>(items: readonly T[], filter: string): T[] {
  return filter === "missing" ? items.filter(needsParams) : [...items];
}

export const countNeedingParams = (items: readonly WithParams[]): number => items.filter(needsParams).length;

export type SuggestionValue = NonNullable<ParamSuggestion["suggestions"][string]>;

/** Schluessel mit einem Vorschlag, in der Reihenfolge der fehlenden Parameter. */
export function suggestedKeys(row: Pick<ParamSuggestion, "missing" | "suggestions">): string[] {
  return row.missing.filter((k) => row.suggestions[k] != null);
}

/** Koerper fuer PUT params einer Zeile: nur Parameter mit einem Vorschlag. Leer, wenn es keinen gibt. */
export function suggestionBody(row: Pick<ParamSuggestion, "missing" | "suggestions">): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of suggestedKeys(row)) out[k] = row.suggestions[k]!.value;
  return out;
}

/** Eindeutig = jeder fehlende Parameter hat einen Vorschlag (Status "suggested"). Teilvorschlaege und Mehrdeutiges nie in "alle uebernehmen". */
export const isUnambiguous = (row: Pick<ParamSuggestion, "status" | "missing" | "suggestions">): boolean =>
  row.status === "suggested" && row.missing.length > 0 && suggestedKeys(row).length === row.missing.length;

export const unambiguousRows = <T extends Pick<ParamSuggestion, "status" | "missing" | "suggestions">>(rows: readonly T[]): T[] => rows.filter(isUnambiguous);

export const canApplyRow = (row: Pick<ParamSuggestion, "missing" | "suggestions">): boolean => suggestedKeys(row).length > 0;

export type RowState = "open" | "applied" | "error";
