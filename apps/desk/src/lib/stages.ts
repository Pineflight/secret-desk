import type { StageView } from "@secret-desk/runtime";

/** Reine Logik zu Stage-Definitionen (ohne React, ohne Netz): Sortierung, Farben, Anzeigename, Environment. */
export type StageKind = StageView["kind"];
export type StageDefLite = Pick<StageView, "id" | "kind"> & Partial<Pick<StageView, "label" | "tone" | "environmentName">>;
export type StageToneName = NonNullable<StageView["tone"]>;

/** Gilt, solange die Definitionen noch nicht geladen sind: entspricht den Standard-Stages des Inventars. */
export const FALLBACK_STAGES: StageDefLite[] = [
  { id: "dev", kind: "dev", environmentName: null },
  { id: "staging", kind: "test", environmentName: "staging" },
  { id: "production", kind: "live", environmentName: "production" },
  { id: "shared", kind: "shared", environmentName: null },
];

export const KIND_ORDER: StageKind[] = ["live", "test", "dev", "shared"];
export const KIND_TONES: Record<StageKind, StageToneName> = { dev: "info", test: "ki", live: "stage-prod", shared: "neutral" };
export const STAGE_KINDS: StageKind[] = ["dev", "test", "live", "shared"];

const find = (defs: readonly StageDefLite[], id: string): StageDefLite | undefined => defs.find((d) => d.id === id);

/** Unbekannte Stage gilt als live (wie im Kern: im Zweifel die strengste Art). */
export const kindOf = (defs: readonly StageDefLite[], id: string): StageKind => find(defs, id)?.kind ?? "live";
export const labelOf = (defs: readonly StageDefLite[], id: string): string => find(defs, id)?.label ?? id;
export const toneOf = (defs: readonly StageDefLite[], id: string): StageToneName => {
  const d = find(defs, id);
  return d ? (d.tone ?? KIND_TONES[d.kind]) : "neutral";
};

/** Wirksamer GitHub-Environment-Name der Stage, null = keine. */
export function environmentOf(defs: readonly StageDefLite[], id: string): string | null {
  const d = find(defs, id);
  if (!d) return null;
  if (d.environmentName !== undefined) return d.environmentName;
  return d.kind === "test" || d.kind === "live" ? d.id : null;
}

/** Reihenfolge der Ids: erst live, dann test, dev, shared; innerhalb einer Art wie definiert. */
export function stageOrder(defs: readonly StageDefLite[]): string[] {
  return KIND_ORDER.flatMap((k) => defs.filter((d) => d.kind === k).map((d) => d.id));
}

export const DEFAULT_ORDER: string[] = stageOrder(FALLBACK_STAGES);

export function stageRank(order: readonly string[], id: string): number {
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
}

export interface StageLook {
  label: string;
  tone: StageToneName;
  icon: "shield" | "dot";
}

export function stageLook(defs: readonly StageDefLite[], id: string): StageLook {
  const kind = find(defs, id)?.kind;
  return { label: labelOf(defs, id), tone: toneOf(defs, id), icon: kind === "live" ? "shield" : "dot" };
}

/** Id-Vorschlag aus einem Anzeigenamen. */
export const slugifyStage = (label: string): string =>
  label
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);

/** Standard-Stage fuer neue Eintraege: die erste der gewuenschten Art, sonst die erste ueberhaupt. */
export function defaultStageId(defs: readonly StageDefLite[], kind: StageKind): string {
  return (defs.find((d) => d.kind === kind) ?? defs[0])?.id ?? "";
}
