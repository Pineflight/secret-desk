/**
 * Namenskonvention fuer Secrets und Variablen (siehe docs/NAMING.md). Reine Logik ohne Netz und Dateizugriff.
 * `checkName` nennt die Verstoesse, `suggestName` den Namen, der alle Regeln erfuellt. Es wird nie ein Wert gelesen.
 */

export interface NamingConfig {
  /** Alter Name -> neuer Name. Geht den allgemeinen Regeln vor (Faelle, die keine Regel kennen kann). */
  renames: Record<string, string>;
  /** Namen, die nie geaendert werden. */
  keep: string[];
}

export const DEFAULT_NAMING: NamingConfig = { renames: {}, keep: [] };

export type NameFindingCode = "not-upper-snake" | "stage-in-name" | "provider-abbreviation" | "github-prefix" | "framework-prefix" | "supabase-canonical" | "non-english" | "workspace-rename";

export interface NameFinding {
  code: NameFindingCode;
  /** Deutscher Text (ASCII, wird an der API-Grenze uebersetzt). */
  text: string;
  /** Der Name, der alle Regeln erfuellt (bei allen Befunden eines Namens derselbe). */
  suggested: string;
}

export interface NameAnalysis {
  suggested: string;
  findings: NameFinding[];
  /** Stage-Woerter, die aus dem Namen entfernt wurden (grossgeschrieben, in der Reihenfolge des Vorkommens). */
  removedStageTokens: string[];
}

/** Ganze `_`-Teile, die eine Stage benennen. Die Stage kommt aus dem GitHub-Environment, nicht aus dem Namen. */
export const STAGE_TOKENS: readonly string[] = ["STAGING", "STAGE", "PRODUCTION", "PROD", "LIVE", "DEV", "TEST"];

/** Welche Stage-Id ein entferntes Stage-Wort nahelegt. TEST ist mehrdeutig (Sandbox oder Staging) und legt nichts nahe. */
export const STAGE_TOKEN_HINT: Readonly<Record<string, string>> = { STAGING: "staging", STAGE: "staging", PRODUCTION: "production", PROD: "production", LIVE: "production", DEV: "dev" };

const GERMAN_TO_ENGLISH: Readonly<Record<string, string>> = {
  GEHEIMNIS: "SECRET",
  ABGLEICH: "RECONCILIATION",
  AUFRAEUMEN: "CLEANUP",
  KUNDENDOMAIN: "CUSTOMER_DOMAIN",
  ZUSTELL: "DELIVERY",
  ZEITSTEUERUNG: "SCHEDULER",
  RECHERCHE: "RESEARCH",
  MANDANT: "TENANT",
  ZUSTAENDIG: "ASSIGNEE",
  BENUTZER: "USER",
  KONTAKT: "CONTACT",
  ABSENDER: "SENDER",
  EMPFAENGER: "RECIPIENT",
  BESTAETIGUNG: "CONFIRMATION",
  ANGEBOT: "QUOTE",
  DATENSCHUTZ: "PRIVACY",
  WIDERRUFSBELEHRUNG: "WITHDRAWAL_NOTICE",
  HINWEIS: "NOTICE",
  EINGANG: "INBOUND",
  BASIS: "BASE",
  SENDEN: "SEND",
  GEPLANT: "SCHEDULED",
  STOPP: "STOP",
  BLOCKIEREND: "BLOCKING",
  ZIEL: "TARGET",
  ASSISTENT: "ASSISTANT",
};

const MESSAGES: Record<NameFindingCode, string> = {
  "not-upper-snake": "Der Name ist nicht in GROSSBUCHSTABEN_MIT_UNTERSTRICH",
  "stage-in-name": "Die Stage steht im Namen, sie kommt aus der GitHub-Environment",
  "provider-abbreviation": "Der Anbieter ist abgekuerzt, er wird ausgeschrieben",
  "github-prefix": "GitHub lehnt Namen ab, die mit GITHUB_ beginnen",
  "framework-prefix": "Das Framework-Praefix gehoert in den Workflow, nicht in den GitHub-Namen",
  "supabase-canonical": "Supabase heisst jetzt publishable und secret key",
  "non-english": "Der Name enthaelt deutsche Woerter, Namen sind englisch",
  "workspace-rename": "Die Konfiguration (naming.renames) legt einen anderen Namen fest",
};

const tokensOf = (name: string): string[] => name.split("_").filter((t) => t !== "");

/** Regel 1: GROSSBUCHSTABEN_MIT_UNTERSTRICH. camelCase und Trennzeichen werden zu Unterstrichen. */
function upperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Regel 2. Bleibt nichts uebrig, bleibt der Name unveraendert. */
function stripStage(tokens: string[], removed: string[]): string[] {
  const kept = tokens.filter((t) => !STAGE_TOKENS.includes(t));
  if (kept.length === 0 || kept.length === tokens.length) return tokens;
  for (const t of tokens) if (STAGE_TOKENS.includes(t)) removed.push(t);
  return kept;
}

/** Regel 4: NEXT_PUBLIC_ und VITE_ am Anfang. */
function stripFramework(tokens: string[]): string[] {
  let rest = tokens;
  if (rest[0] === "NEXT" && rest[1] === "PUBLIC") rest = rest.slice(2);
  else if (rest[0] === "VITE") rest = rest.slice(1);
  return rest.length > 0 ? rest : tokens;
}

