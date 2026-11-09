import { readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "@secret-desk/core";

/**
 * The reports of the live check (see live-check.ts), kept in a small file next to the sign-in memory (mode 600, written
 * atomically). A report holds ids, results, step labels, error kinds and short sanitized texts. No value, no page text, no
 * screenshot, no address.
 */

/** Connection id under which the notification address is read (a source like any connection token). Not listed in the portal. */
export const LIVE_CHECK_NOTIFY_CONNECTION = "live-check-notify";

export type LiveCheckTrigger = "schedule" | "manual";
export type LiveCheckConnectionResult = "ok" | "failed" | "not-connected";
export type LiveCheckRecipeResult = "ok" | "failed" | "needs-sign-in" | "skipped";

export interface LiveCheckConnection {
  id: string;
  result: LiveCheckConnectionResult;
  detail?: string;
}

export interface LiveCheckRecipe {
  id: string;
  result: LiveCheckRecipeResult;
  /** The step that did not work (label only, as the recipe names it). */
  step?: string;
  /** The `RecipeRunError` kind of a failed step. */
  kind?: string;
  detail?: string;
}

export interface LiveCheckSummary {
  connections: { ok: number; failed: number; notConnected: number };
  recipes: { ok: number; failed: number; needsSignIn: number; skipped: number };
}

export interface LiveCheckReport {
  startedAt: string;
  finishedAt: string;
  /** false only when something failed. Not connected, skipped and needs-sign-in do not count. */
  ok: boolean;
  trigger: LiveCheckTrigger;
  connections: LiveCheckConnection[];
  recipes: LiveCheckRecipe[];
  summary: LiveCheckSummary;
}

/** How many reports are kept. */
export const LIVE_CHECK_KEEP = 12;
const FILE_VERSION = 1;
const MAX_ITEMS = 200;
const MAX_TEXT = 300;
const CONNECTION_RESULTS: readonly LiveCheckConnectionResult[] = ["ok", "failed", "not-connected"];
const RECIPE_RESULTS: readonly LiveCheckRecipeResult[] = ["ok", "failed", "needs-sign-in", "skipped"];

const validTime = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v.slice(0, MAX_TEXT) : undefined);
const idOf = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$/.test(v) ? v : undefined);
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);

/** Counts for the summary, from the lists. */
export function summarize(connections: readonly LiveCheckConnection[], recipes: readonly LiveCheckRecipe[]): LiveCheckSummary {
  const c = (r: LiveCheckConnectionResult): number => connections.filter((x) => x.result === r).length;
  const n = (r: LiveCheckRecipeResult): number => recipes.filter((x) => x.result === r).length;
  return { connections: { ok: c("ok"), failed: c("failed"), notConnected: c("not-connected") }, recipes: { ok: n("ok"), failed: n("failed"), needsSignIn: n("needs-sign-in"), skipped: n("skipped") } };
}

/** Rebuilds a report from stored JSON, field by field (an unknown field is dropped, a damaged entry gives null). */
export function parseLiveCheckReport(raw: unknown): LiveCheckReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!validTime(r["startedAt"]) || !validTime(r["finishedAt"]) || (r["trigger"] !== "schedule" && r["trigger"] !== "manual")) return null;
  const connections: LiveCheckConnection[] = [];
  for (const c of records(r["connections"])) {
    const id = idOf(c["id"]);
    const result = CONNECTION_RESULTS.find((x) => x === c["result"]);
    if (id === undefined || result === undefined) continue;
    const detail = text(c["detail"]);
    connections.push({ id, result, ...(detail !== undefined ? { detail } : {}) });
  }
  const recipes: LiveCheckRecipe[] = [];
  for (const c of records(r["recipes"])) {
    const id = idOf(c["id"]);
    const result = RECIPE_RESULTS.find((x) => x === c["result"]);
    if (id === undefined || result === undefined) continue;
    const step = text(c["step"]);
    const kind = text(c["kind"]);
    const detail = text(c["detail"]);
    recipes.push({ id, result, ...(step !== undefined ? { step } : {}), ...(kind !== undefined ? { kind } : {}), ...(detail !== undefined ? { detail } : {}) });
  }
  const ok = !connections.some((c) => c.result === "failed") && !recipes.some((x) => x.result === "failed");
  return { startedAt: r["startedAt"], finishedAt: r["finishedAt"], ok, trigger: r["trigger"], connections, recipes, summary: summarize(connections, recipes) };
}

/**
 * Remembers the last reports. Without a file it stays in memory. A missing or damaged file is ignored (the next write replaces
 * it): the reports are a convenience, nothing depends on them.
 */
export class LiveCheckStore {
  readonly #file: string | null;
  #reports: LiveCheckReport[] = [];
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string | null = null) {
    this.#file = file;
  }

  /** Reads the file. Never throws. */
  async load(): Promise<void> {
    if (!this.#file) return;
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(this.#file, "utf8"));
    } catch {
      return;
    }
    const d = doc as { version?: unknown; reports?: unknown } | null;
    if (d?.version !== FILE_VERSION || !Array.isArray(d.reports)) return;
    const loaded = d.reports.map(parseLiveCheckReport).filter((x): x is LiveCheckReport => x !== null);
    // Reports added before the file was read stay (newest last).
    this.#reports = [...loaded, ...this.#reports].slice(-LIVE_CHECK_KEEP);
  }

  add(report: LiveCheckReport): void {
    this.#reports = [...this.#reports, report].slice(-LIVE_CHECK_KEEP);
    this.#persist();
  }

  /** Newest first. */
  reports(): LiveCheckReport[] {
    return [...this.#reports].reverse();
  }

  latest(): LiveCheckReport | undefined {
    return this.#reports[this.#reports.length - 1];
  }

  /** Waits until everything added so far is on disk. Never rejects. */
  flush(): Promise<void> {
    return this.#writing;
  }

  #persist(): void {
    const file = this.#file;
    if (!file) return;
    const body = `${JSON.stringify({ version: FILE_VERSION, reports: this.#reports }, null, 2)}\n`;
    this.#writing = this.#writing.then(async () => {
      try {
        await ensurePrivateDir(dirname(file));
        const tmp = `${file}.${process.pid}.tmp`;
        await writePrivateFile(tmp, body);
        await rename(tmp, file);
      } catch {
        // A full disk or a read-only folder must not break a check.
      }
    });
  }
}
