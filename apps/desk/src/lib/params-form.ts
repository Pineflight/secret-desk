import type { ParamPreset, ParamProblem, ParamSpec, PreflightFinding } from "@secret-desk/core";
import type { ParamsView } from "@secret-desk/runtime";

/**
 * Formularlogik fuer Anbieter-Parameter: Entwurf (Texte aus Eingabefeldern) in Werte der Schnittstelle umwandeln,
 * Pflichtpruefung, Abhaengigkeiten der Entdeckung, Vorschlaege, Presets und Fehlerzuordnung. Rein, ohne Netz und ohne DOM.
 * Parameter sind Konfiguration (Kennungen, Adressen, Rechte), nie geheime Werte.
 */
export type Lang = "de" | "en";
export type Draft = Record<string, unknown>;
export type ResourceState = ParamsView["resources"][string];
export type ResourceOption = ResourceState["options"][number];
export type ResourceStatus = ResourceState["status"] | "none";
export type IssueCode = "missing" | "wrong_type" | "not_in_options";
export interface ParamIssue {
  key: string;
  code: IssueCode;
}

export const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export const specLabel = (s: ParamSpec, lang: Lang): string => (lang === "en" ? s.labelEn : s.label);
export const specHelp = (s: ParamSpec, lang: Lang): string => (lang === "en" ? s.helpEn : s.help);
export const presetLabel = (p: ParamPreset, lang: Lang): string => (lang === "en" ? p.labelEn : p.label);

export type FieldKind = "pick" | "pickMany" | "enum" | "list" | "url" | "integer" | "text";

/** Welches Eingabefeld ein Parameter bekommt. discover heisst: Auswahl aus entdeckten Ressourcen. */
export function fieldKind(spec: ParamSpec): FieldKind {
  if (spec.discover) return spec.type === "stringList" ? "pickMany" : "pick";
  if (spec.type === "stringList") return "list";
  if (spec.type === "enum" && spec.options && spec.options.length > 0) return "enum";
  if (spec.type === "url") return "url";
  if (spec.type === "integer") return "integer";
  return "text";
}

// ------------------------------------------------------------------------------------------ Entwurf und Werte

/** Wirksame Werte: Werte des Eintrags, fehlende aus den Standardwerten der Integration (nur wo der Anbieter es erlaubt). */
export function effectiveValues(specs: readonly ParamSpec[], values: Draft, defaults: Draft = {}): Draft {
  const out: Draft = { ...values };
  for (const s of specs) if (s.integrationDefault && isBlank(out[s.key]) && !isBlank(defaults[s.key])) out[s.key] = defaults[s.key];
  return out;
}

/** Ist der Parameter bei diesem Stand Pflicht? requiredWhen vergleicht mit dem Wert des anderen Parameters (sonst dessen Standardwert). */
export function isRequiredNow(spec: ParamSpec, specs: readonly ParamSpec[], effective: Draft): boolean {
  if (!spec.requiredWhen) return spec.required;
  const other = specs.find((s) => s.key === spec.requiredWhen!.key);
  const v = effective[spec.requiredWhen.key];
  return (isBlank(v) ? other?.defaultValue : v) === spec.requiredWhen.equals;
}

/** Werte eines gespeicherten Eintrags als Entwurf (Zahlen werden Text, damit das Eingabefeld sie halten kann). */
export function toDraft(specs: readonly ParamSpec[], values: Draft): Draft {
  const out: Draft = {};
  for (const s of specs) {
    const v = values[s.key];
    if (isBlank(v)) continue;
    out[s.key] = s.type === "integer" ? String(v) : Array.isArray(v) ? [...v] : v;
  }
  return out;
}

const splitList = (v: string): string[] => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** Entwurf in Werte der Schnittstelle: leere entfallen, Zahlen werden Zahlen, Listen Arrays. Unlesbare Zahlen sind in `invalid`. */
export function toParams(specs: readonly ParamSpec[], draft: Draft): { params: Record<string, unknown>; invalid: string[] } {
  const params: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const s of specs) {
    const v = draft[s.key];
    if (isBlank(v)) continue;
    if (s.type === "integer") {
      const text = typeof v === "number" ? String(v) : String(v).trim();
      if (/^-?\d+$/.test(text)) params[s.key] = Number(text);
      else {
        params[s.key] = text;
        invalid.push(s.key);
      }
    } else if (s.type === "stringList") {
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : typeof v === "string" ? splitList(v) : [];
      if (list.length > 0) params[s.key] = list;
    } else params[s.key] = typeof v === "string" ? v.trim() : v;
  }
  return { params, invalid };
}

const httpsUrl = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v.trim()).protocol === "https:";
  } catch {
    return false;
  }
};

