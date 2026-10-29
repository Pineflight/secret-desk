import type { StageKind } from "./stages.js";

/**
 * Parameter-Spezifikation eines Anbieters. Sie beschreibt, was im Inventar unter `params` eines Eintrags stehen muss,
 * damit der Anbieter ausstellen kann, und woher das Portal die Werte kennt (Entdeckung beim verbundenen Konto).
 * Parameter sind Konfiguration (Kennungen, Adressen, Rechte), nie geheime Werte.
 */
export type ParamType = "string" | "stringList" | "enum" | "url" | "integer";

export interface ParamOption {
  value: string;
  label: string;
  labelEn: string;
}

/** Vorbelegung mehrerer Parameter auf einmal (zum Beispiel "Worker-Deploy" mit den noetigen Rechten). */
export interface ParamPreset {
  id: string;
  label: string;
  labelEn: string;
  /** Werte, die das Preset setzt (Schluessel = Parameter). */
  values: Record<string, unknown>;
  /** Weitere Parameter, die mit diesem Preset gewaehlt werden muessen (zum Beispiel zoneId). */
  needs?: string[];
}

export interface ParamSpec {
  key: string;
  label: string;
  labelEn: string;
  type: ParamType;
  required: boolean;
  /** Pflicht nur, wenn der Parameter `key` den Wert `equals` hat. Fehlt `key`, gilt der Standardwert des Parameters. Ueberschreibt `required`. */
  requiredWhen?: { key: string; equals: string };
  help: string;
  helpEn: string;
  /** Erlaubte Werte bei type enum. */
  options?: ParamOption[];
  /** Standardwert, wenn der Parameter fehlt (nur Anzeige und requiredWhen). */
  defaultValue?: string;
  /** Art der Entdeckung beim Anbieter, zum Beispiel "cloudflare.account". Siehe Provider.discover. */
  discover?: string;
  presets?: ParamPreset[];
  /** Darf als nicht geheimer Standardwert der Integration gesetzt werden (Fallback fuer Eintraege ohne den Parameter). */
  integrationDefault?: boolean;
  /** Nur integer: Grenzen. */
  min?: number;
  max?: number;
}

/** Eine entdeckte Ressource beim Anbieter (Konto, Projekt, Zone, Domain ...). Nur lesend ermittelt. */
export interface DiscoveredOption {
  value: string | number;
  label: string;
  detail?: string;
  /** Nur gesetzt, wenn genau diese Option anhand von Repository und Stage eindeutig vorgeschlagen wird. */
  suggestedFor?: { score: number; reason: string };
}

export interface DiscoverHint {
  repos: string[];
  stage?: string;
  stageKind?: StageKind;
}

export type ParamProblemCode = "missing" | "wrong_type" | "not_in_options" | "unknown_key";

export interface ParamProblem {
  key: string;
  code: ParamProblemCode;
  /** Deutsche Klartextmeldung zu diesem Parameter. */
  message: string;
  label: string;
  labelEn: string;
}

export class ParamsInvalidError extends Error {
  readonly code = "params_invalid";
  constructor(
    readonly problems: ParamProblem[],
    message?: string,
  ) {
    super(message ?? paramsMessage(problems));
    this.name = "ParamsInvalidError";
  }
}

/** Ein Befund aus dem lesenden Vorabcheck beim Anbieter. */
export interface PreflightFinding {
  id: string;
  level: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
}

export interface PreflightResult {
  /** Lesbare Beschreibung der gewaehlten Ressource, zum Beispiel "Supabase-Projekt wake-miles-staging (ref abc)". */
  resource: string | null;
  findings: PreflightFinding[];
}

/** Der Vorabcheck hat einen sicheren Fehlbefund ergeben: es wird nichts ausgestellt. */
export class PreflightError extends Error {
  readonly code = "preflight_failed";
  constructor(readonly findings: PreflightFinding[]) {
    super(`Vorabpruefung fehlgeschlagen: ${findings.filter((f) => f.level === "fail").map((f) => (f.detail ? `${f.label} (${f.detail})` : f.label)).join("; ")}`);
    this.name = "PreflightError";
  }
}

/** Die Entdeckungsart ist beim Anbieter unbekannt. */
export class UnknownDiscoverKindError extends Error {
  constructor(readonly kind: string) {
    super(`Unbekannte Entdeckungsart: ${kind}`);
    this.name = "UnknownDiscoverKindError";
  }
}

