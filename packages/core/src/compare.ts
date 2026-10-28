import { findStage, stageEnvironment, type StageDef, type StageKind } from "./stages.js";
import type { Inventory, Place } from "./types.js";
import { environmentStage, needStage, type WorkflowNeeds } from "./workflow-needs.js";

/**
 * Stage-Vergleich: eine Matrix aus (Repository, Name) und Stage. Reine Logik ohne Netz:
 * Erwartung kommt aus dem Inventar, der Ist-Zustand (nur Namen, bei Variablen auch Werte) als fertig gelesene Daten.
 * Keine Funktion hier liest oder liefert je einen geheimen Wert.
 */

export type CompareKind = "secret" | "variable";

export type CellState =
  /** erwartet und vorhanden */
  | "ok"
  /** erwartet, fehlt in GitHub */
  | "missing"
  /** in GitHub vorhanden, im Inventar fuer diese Stage unbekannt */
  | "unexpected"
  /** weder erwartet noch vorhanden */
  | "not-expected"
  /** nicht live geprueft, nur die Erwartung ist bekannt */
  | "unknown"
  /** Ziel nicht lesbar (403, 429, Netz ...) */
  | "error"
  /** Variable: Wert in GitHub weicht vom Sollwert ab */
  | "different"
  /** Die Stage hat in diesem Repository kein Ziel (keine Environment, nicht die Repo-Ebene) */
  | "not-applicable"
  /** Ein Workflow braucht den Namen hier, er steht weder im Inventar noch (soweit bekannt) in GitHub */
  | "needed";

export type Parity = "consistent" | "gap" | "n/a";

export interface CompareLocation {
  repo: string;
  scope: Place["scope"];
  environment?: string;
}

/** Ergebnis des Lesens eines Ziels. `names`: Name -> Wert (Variablen) bzw. null (Secrets, nie ein Wert). */
export type LocationRead = { error: string; status?: number } | { names: Map<string, string | null>; notFound?: boolean };
export interface LiveReads {
  secret: Map<string, LocationRead>;
  variable: Map<string, LocationRead>;
}

export interface CompareOptions {
  /** Stage-Ids, deren Praesenz verglichen wird (Paritaet). Standard: alle Stages der Art test und live. */
  compare?: string[];
  kinds?: CompareKind[];
  repo?: string;
  /** Stage-Woerter (STAGING, PRODUCTION, PROD, DEV, Stage-Ids) im Namen weglassen und Zeilen zusammenfuehren. */
  normalizeNames?: boolean;
}

export interface CellDetail {
  /** Inventar-Eintraege, die hier etwas erwarten. */
  ids: string[];
  /** Geprueftes Ziel (Repository, Environment oder Organisation). */
  targets: string[];
  /** Tatsaechliche Namen im Ziel, wenn sie vom Zeilennamen abweichen oder unerwartet sind. */
  actualNames?: string[];
  /** Erwartete Ziele, an denen der Name fehlt. */
  missingAt?: string[];
  /** Sollwerte und Istwerte (nur Variablen). */
  expectedValues?: string[];
  actualValues?: string[];
  /** Environments, die es in GitHub nicht gibt (404). */
  notFound?: string[];
  error?: { target: string; message: string; status?: number };
  /** Workflow-Dateien, die den Namen hier brauchen. */
  neededBy?: string[];
}

export interface CompareCell {
  state: CellState;
  expected: boolean;
  present?: boolean;
  detail?: CellDetail;
}

export interface CompareStage {
  id: string;
  label: string;
  kind: StageKind;
  environment: string | null;
}

