import { GitHubError, placeToTarget, type GitHubClient, type GitHubTarget } from "./github.js";
import { looksSecret } from "./guards.js";
import type { SecretValue } from "./secret.js";
import { stageKind } from "./stages.js";
import { parseDay } from "./status.js";
import type { Inventory, Place } from "./types.js";
import { placeLabel } from "./variables.js";

/**
 * Inventory -> GitHub: one plan that brings GitHub in line with the inventory and the vault, and the executor for it.
 * The plan only reads (names, timestamps, variable values). The executor writes only variables and secrets that the plan
 * marks as `set` or `write`; it never deletes anything in GitHub.
 */

export type SyncAction = "set" | "write" | "skip";

/**
 * Why a line has its action.
 * - set / write: `missing` (not in GitHub), `different` (variable value differs), `overwrite` (secret exists, GitHub cannot be read back,
 *   the plan overwrites it), `github-newer` (like overwrite, but GitHub was changed after the inventory value: off by default).
 * - skip: `no-value` (nothing to write; offer renewing), `ignored-repo`, `unreadable` (GitHub target could not be read),
 *   `target-missing` (the environment does not exist), `secret-like` (the value of a variable looks like a secret),
 *   `needs-ack` (the value only looks suspicious and a human has to confirm it as public).
 */
export type SyncReason = "missing" | "different" | "overwrite" | "github-newer" | "no-value" | "ignored-repo" | "unreadable" | "target-missing" | "secret-like" | "needs-ack";

export interface SyncLine {
  /** Stable key: kind, entry id and place. The executor selects lines by this key. */
  key: string;
  kind: "variable" | "secret";
  entryId: string;
  name: string;
  repo: string;
  place: Place;
  placeLabel: string;
  stage: string;
  /** The stage is a live stage (production): needs the production confirmation to be written. */
  production: boolean;
  action: SyncAction;
  reason: SyncReason;
  /** Whether the UI and the CLI select the line by default. Always false for skipped lines. */
  defaultOn: boolean;
  /** Warning shown next to the line, for example GitHub changed the secret more recently than the inventory. */
  warning?: "github-newer";
  /** Skipped for lack of a value and the provider can issue one: the UI offers "Renew". */
  renewable?: boolean;
  /** GitHub message for `unreadable` lines. */
  detail?: string;
}

export interface SyncCounts {
  set: number;
  write: number;
  skip: number;
  /** Variables that already have the inventory value: no line, only counted. */
  unchanged: number;
}

export interface SyncPlan {
  generatedAt: string;
  lines: SyncLine[];
  counts: SyncCounts;
  /** At least one set/write line is in a live stage. */
  hasProduction: boolean;
}

/** Where stored secret values come from. The vault holds them encrypted; the plan only asks for metadata. */
export interface SecretValueSource {
  info(secretId: string): Promise<{ fingerprint: string; savedAt: string } | null>;
  get(secretId: string): Promise<SecretValue | null>;
}

export interface SyncPlanDeps {
  github: Pick<GitHubClient, "listSecrets" | "listVariables">;
  owner: string;
  inventory: Inventory;
  ignoreRepos?: readonly string[];
  /** Absent: no secret has a stored value. */
  values?: SecretValueSource;
  /** Whether a provider can issue values by itself. Default: everything except `manual`. */
  canIssue?: (providerId: string) => boolean;
  /** Restrict the plan to one repository. */
  repo?: string;
  now?: Date;
}

const targetKey = (t: GitHubTarget): string => `${t.repo}/${t.scope}/${t.environment ?? ""}`;
const dayOf = (iso: string): string => iso.slice(0, 10);

export function syncLineKey(kind: "variable" | "secret", entryId: string, place: Place): string {
  return `${kind}:${entryId}:${place.repo}:${place.scope}:${place.environment ?? ""}:${place.name ?? ""}`;
}

/** Reads GitHub once per target and kind. 404 = the target does not exist, other errors are kept with their message. */
class Listings<T> {
  readonly #cache = new Map<string, Promise<{ ok: true; items: Map<string, T> } | { ok: false; status: number; message: string }>>();
  constructor(private readonly read: (t: GitHubTarget) => Promise<[string, T][]>) {}
  get(t: GitHubTarget) {
    const k = targetKey(t);
    let hit = this.#cache.get(k);
    if (!hit) {
      hit = this.read(t).then(
        (entries) => ({ ok: true as const, items: new Map(entries) }),
        (err: unknown) => ({ ok: false as const, status: err instanceof GitHubError ? err.status : 0, message: err instanceof Error ? err.message : String(err) }),
      );
      this.#cache.set(k, hit);
    }
    return hit;
  }
}

