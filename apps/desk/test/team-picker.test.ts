import { describe, expect, it } from "vitest";
import { effectiveMode, failedChecks, filterRepos, groupRepos, initialRepo, limitRepos, modeAllowed, modeStatus, selectionReady, toTeamSyncConfig, unusableReason, type ModeAccess, type RepoChoice, type TeamSelection } from "../src/lib/team-picker";

const repo = (fullName: string, over: Partial<RepoChoice> = {}): RepoChoice => {
  const [owner, name] = fullName.split("/") as [string, string];
  return { owner, name, fullName, private: true, archived: false, defaultBranch: "main", pushedAt: null, selectable: true, reason: null, ...over };
};
const access = (over: Partial<ModeAccess> = {}): ModeAccess => ({ source: "github-pat", problem: null, mode: "pull", strategy: "pull-request", neededRights: ["Contents: Read"], checks: [], ok: true, ...over });
const sel: TeamSelection = { repo: "acme/team-config", branch: "main", path: "secret-desk.team.yaml", createFile: false, mode: "pull", strategy: "pull-request" };

describe("team picker helpers", () => {
  it("filters by owner and name, every word must match", () => {
    const repos = [repo("acme/team-config"), repo("acme/web"), repo("other/team-notes")];
    expect(filterRepos(repos, "").map((r) => r.fullName)).toHaveLength(3);
    expect(filterRepos(repos, "TEAM").map((r) => r.fullName)).toEqual(["acme/team-config", "other/team-notes"]);
    expect(filterRepos(repos, "acme team").map((r) => r.fullName)).toEqual(["acme/team-config"]);
    expect(filterRepos(repos, "nothing")).toEqual([]);
  });

  it("a mode is allowed only with a passing check and no problem", () => {
    expect(modeAllowed(undefined)).toBe(false);
    expect(modeAllowed(access())).toBe(true);
    expect(modeAllowed(access({ ok: false }))).toBe(false);
    expect(modeAllowed(access({ problem: { code: "no-integration", neededRights: [] } }))).toBe(false);
  });

  it("lists the failed checks of a mode", () => {
    const a = access({ ok: false, checks: [{ id: "read", label: "r", status: "pass" }, { id: "push", label: "p", status: "fail" }] });
    expect(failedChecks(a).map((c) => c.id)).toEqual(["push"]);
    expect(failedChecks(undefined)).toEqual([]);
  });

  it("creating a file forces the write mode", () => {
    expect(effectiveMode("pull", true)).toBe("pull-push");
    expect(effectiveMode("pull", false)).toBe("pull");
  });

  it("the selection is ready when complete and allowed", () => {
    expect(selectionReady(sel, access())).toBe(true);
    expect(selectionReady({ ...sel, branch: "" }, access())).toBe(false);
    expect(selectionReady(sel, access({ ok: false }))).toBe(false);
    expect(selectionReady(null, access())).toBe(false);
  });

  it("builds the team sync config, new files in write mode", () => {
    expect(toTeamSyncConfig(sel)).toEqual({ repo: "acme/team-config", path: "secret-desk.team.yaml", branch: "main", mode: "pull", push: { strategy: "pull-request" } });
    expect(toTeamSyncConfig({ ...sel, createFile: true, strategy: "direct" }).mode).toBe("pull-push");
  });

  it("groups usable repositories first and public or archived ones apart, keeping the order", () => {
    const repos = [
      repo("acme/open-site", { private: false, selectable: false, reason: "public" }),
      repo("acme/team-config"),
      repo("acme/old", { archived: true }),
      repo("acme/web"),
    ];
    const g = groupRepos(repos, "");
    expect(g.usable.map((r) => r.fullName)).toEqual(["acme/team-config", "acme/web"]);
    expect(g.unusable.map((r) => r.fullName)).toEqual(["acme/open-site", "acme/old"]);
    expect(g.unusable.map(unusableReason)).toEqual(["public", "archived"]);
    expect(groupRepos(repos, "web").usable.map((r) => r.fullName)).toEqual(["acme/web"]);
    expect(groupRepos(repos, "web").unusable).toEqual([]);
  });

  it("shows the first rows and keeps the chosen one visible", () => {
    const repos = Array.from({ length: 12 }, (_, i) => repo(`acme/r${i}`));
    expect(limitRepos(repos, 8, "", false)).toHaveLength(8);
    expect(limitRepos(repos, 8, "acme/r10", false).map((r) => r.fullName)).toEqual([...repos.slice(0, 8).map((r) => r.fullName), "acme/r10"]);
    expect(limitRepos(repos, 8, "acme/r2", false)).toHaveLength(8);
    expect(limitRepos(repos, 8, "", true)).toHaveLength(12);
    expect(limitRepos(repos.slice(0, 5), 8, "", false)).toHaveLength(5);
  });

  it("preselects only an accessible private repository that is in the list", () => {
    const repos = [repo("acme/team-config"), repo("acme/public-one", { private: false, selectable: false, reason: "public" }), repo("acme/old", { archived: true })];
    expect(initialRepo({ repos, preselected: "acme/team-config" })).toBe("acme/team-config");
    expect(initialRepo({ repos, preselected: "acme/public-one" })).toBe("");
    expect(initialRepo({ repos, preselected: "acme/old" })).toBe("");
    expect(initialRepo({ repos, preselected: "acme/unknown" })).toBe("");
    expect(initialRepo({ repos, preselected: null })).toBe("");
    expect(initialRepo(undefined)).toBe("");
  });

  it("reduces a mode to one status", () => {
    expect(modeStatus(undefined, true, false)).toBe("checking");
    expect(modeStatus(undefined, false, false)).toBe("checking");
    expect(modeStatus(access(), false, false)).toBe("ready");
    expect(modeStatus(access({ ok: false }), false, false)).toBe("needs");
    expect(modeStatus(access(), false, true)).toBe("create-needs-write");
  });
});
