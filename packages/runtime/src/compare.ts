import {
  GitHubError,
  NotConnectedError,
  HIDDEN_REPOS,
  compareMatrix,
  compareRepos,
  environmentStage,
  extractWorkflowNeeds,
  locationKey,
  requiredLocations,
  stageLocation,
  type CompareExtras,
  type CompareKind,
  type CompareLocation,
  type CompareOptions,
  type CompareResult,
  type GitHubTarget,
  type LiveReads,
  type LocationRead,
  type RepoNote,
  type RepoMeta,
  type WorkflowNeeds,
} from "@secret-desk/core";
import { resolveRenames } from "./repos.js";
import type { Runtime } from "./runtime.js";
import { readWorkflowFiles } from "./workflows.js";

export interface CompareStagesOptions extends CompareOptions {
  /** Ist-Zustand aus GitHub lesen (nur lesend). Ohne: nur die Erwartung aus dem Inventar. */
  live?: boolean;
  /** Mit live: auch die Repositories der Organisation ohne Inventar-Eintrag lesen (Repo-Ebene und Environments). */
  allRepos?: boolean;
  /** Workflow-Dateien auswerten: was `secrets.*` und `vars.*` brauchen. Lokal verknuepfter Ordner, sonst (mit live) die Contents-API. */
  workflows?: boolean;
}

/** Hoechstens so viele GitHub-Anfragen gleichzeitig. */
const CONCURRENCY = 4;

const toTarget = (owner: string, l: CompareLocation): GitHubTarget => ({ owner, repo: l.repo, scope: l.scope, ...(l.environment ? { environment: l.environment } : {}) });

async function readLocation(rt: Runtime, kind: CompareKind, loc: CompareLocation): Promise<LocationRead> {
  const target = toTarget(rt.owner, loc);
  try {
    const names = new Map<string, string | null>();
    if (kind === "secret") for (const s of await rt.github.listSecrets(target)) names.set(s.name, null);
    else for (const v of await rt.github.listVariables(target)) names.set(v.name, v.value);
    return { names };
  } catch (err) {
    // Ohne Verbindung geht es nirgends: ganzer Aufruf scheitert mit der Hinweismeldung.
    if (err instanceof NotConnectedError) throw err;
    // 404: die Environment gibt es nicht. Das ist "nicht vorhanden", kein Lesefehler.
    if (err instanceof GitHubError && err.status === 404) return { names: new Map(), notFound: true };
    return { error: err instanceof Error ? err.message : String(err), ...(err instanceof GitHubError ? { status: err.status } : {}) };
  }
}

/** Fuehrt fn fuer jedes Element aus, hoechstens CONCURRENCY gleichzeitig. */
async function pool<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * Stage-Vergleich: welche Secrets und Variablen liegen auf welcher Stage, und was fehlt. Rein lesend, nie ein Wert
 * (Variablen nur zum Vergleich mit dem Sollwert). Mit `live` wird jedes Ziel (Repo-Ebene, Environment je Stage,
 * Organisation) und jede Art genau einmal gelesen; ein Ziel mit 403/429/5xx wird zur error-Zelle, nicht zum Gesamtfehler.
 *
 * Zusaetzlich (alle ausdruecklich anzufordern, alle ohne Gesamtfehler pro Repository):
 * - `allRepos` (mit live): die Repository-Liste der Organisation; Repositories ohne Inventar-Eintrag werden auf Repo-Ebene
 *   und in ihren Environments gelesen (hoechstens 1 + Arten x (1 + Environments) Anfragen je Repository).
 * - `workflows`: Workflow-Dateien auswerten (lokaler Ordner vor Contents-API; die API nur mit live).
 * - Inventar-Repositories, die GitHub unter dem Namen nicht mehr kennt, werden auf Umbenennung geprueft.
 */
