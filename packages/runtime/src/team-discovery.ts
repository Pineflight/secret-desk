import { GitHubError, GitHubInputError, InventoryError, TeamSyncSchema, isSafeRepoSlug, isValidBranchName, type TeamSyncConfig, type VisibleRepo } from "@secret-desk/core";
import { checkTeamSyncAccessFor, neededRights, openScopedSession, split, teamTokenSource, type TeamAccessCheck, type TeamTokenSource } from "./team-sync.js";
import type { Runtime } from "./runtime.js";

/**
 * Read-only discovery for the team sync pickers (setup page): which repositories the GitHub integration can see, their branches and
 * the team files on a branch. Nothing here writes, and nothing returns a token. Messages are codes; the portal shows localized text.
 */

/** The conventional file name; preselected when it exists, and the name of a new file. */
export const CONVENTIONAL_TEAM_FILE = "secret-desk.team.yaml";
/** Repository names that hint at the team repository. */
const NAME_HINTS = ["team-config", "secret-desk"] as const;
/** At most this many repositories are probed for the conventional file when no name matches (one request each). */
export const MAX_FILE_PROBES = 5;

/** Why a repository cannot be chosen. Team sync needs a private repository. */
export type RepoReason = "public";

export interface RepoChoice {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  selectable: boolean;
  reason: RepoReason | null;
}

/** Why discovery could not run. `no-integration`: no GitHub connection. `missing-permission`: the connection lacks a right. */
export type DiscoveryProblemCode = "no-integration" | "token-rejected" | "missing-permission" | "app-not-installed" | "rate-limit";

export interface DiscoveryProblem {
  code: DiscoveryProblemCode;
  /** The rights discovery needs, as readable lines. */
  neededRights: string[];
}

interface DiscoveryBase {
  source: TeamTokenSource;
  problem: DiscoveryProblem | null;
}

export interface RepoDiscovery extends DiscoveryBase {
  repos: RepoChoice[];
  /** Full name of the repository to preselect, or null. */
  preselected: string | null;
  /** GitHub has more repositories than were read. */
  truncated: boolean;
}

export interface BranchDiscovery extends DiscoveryBase {
  branches: string[];
  defaultBranch: string | null;
  truncated: boolean;
}

export interface FileDiscovery extends DiscoveryBase {
  files: string[];
  /** Path to preselect: the conventional file when it exists, else the first match, else null. */
  preselected: string | null;
  /** Nothing matches: the conventional name can be created (by the first push). */
  canCreate: boolean;
  createPath: string;
  truncated: boolean;
}

export interface ModeAccess extends DiscoveryBase {
  mode: TeamSyncConfig["mode"];
  strategy: TeamSyncConfig["push"]["strategy"];
  /** Rights this mode needs (the same lines the team page shows). */
  neededRights: string[];
  checks: TeamAccessCheck[];
  /** No check failed. */
  ok: boolean;
}

// ------------------------------------------------------------------------------------------------ pure rules

export const DISCOVERY_RIGHTS = ["Metadata: Read", "Contents: Read"] as const;

/** A repository name that hints at the team repository (contains `team-config` or `secret-desk`). */
export const nameHintsTeamRepo = (name: string): boolean => NAME_HINTS.some((h) => name.toLowerCase().includes(h));

/** Team sync needs a private repository: public ones stay visible but cannot be chosen. */
export function toRepoChoice(r: VisibleRepo): RepoChoice {
  return { owner: r.owner, name: r.name, fullName: r.fullName, private: r.private, archived: r.archived, defaultBranch: r.defaultBranch, pushedAt: r.pushedAt, selectable: r.private, reason: r.private ? null : "public" };
}

/**
 * The repository to preselect: a selectable repository whose name hints at the team repository (the most recently pushed first),
 * else the first selectable one that `holdsFile` says holds the conventional file. Never a public repository.
 */