export interface CompareRow {
  repo: string;
  name: string;
  /** Verschiedene tatsaechliche Namen, die diese Zeile zusammenfasst (nur bei normalisierten Namen). */
  names?: string[];
  kind: CompareKind;
  ids: string[];
  product?: string;
  cells: Record<string, CompareCell>;
  parity: Parity;
  missingIn: string[];
  tags: string[];
  /** Workflows, die den Namen brauchen (Datei, Environment; ohne Environment = Repo-Ebene). */
  needs?: { file: string; environment?: string }[];
  /** Environments ohne Stage: wo der Name in GitHub gefunden wurde, und wo ein Workflow ihn braucht, er aber fehlt. */
  other?: { present: string[]; needed: string[] };
  /** Ein Workflow braucht den Namen, aber er fehlt im Inventar und (soweit bekannt) in GitHub. */
  neededMissing: boolean;
}

export interface StageSummary {
  expected: number;
  present: number;
  missing: number;
  unexpected: number;
  error: number;
  needed: number;
}

export type RepoNoteCode =
  /** Dem Token fehlt das Recht Contents: Read (Workflow-Dateien nicht lesbar). */
  | "contents-forbidden"
  | "contents-error"
  | "environments-unreadable"
  | "read-error"
  | "inherit"
  | "all-secrets"
  | "dynamic-environment"
  | "parse-error";

export interface RepoNote {
  code: RepoNoteCode;
  file?: string;
  job?: string;
  target?: string;
  message?: string;
  status?: number;
}

/** Ein Repository der Organisation (oder des Inventars) im Vergleich. */
export interface CompareRepo {
  name: string;
  inInventory: boolean;
  /** null = unbekannt (GitHub-Liste nicht gelesen). */
  private: boolean | null;
  archived: boolean | null;
  pushedAt: string | null;
  /** false = steht im Inventar, aber nicht in der GitHub-Liste (umbenannt, geloescht oder nicht freigegeben). null = unbekannt. */
  onGitHub: boolean | null;
  renamedTo?: string;
  /** Verschiedene Namen, die in GitHub gefunden wurden. */
  found: { secrets: number; variables: number };
  /** Zeilen, die ein Workflow braucht und die fehlen. */
  needed: number;
  notes: RepoNote[];
}

/** Repository-Liste aus GitHub (nur Metadaten). */
export interface RepoMeta {
  name: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}

/** Repositories, die keine Vergleichszeile bekommen. */
export const HIDDEN_REPOS: readonly string[] = [".github", ".github-private"];

/** Zusatzdaten fuer den Vergleich, alle schon gelesen: Repositories ohne Inventar, Workflows, Umbenennungen. */
export interface CompareExtras {
  repos?: RepoMeta[];
  /** Repositories ohne Inventar-Eintrag, deren Ziele gelesen wurden. */
  readRepos?: string[];
  /** Namen der GitHub-Environments je gelesenem Repository. */
  envs?: Map<string, string[]>;
  /** Gelesene Ziele der readRepos (Repo-Ebene, Stage-Environments, andere Environments). */
  reads?: LiveReads;
  /** Organisations-Secrets/-Variablen (zaehlen als vorhanden fuer jeden Workflow). */
  org?: Partial<Record<CompareKind, LocationRead>>;
  needs?: Map<string, WorkflowNeeds>;
  notes?: Map<string, RepoNote[]>;
  /** Alter Name -> aktueller Name. */
  renames?: Record<string, string>;
}

export interface CompareResult {
  stages: CompareStage[];
  /** Die Stages, deren Praesenz fuer die Paritaet verglichen wurde. */
  compared: string[];
  rows: CompareRow[];
  summary: { perStage: Record<string, StageSummary>; gaps: number; orphans: number; neededMissing: number };
  /** Alle bekannten Repositories: Inventar und (mit GitHub-Liste) die der Organisation. */
  repos: CompareRepo[];
  live: boolean;
  errors: { target: string; message: string }[];
}

export const locationKey = (l: CompareLocation): string => (l.scope === "organization" ? "organization" : `${l.repo}/${l.scope}/${l.environment ?? ""}`);
export const locationLabel = (l: CompareLocation): string => (l.scope === "organization" ? "org" : l.scope === "environment" ? `${l.repo}/env:${l.environment}` : `${l.repo}/repo`);