export async function compareStages(rt: Runtime, opts: CompareStagesOptions = {}): Promise<CompareResult> {
  const { live, allRepos, workflows, ...options } = opts;
  const inv = rt.inventory.data;
  const extras: CompareExtras = {};
  const stages = inv.stages;
  const kinds: CompareKind[] = options.kinds && options.kinds.length > 0 ? [...new Set(options.kinds)] : ["secret", "variable"];
  const inventoryRepos = compareRepos(inv, options);
  const extraErrors: { target: string; message: string }[] = [];
  const notes = new Map<string, RepoNote[]>();
  const addNote = (repo: string, n: RepoNote): void => {
    notes.set(repo, [...(notes.get(repo) ?? []), n]);
  };

  const reads: LiveReads = { secret: new Map(), variable: new Map() };
  if (live) {
    const need = requiredLocations(inv, options);
    const jobs: { kind: CompareKind; loc: CompareLocation }[] = [];
    for (const kind of ["secret", "variable"] as const) for (const loc of need[kind]) jobs.push({ kind, loc });
    await pool(jobs, async (job) => {
      reads[job.kind].set(locationKey(job.loc), await readLocation(rt, job.kind, job.loc));
    });
  }

  // Repository-Liste der Organisation und Repositories ohne Inventar-Eintrag.
  let listed: RepoMeta[] | undefined;
  if (live && allRepos) {
    try {
      listed = (await rt.github.listRepos(rt.owner)).map((r) => ({ name: r.name, private: r.private, archived: r.archived, pushedAt: r.pushedAt }));
      extras.repos = listed;
    } catch (err) {
      if (err instanceof NotConnectedError) throw err;
      extraErrors.push({ target: "repositories", message: err instanceof Error ? err.message : String(err) });
    }
  }
  const inInventory = new Set(inventoryRepos);
  const extraRepos = (listed ?? []).filter((r) => !r.archived && !HIDDEN_REPOS.includes(r.name) && !inInventory.has(r.name) && (!options.repo || r.name === options.repo)).map((r) => r.name);
  if (extraRepos.length > 0) {
    extras.readRepos = extraRepos;
    extras.envs = new Map();
    extras.reads = { secret: new Map(), variable: new Map() };
    const exReads = extras.reads;
    await pool(extraRepos, async (repo) => {
      let envs: string[] = [];
      try {
        envs = await rt.github.listEnvironments(rt.owner, repo);
      } catch (err) {
        if (err instanceof NotConnectedError) throw err;
        addNote(repo, { code: "environments-unreadable", message: err instanceof Error ? err.message : String(err), ...(err instanceof GitHubError ? { status: err.status } : {}) });
      }
      extras.envs!.set(repo, envs);
      for (const kind of kinds) {
        const repoLoc: CompareLocation = { repo, scope: "repository" };
        const base = await readLocation(rt, kind, repoLoc);
        // Das Repository selbst nicht gefunden oder nicht freigegeben: ein Lesefehler, nicht "leer".
        exReads[kind].set(locationKey(repoLoc), "names" in base && base.notFound ? { error: "Repository nicht gefunden oder dem Token nicht freigegeben", status: 404 } : base);
        for (const env of envs) {
          const def = environmentStage(stages, env);
          const loc: CompareLocation = (def ? stageLocation(stages, def.id, repo) : undefined) ?? { repo, scope: "environment", environment: env };
          const read = await readLocation(rt, kind, { repo, scope: "environment", environment: env });
          exReads[kind].set(locationKey(loc), read);
        }
      }
    });
  }

  // Workflows: was Secrets und Variablen verlangen.
  if (workflows) {
    extras.needs = new Map<string, WorkflowNeeds>();
    const scope = [...inventoryRepos, ...extraRepos];
    await pool(scope, async (repo) => {
      const src = await readWorkflowFiles(rt, repo, { github: Boolean(live) });
      if (src.note) addNote(repo, src.note);
      if (src.files.length > 0) extras.needs!.set(repo, extractWorkflowNeeds(src.files));
    });
    if (live) {
      extras.org = {};
      for (const kind of kinds) extras.org[kind] = await readLocation(rt, kind, { repo: "", scope: "organization" });
    }
  }

  // Umbenannte Repositories: im Inventar, aber nicht (mehr) in der GitHub-Liste.
  if (listed) {
    const known = new Set(listed.map((r) => r.name));
    const gone = inventoryRepos.filter((n) => !known.has(n));
    if (gone.length > 0) extras.renames = Object.fromEntries(await resolveRenames(rt, gone));
  }
  if (notes.size > 0) extras.notes = notes;

  const result = compareMatrix(inv, options, live ? reads : undefined, extras);
  result.errors.push(...extraErrors);
  return result;
}
