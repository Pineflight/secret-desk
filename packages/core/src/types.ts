import { z } from "zod";
import { VariableSourceSchema } from "./variable-sources.js";
import { DEFAULT_STAGES, StageDefSchema, StageIdSchema, effectiveStages, findStage, resolvePlaces, stageDefIssues, stageKind } from "./stages.js";

/** Id einer Stage (Slug). Ob sie existiert, prueft das Inventar gegen seine `stages`-Definitionen. */
export const StageSchema = StageIdSchema;
export type Stage = string;

/** Eine Zeile: kein Zeilenumbruch jeder Art. Schuetzt Dateien, in die der Text als Kommentar geschrieben wird (.env). */
export const OneLine = z.string().regex(/^[^\r\n\u0085\u2028\u2029]*$/, "Nur eine Zeile, ohne Zeilenumbruch");
/** Nur http(s): keine javascript:-, data:- oder file:-Adressen in Anleitungen und Links. */
export const WebUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), "Nur http:// oder https:// erlaubt");

export const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
export const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Schlagwort in kleinbuchstaben-mit-bindestrich");
/** Beschreibende Angaben, die Secrets und Variablen gleichermassen haben. */
export const Describable = {
  /** Wofuer der Wert gebraucht wird, wo er genutzt wird. */
  description: z.string().max(500).optional(),
  /** Wer sich kuemmert (Person oder Team). */
  owner: z.string().max(80).optional(),
  /** Weiterfuehrende Seite: Anbieter-Dashboard, Doku, Ticket. */
  link: WebUrl.optional(),
  tags: z.array(Tag).max(12).default([]),
};
export const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Name in GROSSBUCHSTABEN_MIT_UNTERSTRICH");
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Slug in kleinbuchstaben-mit-bindestrich");

/** Wo ein Secret im GitHub-Secret-Speicher liegt. */
export const PlaceSchema = z
  .object({
    repo: z.string().min(1),
    scope: z.enum(["repository", "environment", "organization"]),
    /** Fehlt er bei scope environment, kommt der Name aus der Stage des Secrets (siehe stages.ts). */
    environment: z.string().min(1).optional(),
    /** Anderer Name im Ziel als `name` des Secrets (selten). */
    name: SecretName.optional(),
  });
export type Place = z.infer<typeof PlaceSchema>;

export const ExpiryKindSchema = z.enum(["none", "possible", "required", "unknown"]);

export const SecretFields = {
    id: Slug,
    /** Name des Secrets im Ziel, zum Beispiel CLOUDFLARE_API_TOKEN. */
    name: SecretName,
    title: z.string().optional(),
    ...Describable,
    product: z.string().optional(),
    stage: StageSchema.default("shared"),
    service: z.string().min(1),
    /** Anbieter-Modul, das den Wert erzeugt. `manual` = Wert wird von Hand eingefuegt. */
    provider: z.string().default("manual"),
    params: z.record(z.string(), z.unknown()).default({}),
    expiry: ExpiryKindSchema.default("unknown"),
    expires: DateString.nullable().default(null),
    ttlDays: z.number().int().positive().optional(),
    rotatedAt: DateString.optional(),
    /** Wann und von wem der Wert nach der Pruefung bestaetigt wurde. */
    verifiedAt: DateString.optional(),
    verifiedBy: z.string().optional(),
    /** Kennung beim Anbieter (zum Widerrufen), kein Geheimnis. */
    externalId: z.string().optional(),
    source: z.string().optional(),
    rotation: z.string().optional(),
    notes: z.string().optional(),
    places: z.array(PlaceSchema).default([]),
};

export const SecretSchema = z
  .object(SecretFields)
  .superRefine((s, ctx) => {
    if (s.expiry === "none" && s.expires) {
      ctx.addIssue({ code: "custom", message: "expiry none, aber expires gesetzt", path: ["expires"] });
    }
  });
export type SecretEntry = z.infer<typeof SecretSchema>;

/** Woher ein Wert in der .env fuer eine Stage kommt. */
export const EnvSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("default"), value: z.string() }),
  z.object({ type: z.literal("generate"), kind: z.enum(["hex", "base64", "uuid"]).default("hex"), bytes: z.number().int().min(8).max(128).default(32) }),
  z.object({ type: z.literal("issue"), secret: Slug }),
  z.object({ type: z.literal("prompt"), hint: OneLine.optional() }),
  /** Wert einer Variable aus dem Inventar (Konfiguration, kein Geheimnis). */
  z.object({ type: z.literal("variable"), variable: Slug }),
]);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

export const EnvEntrySchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  from: EnvSourceSchema,
  description: OneLine.max(300).optional(),
});

export const EnvTemplateSchema = z.object({
  id: Slug,
  repo: OneLine.min(1),
  stage: StageSchema.default("dev"),
  file: OneLine.min(1).default(".env.local"),
  entries: z.array(EnvEntrySchema).min(1),
});
export type EnvTemplate = z.infer<typeof EnvTemplateSchema>;