const TYPE_MESSAGE: Record<ParamType, (key: string) => string> = {
  string: (k) => `Parameter ${k} muss Text sein`,
  stringList: (k) => `Parameter ${k} muss eine nicht leere Liste von Texten sein`,
  enum: (k) => `Parameter ${k} muss Text sein`,
  url: (k) => `Parameter ${k} muss eine gueltige https-Adresse sein`,
  integer: (k) => `Parameter ${k} muss eine ganze Zahl sein`,
};

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

function typeOk(spec: ParamSpec, v: unknown): boolean {
  switch (spec.type) {
    case "string":
      return typeof v === "string" && v.trim() !== "";
    case "enum":
      return typeof v === "string";
    case "stringList":
      return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");
    case "url":
      if (typeof v !== "string") return false;
      try {
        return new URL(v.trim()).protocol === "https:";
      } catch {
        return false;
      }
    case "integer":
      return typeof v === "number" && Number.isInteger(v) && v >= (spec.min ?? 1) && (spec.max === undefined || v <= spec.max);
  }
}

const problem = (spec: ParamSpec, code: ParamProblemCode, message: string): ParamProblem => ({ key: spec.key, code, message, label: spec.label, labelEn: spec.labelEn });

function isRequired(spec: ParamSpec, params: Record<string, unknown>, specs: readonly ParamSpec[]): boolean {
  if (!spec.requiredWhen) return spec.required;
  const other = specs.find((s) => s.key === spec.requiredWhen!.key);
  const v = params[spec.requiredWhen.key];
  return (isBlank(v) ? other?.defaultValue : v) === spec.requiredWhen.equals;
}

/**
 * Wirksame Parameter eines Eintrags: die Werte des Eintrags, fehlende aus den Standardwerten der Integration.
 * Nur Parameter, die der Anbieter als integrationDefault ausweist, kommen aus den Standardwerten. Unbekannte Parameter bleiben unberuehrt.
 */
export function effectiveParams(provider: { params?: readonly ParamSpec[] }, params: Record<string, unknown>, defaults?: Record<string, unknown>): Record<string, unknown> {
  if (!defaults) return params;
  const out = { ...params };
  for (const spec of provider.params ?? []) {
    if (spec.integrationDefault && isBlank(out[spec.key]) && !isBlank(defaults[spec.key])) out[spec.key] = defaults[spec.key];
  }
  return out;
}

/**
 * Prueft die Parameter eines Eintrags gegen die Spezifikation des Anbieters. Rein, ohne Netzaufruf.
 * Befunde: Pflichtparameter fehlt, falscher Typ, Wert nicht in den erlaubten Optionen. Unbekannte Parameter sind kein Fehler
 * (sie bleiben im Inventar erhalten); `strict` meldet sie fuer Schreibwege.
 */
export function validateEntryParams(
  provider: { params?: readonly ParamSpec[] },
  entry: { params: Record<string, unknown> },
  defaults?: Record<string, unknown>,
  options: { strict?: boolean; requireComplete?: boolean } = {},
): ParamProblem[] {
  const specs = provider.params ?? [];
  const params = effectiveParams(provider, entry.params, defaults);
  const out: ParamProblem[] = [];
  for (const spec of specs) {
    const v = params[spec.key];
    if (isBlank(v)) {
      if (options.requireComplete !== false && isRequired(spec, params, specs)) out.push(problem(spec, "missing", `${spec.key} fehlt`));
      continue;
    }
    if (!typeOk(spec, v)) {
      out.push(problem(spec, "wrong_type", TYPE_MESSAGE[spec.type](spec.key)));
      continue;
    }
    if (spec.type === "enum" && spec.options && !spec.options.some((o) => o.value === v)) {
      out.push(problem(spec, "not_in_options", `Parameter ${spec.key}: "${String(v)}" ist nicht erlaubt (erlaubt: ${spec.options.map((o) => o.value).join(", ")})`));
    }
  }
  if (options.strict) {
    for (const key of Object.keys(entry.params)) {
      if (!specs.some((s) => s.key === key)) out.push({ key, code: "unknown_key", message: `Parameter ${key} ist fuer diesen Anbieter nicht vorgesehen`, label: key, labelEn: key });
    }
  }
  return out;
}

