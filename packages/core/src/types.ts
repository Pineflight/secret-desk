import { z } from "zod";

/** dev = lokale Entwicklung, shared = gilt fuer alle Stages (Repository-Secret). */
export const StageSchema = z.enum(["dev", "staging", "production", "shared"]);
export type Stage = z.infer<typeof StageSchema>;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
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

export const InventorySchema = z
  .object({
    version: z.literal(1),
    thresholds: z.array(z.number().int().positive()).default([30, 14, 7]),
    secrets: z.array(SecretSchema).default([]),
    envTemplates: z.array(EnvTemplateSchema).default([]),
    providers: z.array(ProviderDefSchema).default([]),
  })
  .superRefine((inv, ctx) => {
    const seen = new Set<string>();
    inv.secrets.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `id doppelt: ${s.id}`, path: ["secrets", i, "id"] });
      seen.add(s.id);
    });
    const ids = new Set(inv.secrets.map((s) => s.id));
    inv.envTemplates.forEach((t, i) =>
      t.entries.forEach((e, j) => {
        if (e.from.type === "issue" && !ids.has(e.from.secret)) {
          ctx.addIssue({ code: "custom", message: `unbekanntes Secret: ${e.from.secret}`, path: ["envTemplates", i, "entries", j] });
        }
      }),
    );
  });
export type Inventory = z.infer<typeof InventorySchema>;

export const STAGES: readonly Stage[] = ["dev", "staging", "production", "shared"];