/** Eigener Anbieter ohne API: nur eine Anleitung. */
export const ProviderDefSchema = z.object({
  id: Slug,
  label: z.string().min(1),
  url: WebUrl,
  steps: z.array(z.string()).default([]),
});
export type ProviderDef = z.infer<typeof ProviderDefSchema>;

/**
 * Eine GitHub-Actions-Variable (vars.*): Konfiguration, kein Geheimnis. Der Sollwert steht im Inventar,
 * das Portal gleicht ihn mit GitHub ab und setzt ihn. null = Sollwert noch unbekannt, aus GitHub uebernehmen.
 */
export const VariableSchema = z.object({
  id: Slug,
  name: SecretName,
  ...Describable,
  product: z.string().optional(),
  stage: StageSchema.default("shared"),
  value: z.string().max(1000).nullable().default(null),
  /** Optional: woher der Sollwert gelesen wird (siehe variable-sources.ts). */
  from: VariableSourceSchema.optional(),
  places: z.array(PlaceSchema).min(1, "mindestens ein Ziel"),
});
export type VariableEntry = z.infer<typeof VariableSchema>;

const InventoryObject = z.object({
  version: z.literal(1),
  thresholds: z.array(z.number().int().positive()).default([30, 14, 7]),
  /** Stage-Definitionen. Fehlt der Abschnitt oder ist er leer, gelten dev, staging, production, shared. */
  stages: z.array(StageDefSchema).default([]),
  secrets: z.array(SecretSchema).default([]),
  variables: z.array(VariableSchema).default([]),
  envTemplates: z.array(EnvTemplateSchema).default([]),
  providers: z.array(ProviderDefSchema).default([]),
  /** Nicht geheime Standardwerte je Integration (Verbindungs-Id), zum Beispiel cloudflare: { accountId }. Fallback fuer Eintraege ohne den Parameter. */
  integrationDefaults: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const InventorySchema = InventoryObject.superRefine((inv, ctx) => {
  for (const msg of stageDefIssues(inv.stages)) ctx.addIssue({ code: "custom", message: msg, path: ["stages"] });
  const defs = effectiveStages(inv.stages);
  const checkStage = (stage: string, path: (string | number)[]): boolean => {
    if (findStage(defs, stage)) return true;
    ctx.addIssue({ code: "custom", message: `Unbekannte Stage: ${stage}`, path: [...path, "stage"] });
    return false;
  };
  const checkPlaces = (stage: string, places: Place[], path: (string | number)[]): void => {
    try {
      resolvePlaces(defs, stage, places);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message, path: [...path, "places"] });
    }
  };
  const seen = new Set<string>();
  inv.secrets.forEach((s, i) => {
    if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `id doppelt: ${s.id}`, path: ["secrets", i, "id"] });
    seen.add(s.id);
    if (!checkStage(s.stage, ["secrets", i])) return;
    if (stageKind(defs, s.stage) !== "dev" && s.places.length === 0) {
      ctx.addIssue({ code: "custom", message: "places fehlt (nur Stages der Art dev duerfen ohne Ziel sein)", path: ["secrets", i, "places"] });
    }
    checkPlaces(s.stage, s.places, ["secrets", i]);
  });
  const varIds = new Set<string>();
  inv.variables.forEach((v, i) => {
    if (varIds.has(v.id) || seen.has(v.id)) ctx.addIssue({ code: "custom", message: `id doppelt: ${v.id}`, path: ["variables", i, "id"] });
    varIds.add(v.id);
    if (checkStage(v.stage, ["variables", i])) checkPlaces(v.stage, v.places, ["variables", i]);
  });
  const ids = new Set(inv.secrets.map((s) => s.id));
  inv.envTemplates.forEach((t, i) => {
    checkStage(t.stage, ["envTemplates", i]);
    t.entries.forEach((e, j) => {
      if (e.from.type === "issue" && !ids.has(e.from.secret)) {
        ctx.addIssue({ code: "custom", message: `unbekanntes Secret: ${e.from.secret}`, path: ["envTemplates", i, "entries", j] });
      }
      if (e.from.type === "variable" && !varIds.has(e.from.variable)) {
        ctx.addIssue({ code: "custom", message: `unbekannte Variable: ${e.from.variable}`, path: ["envTemplates", i, "entries", j] });
      }
    });
  });
}).transform((inv) => {
  // Stages immer ausgeschrieben, fehlende Environment-Namen aus der Stage ergaenzt.
  const stages = effectiveStages(inv.stages);
  const fill = <T extends { stage: string; places: Place[] }>(e: T): T => ({ ...e, places: resolvePlaces(stages, e.stage, e.places) });
  return { ...inv, stages, secrets: inv.secrets.map(fill), variables: inv.variables.map(fill) };
});
export type Inventory = z.infer<typeof InventorySchema>;

/** Ids der Standard-Stages (nur als Vorgabe, die Inventar-Definitionen gehen vor). */
export const DEFAULT_STAGE_IDS: readonly string[] = DEFAULT_STAGES.map((d) => d.id);
