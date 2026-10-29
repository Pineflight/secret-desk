import type { CellState, CompareCell, CompareRepo, CompareResult, CompareRow, Parity } from "@secret-desk/core";

/**
 * Reine Logik der Vergleichsseite (ohne React, ohne Netz, ohne `@/`-Importe): Filter, Abweichungen, Gruppen,
 * Paritaet fuer frei gewaehlte Stages und der Markdown-Export.
 */

export type { CellState, CompareCell, CompareRepo, CompareResult, CompareRow, Parity };

export interface CompareFilters {
  /** "" = Secrets und Variablen. */
  kind: "" | "secret" | "variable";
  repo: string;
  /** Freitext ueber Name, tatsaechliche Namen, Eintrags-Ids und Schlagworte. */
  q: string;
  /** Nur Zeilen mit Luecke oder auffaelliger Zelle. */
  onlyDeviations: boolean;
  /** Nur Zeilen, die ein Workflow braucht und die im Inventar und in GitHub fehlen (Zustand `needed`). */
  onlyNeeded?: boolean;
  /** Mit onlyNeeded auch Zeilen mit Ebenen-Unterschied (`level-mismatch`) zeigen. */
  showLevelMismatch?: boolean;
}

export const COMPARE_FILTERS_DEFAULT: CompareFilters = { kind: "", repo: "", q: "", onlyDeviations: false, onlyNeeded: false, showLevelMismatch: false };

/** Zellzustaende, die auf ein Problem hindeuten (live). */
const PROBLEM_STATES: readonly CellState[] = ["missing", "unexpected", "different", "error", "needed"];
export const isProblemState = (s: CellState): boolean => PROBLEM_STATES.includes(s);

/** Standard der verglichenen Stages: alle der Art test und live. */
export function defaultCompared(stages: readonly { id: string; kind: string }[]): string[] {
  return stages.filter((s) => s.kind === "test" || s.kind === "live").map((s) => s.id);
}

/** Gueltige Auswahl (unbekannte Ids fallen weg); leer = Standard. */
export function effectiveCompared(stages: readonly { id: string; kind: string }[], chosen: readonly string[]): string[] {
  const known = chosen.filter((id) => stages.some((s) => s.id === id));
  return known.length > 0 ? known : defaultCompared(stages);
}

/**
 * Paritaet einer Zeile fuer die gewaehlten Stages. Gleiche Regel wie compareMatrix im Kern: live zaehlt der Ist-Zustand,
 * sonst die Erwartung; Fehler- und nicht anwendbare Zellen scheiden aus; weniger als zwei vergleichbare Stages oder
 * nirgends vorhanden = n/a.
 */
export function rowParity(row: Pick<CompareRow, "cells">, compared: readonly string[], live: boolean): { parity: Parity; missingIn: string[] } {
  const have: boolean[] = [];
  const absent: string[] = [];
  for (const id of compared) {
    const c = row.cells[id];
    if (!c || c.state === "error" || c.state === "not-applicable") continue;
    const has = live ? c.present === true : c.expected;
    have.push(has);
    if (!has) absent.push(id);
  }
  if (have.length < 2 || !have.some(Boolean)) return { parity: "n/a", missingIn: [] };
  return absent.length === 0 ? { parity: "consistent", missingIn: [] } : { parity: "gap", missingIn: absent };
}

export interface ViewRow extends CompareRow {
  /** Hat die Zeile eine Abweichung (Luecke, oder live eine auffaellige Zelle)? */
  deviation: boolean;
}

/** Rechnet Paritaet fuer die Auswahl neu und markiert Abweichungen. */
export function viewRows(result: Pick<CompareResult, "rows" | "live">, compared: readonly string[]): ViewRow[] {
  return result.rows.map((r) => {
    const p = rowParity(r, compared, result.live);
    // "Von Workflows benoetigt, aber unbekannt" ist auch ohne Live-Pruefung eine Abweichung.
    const problem = Object.values(r.cells).some((c) => c.state === "needed" || (result.live && isProblemState(c.state)));
    return { ...r, parity: p.parity, missingIn: p.missingIn, deviation: p.parity === "gap" || problem || r.neededMissing === true };
  });
}

