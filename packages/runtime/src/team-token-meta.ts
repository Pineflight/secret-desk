import { TEAM_SYNC_CONNECTION } from "@secret-desk/core";
import type { Runtime } from "./runtime.js";
import { rightsCover, teamRights, type TeamMode, type TeamPushStrategy } from "./team-token-rights.js";

/**
 * What the portal knows about a team token it created itself: where it is valid and under which name it lives at GitHub.
 * Kept next to the token under the connection `team-sync` (entry `team-sync#meta`). Never the value.
 */
export interface TeamTokenMeta {
  repo: string;
  mode: TeamMode;
  strategy: TeamPushStrategy;
  /** Name of the token at GitHub (the human finds it under Settings, Developer settings, Fine-grained tokens). */
  tokenName: string;
  createdAt: string;
  /** YYYY-MM-DD */
  expires: string | null;
}

/** An earlier team token that is replaced but not yet deleted at GitHub (secret-desk cannot do that itself). */
export interface PendingRevocation {
  tokenName: string;
  repo: string;
  since: string;
}

export interface TeamTokenRecord {
  active: TeamTokenMeta | null;
  pendingRevocation: PendingRevocation | null;
}

const ENTRY = `${TEAM_SYNC_CONNECTION}#meta`;
const EMPTY: TeamTokenRecord = { active: null, pendingRevocation: null };

const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isMode = (v: unknown): v is TeamMode => v === "pull" || v === "pull-push";
const isStrategy = (v: unknown): v is TeamPushStrategy => v === "pull-request" || v === "direct";
const text = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function parse(raw: string): TeamTokenRecord {
  try {
    const j = JSON.parse(raw) as { active?: Record<string, unknown> | null; pendingRevocation?: Record<string, unknown> | null };
    const a = j.active;
    const p = j.pendingRevocation;
    const active: TeamTokenMeta | null =
      a && typeof a["repo"] === "string" && REPO.test(a["repo"]) && isMode(a["mode"]) && isStrategy(a["strategy"]) && text(a["tokenName"]) && text(a["createdAt"], 40)
        ? { repo: a["repo"], mode: a["mode"], strategy: a["strategy"], tokenName: a["tokenName"], createdAt: a["createdAt"], expires: typeof a["expires"] === "string" && DAY.test(a["expires"]) ? a["expires"] : null }
        : null;
    const pendingRevocation: PendingRevocation | null =
      p && text(p["tokenName"]) && typeof p["repo"] === "string" && REPO.test(p["repo"]) && text(p["since"], 40) ? { tokenName: p["tokenName"], repo: p["repo"], since: p["since"] } : null;
    return { active, pendingRevocation };
  } catch {
    return EMPTY;
  }
}

export async function readTeamTokenRecord(rt: Pick<Runtime, "connections">): Promise<TeamTokenRecord> {
  try {
    const v = rt.connections.session.get(ENTRY) ?? (await rt.connections.vault?.get(ENTRY)) ?? undefined;
    return v ? parse(v.reveal()) : EMPTY;
  } catch {
    return EMPTY;
  }
}

export async function writeTeamTokenRecord(rt: Pick<Runtime, "connections">, record: TeamTokenRecord): Promise<void> {
  const json = JSON.stringify(record);
  if (rt.connections.vault) await rt.connections.vault.set(ENTRY, json, null);
  else rt.connections.session.set(ENTRY, json, null);
}

/** The team token this portal created (null for a typed-in token, one from the environment or none). */
export async function readTeamTokenMeta(rt: Pick<Runtime, "connections">): Promise<TeamTokenMeta | null> {
  return (await readTeamTokenRecord(rt)).active;
}

/** What a request for the team token needs. All fields optional: nothing known means "no restriction". */
export interface TeamTokenScope {
  repo?: string;
  mode?: TeamMode;
  strategy?: TeamPushStrategy;
}

/** A token created by the portal is valid for one repository and one set of rights. A manual token has no meta and is not restricted here. */
export function metaFits(meta: TeamTokenMeta | null, scope: TeamTokenScope): boolean {
  if (!meta) return true;
  if (!scope.repo || scope.repo !== meta.repo) return false;
  if (scope.mode) return rightsCover(teamRights(meta.mode, meta.strategy), teamRights(scope.mode, scope.strategy ?? "pull-request"));
  return true;
}

/**
 * The connection `team-sync` now holds a value the portal did not create (typed in, or removed): forget the meta and note the
 * earlier portal-made token as one to delete at GitHub. Nothing happens when the portal never made one.
 */
export async function retireTeamToken(rt: Pick<Runtime, "connections">, now: Date = new Date()): Promise<void> {
  const rec = await readTeamTokenRecord(rt);
  if (!rec.active) return;
  await writeTeamTokenRecord(rt, { active: null, pendingRevocation: { tokenName: rec.active.tokenName, repo: rec.active.repo, since: now.toISOString() } });
}
