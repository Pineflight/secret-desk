import { describe, expect, it } from "vitest";
import { tokenDetailsOpen, tokenLine } from "@/lib/team-sync-view";
import { activeToken, tokenInfo } from "./helpers/team-token";
import { runState } from "./helpers/run";

describe("tokenLine", () => {
  it("is null while the info is not loaded", () => {
    expect(tokenLine(undefined, "acme/team", "pull", "pull-request")).toBeNull();
  });
  it("reports a missing token", () => {
    expect(tokenLine(tokenInfo(), "acme/team", "pull", "pull-request")).toBe("missing");
  });
  it("reports an expired token", () => {
    expect(tokenLine(tokenInfo({ active: activeToken({ valid: false }) }), "acme/team", "pull", "pull-request")).toBe("expired");
  });
  it("reports a token that does not cover the mode", () => {
    expect(tokenLine(tokenInfo({ active: activeToken({ mode: "pull" }) }), "acme/team", "pull-push", "pull-request")).toBe("not-covered");
    expect(tokenLine(tokenInfo({ active: activeToken() }), "acme/other", "pull", "pull-request")).toBe("not-covered");
  });
  it("reports the GitHub integration when connected without a team token", () => {
    for (const tokenSource of ["github-pat", "github-app"] as const) {
      expect(tokenLine(tokenInfo(), "acme/team", "pull-push", "pull-request", { connected: true, tokenSource })).toBe("integration");
    }
  });
  it("keeps warning without a team token when not connected or the source is the team token", () => {
    expect(tokenLine(tokenInfo(), "acme/team", "pull", "pull-request", { connected: false, tokenSource: "none" })).toBe("missing");
    expect(tokenLine(tokenInfo(), "acme/team", "pull", "pull-request", { connected: true, tokenSource: "own" })).toBe("missing");
    expect(tokenLine(tokenInfo(), "acme/team", "pull", "pull-request", { connected: false, tokenSource: "github-pat" })).toBe("missing");
  });
  it("still reports an expired token when the integration is connected", () => {
    expect(tokenLine(tokenInfo({ active: activeToken({ valid: false }) }), "acme/team", "pull", "pull-request", { connected: true, tokenSource: "github-pat" })).toBe("expired");
  });
  it("reports a valid covering token", () => {
    expect(tokenLine(tokenInfo({ active: activeToken() }), "acme/team", "pull-push", "pull-request")).toBe("valid");
  });
});

describe("tokenDetailsOpen", () => {
  const valid = (over = {}) => tokenInfo({ active: activeToken(), ...over });
  it("stays closed while nothing is loaded", () => {
    expect(tokenDetailsOpen(undefined, null)).toBe(false);
    expect(tokenDetailsOpen(valid(), null)).toBe(false);
  });
  it("stays closed for a valid covering token without activity", () => {
    expect(tokenDetailsOpen(valid(), "valid")).toBe(false);
  });
  it("stays closed for the integration line, but opens for a run or a pending revocation", () => {
    expect(tokenDetailsOpen(tokenInfo(), "integration")).toBe(false);
    expect(tokenDetailsOpen(tokenInfo({ run: runState({ status: "failed" }) }), "integration")).toBe(true);
  });
  it.each(["missing", "expired", "not-covered"] as const)("opens for %s", (line) => {
    expect(tokenDetailsOpen(valid(), line)).toBe(true);
  });
  it("opens while a run goes, waits or has failed", () => {
    expect(tokenDetailsOpen(valid({ run: runState({ status: "running" }) }), "valid")).toBe(true);
    expect(tokenDetailsOpen(valid({ run: runState({ status: "waiting-human" }) }), "valid")).toBe(true);
    expect(tokenDetailsOpen(valid({ run: runState({ status: "failed" }) }), "valid")).toBe(true);
  });
  it("stays closed after a finished run", () => {
    expect(tokenDetailsOpen(valid({ run: runState({ status: "done" }) }), "valid")).toBe(false);
  });
  it("opens for a pending revocation", () => {
    expect(tokenDetailsOpen(valid({ pendingRevocation: { tokenName: "t", repo: "acme/team", since: "2026-01-01", url: "https://github.test/x" } }), "valid")).toBe(true);
  });
});
