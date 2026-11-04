import type { SyncLine, SyncOutcome, SyncPlan } from "@secret-desk/core";

/** Lines per request: the page sends the plan in batches so it can show a counter and survives a long run. */
export const SYNC_BATCH = 20;

/** Lines that the server would write (not skipped), in plan order. */
export const writable = (plan: SyncPlan): SyncLine[] => plan.lines.filter((l) => l.action !== "skip");

/** Selected by default: everything the plan marks `defaultOn` (overwrites of secrets that GitHub changed more recently are off). */
export const defaultSelection = (plan: SyncPlan): Set<string> => new Set(writable(plan).filter((l) => l.defaultOn).map((l) => l.key));

export interface SyncGroup {
  repo: string;
  lines: SyncLine[];
}

/** Repository groups sorted by name; inside a group writable lines first, then skipped ones. */
export function groupByRepository(lines: readonly SyncLine[]): SyncGroup[] {
  const by = new Map<string, SyncLine[]>();
  for (const l of lines) by.set(l.repo, [...(by.get(l.repo) ?? []), l]);
  const rank = (l: SyncLine): number => (l.action === "skip" ? 1 : 0);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, ls]) => ({ repo, lines: [...ls].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.placeLabel.localeCompare(b.placeLabel)) }));
}

/** The production confirmation is needed as soon as one selected line is in a live stage. */
export const needsProduction = (plan: SyncPlan, selected: ReadonlySet<string>): boolean => writable(plan).some((l) => selected.has(l.key) && l.production);

/** Splits the keys into batches in plan order. */
export function batches(plan: SyncPlan, selected: ReadonlySet<string>, size = SYNC_BATCH): string[][] {
  const keys = writable(plan).filter((l) => selected.has(l.key)).map((l) => l.key);
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

export interface SyncSummary {
  ok: number;
  failed: SyncOutcome[];
  skipped: number;
}

export function summarize(outcomes: readonly SyncOutcome[]): SyncSummary {
  return { ok: outcomes.filter((o) => o.outcome === "created" || o.outcome === "updated").length, failed: outcomes.filter((o) => o.outcome === "failed"), skipped: outcomes.filter((o) => o.outcome === "skipped").length };
}
