import type { VariableView } from "@secret-desk/runtime";

/**
 * Variablen aus Anbietern laden: Auswahl aus der Allowlist des Servers (variable-sources), Koerper der Aufrufe und Auswertung
 * der Vorschlaege. Es werden nur Quellen und Felder angeboten, die der Server nennt; geheime Felder gibt es dort nicht.
 */
export type Lang = "de" | "en";
export interface SourceField {
  field: string;
  label: string;
  labelEn: string;
}
export interface SourceDef {
  kind: string;
  connection: string;
  label: string;
  labelEn: string;
  fields: SourceField[];
  connected: boolean;
}
export type VariableFrom = NonNullable<VariableView["from"]>;
export interface SourceDraft {
  kind: string;
  resource: string;
  field: string;
}
export const EMPTY_SOURCE: SourceDraft = { kind: "", resource: "", field: "" };

export const sourceLabel = (s: Pick<SourceDef, "label" | "labelEn">, lang: Lang): string => (lang === "en" ? s.labelEn : s.label);
export const fieldLabel = (f: SourceField, lang: Lang): string => (lang === "en" ? f.labelEn : f.label);
export const findSource = (sources: readonly SourceDef[], kind: string): SourceDef | undefined => sources.find((s) => s.kind === kind);

/** Neue Quelle gewaehlt: Ressource und Feld gehoeren zur alten und werden verworfen; ein einziges Feld wird gleich gesetzt. */
export function pickKind(sources: readonly SourceDef[], kind: string): SourceDraft {
  const fields = findSource(sources, kind)?.fields ?? [];
  return { kind, resource: "", field: fields.length === 1 ? fields[0]!.field : "" };
}

export const draftOf = (from: VariableFrom | null | undefined): SourceDraft => (from ? { kind: from.kind, resource: from.resource, field: from.field } : EMPTY_SOURCE);
export const sourceComplete = (d: SourceDraft): boolean => d.kind !== "" && d.resource !== "" && d.field !== "";

/** Nur Felder, die die Allowlist der Quelle kennt. */
export const fieldAllowed = (sources: readonly SourceDef[], d: SourceDraft): boolean => Boolean(findSource(sources, d.kind)?.fields.some((f) => f.field === d.field));

/** `from` fuer POST/PATCH variables. null, wenn die Auswahl unvollstaendig oder nicht erlaubt ist. */
export function fromBody(sources: readonly SourceDef[], d: SourceDraft): VariableFrom | null {
  const src = findSource(sources, d.kind);
  if (!src || !sourceComplete(d) || !fieldAllowed(sources, d)) return null;
  return { connection: src.connection, kind: d.kind, resource: d.resource, field: d.field };
}

/** Wie readable: "Supabase-Projekt · URL" fuer die Anzeige einer gemerkten Quelle. */
export function describeFrom(from: VariableFrom, sources: readonly SourceDef[], lang: Lang): string {
  const src = findSource(sources, from.kind);
  const field = src?.fields.find((f) => f.field === from.field);
  return `${src ? sourceLabel(src, lang) : from.kind} · ${field ? fieldLabel(field, lang) : from.field}`;
}

// ------------------------------------------------------------------------------------------ Entdeckung mit Standardwerten

interface ResourcesLike {
  defaults: Record<string, unknown>;
  resources: Record<string, { status: string }>;
}

/**
 * Braucht die Entdeckung einen weiteren Parameter (needs-params), den die Integration als Standardwert kennt (zum Beispiel
 * das Cloudflare-Konto), gilt dieser Standardwert fuer die zweite Anfrage. Sonst null (kein neuer Versuch).
 */
export function retryParams(kind: string, res: ResourcesLike): Record<string, string> | null {
  if (res.resources[kind]?.status !== "needs-params") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.defaults)) if (typeof v === "string" && v !== "") out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

// ------------------------------------------------------------------------------------------ Vorschlaege

export type SuggestionRow =
  | { variableId: string; from: VariableFrom; current: string | null; proposed: string; resourceLabel: string; changed: boolean; status: "ok" }
  | { variableId: string; from: VariableFrom; status: "error"; error: string };

export interface SplitSuggestions {
  changed: Extract<SuggestionRow, { status: "ok" }>[];
  same: Extract<SuggestionRow, { status: "ok" }>[];
  failed: Extract<SuggestionRow, { status: "error" }>[];
}

export function splitSuggestions(rows: readonly SuggestionRow[]): SplitSuggestions {
  const out: SplitSuggestions = { changed: [], same: [], failed: [] };
  for (const r of rows) {
    if (r.status === "error") out.failed.push(r);
    else if (r.changed) out.changed.push(r);
    else out.same.push(r);
  }
  return out;
}

/** Koerper fuer load-from-source mit Uebernahme: die gemerkte Quelle, nach Bestaetigung (apply). */
export function applyBody(from: VariableFrom, acknowledgedPublic = false): Record<string, unknown> {
  return { kind: from.kind, resource: from.resource, field: from.field, apply: true, ...(acknowledgedPublic ? { acknowledgedPublic: true } : {}) };
}

/** Wert gekuerzt anzeigen (Kennungen koennen lang sein). */
export const clip = (v: string | null, n = 60): string => (v === null ? "" : v.length > n ? `${v.slice(0, n - 1)}…` : v);
