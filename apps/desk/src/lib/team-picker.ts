/** Types and small helpers for the team sync pickers (answers of /api/ui/team-sync/discovery/*). No values, no tokens. */
export type TokenSource = "own" | "github-pat" | "github-app" | "none";
export type DiscoveryProblemCode = "no-integration" | "token-rejected" | "missing-permission" | "app-not-installed" | "rate-limit";

export interface DiscoveryProblem {
  code: DiscoveryProblemCode;
  neededRights: string[];
}
export interface RepoChoice {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  selectable: boolean;
  reason: "public" | null;
}
export interface RepoDiscovery {
  source: TokenSource;
  problem: DiscoveryProblem | null;
  repos: RepoChoice[];
  preselected: string | null;
  truncated: boolean;
}
export interface BranchDiscovery {
  source: TokenSource;
  problem: DiscoveryProblem | null;
  branches: string[];
  defaultBranch: string | null;
  truncated: boolean;
}
export interface FileDiscovery {
  source: TokenSource;
  problem: DiscoveryProblem | null;
  files: string[];
  preselected: string | null;
  canCreate: boolean;
  createPath: string;
  truncated: boolean;
}
export interface AccessCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail?: string;
}
export type TeamMode = "pull" | "pull-push";
export type PushStrategy = "pull-request" | "direct";
export interface ModeAccess {
  source: TokenSource;
  problem: DiscoveryProblem | null;
  mode: TeamMode;
  strategy: PushStrategy;
  neededRights: string[];
  checks: AccessCheck[];
  ok: boolean;
}

/** The value for the file select that stands for "create the conventional file". */
export const CREATE_FILE = "__create__";

/** The user's selection in the pickers. */
export interface TeamSelection {
  repo: string;
  branch: string;
  /** Path of an existing file, or the path to create when `createFile` is set. */
  path: string;
  createFile: boolean;
  mode: TeamMode;
  strategy: PushStrategy;
}

/** Search over owner/name; case-insensitive, every word must match. The order is kept (the server sorted by push). */
export function filterRepos(repos: readonly RepoChoice[], query: string): RepoChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...repos];
  return repos.filter((r) => words.every((w) => r.fullName.toLowerCase().includes(w)));
}

/** A repository the integration can use for team sync: private, selectable, not archived. */
export const isUsableRepo = (r: RepoChoice): boolean => r.selectable && !r.archived;

/** Rows shown at first; the rest sits behind "show more". */
export const REPO_ROWS = 8;

/** The matching repositories split into usable ones (order kept) and the ones that cannot be chosen (public, archived). */
export function groupRepos(repos: readonly RepoChoice[], query: string): { usable: RepoChoice[]; unusable: RepoChoice[] } {
  const matching = filterRepos(repos, query);
  return { usable: matching.filter(isUsableRepo), unusable: matching.filter((r) => !isUsableRepo(r)) };
}

/** The rows to show: the first `limit`, plus the chosen repository when it lies further down, so the choice never disappears. */
export function limitRepos(usable: readonly RepoChoice[], limit: number, selected: string, showAll: boolean): RepoChoice[] {
  if (showAll || usable.length <= limit) return [...usable];
  const head = usable.slice(0, limit);
  const chosen = usable.find((r) => r.fullName === selected);
  return chosen && !head.includes(chosen) ? [...head, chosen] : head;
}

/** Short reason code for a repository that cannot be chosen (the portal translates it). */
export const unusableReason = (r: RepoChoice): "public" | "archived" => (r.selectable ? "archived" : "public");

/** The repository to preselect: the server's pick, but only when it is an accessible private repository in the list. Else nothing. */
export function initialRepo(data: Pick<RepoDiscovery, "repos" | "preselected"> | undefined): string {
  const pick = data?.preselected;
  if (!data || !pick) return "";
  const found = data.repos.find((r) => r.fullName === pick);
  return found && isUsableRepo(found) ? found.fullName : "";
}

/** The single status of a mode, shown as one compact line. */
export type ModeStatus = "checking" | "ready" | "needs" | "create-needs-write";
export function modeStatus(access: ModeAccess | undefined, loading: boolean, disabledByFile: boolean): ModeStatus {
  if (disabledByFile) return "create-needs-write";
  if (loading || !access) return "checking";
  return modeAllowed(access) ? "ready" : "needs";
}

/** The rights to name in a "needs" line, short: what the mode needs from the integration. */
export const neededRightsLine = (access: ModeAccess | undefined): string => (access?.neededRights ?? []).join(", ");

/** A mode can be chosen when its check found no failure. Without a check result yet it cannot. */
export const modeAllowed = (access: ModeAccess | undefined): boolean => Boolean(access && !access.problem && access.ok);

/** Failed checks, for showing what is missing next to a mode. */
export const failedChecks = (access: ModeAccess | undefined): AccessCheck[] => (access?.checks ?? []).filter((c) => c.status === "fail");

/** A new file can only be created by a push, so it needs the write mode. */
export function effectiveMode(mode: TeamMode, createFile: boolean): TeamMode {
  return createFile ? "pull-push" : mode;
}

/** The selection is complete and the integration allows its mode. */
export function selectionReady(sel: TeamSelection | null, access: ModeAccess | undefined): boolean {
  return Boolean(sel && sel.repo && sel.branch && sel.path && modeAllowed(access));
}

/** The `teamSync` object for PUT team-sync/config. */
export function toTeamSyncConfig(sel: TeamSelection): { repo: string; path: string; branch: string; mode: TeamMode; push: { strategy: PushStrategy } } {
  return { repo: sel.repo, path: sel.path, branch: sel.branch, mode: effectiveMode(sel.mode, sel.createFile), push: { strategy: sel.strategy } };
}