/** Klartext: "Pflichtparameter fehlen: accountId (Cloudflare-Konto), permissions (Berechtigungen)", dazu weitere Befunde. */
export function paramsMessage(problems: readonly ParamProblem[]): string {
  const missing = problems.filter((p) => p.code === "missing");
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Pflichtparameter fehlen: ${missing.map((p) => `${p.key} (${p.label})`).join(", ")}`);
  for (const p of problems) if (p.code !== "missing") parts.push(p.message);
  return parts.join("; ");
}

/** Wirft ParamsInvalidError, wenn Befunde vorliegen. */
export function assertEntryParams(provider: { params?: readonly ParamSpec[] }, entry: { params: Record<string, unknown> }, defaults?: Record<string, unknown>): void {
  const problems = validateEntryParams(provider, entry, defaults);
  if (problems.length > 0) throw new ParamsInvalidError(problems);
}

/** Standardwerte der Integration `connection` aus dem Inventar. */
export function integrationDefaultsOf(inventory: { data: { integrationDefaults?: Record<string, Record<string, unknown>> | undefined } }, provider: { connection?: string | undefined }): Record<string, unknown> | undefined {
  return provider.connection ? inventory.data.integrationDefaults?.[provider.connection] : undefined;
}

// ------------------------------------------------------------------------------------------ Vorschlaege

/** Wie eine Entdeckungsart einen Vorschlag ableitet: name = Repository und Stage im Namen, repo = Repository im Namen, sole = einzige Option. */
export const SUGGEST_MODES: Record<string, "name" | "repo" | "sole"> = {
  "supabase.project": "name",
  "cloudflare.zone": "repo",
  "resend.domain": "repo",
  "cloudflare.account": "sole",
  "grafana.serviceAccount": "sole",
};

const STAGE_WORDS: Record<StageKind, string[]> = {
  live: ["production", "prod", "live"],
  test: ["staging", "stage", "test", "qa"],
  dev: ["dev", "development", "local"],
  shared: [],
};

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Markiert hoechstens eine Option als Vorschlag. Zweideutig oder unsicher heisst: kein Vorschlag.
 * Es wird nie etwas uebernommen; die Wahl trifft der Mensch.
 */
export function markSuggestions(kind: string, options: readonly DiscoveredOption[], hint: DiscoverHint): { options: DiscoveredOption[]; suggested: string | number | null } {
  const plain = options.map((o) => ({ value: o.value, label: o.label, ...(o.detail ? { detail: o.detail } : {}) }));
  const mode = SUGGEST_MODES[kind];
  const none = { options: plain as DiscoveredOption[], suggested: null };
  if (!mode || plain.length === 0) return none;
  let winner: { index: number; score: number; reason: string } | null = null;
  if (mode === "sole") {
    if (plain.length === 1) winner = { index: 0, score: 1, reason: "einzige Option" };
  } else {
    const repos = hint.repos.map(squash).filter((r) => r.length >= 3);
    const own = new Set([...(hint.stage ? [squash(hint.stage)] : []), ...(hint.stageKind ? STAGE_WORDS[hint.stageKind] : [])]);
    const other = new Set((Object.keys(STAGE_WORDS) as StageKind[]).filter((k) => k !== hint.stageKind).flatMap((k) => STAGE_WORDS[k]).filter((w) => !own.has(w)));
    const hits: { index: number; score: number; reason: string }[] = [];
    plain.forEach((o, index) => {
      const name = squash(o.label);
      if (!repos.some((r) => name.includes(r))) return;
      if (mode === "repo") return void hits.push({ index, score: 2, reason: "Name enthaelt das Repository" });
      const words = tokens(o.label);
      if (own.size === 0) return void hits.push({ index, score: 2, reason: "Name enthaelt das Repository" });
      if (words.some((w) => own.has(w))) return void hits.push({ index, score: 3, reason: "Name enthaelt Repository und Stage" });
      // Nennt der Name eine andere Stage-Art, ist es das falsche Ziel; nennt er keine, ist der Treffer zu schwach fuer einen Vorschlag.
      void words.some((w) => other.has(w));
    });
    if (hits.length === 1) winner = hits[0]!;
  }
  if (!winner) return none;
  const options2 = plain.map((o, i) => (i === winner!.index ? { ...o, suggestedFor: { score: winner!.score, reason: winner!.reason } } : o)) as DiscoveredOption[];
  return { options: options2, suggested: plain[winner.index]!.value };
}