/** Dieselben Regeln wie der Server (Pflicht, Typ, Optionen), damit Speichern erst geht, wenn es der Server annimmt. */
export function validateDraft(specs: readonly ParamSpec[], draft: Draft, defaults: Draft = {}): ParamIssue[] {
  const { params, invalid } = toParams(specs, draft);
  const effective = effectiveValues(specs, params, defaults);
  const out: ParamIssue[] = [];
  for (const s of specs) {
    const v = effective[s.key];
    if (isBlank(v)) {
      if (isRequiredNow(s, specs, effective)) out.push({ key: s.key, code: "missing" });
      continue;
    }
    if (s.type === "integer") {
      const bad = invalid.includes(s.key) || typeof v !== "number" || !Number.isInteger(v) || v < (s.min ?? 1) || (s.max !== undefined && v > s.max);
      if (bad) out.push({ key: s.key, code: "wrong_type" });
    } else if (s.type === "url") {
      if (!httpsUrl(v)) out.push({ key: s.key, code: "wrong_type" });
    } else if (s.type === "enum" && s.options && !s.options.some((o) => o.value === v)) out.push({ key: s.key, code: "not_in_options" });
  }
  return out;
}

export const missingKeys = (issues: readonly ParamIssue[]): string[] => issues.filter((i) => i.code === "missing").map((i) => i.key);
export const canSave = (specs: readonly ParamSpec[], draft: Draft, defaults: Draft = {}): boolean => validateDraft(specs, draft, defaults).length === 0;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Koerper fuer PUT params: nur geaenderte Schluessel, geleerte als null (entfernt). */
export function buildPut(specs: readonly ParamSpec[], draft: Draft, original: Draft): { params: Record<string, unknown>; changed: boolean } {
  const { params } = toParams(specs, draft);
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    const next = params[s.key];
    const prev = isBlank(original[s.key]) ? undefined : original[s.key];
    if (next === undefined) {
      if (prev !== undefined) out[s.key] = null;
    } else if (!same(next, prev)) out[s.key] = next;
  }
  return { params: out, changed: Object.keys(out).length > 0 };
}

// ------------------------------------------------------------------------------------------ Abhaengigkeiten

/** Einzelwerte, von denen andere Entdeckungen abhaengen koennen (param.<key>). Listen zaehlen nicht. */
export function dependencyParams(specs: readonly ParamSpec[], draft: Draft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of specs) {
    if (s.type === "stringList") continue;
    const v = draft[s.key];
    if (isBlank(v) || (typeof v !== "string" && typeof v !== "number")) continue;
    out[s.key] = String(v).trim();
  }
  return out;
}

/** Stabiler Schluessel: aendert er sich, muessen die Listen neu geladen werden. */
export const dependencyKey = (deps: Record<string, string>): string => JSON.stringify(Object.keys(deps).sort().map((k) => [k, deps[k]]));

/** Query-Teil `param.a=1&param.b=2` (kodiert) fuer die Entdeckungsrouten. */
export function dependencyQuery(deps: Record<string, string>): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of Object.keys(deps).sort()) q.set(`param.${k}`, deps[k]!);
  return q;
}

// ------------------------------------------------------------------------------------------ Ressourcen und Vorschlaege

export const resourceStatus = (state: ResourceState | undefined): ResourceStatus => state?.status ?? "none";
export const optionsOf = (state: ResourceState | undefined): ResourceOption[] => (state?.status === "ok" ? state.options : []);

export function optionText(o: ResourceOption): string {
  const detail = o.detail && o.detail !== String(o.value) && o.detail !== o.label ? o.detail : "";
  return detail ? `${o.label} · ${detail}` : o.label;
}

/** Der eine Vorschlag der Entdeckung (nur wenn die Option ihn auch markiert). Nie automatisch uebernommen. */
export function suggestionOf(state: ResourceState | undefined): ResourceOption | null {
  if (!state || state.status !== "ok" || state.suggested === null || state.suggested === undefined) return null;
  return state.options.find((o) => String(o.value) === String(state.suggested) && o.suggestedFor) ?? null;
}

export const isSuggested = (state: ResourceState | undefined, value: unknown): boolean => {
  const s = suggestionOf(state);
  return s !== null && String(s.value) === String(value);
};

/** Wert steht (noch) nicht in der entdeckten Liste, zum Beispiel nach Wechsel des Kontos. */
export function isUnlisted(spec: ParamSpec, value: unknown, state: ResourceState | undefined): boolean {
  if (fieldKind(spec) !== "pick" || isBlank(value) || state?.status !== "ok" || state.options.length === 0) return false;
  return !state.options.some((o) => String(o.value) === String(value));
}

