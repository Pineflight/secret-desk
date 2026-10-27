/** Reine Logik der Variablen-Liste: Abgleichstatus je Variable zusammenfassen, danach filtern, Sollwert kuerzen. */

export type DriftKind = "in-sync" | "missing" | "different" | "unknown-expected" | "unreachable";
export type DriftSummary = DriftKind | "not-compared";

/** Filterwerte in Anzeigereihenfolge. */
export const DRIFT_FILTERS: readonly DriftSummary[] = ["not-compared", "in-sync", "different", "missing", "unreachable", "unknown-expected"];

/** Der schlechteste Zustand gewinnt. */
const WORST_FIRST: readonly DriftKind[] = ["unreachable", "missing", "different", "unknown-expected", "in-sync"];

/** Fasst die Ergebnisse je Ziel zusammen. Ohne Ergebnis (nie verglichen) oder ohne Ziele: "not-compared". */
export function summarizeDrift(drift: readonly { state: string }[] | null | undefined): DriftSummary {
  if (!drift || drift.length === 0) return "not-compared";
  for (const s of WORST_FIRST) if (drift.some((d) => d.state === s)) return s;
  return "not-compared";
}

/** Zaehlt die Zustaende, z. B. fuer "2 weichen ab". */
export function countDrift(drift: readonly { state: string }[] | null | undefined): Partial<Record<DriftKind, number>> {
  const out: Partial<Record<DriftKind, number>> = {};
  for (const d of drift ?? []) out[d.state as DriftKind] = (out[d.state as DriftKind] ?? 0) + 1;
  return out;
}

/** Sind schon Ergebnisse bekannt? Erst dann lohnt der Status-Filter. */
export function anyCompared(drifts: Readonly<Record<string, readonly { state: string }[] | undefined>>, ids?: readonly string[]): boolean {
  return (ids ?? Object.keys(drifts)).some((id) => (drifts[id]?.length ?? 0) > 0);
}

/** Filtert nach zusammengefasstem Abgleichstatus. Leerer Filter laesst alles durch. */
export function filterByDrift<T extends { id: string }>(items: readonly T[], drifts: Readonly<Record<string, readonly { state: string }[] | undefined>>, status: string): T[] {
  if (!status) return [...items];
  return items.filter((i) => summarizeDrift(drifts[i.id]) === status);
}

/** Kuerzt einen Sollwert auf eine Zeile. Mehrzeiliges wird zusammengezogen. */
export function shortValue(value: string | null | undefined, max = 32): string {
  if (value === null || value === undefined) return "";
  const t = value.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Fortschrittstext "3/25". */
export function progressText(done: number, total: number): string {
  return `${done}/${total}`;
}
