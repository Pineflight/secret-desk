import { parse } from "yaml";
import { findStage, stageEnvironment, type StageDef } from "./stages.js";

/**
 * Was GitHub-Actions-Workflows an Secrets und Variablen brauchen. Reine Logik ohne Netz und ohne Dateizugriff:
 * Der Aufrufer liest die Workflow-Dateien (lokal oder ueber die Contents-API) und uebergibt Name und Text.
 * Nur Ausdruecke `${{ ... }}` (und bare `if:`-Ausdruecke) zaehlen, nie Dateinamen wie `secrets.sh` in Skriptaufrufen.
 * Kommentare im YAML fallen durch das Parsen weg. Es wird nie ein Wert gelesen.
 */

export interface WorkflowFile {
  /** Dateiname, zum Beispiel deploy.yml. */
  name: string;
  content: string;
}

export interface WorkflowRef {
  kind: "secret" | "variable";
  name: string;
  file: string;
  /** Environment des Jobs. Fehlt sie, gilt die Repo-Ebene. */
  environment?: string;
}

export type WorkflowNoteCode =
  /** `secrets: inherit`: der aufgerufene Workflow bekommt alle Secrets, welche, sieht man hier nicht. */
  | "inherit"
  /** `${{ secrets }}` als Ganzes (zum Beispiel toJSON(secrets)). */
  | "all-secrets"
  /** Die Environment eines Jobs ist ein Ausdruck, der sich nicht aufloesen laesst. */
  | "dynamic-environment"
  /** Die Datei ist kein gueltiges YAML. */
  | "parse-error";

export interface WorkflowNote {
  code: WorkflowNoteCode;
  file: string;
  /** Job, wenn die Meldung zu einem Job gehoert. */
  job?: string;
}

export interface WorkflowNeeds {
  refs: WorkflowRef[];
  notes: WorkflowNote[];
}

/** Dateien, die als Workflow zaehlen. */
export const isWorkflowFileName = (name: string): boolean => /^[^/\\]+\.ya?ml$/i.test(name);

