import { describe, expect, it } from "vitest";
import type { ParamSuggestion } from "@secret-desk/runtime";
import { canApplyRow, countNeedingParams, filterByParams, isUnambiguous, needsParams, suggestedKeys, suggestionBody, unambiguousRows } from "../src/lib/params-list";

const s = (id: string, status: "ok" | "missing" | "invalid" | "none", missing: string[] = []) => ({ id, params: { status, missing } });
const row = (o: Partial<ParamSuggestion> & Pick<ParamSuggestion, "secretId" | "missing" | "suggestions" | "status">): ParamSuggestion => ({ provider: "cloudflare-token", stage: "staging", ...o });
const sg = (value: string) => ({ value, label: value, reason: "einzige Option" });

describe("params list filter", () => {
  const items = [s("a", "ok"), s("b", "missing", ["accountId"]), s("c", "none"), s("d", "invalid")];
  it("needs params for missing and invalid only", () => {
    expect(items.map(needsParams)).toEqual([false, true, false, true]);
    expect(countNeedingParams(items)).toBe(2);
  });
  it("filters by the missing-parameters mode", () => {
    expect(filterByParams(items, "missing").map((i) => i.id)).toEqual(["b", "d"]);
    expect(filterByParams(items, "").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterByParams(items, "unknown").map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("suggestions", () => {
  const full = row({ secretId: "one", missing: ["accountId", "zoneId"], suggestions: { accountId: sg("acc1"), zoneId: sg("z1") }, status: "suggested" });
  const partial = row({ secretId: "two", missing: ["accountId", "zoneId"], suggestions: { accountId: sg("acc1"), zoneId: null }, status: "partial" });
  const none = row({ secretId: "three", missing: ["accountId"], suggestions: { accountId: null }, status: "none" });
  const off = row({ secretId: "four", missing: ["accountId"], suggestions: {}, status: "not-connected" });
  it("takes only keys with a suggestion", () => {
    expect(suggestedKeys(partial)).toEqual(["accountId"]);
    expect(suggestionBody(full)).toEqual({ accountId: "acc1", zoneId: "z1" });
    expect(suggestionBody(partial)).toEqual({ accountId: "acc1" });
    expect(suggestionBody(none)).toEqual({});
    expect(canApplyRow(partial)).toBe(true);
    expect(canApplyRow(none)).toBe(false);
    expect(canApplyRow(off)).toBe(false);
  });
  it("applies all only for unambiguous rows, never partial or empty ones", () => {
    expect([full, partial, none, off].map(isUnambiguous)).toEqual([true, false, false, false]);
    expect(unambiguousRows([full, partial, none, off]).map((r) => r.secretId)).toEqual(["one"]);
  });
  it("does not trust a status that its suggestions contradict", () => {
    expect(isUnambiguous({ status: "suggested", missing: ["a", "b"], suggestions: { a: sg("x"), b: null } })).toBe(false);
    expect(isUnambiguous({ status: "suggested", missing: [], suggestions: {} })).toBe(false);
  });
});
