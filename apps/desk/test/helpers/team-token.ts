import type { TeamTokenInfo, TeamTokenMeta } from "@/lib/team-token";
import { runState } from "./run";

/** A team token description as the server reports it: available, no token yet, idle run. */
export const tokenInfo = (over: Partial<TeamTokenInfo> = {}): TeamTokenInfo => ({
  available: true,
  reason: null,
  viewerUrl: null,
  timeoutMinutes: 10,
  active: null,
  pendingRevocation: null,
  tokensUrl: "https://github.test/settings/tokens",
  days: 30,
  rights: { pull: ["Contents: read"], "pull-push": ["Contents: read and write", "Pull requests: write"] },
  run: runState({ status: "idle" }),
  ...over,
});

export const activeToken = (over: Partial<TeamTokenMeta> = {}): TeamTokenMeta => ({
  repo: "acme/team",
  mode: "pull-push",
  strategy: "pull-request",
  tokenName: "secret-desk-team",
  createdAt: "2026-01-01T00:00:00Z",
  expires: "2030-05-06",
  valid: true,
  ...over,
});
