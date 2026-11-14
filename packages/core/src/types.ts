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
} as const;
export const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Name in GROSSBUCHSTABEN_MIT_UNTERSTRICH");
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Slug in kleinbuchstaben-mit-bindestrich");

/** A place in the GitHub secret store (repository, environment or organization). */
export const GitHubPlaceSchema = z.object({
  repo: z.string().min(1),
  scope: z.enum(["repository", "environment", "organization"]),
  /** Fehlt er bei scope environment, kommt der Name aus der Stage des Secrets (siehe stages.ts). */
  environment: z.string().min(1).optional(),
  /** Anderer Name im Ziel als `name` des Secrets (selten). */
  name: SecretName.optional(),
});
export type GitHubPlace = z.infer<typeof GitHubPlaceSchema>;

/**
 * A secret of a deployed Cloudflare Worker (what `wrangler secret put` writes). `script` is the deployed Worker name,
 * for example `acme-portal-staging` for the staging environment of `acme-portal`. Only secrets, never Worker variables.
 */
export const WorkerPlaceSchema = z.object({
  scope: z.literal("cloudflare-worker"),
  accountId: z.string().regex(/^[0-9a-f]{32}$/i, "Cloudflare account id: 32 hex characters"),
  script: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, "Worker script name"),
  /** Other name on the Worker than `name` of the secret (rare). */
  name: SecretName.optional(),
});
export type WorkerPlace = z.infer<typeof WorkerPlaceSchema>;

/** Where a secret lives: the GitHub secret store or the secrets of a Cloudflare Worker. */
export const PlaceSchema = z.union([GitHubPlaceSchema, WorkerPlaceSchema]);
export type Place = GitHubPlace | WorkerPlace;

export const isWorkerPlace = (p: Place): p is WorkerPlace => p.scope === "cloudflare-worker";
export const isGitHubPlace = (p: Place): p is GitHubPlace => p.scope !== "cloudflare-worker";
/** The GitHub places of a list: Worker places have no repository and take no part in repository comparisons. */
export const githubPlacesOf = (places: readonly Place[]): GitHubPlace[] => places.filter(isGitHubPlace);

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
} as const;

export const SecretSchema = z
  .object(SecretFields)
  .superRefine((s, ctx) => {
    if (s.expiry === "none" && s.expires) {
      ctx.addIssue({ code: "custom", message: "expiry none, aber expires gesetzt", path: ["expires"] });
    }
  });
export type SecretEntry = z.infer<typeof SecretSchema>;

/** Woher ein Wert in der .env fuer eine Stage kommt. */
const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** Commands a template may name for runtime-local values. Fixed program and arguments, never taken from the template. */
export const ENV_COMMANDS = ["supabase-status"] as const;
export type EnvCommand = (typeof ENV_COMMANDS)[number];

export const EnvSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("default"), value: z.string() }),
  /**
   * Random value made now. `prefix` is written in front (e.g. "whsec_"). kind "vapid-public"/"vapid-private" is one half
   * of a Web Push key pair; entries with the same `pair` in one export share one pair.
   */
  z.object({
    type: z.literal("generate"),
    kind: z.enum(["hex", "base64", "base64url", "uuid", "vapid-public", "vapid-private"]).default("hex"),
    bytes: z.number().int().min(8).max(128).default(32),
    prefix: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional(),
    pair: Slug.optional(),
  }),
  z.object({ type: z.literal("issue"), secret: Slug }),
  /** A value a human types. With optional: true a missing value is written as a commented, empty line. */
  z.object({ type: z.literal("prompt"), hint: OneLine.optional(), optional: z.boolean().default(false) }),
  /**
   * Value of another template's key: taken from the same export run, or from the file that template already produced.
   * Stored nowhere else.
   */
  z.object({ type: z.literal("ref"), template: Slug, key: EnvKey }),
  /** Value read from the output of an allowlisted local command (run by the CLI on the developer machine only). */
  z.object({ type: z.literal("command"), command: z.enum(ENV_COMMANDS), key: EnvKey, optional: z.boolean().default(false) }),
  /** Wert einer Variable aus dem Inventar (Konfiguration, kein Geheimnis). */
  z.object({ type: z.literal("variable"), variable: Slug }),
]);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

export const EnvEntrySchema = z.object({
  key: EnvKey,
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
  places: z.array(GitHubPlaceSchema).min(1, "mindestens ein Ziel"),
});
export type VariableEntry = z.infer<typeof VariableSchema>;

/** Vom Menschen gepflegte Zuordnung Repository (und optional Stage) zu einer Ressource beim Anbieter. Kein Geheimnis. */
export const ResourceMapEntrySchema = z.object({
  /** Entdeckungsart, zum Beispiel "resend.domain", "supabase.project". */
  kind: z.string().min(1),
  repo: z.string().min(1),
  /** Ohne Stage gilt der Eintrag fuer alle Stages; mit Stage hat er Vorrang. */
  stage: z.string().min(1).optional(),
  /** Kennung der Ressource, wie options[].value der Entdeckung. */
  value: z.string().min(1),
  /** Anzeigename zum Zeitpunkt der Wahl, nur zur Anzeige. */
  label: z.string().optional(),
});
export type ResourceMapEntry = z.infer<typeof ResourceMapEntrySchema>;

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
  /** Zuordnung Repository (und Stage) zu Ressourcen beim Anbieter; geht den Namensregeln der Vorschlaege vor. */
  resourceMap: z.array(ResourceMapEntrySchema).optional(),
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
      if (e.from.type === "ref") {
        const target = inv.envTemplates.find((x) => x.id === (e.from as { template: string }).template);
        const refKey = e.from.key;
        if (!target) ctx.addIssue({ code: "custom", message: `unbekannte Vorlage: ${e.from.template}`, path: ["envTemplates", i, "entries", j] });
        else if (target.id === t.id) ctx.addIssue({ code: "custom", message: "ref zeigt auf die eigene Vorlage", path: ["envTemplates", i, "entries", j] });
        else if (target.stage !== t.stage) ctx.addIssue({ code: "custom", message: `ref nur innerhalb derselben Stage: ${target.id} ist ${target.stage}`, path: ["envTemplates", i, "entries", j] });
        else {
          const hit = target.entries.find((x) => x.key === refKey);
          if (!hit) ctx.addIssue({ code: "custom", message: `unbekannter Schluessel in ${target.id}: ${refKey}`, path: ["envTemplates", i, "entries", j] });
          else if (hit.from.type === "ref") ctx.addIssue({ code: "custom", message: "ref auf einen ref-Eintrag ist nicht erlaubt", path: ["envTemplates", i, "entries", j] });
        }
      }
      if (e.from.type === "generate" && (e.from.kind === "vapid-public" || e.from.kind === "vapid-private") && e.from.prefix) {
        ctx.addIssue({ code: "custom", message: "prefix gehoert nicht zu einem VAPID-Schluessel", path: ["envTemplates", i, "entries", j] });
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