export async function buildSyncPlan(deps: SyncPlanDeps): Promise<SyncPlan> {
  const { inventory, owner } = deps;
  const ignored = new Set(deps.ignoreRepos ?? []);
  const canIssue = deps.canIssue ?? ((id: string) => id !== "manual");
  const variables = new Listings<{ value: string }>(async (t) => (await deps.github.listVariables(t)).map((v) => [v.name, { value: v.value }]));
  const secrets = new Listings<{ updatedAt: string }>(async (t) => (await deps.github.listSecrets(t)).map((s) => [s.name, { updatedAt: s.updatedAt }]));
  const lines: SyncLine[] = [];
  let unchanged = 0;

  const base = (kind: SyncLine["kind"], entryId: string, name: string, stage: string, place: Place) => ({
    key: syncLineKey(kind, entryId, place),
    kind,
    entryId,
    name,
    repo: place.repo,
    place,
    placeLabel: placeLabel(place),
    stage,
    production: stageKind(inventory.stages, stage) === "live",
  });
  const skip = (b: ReturnType<typeof base>, reason: SyncReason, extra: Partial<SyncLine> = {}): void => {
    lines.push({ ...b, action: "skip", reason, defaultOn: false, ...extra });
  };

  for (const v of inventory.variables) {
    for (const place of v.places) {
      if (deps.repo && place.repo !== deps.repo) continue;
      const name = place.name ?? v.name;
      const b = base("variable", v.id, name, v.stage, place);
      if (ignored.has(place.repo)) {
        skip(b, "ignored-repo");
        continue;
      }
      if (v.value === null) {
        skip(b, "no-value");
        continue;
      }
      const finding = looksSecret(name, v.value);
      if (finding) {
        skip(b, finding.level === "block" ? "secret-like" : "needs-ack");
        continue;
      }
      const live = await variables.get(placeToTarget(owner, place));
      if (!live.ok) {
        skip(b, live.status === 404 ? "target-missing" : "unreadable", live.status === 404 ? {} : { detail: live.message });
        continue;
      }
      const found = live.items.get(name);
      if (found && found.value === v.value) unchanged += 1;
      else lines.push({ ...b, action: "set", reason: found ? "different" : "missing", defaultOn: true });
    }
  }

  for (const s of inventory.secrets) {
    for (const place of s.places) {
      if (deps.repo && place.repo !== deps.repo) continue;
      const name = place.name ?? s.name;
      const b = base("secret", s.id, name, s.stage, place);
      if (ignored.has(place.repo)) {
        skip(b, "ignored-repo");
        continue;
      }
      let stored: Awaited<ReturnType<SecretValueSource["info"]>> = null;
      try {
        stored = (await deps.values?.info(s.id)) ?? null;
      } catch {
        stored = null;
      }
      if (!stored) {
        skip(b, "no-value", canIssue(s.provider) ? { renewable: true } : {});
        continue;
      }
      const live = await secrets.get(placeToTarget(owner, place));
      if (!live.ok) {
        skip(b, live.status === 404 ? "target-missing" : "unreadable", live.status === 404 ? {} : { detail: live.message });
        continue;
      }
      const found = live.items.get(name);
      if (!found) {
        lines.push({ ...b, action: "write", reason: "missing", defaultOn: true });
        continue;
      }
      // GitHub cannot be read back: the line says "will overwrite". If GitHub was changed after the inventory value was
      // made (rotatedAt, else the day the value was stored), somebody else may have changed it: off by default, with a warning.
      const reference = s.rotatedAt ?? dayOf(stored.savedAt);
      const githubNewer = parseDay(dayOf(found.updatedAt)).getTime() > parseDay(reference).getTime();
      lines.push(githubNewer ? { ...b, action: "write", reason: "github-newer", defaultOn: false, warning: "github-newer" } : { ...b, action: "write", reason: "overwrite", defaultOn: true });
    }
  }

  const counts: SyncCounts = { set: 0, write: 0, skip: 0, unchanged };
  for (const l of lines) counts[l.action] += 1;
  return { generatedAt: (deps.now ?? new Date()).toISOString(), lines, counts, hasProduction: lines.some((l) => l.action !== "skip" && l.production) };
}