const placeLocation = (p: Place): CompareLocation => ({ repo: p.repo, scope: p.scope, ...(p.environment ? { environment: p.environment } : {}) });

/** Standard-Woerter, die eine Stage im Namen kennzeichnen. */
export const STAGE_NAME_TOKENS: readonly string[] = ["STAGING", "PRODUCTION", "PROD", "DEV"];

/** Die Stage, der die Repo-Ebene (Secrets/Variablen ohne Environment) gehoert: erste ohne Environment der Art shared, sonst die erste ohne Environment. */
export function repoLevelStage(stages: readonly StageDef[]): string | undefined {
  const free = stages.filter((d) => stageEnvironment(d) === null);
  return (free.find((d) => d.kind === "shared") ?? free[0])?.id;
}

/** Wo eine Stage in einem Repository liegt: ihre Environment, oder (nur die Repo-Stage) die Repo-Ebene. Sonst nirgends. */
export function stageLocation(stages: readonly StageDef[], stageId: string, repo: string): CompareLocation | undefined {
  const def = findStage(stages, stageId);
  if (!def) return undefined;
  const env = stageEnvironment(def);
  if (env) return { repo, scope: "environment", environment: env };
  return repoLevelStage(stages) === stageId ? { repo, scope: "repository" } : undefined;
}

type Source = Pick<Inventory, "stages" | "secrets" | "variables">;

function kindsOf(opts: CompareOptions): CompareKind[] {
  return opts.kinds && opts.kinds.length > 0 ? [...new Set(opts.kinds)] : ["secret", "variable"];
}

function entriesOf(inv: Source, kind: CompareKind) {
  return kind === "secret" ? inv.secrets : inv.variables;
}

