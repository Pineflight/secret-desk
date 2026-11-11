/** Pure view helpers for the team sync card: the one-line token status and whether the token details start open. */
import type { PushStrategy, TeamMode } from "./team-picker";
import { teamTokenView, tokenCovers, type TeamTokenInfo } from "./team-token";

export type TokenLine = "valid" | "expired" | "missing" | "not-covered";

/** The status of the team token for the configured repository and mode; `null` while the token info is not loaded. */
export function tokenLine(info: TeamTokenInfo | undefined, repo: string, mode: TeamMode, strategy: PushStrategy): TokenLine | null {
  if (!info) return null;
  if (!info.active) return "missing";
  if (!info.active.valid) return "expired";
  return tokenCovers(info.active, repo, mode, strategy) ? "valid" : "not-covered";
}

/**
 * The token details start open when the person has something to do there: no usable token, a run that is going or has
 * failed, or a revocation that is waiting for them. A valid covering token keeps them closed.
 */
export function tokenDetailsOpen(info: TeamTokenInfo | undefined, line: TokenLine | null): boolean {
  if (!info || line === null) return false;
  const view = teamTokenView(info);
  return line !== "valid" || view === "running" || view === "waiting" || view === "failed" || info.pendingRevocation !== null;
}
