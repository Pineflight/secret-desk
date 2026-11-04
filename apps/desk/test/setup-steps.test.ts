import { describe, expect, it } from "vitest";
import { showPermissionWarning, showSignInCheck, stepperState } from "../src/lib/setup-steps";

const status = (i: Parameters<typeof stepperState>[0]) => stepperState(i).map((s) => `${s.id}:${s.status}`).join(" ");

describe("stepperState", () => {
  it("starts at the repository", () => {
    expect(status({ repo: "", branch: "", path: "", modeAllowed: false })).toBe("repo:current file:todo mode:todo token:todo");
  });
  it("moves to branch and file once a repository is chosen", () => {
    expect(status({ repo: "acme-org/team-config", branch: "", path: "", modeAllowed: false })).toBe("repo:done file:current mode:todo token:todo");
    expect(status({ repo: "acme-org/team-config", branch: "main", path: "", modeAllowed: false })).toBe("repo:done file:current mode:todo token:todo");
  });
  it("asks for the team token when the mode is not allowed yet", () => {
    expect(status({ repo: "a/b", branch: "main", path: "team.yaml", modeAllowed: false })).toBe("repo:done file:done mode:done token:current");
  });
  it("is complete when the mode is allowed", () => {
    expect(status({ repo: "a/b", branch: "main", path: "team.yaml", modeAllowed: true })).toBe("repo:done file:done mode:done token:done");
  });
  it("never marks the token done before the file is chosen", () => {
    expect(status({ repo: "a/b", branch: "", path: "", modeAllowed: true })).toBe("repo:done file:current mode:todo token:todo");
  });
});

describe("showPermissionWarning", () => {
  it("is quiet while a team token can be created", () => {
    expect(showPermissionWarning(true, true)).toBe(false);
    expect(showPermissionWarning(true, false)).toBe(true);
    expect(showPermissionWarning(false, false)).toBe(false);
  });
});

describe("showSignInCheck", () => {
  const base = { available: true, signedIn: true, checkedAt: 1_000_000, now: 1_000_000 + 60_000, freshMs: 3_600_000 };
  it("disappears while a positive answer is fresh", () => {
    expect(showSignInCheck(base)).toBe(false);
  });
  it("returns when the answer is old, negative or missing", () => {
    expect(showSignInCheck({ ...base, now: base.checkedAt + 4_000_000 })).toBe(true);
    expect(showSignInCheck({ ...base, signedIn: false })).toBe(true);
    expect(showSignInCheck({ ...base, signedIn: null, checkedAt: null })).toBe(true);
  });
  it("is never offered when the sign-in cannot run", () => {
    expect(showSignInCheck({ ...base, available: false, signedIn: null, checkedAt: null })).toBe(false);
  });
});
