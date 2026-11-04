import { describe, expect, it } from "vitest";
import { showPermissionWarning, showSignInCheck, stepperState } from "../src/lib/setup-steps";

import { NO_CONFIRMATIONS, type StepConfirmations } from "../src/lib/setup-steps";

const ALL: StepConfirmations = { repo: true, file: true, mode: true };
type In = Omit<Parameters<typeof stepperState>[0], "confirmed"> & { confirmed?: StepConfirmations };
const status = (i: In) => stepperState({ confirmed: ALL, ...i }).map((s) => `${s.id}:${s.status}`).join(" ");

describe("stepperState", () => {
  it("starts at the repository", () => {
    expect(status({ repo: "", branch: "", path: "", modeAllowed: false, confirmed: NO_CONFIRMATIONS })).toBe("repo:current file:todo mode:todo token:todo");
  });
  it("keeps every step open while only suggestions exist", () => {
    expect(status({ repo: "a/b", branch: "main", path: "team.yaml", modeAllowed: true, confirmed: NO_CONFIRMATIONS })).toBe("repo:current file:todo mode:todo token:todo");
  });
  it("completes a step only after the human confirmed it", () => {
    const base = { repo: "a/b", branch: "main", path: "team.yaml", modeAllowed: false };
    expect(status({ ...base, confirmed: { repo: true, file: false, mode: false } })).toBe("repo:done file:current mode:todo token:todo");
    expect(status({ ...base, confirmed: { repo: true, file: true, mode: false } })).toBe("repo:done file:done mode:current token:todo");
    expect(status({ ...base, confirmed: ALL })).toBe("repo:done file:done mode:done token:current");
  });
  it("moves to branch and file once a repository is confirmed", () => {
    expect(status({ repo: "acme-org/team-config", branch: "", path: "", modeAllowed: false, confirmed: { repo: true, file: false, mode: false } })).toBe("repo:done file:current mode:todo token:todo");
  });
  it("is complete when everything is confirmed and the mode is allowed", () => {
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
