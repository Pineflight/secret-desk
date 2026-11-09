import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optionsFromChildren } from "../src/lib/select-options";
import {
  CHOICE_STORAGE_KEY, EMPTY_CHOICE, parseChoice, readChoice, withBranch, withFile, withMode, withRepo, writeChoice, type SetupChoice,
} from "../src/lib/setup-choice";
import { compact, didYouMean, highlight, parseQuery, scoreTerm, search, suggestFilters, tokens, vocabularyOf, type SearchDoc } from "../src/lib/smart-search";
import { defaultEnvironment, kindTone, suggestId } from "../src/lib/stage-draft";
import { defaultStageId, environmentOf, stageRank, toneOf } from "../src/lib/stages";
import { approvalStateInfo, checkInfo, driftInfo, overallInfo, statusInfo } from "../src/lib/status";
import { groupByRepository } from "../src/lib/sync-view";
import { nextTab } from "../src/lib/tabs";
import { neededRightsLine } from "../src/lib/team-picker";
import { SECTIONS } from "../src/lib/team-sync";
import { createLabelKey, type TeamTokenMeta, readyTokenExpiry, teamTokenSteps, tokenCovers } from "../src/lib/team-token";
import { readStored, writeStored } from "../src/lib/persisted-state";
import { pushToast } from "../src/lib/toast-queue";
import { summarizeDrift } from "../src/lib/variable-list";

afterEach(() => vi.unstubAllGlobals());

describe("select options", () => {
  it("skips text children and reads only strings and numbers inside an option", () => {
    const tree = createElement(Fragment, null, "stray text", createElement("option", { value: "a" }, "Alpha ", 2, createElement("b", null, "x")), createElement("option", null, "Plain"));
    expect(optionsFromChildren(tree)).toEqual([{ value: "a", label: "Alpha 2" }, { value: "Plain", label: "Plain" }]);
  });
});

describe("setup choice", () => {
  const full: SetupChoice = { repo: "r", branch: "b", file: "f", mode: "pull-push", strategy: "direct", confirmed: { repo: true, file: true, mode: true } };
  it("parses defensively", () => {
    expect(parseChoice(null)).toBe(EMPTY_CHOICE);
    expect(parseChoice("text")).toBe(EMPTY_CHOICE);
    expect(parseChoice({ repo: "r", confirmed: "yes", mode: "pull-push", strategy: "direct" })).toMatchObject({ repo: "r", branch: "", mode: "pull-push", strategy: "direct", confirmed: { repo: false } });
    expect(parseChoice({ repo: "r", branch: "b", file: "f", confirmed: { repo: true, file: true, mode: true } }).confirmed).toEqual({ repo: true, file: true, mode: true });
    expect(parseChoice({ repo: "r", branch: "b", file: "f", confirmed: { repo: true, file: true } }).confirmed.mode).toBe(false);
    expect(parseChoice({ repo: "x".repeat(301) }).repo).toBe("");
  });
  it("reads and writes through an injected storage and removes the key without a repo", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    writeChoice(full, storage);
    expect(readChoice(storage)).toEqual(full);
    writeChoice(EMPTY_CHOICE, storage);
    expect(data.has(CHOICE_STORAGE_KEY)).toBe(false);
    expect(readChoice(storage)).toBe(EMPTY_CHOICE);
    data.set(CHOICE_STORAGE_KEY, "{broken");
    expect(readChoice(storage)).toBe(EMPTY_CHOICE);
    expect(readChoice(null)).toBe(EMPTY_CHOICE);
  });
  it("ignores storage that throws on write", () => {
    expect(() => writeChoice(full, { setItem: () => { throw new Error("full"); }, removeItem: () => undefined })).not.toThrow();
  });
  it("uses the default storage lookup without a browser and with a window", () => {
    expect(readChoice()).toBe(EMPTY_CHOICE);
    expect(() => writeChoice(EMPTY_CHOICE)).not.toThrow();
  });
  it("reads the choice from window.localStorage and treats blocked storage as empty", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => JSON.stringify(full) } });
    expect(readChoice()).toEqual(full);
    vi.stubGlobal("window", { get localStorage(): never { throw new Error("blocked"); } });
    expect(readChoice()).toBe(EMPTY_CHOICE);
  });
  it("keeps the same object when nothing changes and resets what depends on a change", () => {
    expect(withRepo(full, "r")).toBe(full);
    expect(withRepo(full, "other")).toMatchObject({ repo: "other", branch: "", file: "", confirmed: { repo: false } });
    expect(withBranch(full, "b")).toBe(full);
    expect(withBranch(full, "b2")).toMatchObject({ branch: "b2", file: "", confirmed: { repo: true, file: false, mode: false } });
    expect(withFile(full, "f")).toBe(full);
    expect(withFile(full, "f2")).toMatchObject({ file: "f2", confirmed: { file: false, mode: false } });
    expect(withMode(full, "pull-push", "direct")).toBe(full);
    expect(withMode(full, "pull-push", "pull-request")).toMatchObject({ strategy: "pull-request", confirmed: { mode: false } });
    expect(withMode(full, "pull", "direct")).toMatchObject({ mode: "pull" });
  });
});