export function filterRows(rows: readonly ViewRow[], f: CompareFilters): ViewRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind && r.kind !== f.kind) return false;
    if (f.repo && r.repo !== f.repo) return false;
    if (f.onlyDeviations && !r.deviation) return false;
    if (f.onlyNeeded && !(r.neededMissing || (f.showLevelMismatch === true && r.levelMismatch))) return false;
    if (q && ![r.name, ...(r.names ?? []), ...r.ids, ...r.tags, r.product ?? ""].some((x) => x.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Luecken zuerst (stabil), sonst die Reihenfolge des Servers (Repository, Art, Name). */
export function sortRows(rows: readonly ViewRow[], gapsFirst: boolean): ViewRow[] {
  const weight = (r: ViewRow): number => (r.parity === "gap" ? 0 : r.deviation ? 1 : 2);
  const idx = new Map(rows.map((r, i) => [r, i] as const));
  return [...rows].sort((a, b) => (gapsFirst ? weight(a) - weight(b) : 0) || a.repo.localeCompare(b.repo) || idx.get(a)! - idx.get(b)!);
}

export interface RepoGroup {
  repo: string;
  rows: ViewRow[];
  gaps: number;
  deviations: number;
}

/** Gruppen nach Repository in der Reihenfolge ihres ersten Auftretens. */
export function groupByRepo(rows: readonly ViewRow[]): RepoGroup[] {
  const map = new Map<string, RepoGroup>();
  for (const r of rows) {
    const g = map.get(r.repo) ?? { repo: r.repo, rows: [], gaps: 0, deviations: 0 };
    g.rows.push(r);
    if (r.parity === "gap") g.gaps += 1;
    if (r.deviation) g.deviations += 1;
    map.set(r.repo, g);
  }
  return [...map.values()];
}

/** Blendet vom Nutzer ausgeblendete Repositories aus (nur Anzeige, nichts wird gespeichert ausser der Auswahl im Browser). */
export function hideRepos<T extends { repo: string }>(rows: readonly T[], hidden: readonly string[], showHidden: boolean): T[] {
  if (showHidden || hidden.length === 0) return [...rows];
  const set = new Set(hidden);
  return rows.filter((r) => !set.has(r.repo));
}

/** Ausgeblendete Repositories, die in den Zeilen vorkommen. */
export const hiddenPresent = (rows: readonly { repo: string }[], hidden: readonly string[]): string[] => {
  const present = new Set(rows.map((r) => r.repo));
  return hidden.filter((h) => present.has(h));
};

/** Namen fuer den Repository-Filter: alle bekannten Repositories (auch ohne Zeilen) und die der Zeilen. */
export function repoList(rows: readonly { repo: string }[], repos: readonly { name: string }[] = []): string[] {
  return [...new Set([...repos.map((r) => r.name), ...rows.map((r) => r.repo)])].sort((a, b) => a.localeCompare(b));
}

/** Repositories ohne Inventar-Eintrag und ohne einen einzigen Fund (weder in GitHub noch von Workflows gebraucht). */
export function reposWithoutEntries(repos: readonly CompareRepo[], filters: Pick<CompareFilters, "repo" | "q"> = { repo: "", q: "" }): CompareRepo[] {
  const q = filters.q.trim().toLowerCase();
  return repos.filter((r) => !r.inInventory && r.found.secrets + r.found.variables + r.needed === 0 && (!filters.repo || r.name === filters.repo) && (!q || r.name.toLowerCase().includes(q)));
}

/** Inventar-Repositories, die GitHub unter dem Namen nicht mehr kennt (umbenannt, geloescht, nicht freigegeben). */
export const missingOnGitHub = (repos: readonly CompareRepo[]): CompareRepo[] => repos.filter((r) => r.inInventory && r.onGitHub === false);

/** Kurztext "deploy.yml, ci.yml" fuer die Dateien, die eine Zeile brauchen (ohne Wiederholung). */
export function needFiles(row: Pick<CompareRow, "needs">): string[] {
  return [...new Set((row.needs ?? []).map((n) => n.file))];
}

export interface MarkdownText {
  repo: string;
  name: string;
  kind: string;
  parity: string;
  /** Kurztext einer Zelle, zum Beispiel "fehlt". */
  cell: (c: CompareCell) => string;
  kindText: (k: "secret" | "variable") => string;
  parityText: (r: ViewRow) => string;
  stageLabel: (id: string) => string;
}

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Tabelle der Abweichungen als Markdown: nur Namen, Zustaende und Paritaet, nie ein Wert. */
export function toMarkdown(rows: readonly ViewRow[], stageIds: readonly string[], text: MarkdownText): string {
  const header = [text.repo, text.name, text.kind, ...stageIds.map(text.stageLabel), text.parity];
  const lines = [`| ${header.map(esc).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of rows.filter((x) => x.deviation)) {
    lines.push(`| ${[r.repo, r.name, text.kindText(r.kind), ...stageIds.map((id) => (r.cells[id] ? text.cell(r.cells[id]!) : "–")), text.parityText(r)].map(esc).join(" | ")} |`);
  }
  return lines.join("\n");
}

export type CellTone = "success" | "danger" | "warn" | "warn-strong" | "neutral";
export interface CellLook {
  /** Schluessel im Namensraum compare.state.* */
  key: CellState;
  tone: CellTone;
  icon: "check" | "x" | "alert" | "help" | "dot";
  /** Leere Zelle: nur ein Strich, kein Badge. */
  quiet: boolean;
}

const LOOK: Record<CellState, CellLook> = {
  ok: { key: "ok", tone: "success", icon: "check", quiet: false },
  missing: { key: "missing", tone: "danger", icon: "x", quiet: false },
  unexpected: { key: "unexpected", tone: "warn", icon: "alert", quiet: false },
  unknown: { key: "unknown", tone: "neutral", icon: "help", quiet: false },
  error: { key: "error", tone: "danger", icon: "alert", quiet: false },
  different: { key: "different", tone: "warn-strong", icon: "alert", quiet: false },
  "not-expected": { key: "not-expected", tone: "neutral", icon: "dot", quiet: true },
  "not-applicable": { key: "not-applicable", tone: "neutral", icon: "dot", quiet: true },
  needed: { key: "needed", tone: "warn-strong", icon: "alert", quiet: false },
  "level-mismatch": { key: "level-mismatch", tone: "warn", icon: "alert", quiet: false },
  optional: { key: "optional", tone: "neutral", icon: "help", quiet: false },
};
export const cellLook = (s: CellState): CellLook => LOOK[s] ?? LOOK["not-expected"];

export interface StageTotals {
  expected: number;
  present: number;
  missing: number;
  unexpected: number;
  error: number;
  needed: number;
  levelMismatch: number;
}

/** Karten oben: Summen je Stage, nur ueber die sichtbaren Zeilen. */
export function stageTotals(rows: readonly ViewRow[], stageIds: readonly string[]): Record<string, StageTotals> {
  const out: Record<string, StageTotals> = {};
  for (const id of stageIds) out[id] = { expected: 0, present: 0, missing: 0, unexpected: 0, error: 0, needed: 0, levelMismatch: 0 };
  for (const r of rows) {
    for (const id of stageIds) {
      const c = r.cells[id];
      const t = out[id];
      if (!c || !t) continue;
      if (c.expected) t.expected += 1;
      if (c.present) t.present += 1;
      if (c.state === "missing") t.missing += 1;
      else if (c.state === "unexpected") t.unexpected += 1;
      else if (c.state === "error") t.error += 1;
      else if (c.state === "needed") t.needed += 1;
      else if (c.state === "level-mismatch") t.levelMismatch += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ins Inventar aufnehmen (Zeilen mit Zustand "needed")
// ---------------------------------------------------------------------------

export interface AdoptCandidate {
  /** Stabile Kennung innerhalb der Liste. */
  key: string;
  repo: string;
  name: string;
  kind: "secret" | "variable";
  stage: string;
  /** Workflow-Dateien, die den Namen brauchen. */
  files: string[];
  /** Vorgeschlagene Inventar-Id. */
  id: string;
  /** Name erfuellt die Namensregel des Inventars nicht (GROSSBUCHSTABEN_MIT_UNTERSTRICH). */
  invalidName: boolean;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Vorgeschlagene Id: repo-name-stage, eindeutig gegen `taken` (wird ergaenzt). */
export function suggestId(repo: string, name: string, stage: string, taken: Set<string>): string {
  const base = slug(`${repo}-${name}-${stage}`).slice(0, 80).replace(/-+$/g, "") || "eintrag";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Alle Zellen mit Zustand "needed": je Stage, Name und Art ein Vorschlag. */
export function adoptCandidates(rows: readonly CompareRow[]): AdoptCandidate[] {
  const taken = new Set<string>(rows.flatMap((r) => r.ids));
  const out: AdoptCandidate[] = [];
  for (const r of rows) {
    for (const [stage, cell] of Object.entries(r.cells)) {
      if (cell.state !== "needed") continue;
      const names = cell.detail?.actualNames && cell.detail.actualNames.length > 0 ? cell.detail.actualNames : [r.name];
      for (const name of names) {
        out.push({
          key: `${r.repo}\u0000${r.kind}\u0000${name}\u0000${stage}`,
          repo: r.repo,
          name,
          kind: r.kind,
          stage,
          files: cell.detail?.neededBy ?? [],
          id: suggestId(r.repo, name, stage, taken),
          invalidName: !/^[A-Z][A-Z0-9_]*$/.test(name),
        });
      }
    }
  }
  return out;
}

/**
 * Anfrage zum Anlegen im Inventar: nur Metadaten, nie ein Wert. Secrets: Anbieter manual, Ablauf unknown.
 * Hat die Stage eine Environment, ist das Ziel die Environment, sonst die Repo-Ebene.
 */
export function adoptRequest(c: Pick<AdoptCandidate, "repo" | "name" | "kind" | "stage" | "id">, ctx: { environment: string | null; description: string }): { path: "secrets" | "variables"; body: Record<string, unknown> } {
  const places = [ctx.environment ? { repo: c.repo, scope: "environment" } : { repo: c.repo, scope: "repository" }];
  const common = { id: c.id, name: c.name, stage: c.stage, description: ctx.description, places };
  if (c.kind === "secret") return { path: "secrets", body: { ...common, service: "github-actions", provider: "manual", expiry: "unknown" } };
  return { path: "variables", body: common };
}

/** Parameter fuer die Neu-Dialoge auf /secrets und /variables (Vorbelegung per Link). */
export function adoptLink(c: Pick<AdoptCandidate, "repo" | "name" | "kind" | "stage" | "id" | "files">, description: string): string {
  const q = new URLSearchParams({ new: "1", pf_name: c.name, pf_repo: c.repo, pf_stage: c.stage, pf_id: c.id, pf_desc: description });
  return `${c.kind === "secret" ? "/secrets" : "/variables"}?${q.toString()}`;
}