/** Repositories der Matrix: die der Inventar-Ziele (mit Filter). */
export function compareRepos(inv: Source, opts: CompareOptions = {}): string[] {
  const out = new Set<string>();
  for (const kind of kindsOf(opts)) for (const e of entriesOf(inv, kind)) for (const p of e.places) if (!opts.repo || p.repo === opts.repo) out.add(p.repo);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Alle Ziele, die fuer den Live-Abgleich gelesen werden muessen: je Repository die Repo-Ebene (falls eine Stage sie nutzt),
 * die Environment jeder Stage, dazu die Ziele der Inventar-Eintraege. Jedes Ziel einmal.
 */
export function requiredLocations(inv: Source, opts: CompareOptions = {}): Record<CompareKind, CompareLocation[]> {
  const out: Record<CompareKind, CompareLocation[]> = { secret: [], variable: [] };
  const repos = compareRepos(inv, opts);
  for (const kind of kindsOf(opts)) {
    const seen = new Set<string>();
    const add = (l: CompareLocation | undefined): void => {
      if (!l || seen.has(locationKey(l))) return;
      seen.add(locationKey(l));
      out[kind].push(l);
    };
    for (const repo of repos) for (const d of inv.stages) add(stageLocation(inv.stages, d.id, repo));
    for (const e of entriesOf(inv, kind)) for (const p of e.places) if (!opts.repo || p.repo === opts.repo) add(placeLocation(p));
  }
  return out;
}

interface Exp {
  id: string;
  stage: string;
  actualName: string;
  place: Place;
  value: string | null;
}

interface Acc {
  repo: string;
  kind: CompareKind;
  key: string;
  name: string;
  names: Set<string>;
  exps: Exp[];
  tags: Set<string>;
  needs: { file: string; environment?: string; name: string }[];
  otherPresent: Set<string>;
  product?: string;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Baut die Matrix. Ohne `live` zeigen Zellen mit Erwartung `unknown`. */
export function compareMatrix(inv: Source, opts: CompareOptions = {}, live?: LiveReads, extras?: CompareExtras): CompareResult {
  const stages = inv.stages;
  const kinds = kindsOf(opts);
  const stageList: CompareStage[] = stages.map((d) => ({ id: d.id, label: d.label ?? d.id, kind: d.kind, environment: stageEnvironment(d) }));

  const tokens = new Set<string>(STAGE_NAME_TOKENS);
  for (const d of stages) {
    for (const w of [d.id, stageEnvironment(d)]) if (w && !w.includes("-")) tokens.add(w.toUpperCase());
  }
  const normalize = (name: string): string => {
    if (!opts.normalizeNames) return name;
    const kept = name.split("_").filter((s) => s !== "" && !tokens.has(s));
    return kept.length > 0 ? kept.join("_") : name;
  };

  const rows = new Map<string, Acc>();
  const rowFor = (repo: string, kind: CompareKind, actualName: string): Acc => {
    const name = normalize(actualName);
    const key = `${repo}\u0000${kind}\u0000${name}`;
    let acc = rows.get(key);
    if (!acc) {
      acc = { repo, kind, key, name, names: new Set(), exps: [], tags: new Set(), needs: [], otherPresent: new Set() };
      rows.set(key, acc);
    }
    acc.names.add(actualName);
    return acc;
  };

  for (const kind of kinds) {
    for (const e of entriesOf(inv, kind)) {
      for (const p of e.places) {
        if (opts.repo && p.repo !== opts.repo) continue;
        const actualName = p.name ?? e.name;
        const acc = rowFor(p.repo, kind, actualName);
        acc.exps.push({ id: e.id, stage: e.stage, actualName, place: p, value: "value" in e ? (e.value ?? null) : null });
        for (const t of e.tags) acc.tags.add(t);
        if (e.product && !acc.product) acc.product = e.product;
      }
    }
  }

  const errors: { target: string; message: string }[] = [];
  const errSeen = new Set<string>();
  const readOf = (kind: CompareKind, loc: CompareLocation): LocationRead | undefined => live?.[kind].get(locationKey(loc)) ?? extras?.reads?.[kind].get(locationKey(loc));
  const inventoryRepos = compareRepos(inv, opts);
  const readRepos = (extras?.readRepos ?? []).filter((r) => !opts.repo || r === opts.repo);
  const extraSet = new Set(readRepos);
  const repoLevel = repoLevelStage(stages);
  const notesOf = new Map<string, RepoNote[]>();
  const noteFor = (repo: string, n: RepoNote): void => {
    const list = notesOf.get(repo) ?? [];
    if (!list.some((x) => x.code === n.code && x.target === n.target && x.file === n.file && x.job === n.job)) list.push(n);
    notesOf.set(repo, list);
  };

  // Was Workflows brauchen, bekommt eine Zeile, auch wenn es sonst nirgends vorkommt.
  if (extras?.needs) {
    const inScope = new Set([...inventoryRepos, ...readRepos]);
    for (const [repo, wn] of extras.needs) {
      if (!inScope.has(repo)) continue;
      for (const ref of wn.refs) {
        if (!kinds.includes(ref.kind)) continue;
        const acc = rowFor(repo, ref.kind, ref.name);
        acc.needs.push({ file: ref.file, ...(ref.environment !== undefined ? { environment: ref.environment } : {}), name: ref.name });
      }
      for (const n of wn.notes) noteFor(repo, { code: n.code, file: n.file, ...(n.job ? { job: n.job } : {}) });
    }
  }

  // Repositories ohne Inventar-Eintrag: Namen an Stage-Zielen und in anderen Environments sind "nur in GitHub".
  if (extras?.reads) {
    for (const kind of kinds) {
      for (const repo of readRepos) {
        const locs: CompareLocation[] = [];
        for (const d of stages) {
          const loc = stageLocation(stages, d.id, repo);
          if (loc) locs.push(loc);
        }
        for (const env of extras.envs?.get(repo) ?? []) if (!environmentStage(stages, env)) locs.push({ repo, scope: "environment", environment: env });
        for (const loc of locs) {
          const read = readOf(kind, loc);
          if (!read) continue;
          if ("error" in read) {
            noteFor(repo, { code: "read-error", target: locationLabel(loc), message: read.error, ...(read.status !== undefined ? { status: read.status } : {}) });
            continue;
          }
          const isOther = loc.scope === "environment" && loc.environment !== undefined && !environmentStage(stages, loc.environment);
          for (const n of read.names.keys()) {
            const acc = rowFor(repo, kind, n);
            if (isOther) acc.otherPresent.add(loc.environment!);
          }
        }
      }
    }
  }
  for (const [repo, list] of extras?.notes ?? []) for (const n of list) noteFor(repo, n);
  if (live) {
    for (const kind of kinds) {
      for (const [key, read] of live[kind]) {
        if ("error" in read && !errSeen.has(`${kind}:${key}`)) {
          errSeen.add(`${kind}:${key}`);
          errors.push({ target: `${kind} ${key}`, message: read.error });
        }
      }
    }
    // Waisen: Namen an den Stage-Zielen, die im Inventar fehlen, bekommen eine eigene Zeile.
    for (const kind of kinds) {
      for (const repo of inventoryRepos) {
        for (const d of stages) {
          const loc = stageLocation(stages, d.id, repo);
          const read = loc ? readOf(kind, loc) : undefined;
          if (read && "names" in read) for (const n of read.names.keys()) rowFor(repo, kind, n);
        }
      }
    }
  }

  const comparedIds = (opts.compare ?? []).filter((id) => stages.some((d) => d.id === id));
  const compared = comparedIds.length > 0 ? uniq(comparedIds) : stages.filter((d) => d.kind === "test" || d.kind === "live").map((d) => d.id);

  const perStage: Record<string, StageSummary> = {};
  for (const d of stages) perStage[d.id] = { expected: 0, present: 0, missing: 0, unexpected: 0, error: 0, needed: 0 };
  let gaps = 0;
  let orphans = 0;
  let neededMissing = 0;

  const covered = (acc: Acc, name: string, envScoped: boolean): boolean => {
    if (envScoped) {
      const repoRead = readOf(acc.kind, { repo: acc.repo, scope: "repository" });
      if (repoRead && "names" in repoRead && repoRead.names.has(name)) return true;
    }
    const org = extras?.org?.[acc.kind];
    return Boolean(org && "names" in org && org.names.has(name));
  };

  const out: CompareRow[] = [];
  for (const acc of rows.values()) {
    const cells: Record<string, CompareCell> = {};
    for (const d of stages) {
      const here = acc.needs.filter((n) => needStage(stages, n.environment, repoLevel) === d.id);
      const needInfo = here.length > 0 ? { files: uniq(here.map((n) => n.file)), names: uniq(here.map((n) => n.name)), covered: Boolean(live) && here.every((n) => covered(acc, n.name, n.environment !== undefined)) } : undefined;
      const cell = computeCell(acc, d, stages, live ? (loc) => readOf(acc.kind, loc) : undefined, normalize, needInfo);
      cells[d.id] = cell;
      const s = perStage[d.id]!;
      if (cell.expected) s.expected += 1;
      if (cell.present) s.present += 1;
      if (cell.state === "missing") s.missing += 1;
      else if (cell.state === "unexpected") s.unexpected += 1;
      else if (cell.state === "error") s.error += 1;
      else if (cell.state === "needed") s.needed += 1;
    }

    // Environments ohne Stage: nur bei Repositories, deren Ziele gelesen wurden, laesst sich sagen, ob der Name fehlt.
    const otherNeeded: string[] = [];
    for (const n of acc.needs) {
      if (needStage(stages, n.environment, repoLevel) !== undefined) continue;
      if (!extraSet.has(acc.repo) || !live) continue;
      const env = n.environment;
      const actualEnv = env === undefined ? undefined : (extras?.envs?.get(acc.repo) ?? []).find((e) => e.toLowerCase() === env.toLowerCase());
      const read = env === undefined ? readOf(acc.kind, { repo: acc.repo, scope: "repository" }) : actualEnv ? readOf(acc.kind, { repo: acc.repo, scope: "environment", environment: actualEnv }) : undefined;
      const here = Boolean(read && "names" in read && read.names.has(n.name));
      if (!here && !covered(acc, n.name, env !== undefined)) otherNeeded.push(env ?? "");
    }
    const hasNeeded = Object.values(cells).some((c) => c.state === "needed") || otherNeeded.length > 0;
    if (hasNeeded) neededMissing += 1;

    // Paritaet: Praesenz in den verglichenen Stages. Live zaehlt der Ist-Zustand, sonst die Erwartung; Fehler und n/a scheiden aus.
    const have: boolean[] = [];
    const absent: string[] = [];
    for (const id of compared) {
      const c = cells[id]!;
      if (c.state === "error" || c.state === "not-applicable") continue;
      const has = live ? c.present === true : c.expected;
      have.push(has);
      if (!has) absent.push(id);
    }
    let parity: Parity = "n/a";
    if (have.length >= 2 && have.some(Boolean)) parity = absent.length === 0 ? "consistent" : "gap";
    if (parity === "gap") gaps += 1;
    const ids = uniq(acc.exps.map((x) => x.id));
    if (ids.length === 0) orphans += 1;
    const names = [...acc.names].sort();
    out.push({
      repo: acc.repo,
      name: acc.name,
      ...(names.length > 1 || (names[0] !== undefined && names[0] !== acc.name) ? { names } : {}),
      kind: acc.kind,
      ids,
      ...(acc.product ? { product: acc.product } : {}),
      cells,
      parity,
      missingIn: parity === "gap" ? absent : [],
      tags: [...acc.tags].sort(),
      ...(acc.needs.length > 0 ? { needs: uniqBy(acc.needs.map((n) => ({ file: n.file, ...(n.environment !== undefined ? { environment: n.environment } : {}) })), (n) => `${n.file}\u0000${n.environment ?? ""}`) } : {}),
      ...(acc.otherPresent.size > 0 || otherNeeded.length > 0 ? { other: { present: [...acc.otherPresent].sort(), needed: uniq(otherNeeded).sort() } } : {}),
      neededMissing: hasNeeded,
    });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo) || (a.kind === b.kind ? 0 : a.kind === "secret" ? -1 : 1) || a.name.localeCompare(b.name));
  const repos = buildRepos(inv, opts, out, extras, notesOf);
  return { stages: stageList, compared, rows: out, summary: { perStage, gaps, orphans, neededMissing }, repos, live: Boolean(live), errors };
}

function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildRepos(inv: Source, opts: CompareOptions, rows: readonly CompareRow[], extras: CompareExtras | undefined, notesOf: Map<string, RepoNote[]>): CompareRepo[] {
  const meta = new Map<string, RepoMeta>();
  for (const r of extras?.repos ?? []) meta.set(r.name, r);
  const inInventory = new Set(compareRepos(inv, opts));
  const names = new Set<string>(inInventory);
  for (const r of meta.values()) {
    if (HIDDEN_REPOS.includes(r.name) || (opts.repo && r.name !== opts.repo)) continue;
    if (r.archived && !inInventory.has(r.name)) continue;
    names.add(r.name);
  }
  const out: CompareRepo[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const m = meta.get(name);
    const mine = rows.filter((r) => r.repo === name);
    const present = (kind: CompareKind): number => mine.filter((r) => r.kind === kind && (Object.values(r.cells).some((c) => c.present === true) || (r.other?.present.length ?? 0) > 0)).length;
    const renamedTo = extras?.renames?.[name];
    out.push({
      name,
      inInventory: inInventory.has(name),
      private: m ? m.private : null,
      archived: m ? m.archived : null,
      pushedAt: m ? m.pushedAt : null,
      onGitHub: extras?.repos ? Boolean(m) : null,
      ...(renamedTo ? { renamedTo } : {}),
      found: { secrets: present("secret"), variables: present("variable") },
      needed: mine.filter((r) => r.neededMissing).length,
      notes: notesOf.get(name) ?? [],
    });
  }
  return out;
}

function computeCell(
  acc: Acc,
  def: StageDef,
  stages: readonly StageDef[],
  read: ((loc: CompareLocation) => LocationRead | undefined) | undefined,
  normalize: (name: string) => string,
  need?: { files: string[]; names: string[]; covered: boolean },
): CompareCell {
  const exps = acc.exps.filter((x) => x.stage === def.id);
  const ids = uniq(exps.map((x) => x.id));

  if (exps.length === 0) {
    const loc = stageLocation(stages, def.id, acc.repo);
    if (!loc) return { state: "not-applicable", expected: false };
    const r = read?.(loc);
    const neededCell = (): CompareCell => ({ state: "needed", expected: false, detail: { ids, targets: [locationLabel(loc)], neededBy: need!.files, actualNames: need!.names.sort() } });
    if (!r) return need && !need.covered ? neededCell() : { state: "not-expected", expected: false };
    if ("error" in r) return { state: "error", expected: false, detail: { ids, targets: [locationLabel(loc)], error: { target: locationLabel(loc), message: r.error, ...(r.status !== undefined ? { status: r.status } : {}) } } };
    // Namen, die ein Eintrag einer anderen Stage genau an dieses Ziel legt, sind hier nicht "unerwartet".
    const claimed = (n: string): boolean => acc.exps.some((x) => x.actualName === n && locationKey(placeLocation(x.place)) === locationKey(loc));
    const found = [...r.names.keys()].filter((n) => normalize(n) === acc.name && !claimed(n));
    if (found.length === 0) return need && !need.covered ? neededCell() : { state: "not-expected", expected: false };
    return { state: "unexpected", expected: false, present: true, detail: { ids, targets: [locationLabel(loc)], actualNames: found.sort() } };
  }

  const targets = uniq(exps.map((x) => locationLabel(placeLocation(x.place))));
  if (!read) return { state: "unknown", expected: true, detail: { ids, targets } };

  const missingAt: string[] = [];
  const notFound: string[] = [];
  const actualValues: string[] = [];
  const expectedValues: string[] = [];
  let different = false;
  let unreadable: { target: string; message: string; status?: number } | undefined;
  let unread = false;
  for (const x of exps) {
    const loc = placeLocation(x.place);
    const r = read(loc);
    if (!r) {
      unread = true;
      continue;
    }
    if ("error" in r) {
      unreadable ??= { target: locationLabel(loc), message: r.error, ...(r.status !== undefined ? { status: r.status } : {}) };
      continue;
    }
    if (!r.names.has(x.actualName)) {
      missingAt.push(locationLabel(loc));
      if (r.notFound) notFound.push(locationLabel(loc));
      continue;
    }
    const actual = r.names.get(x.actualName);
    if (acc.kind === "variable" && x.value !== null && typeof actual === "string") {
      if (!expectedValues.includes(x.value)) expectedValues.push(x.value);
      if (actual !== x.value) {
        different = true;
        if (!actualValues.includes(actual)) actualValues.push(actual);
      }
    }
  }
  const detail: CellDetail = { ids, targets };
  if (unreadable) return { state: "error", expected: true, detail: { ...detail, error: unreadable } };
  if (unread) return { state: "unknown", expected: true, detail };
  if (missingAt.length > 0) return { state: "missing", expected: true, present: false, detail: { ...detail, missingAt: uniq(missingAt), ...(notFound.length > 0 ? { notFound: uniq(notFound) } : {}) } };
  if (different) return { state: "different", expected: true, present: true, detail: { ...detail, expectedValues, actualValues } };
  return { state: "ok", expected: true, present: true, detail };
}
