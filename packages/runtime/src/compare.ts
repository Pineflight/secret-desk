import {
  GitHubError,
  NotConnectedError,
  compareMatrix,
  locationKey,
  requiredLocations,
  type CompareKind,
  type CompareLocation,
  type CompareOptions,
  type CompareResult,
  type GitHubTarget,
  type LiveReads,
  type LocationRead,
} from "@secret-desk/core";
import type { Runtime } from "./runtime.js";

export interface CompareStagesOptions extends CompareOptions {
  /** Ist-Zustand aus GitHub lesen (nur lesend). Ohne: nur die Erwartung aus dem Inventar. */
  live?: boolean;
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

/**
 * Stage-Vergleich: welche Secrets und Variablen liegen auf welcher Stage, und was fehlt. Rein lesend, nie ein Wert
 * (Variablen nur zum Vergleich mit dem Sollwert). Mit `live` wird jedes Ziel (Repo-Ebene, Environment je Stage,
 * Organisation) und jede Art genau einmal gelesen; ein Ziel mit 403/429/5xx wird zur error-Zelle, nicht zum Gesamtfehler.
 */
export async function compareStages(rt: Runtime, opts: CompareStagesOptions = {}): Promise<CompareResult> {
  const { live, ...options } = opts;
  const inv = rt.inventory.data;
  if (!live) return compareMatrix(inv, options);

  const need = requiredLocations(inv, options);
  const reads: LiveReads = { secret: new Map(), variable: new Map() };
  const jobs: { kind: CompareKind; loc: CompareLocation }[] = [];
  for (const kind of ["secret", "variable"] as const) for (const loc of need[kind]) jobs.push({ kind, loc });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      reads[job.kind].set(locationKey(job.loc), await readLocation(rt, job.kind, job.loc));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return compareMatrix(inv, options, reads);
}
