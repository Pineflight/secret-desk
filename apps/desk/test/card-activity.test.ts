import { describe, expect, it } from "vitest";
import { activityReducer, clockTime, emptyActivity, hasFailedTest, isCardBusy, isLineBusy, lastCardResult, lastResult, toastKey } from "../src/lib/card-activity";

describe("card activity", () => {
  it("marks a card and its line busy from start to finish", () => {
    let s = activityReducer(emptyActivity(), { type: "start", key: { card: "stripe", kind: "test", line: "stripe:acct_1:live" } });
    expect(isCardBusy(s, "stripe")).toBe(true);
    expect(isLineBusy(s, "stripe", "stripe:acct_1:live")).toBe(true);
    expect(isLineBusy(s, "stripe", "other")).toBe(false);
    expect(isCardBusy(s, "github")).toBe(false);
    s = activityReducer(s, { type: "finish", key: { card: "stripe", kind: "test", line: "stripe:acct_1:live" }, ok: false, at: 1000 });
    expect(isCardBusy(s, "stripe")).toBe(false);
    expect(lastResult(s, "stripe", "stripe:acct_1:live")).toMatchObject({ ok: false, at: 1000, kind: "test" });
  });
  it("keeps two kinds on one card apart and returns the newest result", () => {
    let s = emptyActivity();
    s = activityReducer(s, { type: "start", key: { card: "a", kind: "signin" } });
    s = activityReducer(s, { type: "start", key: { card: "a", kind: "test", line: "k" } });
    s = activityReducer(s, { type: "finish", key: { card: "a", kind: "signin" }, ok: true, at: 5 });
    expect(isCardBusy(s, "a")).toBe(true);
    s = activityReducer(s, { type: "finish", key: { card: "a", kind: "test", line: "k" }, ok: false, at: 9 });
    expect(isCardBusy(s, "a")).toBe(false);
    expect(lastCardResult(s, "a")).toMatchObject({ ok: false, at: 9 });
    expect(lastCardResult(s, "b")).toBeUndefined();
  });
  it("remembers a failed test until the same key passes again", () => {
    let s = activityReducer(emptyActivity(), { type: "finish", key: { card: "a", kind: "test", line: "k" }, ok: false, at: 1 });
    expect(hasFailedTest(s, "a")).toBe(true);
    expect(hasFailedTest(s, "b")).toBe(false);
    s = activityReducer(s, { type: "finish", key: { card: "a", kind: "test", line: "k" }, ok: true, at: 2 });
    expect(hasFailedTest(s, "a")).toBe(false);
    s = activityReducer(s, { type: "finish", key: { card: "a", kind: "signin" }, ok: false, at: 3 });
    expect(hasFailedTest(s, "a")).toBe(false);
  });
  it("does not mutate the previous state", () => {
    const a = emptyActivity();
    activityReducer(a, { type: "start", key: { card: "a", kind: "test" } });
    expect(a.running.size).toBe(0);
  });
  it("formats the time and names the toast message", () => {
    expect(clockTime(new Date(2026, 10, 4, 9, 5).getTime())).toBe("09:05");
    expect(toastKey("renewal", true)).toBe("activity.ok.renewal");
    expect(toastKey("remove", false)).toBe("activity.fail.remove");
  });
});