// ------------------------------------------------------------------------------------------------ execution

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: "production-confirmation" | "nothing-selected" | "unknown-line",
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncOutcome {
  key: string;
  kind: SyncLine["kind"];
  entryId: string;
  name: string;
  placeLabel: string;
  outcome: "created" | "updated" | "failed" | "skipped";
  /** For failed: GitHub's reason (never a value). For skipped: why. */
  error?: string;
}

export interface SyncResult {
  outcomes: SyncOutcome[];
  ok: number;
  failed: number;
}

export interface SyncRunOptions {
  /** Keys of the plan lines to execute. */
  keys: readonly string[];
  /** The human confirmed the production checklist item. Required when a selected line is in a live stage. */
  confirmProduction?: boolean;
  /** Lines per batch; a batch finishes before the next starts. */
  batchSize?: number;
  /** Retry waits (ms) after a rate-limit answer. Default: 2 s, 10 s, 30 s. */
  retryWaitsMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called after every batch: done and total, for a progress display. */
  onProgress?: (done: number, total: number) => void;
}

export interface SyncRunDeps {
  github: Pick<GitHubClient, "putVariable" | "putSecret">;
  owner: string;
  /** The plan, built right before. The executor trusts only this, never line content from a caller. */
  plan: SyncPlan;
  inventory: Inventory;
  values?: SecretValueSource;
}

const isRateLimit = (err: unknown): boolean => err instanceof GitHubError && (err.status === 429 || (err.status === 403 && /rate limit/i.test(err.message)));

/** Writes the selected plan lines. Partial failure does not stop the run; every line gets its own outcome. */
export async function runSync(deps: SyncRunDeps, options: SyncRunOptions): Promise<SyncResult> {
  const byKey = new Map(deps.plan.lines.map((l) => [l.key, l]));
  const selected: SyncLine[] = [];
  for (const key of new Set(options.keys)) {
    const line = byKey.get(key);
    if (!line) throw new SyncError("Eine gewaehlte Zeile gehoert nicht zum aktuellen Plan. Plan neu erstellen.", "unknown-line");
    if (line.action !== "skip") selected.push(line);
  }
  if (selected.length === 0) throw new SyncError("Es ist keine Aenderung gewaehlt.", "nothing-selected");
  if (selected.some((l) => l.production) && options.confirmProduction !== true) {
    throw new SyncError("Die Auswahl enthaelt Ziele der Produktion. Bestaetigen, dass dies die Produktion betrifft.", "production-confirmation");
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waits = options.retryWaitsMs ?? [2_000, 10_000, 30_000];
  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const wait = waits[attempt];
        if (!isRateLimit(err) || wait === undefined) throw err;
        await sleep(wait);
      }
    }
  };

  const variableById = new Map(deps.inventory.variables.map((v) => [v.id, v]));
  const outcomes: SyncOutcome[] = [];
  const batch = Math.max(1, options.batchSize ?? 10);
  for (let i = 0; i < selected.length; i += batch) {
    for (const line of selected.slice(i, i + batch)) {
      const meta = { key: line.key, kind: line.kind, entryId: line.entryId, name: line.name, placeLabel: line.placeLabel };
      const target = placeToTarget(deps.owner, line.place);
      try {
        if (line.kind === "variable") {
          const v = variableById.get(line.entryId);
          // The plan was built from this inventory; an entry that changed in between is skipped, never guessed.
          if (!v || v.value === null) {
            outcomes.push({ ...meta, outcome: "skipped", error: "Die Variable hat keinen Sollwert mehr. Plan neu erstellen." });
            continue;
          }
          const finding = looksSecret(line.name, v.value);
          if (finding) {
            outcomes.push({ ...meta, outcome: "skipped", error: finding.reason });
            continue;
          }
          const value = v.value;
          outcomes.push({ ...meta, outcome: await withRetry(() => deps.github.putVariable(target, line.name, value)) });
        } else {
          const value = await deps.values?.get(line.entryId);
          if (!value) {
            outcomes.push({ ...meta, outcome: "skipped", error: "Kein gespeicherter Wert mehr. Plan neu erstellen." });
            continue;
          }
          outcomes.push({ ...meta, outcome: await withRetry(() => deps.github.putSecret(target, line.name, value)) });
        }
      } catch (err) {
        outcomes.push({ ...meta, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
    options.onProgress?.(Math.min(i + batch, selected.length), selected.length);
  }
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  return { outcomes, ok: outcomes.filter((o) => o.outcome === "created" || o.outcome === "updated").length, failed };
}