/** Lesbare Anzeige eines gespeicherten Werts: Name der Ressource statt Kennung, wo die Liste sie kennt. */
export function describeValue(spec: ParamSpec, value: unknown, state: ResourceState | undefined, lang: Lang): string {
  if (isBlank(value)) return "";
  const name = (v: unknown): string => {
    const hit = state?.options.find((o) => String(o.value) === String(v));
    if (hit) return hit.label === String(hit.value) ? hit.label : `${hit.label} (${String(hit.value)})`;
    if (spec.type === "enum") return spec.options?.find((o) => o.value === v) ? (lang === "en" ? spec.options.find((o) => o.value === v)!.labelEn : spec.options.find((o) => o.value === v)!.label) : String(v);
    return String(v);
  };
  return Array.isArray(value) ? value.map(name).join(", ") : name(value);
}

export function toggleValue(list: unknown, value: string): string[] {
  const cur = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  return cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
}

// ------------------------------------------------------------------------------------------ Presets

/** Setzt die Werte des Presets in den Entwurf. Geschrieben wird erst beim Speichern. */
export function applyPreset(draft: Draft, preset: ParamPreset): Draft {
  const out: Draft = { ...draft };
  for (const [k, v] of Object.entries(preset.values)) out[k] = Array.isArray(v) ? [...v] : v;
  return out;
}

export function presetActive(preset: ParamPreset, draft: Draft): boolean {
  const entries = Object.entries(preset.values);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => {
    const cur = draft[k];
    if (Array.isArray(v)) return Array.isArray(cur) && cur.length === v.length && v.every((x) => cur.includes(x));
    return cur === v;
  });
}

/** Parameter, die zu einem Preset noch gewaehlt werden muessen (needs), soweit sie leer sind. */
export function presetNeeds(preset: ParamPreset, draft: Draft): string[] {
  return (preset.needs ?? []).filter((k) => isBlank(draft[k]));
}

// ------------------------------------------------------------------------------------------ Fehler

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** Server-Befunde (params_invalid) als Text je Parameter, in der Sprache der Oberflaeche. */
export function problemMessages(problems: readonly Pick<ParamProblem, "key" | "code" | "message" | "label" | "labelEn">[], tr: Tr, lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of problems) {
    const label = lang === "en" ? p.labelEn : p.label;
    out[p.key] = ["missing", "wrong_type", "not_in_options", "unknown_key"].includes(p.code) ? tr(`params.problem.${p.code}`, { label }) : p.message;
  }
  return out;
}

export function issueMessages(issues: readonly ParamIssue[], specs: readonly ParamSpec[], tr: Tr, lang: Lang): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const s = specs.find((x) => x.key === i.key);
    out[i.key] = tr(`params.problem.${i.code}`, { label: s ? specLabel(s, lang) : i.key });
  }
  return out;
}

/** Befunde aus einem Fehler der Schnittstelle (400 params_invalid), sonst leer. */
export function problemsFromError(e: unknown): ParamProblem[] {
  const err = e as { code?: unknown; problems?: unknown } | null;
  if (!err || err.code !== "params_invalid" || !Array.isArray(err.problems)) return [];
  return err.problems.filter((p): p is ParamProblem => typeof p === "object" && p !== null && typeof (p as ParamProblem).key === "string" && typeof (p as ParamProblem).code === "string");
}

export function findingsFromError(e: unknown): PreflightFinding[] {
  const err = e as { code?: unknown; findings?: unknown } | null;
  if (!err || err.code !== "preflight_failed" || !Array.isArray(err.findings)) return [];
  return err.findings.filter((f): f is PreflightFinding => typeof f === "object" && f !== null && typeof (f as PreflightFinding).label === "string");
}

// ------------------------------------------------------------------------------------------ Vorabcheck

export interface PreflightLike {
  status: "ok" | "warn" | "fail" | "skipped" | "not-connected";
  resource: string | null;
  findings: readonly PreflightFinding[];
}

/** Wie der Vorabcheck gemeldet wird: Erfolg, Hinweis, Fehlbefund oder gar nicht (uebersprungen). */
export function preflightTone(pre: PreflightLike | null | undefined): "success" | "info" | "error" | null {
  if (!pre) return null;
  if (pre.status === "ok") return "success";
  if (pre.status === "warn") return "info";
  if (pre.status === "fail") return "error";
  return null;
}

/** Befunde, die nicht "ok" sind, als ein Text ("Label (Detail); ..."). */
export const findingsText = (findings: readonly PreflightFinding[]): string => findings.filter((f) => f.level !== "ok").map((f) => (f.detail ? `${f.label} (${f.detail})` : f.label)).join("; ");
