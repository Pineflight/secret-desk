import { z } from "zod";
import { InventoryError } from "./inventory.js";
import { DateString, ExpiryKindSchema, SecretFields, Tag, VariableSchema, WebUrl } from "./types.js";

/**
 * Eingabeschemas fuer Aenderungen. Alle sind strikt: ein unbekanntes Feld ist ein Fehler (400), kein stilles Durchreichen.
 * Zwei Wege fuer Secrets:
 *   - Mensch (Portal/CLI): alle bearbeitbaren Felder, aber ausdruecklich benannt.
 *   - Agent (MCP, /api/agent): nur beschreibende Metadaten. Stage, Ziele, Anbieter, Parameter, Ablauf, Pruefstempel
 *     und Kennung beim Anbieter aendert ein Agent nie an einem bestehenden Eintrag.
 */
const metaShape = {
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  owner: z.string().max(80).nullable().optional(),
  link: WebUrl.nullable().optional(),
  tags: z.array(Tag).max(12).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  product: z.string().max(100).nullable().optional(),
};

/** Erlaubte Felder einer Agenten-Aenderung. */
export const SecretAgentPatchSchema = z.strictObject(metaShape);
export type SecretAgentPatch = z.infer<typeof SecretAgentPatchSchema>;

/** Erlaubte Felder einer Aenderung durch einen Menschen. */
export const SecretHumanPatchSchema = z.strictObject({
  ...metaShape,
  expires: DateString.nullable().optional(),
  rotatedAt: DateString.nullable().optional(),
  verifiedAt: DateString.nullable().optional(),
  verifiedBy: z.string().max(100).nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
  ttlDays: z.number().int().positive().nullable().optional(),
  expiry: ExpiryKindSchema.nullable().optional(),
});
export type SecretHumanPatch = z.infer<typeof SecretHumanPatchSchema>;

/** Felder, die InventoryStore.patchSecret ueberhaupt setzt (Verteidigung in der Tiefe). */
export const SECRET_PATCH_KEYS: readonly string[] = Object.keys(SecretHumanPatchSchema.shape);

/**
 * Neuanlage durch einen Agenten: ohne Pruefstempel und Anbieter-Kennung (expires, rotatedAt, verifiedAt, verifiedBy, externalId).
 * Stage, Anbieter und Parameter prueft zusaetzlich die Richtlinie in agent-api.ts.
 */
const { expires: _e, rotatedAt: _r, verifiedAt: _va, verifiedBy: _vb, externalId: _x, ...agentCreateShape } = SecretFields;
void [_e, _r, _va, _vb, _x];
export const SecretAgentCreateSchema = z.strictObject(agentCreateShape);

export const VariableAgentCreateSchema = z.strictObject(VariableSchema.shape);

/** Aenderung einer Variablen (Mensch und Agent gleich): nur Sollwert und Beschreibung, nie Stage oder Ziele. */
export const VariablePatchSchema = z.strictObject({
  value: z.string().max(1000).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  owner: z.string().max(80).nullable().optional(),
  link: WebUrl.nullable().optional(),
  tags: z.array(Tag).max(12).nullable().optional(),
  acknowledgedPublic: z.boolean().optional(),
});
export type VariablePatch = z.infer<typeof VariablePatchSchema>;

/** Wie parse, aber als InventoryError mit deutscher Meldung. Unbekannte Felder werden benannt. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new InventoryError(
    r.error.issues
      .map((i) => (i.code === "unrecognized_keys" ? `Feld nicht erlaubt: ${i.keys.join(", ")}` : `${i.path.join(".") || "(Wurzel)"}: ${i.message}`))
      .join("; "),
  );
}