describe("smart search edge cases", () => {
  it("folds umlauts and splits words at separators", () => {
    expect(compact("Ärger Öl Über Straße")).toBe("aergeroelueberstrasse");
    expect(tokens("alpha-beta-")).toEqual(["alpha", "beta"]);
  });
  it("scores nothing for an empty term or an empty text", () => {
    expect(scoreTerm("", "text")).toBe(0);
    expect(scoreTerm("abc", "---")).toBe(0);
  });
  it("tolerates a typo but not an unrelated word", () => {
    expect(scoreTerm("stripee", "stripe secret")).toBeGreaterThan(0);
    expect(scoreTerm("zzzzzz", "stripe secret")).toBe(0);
  });
  it("keeps its cache bounded", () => {
    for (let i = 0; i < 20_050; i++) scoreTerm("abc", `unique text number ${i}`, false);
    expect(scoreTerm("abc", "unique text abc", false)).toBeGreaterThan(0);
  });
  it("ignores query words without letters and digits", () => {
    expect(parseQuery("!!! foo")).toMatchObject({ terms: ["foo"] });
  });
  it("sorts hits of documents without fields", () => {
    const docs: SearchDoc[] = [{ id: "1", kind: "x", fields: [], attrs: {} }, { id: "2", kind: "x", fields: [], attrs: {} }];
    expect(search(docs, "stage:none")).toEqual([]);
    expect(search(docs, "")).toHaveLength(2);
  });
  it("skips empty highlight terms", () => {
    expect(highlight("abc", [""])).toEqual([{ text: "abc", hit: false }]);
  });
  const ctx = { values: { stage: ["staging", "production"], art: ["secret", "variable"], tag: ["two words"] } } as never;
  it("suggests filter values, quoted when they contain spaces, and ignores unknown keys", () => {
    expect(suggestFilters("foo:x", ctx)).toEqual([]);
    expect(suggestFilters("art:sec", ctx).map((s) => s.label)).toEqual(["art:secret"]);
    expect(suggestFilters("kind:var", ctx).map((s) => s.label)).toEqual(["kind:variable"]);
    expect(suggestFilters("tag:tw", ctx)[0]!.query).toBe('tag:"two words" ');
    expect(suggestFilters("owner:a", ctx)).toEqual([]);
    expect(suggestFilters("x", ctx)).toEqual([]);
    expect(suggestFilters("", ctx)).toEqual([]);
    expect(suggestFilters("sta", ctx).map((s) => s.label)).toEqual(["stage:", "status:"]);
  });
  it("corrects unknown words, prefers shorter words on ties and keeps filters", () => {
    expect(didYouMean("", new Set(["stripe"]))).toBeNull();
    expect(didYouMean("stripee", new Set(["stripe"]))).toBe("stripe");
    expect(didYouMean("stripe", new Set(["stripe"]))).toBeNull();
    expect(didYouMean("stage:prod stripee", new Set(["stripe"]))).toBe("stage:prod stripe");
    expect(didYouMean("strip3", new Set(["stripes", "stripe"]))).toBe("stripe");
    expect(didYouMean("abcdef", new Set(["abcdxx", "abcdx"]))).toBe("abcdx");
    expect(didYouMean("qqqqqq", new Set(["stripe"]))).toBeNull();
    expect(didYouMean("ab", new Set(["ac"]))).toBeNull();
  });
  it("builds a vocabulary without descriptions and short words", () => {
    const v = vocabularyOf([{ id: "1", kind: "x", attrs: {}, fields: [{ key: "name", text: "Alpha is" }, { key: "description", text: "hidden words" }] }]);
    expect([...v]).toEqual(["alpha"]);
  });
});

describe("stages", () => {
  const defs = [{ id: "prod", label: "Prod", kind: "live" }, { id: "t", label: "T", kind: "test", tone: "warn" }] as never;
  it("falls back for unknown stages", () => {
    expect(toneOf(defs, "nope")).toBe("neutral");
    expect(toneOf(defs, "t")).toBe("warn");
    expect(environmentOf(defs, "nope")).toBeNull();
    expect(stageRank(["a", "b"], "zzz")).toBe(2);
    expect(defaultStageId([], "live")).toBe("");
    expect(defaultStageId(defs, "dev")).toBe("prod");
  });
  it("derives drafts helpers", () => {
    expect(defaultEnvironment({ id: "", kind: "test" })).toBeNull();
    expect(defaultEnvironment({ id: "qa", kind: "test" })).toBe("qa");
    expect(defaultEnvironment({ id: "qa", kind: "dev" })).toBeNull();
    expect(suggestId("Mein Test-Stand")).toBe("mein-test-stand");
    expect(kindTone("live")).toBe("stage-prod");
  });
});

