import type { TeamSyncConfig } from "@secret-desk/core";

/** The GitHub fine-grained permissions team sync needs for one mode: exactly these, not more. */
export type TeamRights = {
  contents: "read" | "write";
  pull_requests?: "write";
  metadata: "read";
};

export type TeamMode = TeamSyncConfig["mode"];
export type TeamPushStrategy = TeamSyncConfig["push"]["strategy"];

/**
 * Rights per mode (one place for the permission check, the team token and the docs).
 * `pull` reads the team file; `pull-push` also writes it, and with the pull-request strategy opens pull requests.
 */
export function teamRights(mode: TeamMode, strategy: TeamPushStrategy): TeamRights {
  if (mode === "pull") return { contents: "read", metadata: "read" };
  return strategy === "pull-request" ? { contents: "write", pull_requests: "write", metadata: "read" } : { contents: "write", metadata: "read" };
}

/** Human readable list in the wording of GitHub's token form. */
export function teamRightsLabels(r: TeamRights): string[] {
  return [`Contents: ${r.contents === "write" ? "Read and write" : "Read"}`, ...(r.pull_requests ? ["Pull requests: Read and write"] : []), "Metadata: Read"];
}

/** The `permissionsQuery` of the GitHub token recipe: already URL-encoded `name=level` pairs, stable order. */
export function teamRightsQuery(r: TeamRights): string {
  return Object.entries(r)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** The recipe's `permissions` variable: `name=level` pairs separated by commas. */
export function teamRightsList(r: TeamRights): string {
  return Object.entries(r)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** Does a token with rights `have` do everything `want` asks for? Write includes read. */
export function rightsCover(have: TeamRights, want: TeamRights): boolean {
  if (want.contents === "write" && have.contents !== "write") return false;
  if (want.pull_requests === "write" && have.pull_requests !== "write") return false;
  return true;
}
