/** Pure view helpers for the team sync card: the one-line token status and whether the token details start open. */
import type { PushStrategy, TeamMode } from "./team-picker";
import { teamTokenView, tokenCovers, type TeamTokenInfo } from "./team-token";

export type TokenLine = "valid" | "expired" | "missing" | "not-covered" | "integration";

/** How the panel is connected: `connected` and the source reported by the server status. */
export interface TokenConnection {
  connected: boolean;
  tokenSource: "own" | "github-pat" | "github-app" | "none";
}

/**
 * The status of the team token for the configured repository and mode; `null` while the token info is not loaded.
 * Without a team token, a panel that is connected through the GitHub integration is fine ("integration"), not a warning.
 */
export function tokenLine(info: TeamTokenInfo | undefined, repo: string, mode: TeamMode, strategy: PushStrategy, connection?: TokenConnection): TokenLine | null {
  if (!info) return null;
  if (!info.active) return connection?.connected && (connection.tokenSource === "github-pat" || connection.tokenSource === "github-app") ? "integration" : "missing";
  if (!info.active.valid) return "expired";
  return tokenCovers(info.active, repo, mode, strategy) ? "valid" : "not-covered";
}

/**
 * The token details start open when the person has something to do there: no usable token, a run that is going or has
 * failed, or a revocation that is waiting for them. A valid covering token, or the GitHub integration, keeps them closed.
 */
export function tokenDetailsOpen(info: TeamTokenInfo | undefined, line: TokenLine | null): boolean {
  if (!info || line === null) return false;
  const view = teamTokenView(info);
  return (line !== "valid" && line !== "integration") || view === "running" || view === "waiting" || view === "failed" || info.pendingRevocation !== null;
}