describe("status infos", () => {
  it("describes every state", () => {
    expect(statusInfo("nonsense" as never).tone).toBe("neutral");
    expect(checkInfo("pass").tone).toBe("success");
    expect(checkInfo("warn").tone).toBe("warn");
    expect(checkInfo("fail").tone).toBe("danger");
    expect(checkInfo("info").tone).toBe("info");
    expect(overallInfo("pass").tone).toBe("success");
    expect(overallInfo("warn").tone).toBe("warn");
    expect(overallInfo("fail").tone).toBe("danger");
    expect(driftInfo("missing").tone).toBe("danger");
    expect(driftInfo("in-sync").tone).toBe("success");
    expect(driftInfo("different").tone).toBe("warn-strong");
    expect(driftInfo("unknown-expected").tone).toBe("neutral");
    expect(driftInfo("unreachable").tone).toBe("danger");
    expect(approvalStateInfo("pending").tone).toBe("warn");
    expect(approvalStateInfo("approved").tone).toBe("success");
    expect(approvalStateInfo("denied").tone).toBe("neutral");
    expect(approvalStateInfo("stale").tone).toBe("warn");
    expect(approvalStateInfo("anything else").tone).toBe("danger");
  });
});

describe("small pure helpers", () => {
  it("orders lines of one place by place label", () => {
    const line = (placeLabel: string) => ({ repo: "r", name: "N", action: "set", placeLabel, key: placeLabel }) as never;
    expect(groupByRepository([line("b"), line("a")])[0]!.lines.map((l) => l.placeLabel)).toEqual(["a", "b"]);
  });
  it("does not move through an empty tab list", () => {
    expect(nextTab([], "a", "ArrowRight")).toBeNull();
  });
  it("names no rights without access data", () => {
    expect(neededRightsLine(undefined)).toBe("");
    expect(neededRightsLine({ neededRights: ["a", "b"] } as never)).toBe("a, b");
  });
  it("lists the team sync sections", () => {
    expect(SECTIONS).toContain("envTemplates");
  });
  it("treats unknown drift states as not compared", () => {
    expect(summarizeDrift([{ state: "weird" }])).toBe("not-compared");
  });
  it("keeps other toasts when an identical one renews", () => {
    const a = { id: 1, kind: "info" as const, text: "a" };
    const b = { id: 2, kind: "info" as const, text: "b" };
    const list = pushToast(pushToast([], a), b);
    const again = pushToast(list, { ...a, id: 3 });
    expect(again.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("persisted state without a browser", () => {
  it("returns the fallback and writes nothing", () => {
    expect(readStored("k", "fallback")).toBe("fallback");
    expect(() => writeStored("k", 1, 0)).not.toThrow();
  });
});

describe("team token", () => {
  it("handles runs without a timeline and failed phases", () => {
    expect(teamTokenSteps(null).map((s) => s.state)).toEqual(["pending", "pending", "pending", "pending"]);
    const steps = teamTokenSteps({ status: "running", timeline: [{ phase: "opening", state: "failed" }] } as never);
    expect(steps[0]).toEqual({ phase: "opening", state: "failed" });
    expect(teamTokenSteps({ status: "running", timeline: undefined } as never)).toHaveLength(4);
  });
  it("reads the expiry of a covering token, an empty text when it has none", () => {
    const active = { repo: "r", mode: "pull-push", strategy: "direct", valid: true, expires: null };
    expect(readyTokenExpiry({ source: "own" } as never, { active } as never, "r")).toBe("");
    expect(readyTokenExpiry({ source: "own" } as never, { active: { ...active, expires: "2027-01-01" } } as never, "r")).toBe("2027-01-01");
    expect(readyTokenExpiry({ source: "own" } as never, { active } as never, "other")).toBeNull();
    expect(readyTokenExpiry({ source: "env" } as never, { active } as never, "r")).toBeNull();
    expect(readyTokenExpiry(undefined, { active } as never, "r")).toBeNull();
  });
  it("covers selections", () => {
    const active = { repo: "r", mode: "pull-push", strategy: "pull-request", valid: true } as unknown as TeamTokenMeta;
    expect(tokenCovers(active, "r", "pull", "direct")).toBe(true);
    expect(tokenCovers(active, "r", "pull-push", "pull-request")).toBe(true);
    expect(tokenCovers(active, "r", "pull-push", "direct")).toBe(true);
    expect(tokenCovers({ ...active, strategy: "direct" }, "r", "pull-push", "pull-request")).toBe(false);
    expect(tokenCovers({ ...active, mode: "pull" }, "r", "pull-push", "pull-request")).toBe(false);
    expect(tokenCovers(null, "r", "pull", "direct")).toBe(false);
    expect(createLabelKey({ active } as never)).toBe("teamToken.createNew");
    expect(createLabelKey(undefined)).toBe("teamToken.create");
  });
});
