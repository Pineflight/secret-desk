/**
 * Pure logic of the combined entries list (secrets and variables in one table): the kind filter, which filters apply to
 * which kind, and the status filter that spans the expiry states of secrets and the comparison states of variables.
 * A filter that only exists for one kind is never applied silently to the other one: `narrowedBy` names every filter that
 * hides a kind, and the page shows it.
 */
import type { SecretView, VariableView } from "@secret-desk/runtime";
import { DRIFT_FILTERS, summarizeDrift } from "./variable-list";
import { needsParams } from "./params-list";

export type EntryKind = "secret" | "variable";
export type KindFilter = "" | EntryKind;
export const KINDS: readonly EntryKind[] = ["secret", "variable"];

export type SecretRow = SecretView & { entryKind: "secret" };
export type VariableRow = VariableView & { entryKind: "variable" };
export type EntryRow = SecretRow | VariableRow;

/** Value of ?kind=: unknown values mean "all". */
export function parseKind(value: string | null | undefined): KindFilter {
  return value === "secret" || value === "variable" ? value : "";
}

/** Expiry states of secrets, in display order. */
export const SECRET_STATUSES = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;
/** Comparison states of variables, in display order ("ok" is the shared word for "in-sync"). */
export const VARIABLE_STATUSES = DRIFT_FILTERS;

/** The one combination the overview links to; the status select offers it only while the URL carries it. */
export const SOON_OR_DUE = "soon,due";

/** Statuses of one kind: secret expiry states, or variable comparison states ("ok" counts for both). */
function kindsOfStatus(status: string): EntryKind[] {
  const out: EntryKind[] = [];
  if ((SECRET_STATUSES as readonly string[]).includes(status)) out.push("secret");
  if (status === "ok" || (VARIABLE_STATUSES as readonly string[]).includes(status)) out.push("variable");
  return out;
}

/** Parsed ?status=: no filter, a list of statuses, or an input from which no valid status remains (matches nothing). */
export type StatusFilter = { mode: "none" } | { mode: "list"; statuses: string[] } | { mode: "invalid" };

/**
 * Value of ?status=: one status or a comma separated list ("soon,due"). A single value is taken as it is (an unknown one
 * matches nothing); in a list unknown tokens and duplicates are dropped, and a list without any valid token is "invalid",
 * which matches nothing as well. Empty means no filter.
 */
export function parseStatusList(value: string | null | undefined): StatusFilter {
  if (!value) return { mode: "none" };
  if (!value.includes(",")) return { mode: "list", statuses: [value] };
  const tokens = value.split(",").map((t) => t.trim());
  const statuses = tokens.filter((t, i) => kindsOfStatus(t).length > 0 && tokens.indexOf(t) === i);
  return statuses.length ? { mode: "list", statuses } : { mode: "invalid" };
}

/** Does the value carry exactly the given combination (any order)? */
export function isStatusCombination(value: string, combination: string): boolean {
  const have = parseStatusList(value);
  const want = parseStatusList(combination);
  if (have.mode !== "list" || want.mode !== "list") return false;
  return have.statuses.length === want.statuses.length && want.statuses.every((w) => have.statuses.includes(w));
}

/** Kinds a status filter value is meaningful for. "ok" and "missing" exist for both; "ok" means "in-sync" for a variable. */
export function statusKinds(status: string): EntryKind[] {
  const f = parseStatusList(status);
  if (f.mode === "none") return [...KINDS];
  if (f.mode === "invalid") return [];
  return KINDS.filter((k) => f.statuses.some((s) => kindsOfStatus(s).includes(k)));
}

export interface EntryFilters {
  kind: KindFilter;
  status: string;
  /** "auto" | "manual" | "" (secrets only). */
  provider: string;
  /** "missing" | "" (secrets only). */
  params: string;
}

export type FilterName = "status" | "provider" | "params";

/** Kinds that can still show rows under the filters. */
export function activeKinds(f: EntryFilters): EntryKind[] {
  return KINDS.filter((k) => {
    if (f.kind && f.kind !== k) return false;
    return !narrowingFilters(f, k).length;
  });
}

/** Filters that rule a kind out completely (they do not exist for it). Secret-only filters are ignored when the kind filter picks variables. */
export function narrowingFilters(f: EntryFilters, kind: EntryKind): FilterName[] {
  const out: FilterName[] = [];
  if (f.status && !statusKinds(f.status).includes(kind)) out.push("status");
  if (kind === "variable" && f.kind !== "variable") {
    if (f.provider) out.push("provider");
    if (f.params) out.push("params");
  }
  return out;
}

/** Variables never show a secret-only filter, so with kind=variable those are dropped instead of hiding everything. */
export function effectiveFilters(f: EntryFilters): EntryFilters {
  return f.kind === "variable" ? { ...f, provider: "", params: "" } : f;
}

export function secretMatches(s: SecretView, f: EntryFilters): boolean {
  const list = parseStatusList(f.status);
  if (list.mode === "invalid" || (list.mode === "list" && !list.statuses.includes(s.status))) return false;
  if (f.provider && (f.provider === "auto" ? !s.automatic : s.automatic)) return false;
  if (f.params === "missing" && !needsParams(s)) return false;
  return true;
}

type Drifts = Readonly<Record<string, readonly { state: string }[] | undefined>>;

/** Comparison state of a variable for the status filter ("ok" = "in-sync"). */
export function variableMatches(v: VariableView, f: EntryFilters, drifts: Drifts): boolean {
  const list = parseStatusList(f.status);
  if (list.mode === "none") return true;
  if (list.mode === "invalid") return false;
  const sum = summarizeDrift(drifts[v.id]);
  return list.statuses.some((s) => (s === "ok" ? sum === "in-sync" : sum === s));
}

/** Does the status filter depend on comparison results that are still missing for some variables? Only these states need a comparison. */
export function needsComparison(status: string): boolean {
  const list = parseStatusList(status);
  return list.mode === "list" && list.statuses.some((s) => s !== "not-compared" && kindsOfStatus(s).includes("variable"));
}

export function counts(rows: readonly { entryKind: EntryKind }[]): Record<EntryKind, number> {
  return { secret: rows.filter((r) => r.entryKind === "secret").length, variable: rows.filter((r) => r.entryKind === "variable").length };
}

/** Which kind the new-entry dialog starts with: ?new=secret|variable wins, then the kind filter, otherwise secret. */
export function initialNewKind(param: string | null | undefined, kind: KindFilter): EntryKind {
  return parseKind(param) || kind || "secret";
}

/** URL for the list with filters set, for links from other pages (compare, overview, repositories). */
export function entriesHref(f: { kind?: KindFilter; stage?: string; status?: string; repo?: string; q?: string; tag?: string } = {}): string {
  const p = new URLSearchParams();
  for (const k of ["kind", "stage", "status", "repo", "q", "tag"] as const) if (f[k]) p.set(k, f[k]!);
  const s = p.toString();
  return s ? `/entries?${s}` : "/entries";
}