/** Regel 3: Abkuerzungen am Anfang. GitHub selbst lehnt GITHUB_ ab, deshalb wandert der Anbieter ans Ende. */
function expandProvider(tokens: string[]): string[] {
  const [first, ...rest] = tokens;
  if (rest.length === 0) return tokens;
  if (first === "CF") return ["CLOUDFLARE", ...rest];
  if (first === "TF") return ["TERRAFORM", ...rest];
  if (first === "R2") return ["CLOUDFLARE", "R2", ...rest];
  if (first === "GH") return moveGithub(rest, tokens);
  return tokens;
}

/** GITHUB_<X> am Anfang: GitHub lehnt den Namen ab, der Anbieter wandert ans Ende. */
function githubPrefix(tokens: string[]): string[] {
  return tokens[0] === "GITHUB" && tokens.length > 1 ? moveGithub(tokens.slice(1), tokens) : tokens;
}

/** `<X>_TOKEN` -> `<X>_GITHUB_TOKEN`, sonst `<X>` -> `<X>_GITHUB`. Ein nacktes TOKEN bleibt (kein Name ohne den Rest). */
function moveGithub(rest: string[], original: string[]): string[] {
  if (rest.length === 1 && rest[0] === "TOKEN") return original;
  if (rest.length > 1 && rest[rest.length - 1] === "TOKEN") return [...rest.slice(0, -1), "GITHUB", "TOKEN"];
  return [...rest, "GITHUB"];
}

/** Regel 5: kanonische Supabase-Namen (nach dem Entfernen von Stage und Framework-Praefix). */
function supabaseCanonical(tokens: string[]): string[] {
  if (tokens[0] !== "SUPABASE") return tokens;
  if (tokens[1] === "ANON" && tokens[2] === "KEY") return ["SUPABASE", "PUBLISHABLE", "KEY", ...tokens.slice(3)];
  if (tokens[1] === "SERVICE" && tokens[2] === "ROLE" && tokens[3] === "KEY") return ["SUPABASE", "SECRET", "KEY", ...tokens.slice(4)];
  return tokens;
}

/** Regel 6: deutsche Woerter, die im Woerterbuch stehen. Unbekannte Woerter werden nie geraten. */
const toEnglish = (tokens: string[]): string[] => tokens.flatMap((t) => GERMAN_TO_ENGLISH[t]?.split("_") ?? [t]);

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Prueft einen Namen gegen alle Regeln und schlaegt den konformen Namen vor. Die Regeln laufen bis zum Fixpunkt, damit
 * der Vorschlag selbst keinen Verstoss mehr enthaelt (suggestName ist idempotent).
 */
export function analyzeName(name: string, naming: Partial<NamingConfig> = {}): NameAnalysis {
  const keep = naming.keep ?? [];
  const renames = naming.renames ?? {};
  const own = Object.prototype.hasOwnProperty.call(renames, name) ? renames[name] : undefined;
  if (keep.includes(name)) return { suggested: name, findings: [], removedStageTokens: [] };
  if (own !== undefined) {
    if (own === name) return { suggested: name, findings: [], removedStageTokens: [] };
    return { suggested: own, findings: [{ code: "workspace-rename", text: MESSAGES["workspace-rename"], suggested: own }], removedStageTokens: [] };
  }

  const hit = new Set<NameFindingCode>();
  const removed: string[] = [];
  let current = name;
  for (let pass = 0; pass < 6; pass++) {
    const startPass = current;
    const snake = upperSnake(current);
    if (snake !== current) hit.add("not-upper-snake");
    let tokens = tokensOf(snake);
    if (tokens.length === 0) break;
    const step = (code: NameFindingCode, fn: (t: string[]) => string[]): void => {
      const next = fn(tokens);
      if (!same(next, tokens)) hit.add(code);
      tokens = next;
    };
    step("stage-in-name", (t) => stripStage(t, removed));
    step("framework-prefix", stripFramework);
    step("provider-abbreviation", expandProvider);
    step("github-prefix", githubPrefix);
    step("supabase-canonical", supabaseCanonical);
    step("non-english", toEnglish);
    current = tokens.join("_");
    if (current === startPass) break;
  }
  // GITHUB_ ist ein eigener Befund, auch wenn kein Vorschlag moeglich ist (nacktes GITHUB_TOKEN).
  if (name.startsWith("GITHUB_")) hit.add("github-prefix");
  const order: NameFindingCode[] = ["not-upper-snake", "stage-in-name", "provider-abbreviation", "github-prefix", "framework-prefix", "supabase-canonical", "non-english"];
  const findings = order.filter((c) => hit.has(c)).map((code) => ({ code, text: MESSAGES[code], suggested: current }));
  return { suggested: current, findings, removedStageTokens: current === name ? [] : removed };
}

export const checkName = (name: string, naming: Partial<NamingConfig> = {}): NameFinding[] => analyzeName(name, naming).findings;

export const suggestName = (name: string, naming: Partial<NamingConfig> = {}): string => analyzeName(name, naming).suggested;