const IGNORED_SECRETS = new Set(["GITHUB_TOKEN"]);
const EXPR_RE = /\$\{\{([\s\S]*?)\}\}/g;
// secrets.NAME, vars.NAME, secrets['NAME'], secrets["NAME"]; nicht nach einem Punkt oder Wortzeichen (foo.secrets.X, mysecrets.X)
const REF_DOT = /(?<![.\w])(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;
const REF_BRACKET = /(?<![.\w])(secrets|vars)\[\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")\s*\]/g;
// secrets allein (nicht gefolgt von . oder [), zum Beispiel toJSON(secrets)
const ALL_SECRETS = /(?<![.\w])secrets(?![\w.\[])/;

interface Found {
  refs: { kind: "secret" | "variable"; name: string }[];
  all: boolean;
}

/** Referenzen in einem Ausdruck (ohne die geschweiften Klammern). */
export function refsInExpression(expr: string): Found {
  const refs: Found["refs"] = [];
  const add = (which: string, name: string): void => {
    if (which === "secrets" && IGNORED_SECRETS.has(name)) return;
    refs.push({ kind: which === "secrets" ? "secret" : "variable", name });
  };
  // Zeichenketten-Literale herausnehmen, damit 'secrets.X' im Text kein Treffer wird, aber secrets['X'] bleibt.
  for (const m of expr.matchAll(REF_BRACKET)) add(m[1]!, (m[2] ?? m[3])!);
  const withoutBracket = expr.replace(REF_BRACKET, " ");
  const withoutStrings = withoutBracket.replace(/'[^']*'|"[^"]*"/g, " ");
  for (const m of withoutStrings.matchAll(REF_DOT)) add(m[1]!, m[2]!);
  return { refs, all: ALL_SECRETS.test(withoutStrings.replace(REF_DOT, " ")) };
}

/** Alle Ausdruecke in einem Text: `${{ ... }}`; mit bare=true gilt ein Text ohne Klammern als ein Ausdruck (if:). */
function expressionsIn(text: string, bare: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EXPR_RE)) out.push(m[1]!);
  if (out.length === 0 && bare) out.push(text);
  return out;
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Sammelt alle Ausdruecke aller Zeichenketten unterhalb von `node`. Schluessel `if` zaehlt als bare Ausdruck. */
function collect(node: Json, key: string | undefined, out: string[]): void {
  if (typeof node === "string") {
    out.push(...expressionsIn(node, key === "if"));
  } else if (Array.isArray(node)) {
    for (const x of node) collect(x, key, out);
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) collect(v, k, out);
  }
}

/** Werte, die `${{ matrix.X }}` annehmen kann (einfache Listen und include-Eintraege). */
function matrixValues(job: Record<string, Json>, key: string): string[] {
  const strategy = job["strategy"];
  const matrix = isObj(strategy) ? strategy["matrix"] : undefined;
  if (!isObj(matrix)) return [];
  const out: string[] = [];
  const list = matrix[key];
  if (Array.isArray(list)) for (const v of list) if (typeof v === "string") out.push(v);
  const include = matrix["include"];
  if (Array.isArray(include)) for (const inc of include) if (isObj(inc) && typeof inc[key] === "string") out.push(inc[key] as string);
  return [...new Set(out)];
}

/** Environments eines Jobs: undefined = keine; "dynamic" = nicht aufloesbar. */
function jobEnvironments(job: Record<string, Json>): { envs: (string | undefined)[]; dynamic: boolean } {
  const raw = job["environment"];
  const name = typeof raw === "string" ? raw : isObj(raw) && typeof raw["name"] === "string" ? (raw["name"] as string) : undefined;
  if (name === undefined || name.trim() === "") return { envs: [undefined], dynamic: false };
  if (!name.includes("${{")) return { envs: [name.trim()], dynamic: false };
  const exprs = expressionsIn(name, false).map((e) => e.trim());
  const matrixKey = exprs.length === 1 && name.trim() === `\${{ ${exprs[0]} }}` ? /^matrix\.([A-Za-z_][\w-]*)$/.exec(exprs[0]!)?.[1] : undefined;
  if (matrixKey) {
    const values = matrixValues(job, matrixKey);
    if (values.length > 0) return { envs: values, dynamic: false };
  }
  return { envs: [undefined], dynamic: true };
}

/** Wertet Workflow-Dateien aus. Mehrfachnennungen bleiben als je eine Referenz je Datei und Environment erhalten (siehe aggregateNeeds). */
export function extractWorkflowNeeds(files: readonly WorkflowFile[]): WorkflowNeeds {
  const refs: WorkflowRef[] = [];
  const notes: WorkflowNote[] = [];
  const seenRef = new Set<string>();
  const seenNote = new Set<string>();
  const addRef = (r: WorkflowRef): void => {
    const key = `${r.file}\u0000${r.kind}\u0000${r.environment ?? ""}\u0000${r.name}`;
    if (seenRef.has(key)) return;
    seenRef.add(key);
    refs.push(r);
  };
  const addNote = (n: WorkflowNote): void => {
    const key = `${n.code}\u0000${n.file}\u0000${n.job ?? ""}`;
    if (seenNote.has(key)) return;
    seenNote.add(key);
    notes.push(n);
  };

  for (const file of files) {
    let doc: Json;
    try {
      doc = parse(file.content, { schema: "core", maxAliasCount: 100 });
    } catch {
      addNote({ code: "parse-error", file: file.name });
      continue;
    }
    if (!isObj(doc)) continue;

    // Ausdruecke ausserhalb der Jobs (workflow-weites env, run-name ...) gelten fuer jeden Job; `on` hat keine Secrets.
    const workflowLevel: string[] = [];
    for (const [k, v] of Object.entries(doc)) if (k !== "jobs" && k !== "on" && k !== "true") collect(v, k, workflowLevel);

    const jobs = isObj(doc["jobs"]) ? doc["jobs"] : {};
    const jobEntries = Object.entries(jobs).filter((e): e is [string, Record<string, Json>] => isObj(e[1]));

    const emit = (exprs: string[], env: string | undefined, job?: string): void => {
      for (const expr of exprs) {
        const found = refsInExpression(expr);
        for (const r of found.refs) addRef({ kind: r.kind, name: r.name, file: file.name, ...(env !== undefined ? { environment: env } : {}) });
        if (found.all) addNote({ code: "all-secrets", file: file.name, ...(job ? { job } : {}) });
      }
    };

    if (jobEntries.length === 0) emit(workflowLevel, undefined);
    for (const [jobId, job] of jobEntries) {
      const { envs, dynamic } = jobEnvironments(job);
      if (dynamic) addNote({ code: "dynamic-environment", file: file.name, job: jobId });
      // Ausdruecke des Jobs ohne den Schluessel environment (der eigene Name ist keine Referenz).
      const own: string[] = [];
      for (const [k, v] of Object.entries(job)) if (k !== "environment") collect(v, k, own);
      if (job["secrets"] === "inherit") addNote({ code: "inherit", file: file.name, job: jobId });
      for (const env of envs) emit([...workflowLevel, ...own], env, jobId);
    }
  }
  return { refs, notes };
}

export interface NeedAggregate {
  kind: "secret" | "variable";
  name: string;
  /** Pro Environment (undefined = Repo-Ebene) die Dateien, die den Namen brauchen. */
  at: { environment?: string; files: string[] }[];
}

/** Fasst Referenzen je (Art, Name) zusammen: Mehrfachnennung in mehreren Dateien/Environments bleibt sichtbar. */
export function aggregateNeeds(refs: readonly WorkflowRef[]): NeedAggregate[] {
  const map = new Map<string, NeedAggregate>();
  for (const r of refs) {
    const key = `${r.kind}\u0000${r.name}`;
    const agg = map.get(key) ?? { kind: r.kind, name: r.name, at: [] };
    let at = agg.at.find((a) => a.environment === r.environment);
    if (!at) {
      at = { ...(r.environment !== undefined ? { environment: r.environment } : {}), files: [] };
      agg.at.push(at);
    }
    if (!at.files.includes(r.file)) at.files.push(r.file);
    map.set(key, agg);
  }
  return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** Stage, deren Environment so heisst (GitHub vergleicht Environment-Namen ohne Gross-/Kleinschreibung). */
export function environmentStage(stages: readonly StageDef[], environment: string): StageDef | undefined {
  const wanted = environment.toLowerCase();
  return stages.find((d) => stageEnvironment(d)?.toLowerCase() === wanted);
}

/** Id der Stage, der eine Referenz gehoert: Environment -> Stage mit dieser Environment; ohne Environment die Repo-Ebene-Stage. */
export function needStage(stages: readonly StageDef[], environment: string | undefined, repoLevel: string | undefined): string | undefined {
  if (environment === undefined) return repoLevel && findStage(stages, repoLevel) ? repoLevel : undefined;
  return environmentStage(stages, environment)?.id;
}