export function choosePreselectedRepo(repos: readonly RepoChoice[], holdsFile: ReadonlySet<string> = new Set()): string | null {
  const selectable = repos.filter((r) => r.selectable && !r.archived);
  const byPush = (a: RepoChoice, b: RepoChoice) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
  const named = selectable.filter((r) => nameHintsTeamRepo(r.name)).sort(byPush);
  // A name hint that also holds the file is the strongest signal.
  const both = named.find((r) => holdsFile.has(r.fullName));
  if (both) return both.fullName;
  if (named[0]) return named[0].fullName;
  const holder = selectable.filter((r) => holdsFile.has(r.fullName)).sort(byPush)[0];
  return holder?.fullName ?? null;
}

/** The default branch when it exists in the list; else `main`, `master`, the first branch. */
export function chooseBranch(branches: readonly string[], defaultBranch: string | null): string | null {
  if (defaultBranch && branches.includes(defaultBranch)) return defaultBranch;
  for (const c of ["main", "master"]) if (branches.includes(c)) return c;
  return branches[0] ?? null;
}

/** A team file by the conventions: `secret-desk.team.yaml`, `*.team.yaml` (also `.yml`), `secret-desk/*.yaml`. */
export function isTeamFilePath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (/\.team\.ya?ml$/.test(base)) return true;
  return /^secret-desk\/[^/]+\.ya?ml$/.test(path);
}

/** Matching files, the conventional name first, then files at the root, then by path. */
export function selectTeamFiles(paths: readonly string[]): string[] {
  const rank = (p: string) => (p === CONVENTIONAL_TEAM_FILE ? 0 : !p.includes("/") ? 1 : 2);
  return paths.filter(isTeamFilePath).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ------------------------------------------------------------------------------------------------ requests

const DISCOVERY_PERMISSIONS = { metadata: "read", contents: "read" } as const;

/** Turns a GitHub failure into a problem the portal can explain; anything else is rethrown. */
function toProblem(e: unknown): DiscoveryProblem {
  const needed = [...DISCOVERY_RIGHTS];
  if (e instanceof GitHubError) {
    if (/nicht installiert/.test(e.message)) return { code: "app-not-installed", neededRights: needed };
    if (e.status === 429) return { code: "rate-limit", neededRights: needed };
    if (e.status === 401) return { code: "token-rejected", neededRights: needed };
    if (e.status === 403 || (e.status === 422 && /access_tokens/.test(e.message))) return { code: "missing-permission", neededRights: needed };
  }
  throw e;
}

const noIntegration = (source: TeamTokenSource): DiscoveryBase => ({ source, problem: { code: "no-integration", neededRights: [...DISCOVERY_RIGHTS] } });

function parseRepo(repo: string): [string, string] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !isSafeRepoSlug(repo)) throw new InventoryError('Feld repo: Format "owner/name".');
  return split(repo);
}

function parseBranch(branch: string): string {
  if (!isValidBranchName(branch)) throw new InventoryError("Feld branch: ungueltiger Zweigname.");
  return branch;
}

/** The repositories the integration can see. Public ones are listed but not selectable. */
export async function listTeamRepos(rt: Runtime): Promise<RepoDiscovery> {
  const source = await teamTokenSource(rt);
  const empty = { repos: [], preselected: null, truncated: false };
  if (source === "none") return { ...noIntegration(source), ...empty };
  try {
    const sess = await openScopedSession(rt, { owner: rt.config.github.owner, permissions: DISCOVERY_PERMISSIONS });
    const { repos: visible, truncated } = await sess.gh.listVisibleRepos(sess.source === "github-app" ? "installation" : "user");
    const repos = visible.map(toRepoChoice);
    let preselected = choosePreselectedRepo(repos);
    if (!preselected) {
      // No name hint: look for the conventional file in the few most recently pushed private repositories.
      const holders = new Set<string>();
      for (const r of repos.filter((x) => x.selectable && !x.archived && x.defaultBranch).slice(0, MAX_FILE_PROBES)) {
        try {
          if (await sess.gh.getContentFile(r.owner, r.name, CONVENTIONAL_TEAM_FILE, r.defaultBranch!)) holders.add(r.fullName);
        } catch (e) {
          if (e instanceof GitHubError && e.status === 429) break;
          /* not readable: not a candidate */
        }
      }
      preselected = choosePreselectedRepo(repos, holders);
    }
    return { source, problem: null, repos, preselected, truncated };
  } catch (e) {
    return { source, problem: toProblem(e), ...empty };
  }
}

