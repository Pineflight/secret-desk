import { z } from "zod";

/** dev = lokale Entwicklung, shared = gilt fuer alle Stages (Repository-Secret). */
export const StageSchema = z.enum(["dev", "staging", "production", "shared"]);
export type Stage = z.infer<typeof StageSchema>;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Schlagwort in kleinbuchstaben-mit-bindestrich");
/** Beschreibende Angaben, die Secrets und Variablen gleichermassen haben. */
const Describable = {
  /** Wofuer der Wert gebraucht wird, wo er genutzt wird. */
  description: z.string().max(500).optional(),
  /** Wer sich kuemmert (Person oder Team). */
  owner: z.string().max(80).optional(),
  /** Weiterfuehrende Seite: Anbieter-Dashboard, Doku, Ticket. */
  link: z.string().url().optional(),
  tags: z.array(Tag).max(12).default([]),
};
const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Name in GROSSBUCHSTABEN_MIT_UNTERSTRICH");
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Slug in kleinbuchstaben-mit-bindestrich");

/** Wo ein Secret im GitHub-Secret-Speicher liegt. */
export const PlaceSchema = z
  .object({
    repo: z.string().min(1),
    scope: z.enum(["repository", "environment", "organization"]),
    environment: z.string().min(1).optional(),
    /** Anderer Name im Ziel als `name` des Secrets (selten). */
    name: SecretName.optional(),
  })
  .refine((p) => p.scope !== "environment" || !!p.environment, { message: "environment fehlt" });
export type Place = z.infer<typeof PlaceSchema>;

export const ExpiryKindSchema = z.enum(["none", "possible", "required", "unknown"]);

export const SecretSchema = z
  .object({
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
  })
  .superRefine((s, ctx) => {
    if (s.stage !== "dev" && s.places.length === 0) {
      ctx.addIssue({ code: "custom", message: "places fehlt (nur dev darf ohne Ziel sein)", path: ["places"] });
    }
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
  z.object({ type: z.literal("prompt"), hint: z.string().optional() }),
  /** Wert einer Variable aus dem Inventar (Konfiguration, kein Geheimnis). */
  z.object({ type: z.literal("variable"), variable: Slug }),
]);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

export const EnvEntrySchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  from: EnvSourceSchema,
  description: z.string().optional(),
});

export const EnvTemplateSchema = z.object({
  id: Slug,
  repo: z.string().min(1),
  stage: StageSchema.default("dev"),
  file: z.string().default(".env.local"),
  entries: z.array(EnvEntrySchema).min(1),
});
export type EnvTemplate = z.infer<typeof EnvTemplateSchema>;

/** Eigener Anbieter ohne API: nur eine Anleitung. */
export const ProviderDefSchema = z.object({
  id: Slug,
  label: z.string().min(1),
  url: z.string().url(),
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
  places: z.array(PlaceSchema).min(1, "mindestens ein Ziel"),
});
export type VariableEntry = z.infer<typeof VariableSchema>;

export const InventorySchema = z
  .object({
    version: z.literal(1),
    thresholds: z.array(z.number().int().positive()).default([30, 14, 7]),
    secrets: z.array(SecretSchema).default([]),
    variables: z.array(VariableSchema).default([]),
    envTemplates: z.array(EnvTemplateSchema).default([]),
    providers: z.array(ProviderDefSchema).default([]),
  })
  .superRefine((inv, ctx) => {
    const seen = new Set<string>();
    inv.secrets.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `id doppelt: ${s.id}`, path: ["secrets", i, "id"] });
      seen.add(s.id);
    });
    const varIds = new Set<string>();
    inv.variables.forEach((v, i) => {
      if (varIds.has(v.id) || seen.has(v.id)) ctx.addIssue({ code: "custom", message: `id doppelt: ${v.id}`, path: ["variables", i, "id"] });
      varIds.add(v.id);
    });
    const ids = new Set(inv.secrets.map((s) => s.id));
    inv.envTemplates.forEach((t, i) =>
      t.entries.forEach((e, j) => {
        if (e.from.type === "issue" && !ids.has(e.from.secret)) {
          ctx.addIssue({ code: "custom", message: `unbekanntes Secret: ${e.from.secret}`, path: ["envTemplates", i, "entries", j] });
        }
        if (e.from.type === "variable" && !varIds.has(e.from.variable)) {
          ctx.addIssue({ code: "custom", message: `unbekannte Variable: ${e.from.variable}`, path: ["envTemplates", i, "entries", j] });
        }
      }),
    );
  });
export type Inventory = z.infer<typeof InventorySchema>;

export const STAGES: readonly Stage[] = ["dev", "staging", "production", "shared"];
