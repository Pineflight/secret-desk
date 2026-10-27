import type { StageView } from "@secret-desk/runtime";
import { KIND_TONES, STAGE_KINDS, slugifyStage, type StageKind, type StageToneName } from "./stages";

/** Formularzeile der Einstellungen: Texte statt null/undefined, damit Eingabefelder einfach bleiben. */
export interface StageDraft {
  id: string;
  label: string;
  kind: StageKind;
  /** Leer = Standard der Art (id bei test/live, sonst keine). */
  environment: string;
  /** Ausdruecklich keine GitHub-Environment. */
  noEnvironment: boolean;
  /** Leer = Standardfarbe der Art. */
  tone: StageToneName | "";
  isNew: boolean;
  usage: { secrets: number; variables: number; templates: number; policy: boolean };
}

export const MAX_STAGES = 12;
export const TONE_CHOICES: StageToneName[] = ["info", "ki", "stage-prod", "neutral", "primary", "success", "warn"];

export const emptyUsage = (): StageDraft["usage"] => ({ secrets: 0, variables: 0, templates: 0, policy: false });

export function toDrafts(stages: readonly StageView[]): StageDraft[] {
  return stages.map((s) => ({
    id: s.id,
    label: s.label ?? "",
    kind: s.kind,
    environment: typeof s.environment === "string" ? s.environment : "",
    noEnvironment: s.environment === null,
    tone: s.tone ?? "",
    isNew: false,
    usage: s.usage,
  }));
}

export const newDraft = (kind: StageKind = "test"): StageDraft => ({ id: "", label: "", kind, environment: "", noEnvironment: false, tone: "", isNew: true, usage: emptyUsage() });

/** Standardname der Environment fuer die Anzeige als Platzhalter. */
export const defaultEnvironment = (d: Pick<StageDraft, "id" | "kind">): string | null => (d.kind === "test" || d.kind === "live" ? d.id || null : null);

export function toPayload(drafts: readonly StageDraft[]): Record<string, unknown>[] {
  return drafts.map((d) => ({
    id: d.id.trim(),
    kind: d.kind,
    ...(d.label.trim() ? { label: d.label.trim() } : {}),
    ...(d.noEnvironment ? { environment: null } : d.environment.trim() ? { environment: d.environment.trim() } : {}),
    ...(d.tone ? { tone: d.tone } : {}),
  }));
}

export const usageTotal = (u: StageDraft["usage"]): number => u.secrets + u.variables + u.templates + (u.policy ? 1 : 0);

export type DraftProblem =
  | { code: "empty" }
  | { code: "max" }
  | { code: "id"; row: number }
  | { code: "duplicate"; id: string };

/** Pruefung vor dem Speichern (der Server prueft erneut). Erstes Problem oder null. */
export function validateDrafts(drafts: readonly StageDraft[]): DraftProblem | null {
  if (drafts.length === 0) return { code: "empty" };
  if (drafts.length > MAX_STAGES) return { code: "max" };
  const seen = new Set<string>();
  for (const [row, d] of drafts.entries()) {
    const id = d.id.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) return { code: "id", row };
    if (seen.has(id)) return { code: "duplicate", id };
    seen.add(id);
  }
  return null;
}

/** Id-Vorschlag, solange die Zeile neu ist und der Nutzer die Id nicht selbst angefasst hat. */
export const suggestId = (label: string): string => slugifyStage(label);

export const kindTone = (kind: StageKind): StageToneName => KIND_TONES[kind];
export { STAGE_KINDS };