/** The branches of a repository, the default branch first choice. */
export async function listTeamBranches(rt: Runtime, repo: string): Promise<BranchDiscovery> {
  const [owner, name] = parseRepo(repo);
  const source = await teamTokenSource(rt);
  const empty = { branches: [], defaultBranch: null, truncated: false };
  if (source === "none") return { ...noIntegration(source), ...empty };
  try {
    const sess = await openScopedSession(rt, { owner, repositories: [name], permissions: DISCOVERY_PERMISSIONS });
    const [{ names, truncated }, info] = await Promise.all([sess.gh.listBranches(owner, name), sess.gh.getRepo(owner, name)]);
    return { source, problem: null, branches: names, defaultBranch: chooseBranch(names, info.defaultBranch ?? null), truncated };
  } catch (e) {
    if (e instanceof GitHubInputError) throw new InventoryError("Feld repo: Format \"owner/name\".");
    return { source, problem: toProblem(e), ...empty };
  }
}

/** The team files on a branch. Without a match the conventional file can be created by the first push. */
export async function listTeamFiles(rt: Runtime, repo: string, branch: string): Promise<FileDiscovery> {
  const [owner, name] = parseRepo(repo);
  parseBranch(branch);
  const source = await teamTokenSource(rt);
  const base = { files: [], preselected: null, canCreate: false, createPath: CONVENTIONAL_TEAM_FILE, truncated: false };
  if (source === "none") return { ...noIntegration(source), ...base };
  try {
    const sess = await openScopedSession(rt, { owner, repositories: [name], permissions: DISCOVERY_PERMISSIONS });
    const tree = await sess.gh.listFilePaths(owner, name, branch);
    const files = tree ? selectTeamFiles(tree.paths) : [];
    return { source, problem: null, files, preselected: files[0] ?? null, canCreate: files.length === 0, createPath: CONVENTIONAL_TEAM_FILE, truncated: tree?.truncated === true };
  } catch (e) {
    if (e instanceof GitHubInputError) throw new InventoryError("Feld repo oder branch ist ungueltig.");
    return { source, problem: toProblem(e), ...base };
  }
}

/**
 * Checks what a mode needs against the integration, with the same checks as the saved team sync (token source, read, private,
 * team file, pull requests, rights of a GitHub App installation, push permission). Nothing is written.
 */
export async function checkTeamModeAccess(rt: Runtime, input: { repo: string; branch: string; path: string; mode: string; strategy?: string }): Promise<ModeAccess> {
  parseRepo(input.repo);
  const parsed = TeamSyncSchema.safeParse({ repo: input.repo, branch: input.branch, path: input.path, mode: input.mode, push: { strategy: input.strategy ?? "pull-request" } });
  if (!parsed.success) throw new InventoryError(`Team-Sync ungueltig: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const c = parsed.data;
  const source = await teamTokenSource(rt);
  const rights = neededRights(c);
  if (source === "none") return { ...noIntegration(source), mode: c.mode, strategy: c.push.strategy, neededRights: rights, checks: [], ok: false };
  const checks = await checkTeamSyncAccessFor(rt, c);
  return { source, problem: null, mode: c.mode, strategy: c.push.strategy, neededRights: rights, checks, ok: !checks.some((x) => x.status === "fail") };
}
