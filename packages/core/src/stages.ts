import { z } from "zod";

/**
 * Stage-Definitionen: frei benennbar, das Verhalten haengt nur an der Art (kind).
 * dev = lokal, test = Sandbox/Test, live = Produktionsgrad, shared = passt zu allen.
 */
export const STAGE_KINDS = ["dev", "test", "live", "shared"] as const;
export const StageKindSchema = z.enum(STAGE_KINDS);
export type StageKind = z.infer<typeof StageKindSchema>;

/** Farbtoene des Portals (siehe apps/desk lib/status.ts). */
export const STAGE_TONES = ["info", "ki", "stage-prod", "neutral", "primary", "success", "warn"] as const;
export const StageToneSchema = z.enum(STAGE_TONES);
export type StageTone = z.infer<typeof StageToneSchema>;

export const MAX_STAGES = 12;

export const StageIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Stage-Id in kleinbuchstaben-mit-bindestrich");

export const StageDefSchema = z.object({
  id: StageIdSchema,
  label: z.string().min(1).max(40).optional(),
  kind: StageKindSchema,
  /** Name der GitHub-Environment. Fehlt er: id (test/live) bzw. keine Environment (dev/shared). null = bewusst keine. */
  environment: z.string().min(1).max(100).nullable().optional(),
  tone: StageToneSchema.optional(),
});
export type StageDef = z.infer<typeof StageDefSchema>;

export const DEFAULT_STAGES: readonly StageDef[] = [
  { id: "dev", kind: "dev", environment: null },
  { id: "staging", kind: "test", environment: "staging" },
  { id: "production", kind: "live", environment: "production" },
  { id: "shared", kind: "shared", environment: null },
];

/** Standardfarbe je Art, wenn die Definition keine tone setzt. */
export const KIND_TONES: Record<StageKind, StageTone> = { dev: "info", test: "ki", live: "stage-prod", shared: "neutral" };

/** Leere oder fehlende Liste = Standard-Stages (Rueckwaertskompatibilitaet). */
export function effectiveStages(defs: readonly StageDef[] | undefined): StageDef[] {
  return defs && defs.length > 0 ? [...defs] : DEFAULT_STAGES.map((d) => ({ ...d }));
}

export const stageIds = (defs: readonly StageDef[]): string[] => defs.map((d) => d.id);

export const findStage = (defs: readonly StageDef[], id: string): StageDef | undefined => defs.find((d) => d.id === id);

/** Art einer Stage. Unbekannte Stage gilt als live: im Zweifel die strengste Behandlung. */
export function stageKind(defs: readonly StageDef[], id: string): StageKind {
  return findStage(defs, id)?.kind ?? "live";
}

/** Art fuer Code ohne Inventar-Zugriff: aus dem Kontext, sonst ueber die Standard-Stages. */
export const contextKind = (ctx: { stage: string; stageKind?: StageKind | undefined }): StageKind => ctx.stageKind ?? stageKind(DEFAULT_STAGES, ctx.stage);

export const stageLabel = (defs: readonly StageDef[], id: string): string => findStage(defs, id)?.label ?? id;

export const stageTone = (defs: readonly StageDef[], id: string): StageTone => {
  const d = findStage(defs, id);
  return d ? (d.tone ?? KIND_TONES[d.kind]) : "neutral";
};

/** GitHub-Environment der Stage, oder null wenn sie keine hat. */
export function stageEnvironment(def: StageDef): string | null {
  if (def.environment !== undefined) return def.environment;
  return def.kind === "test" || def.kind === "live" ? def.id : null;
}

/** Fehlermeldungen fuer eine Liste von Definitionen (leer = gueltig). */
export function stageDefIssues(defs: readonly StageDef[]): string[] {
  const out: string[] = [];
  if (defs.length > MAX_STAGES) out.push(`hoechstens ${MAX_STAGES} Stages`);
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) out.push(`Stage-Id doppelt: ${d.id}`);
    seen.add(d.id);
  }
  return out;
}

export class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}

interface PlaceLike {
  scope: "repository" | "environment" | "organization";
  environment?: string | undefined;
}

/**
 * Setzt bei scope "environment" ohne Namen die Environment der Stage ein.
 * Hat die Stage keine (dev/shared), ist das ein Fehler. Unbekannte Stage: StageError.
 */
export function resolvePlaces<P extends PlaceLike>(defs: readonly StageDef[], stageId: string, places: readonly P[]): P[] {
  const def = findStage(defs, stageId);
  if (!def) throw new StageError(`Unbekannte Stage: ${stageId}`);
  return places.map((p) => {
    if (p.scope !== "environment" || p.environment) return { ...p };
    const env = stageEnvironment(def);
    if (!env) throw new StageError(`Stage ${stageId} hat keine GitHub-Environment (Art ${def.kind}): Bereich Umgebung braucht einen Namen oder eine andere Stage`);
    return { ...p, environment: env };
  });
}
