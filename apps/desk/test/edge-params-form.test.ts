import { describe, expect, it } from "vitest";
import type { ParamPreset, ParamSpec } from "@secret-desk/core";
import {
  applyPreset, buildPut, canSave, dependencyParams, describeValue, findingsFromError, findingsText, isSuggested, isUnlisted, issueMessages, optionText, optionsOf, presetActive, presetLabel,
  presetNeeds, preflightTone, problemMessages, problemsFromError, resourceStatus, specHelp, specLabel, toDraft, toParams, validateDraft,
  type ResourceState,
} from "../src/lib/params-form";

const spec = (over: Partial<ParamSpec>): ParamSpec => ({ key: "k", label: "Etikett", labelEn: "Label", type: "string", required: false, help: "Hilfe", helpEn: "Help", ...over }) as ParamSpec;

describe("labels", () => {
  it("picks the language", () => {
    const s = spec({});
    expect(specLabel(s, "de")).toBe("Etikett");
    expect(specLabel(s, "en")).toBe("Label");
    expect(specHelp(s, "de")).toBe("Hilfe");
    expect(specHelp(s, "en")).toBe("Help");
    const p = { id: "p", label: "Preis", labelEn: "Price", values: {} } as unknown as ParamPreset;
    expect(presetLabel(p, "de")).toBe("Preis");
    expect(presetLabel(p, "en")).toBe("Price");
  });
});

describe("toDraft and toParams edge cases", () => {
  it("turns numbers and boolean enums into text and copies lists", () => {
    const specs = [spec({ key: "n", type: "integer" }), spec({ key: "e", type: "enum" }), spec({ key: "l", type: "stringList" }), spec({ key: "t" }), spec({ key: "x" })];
    const list = ["a"];
    const draft = toDraft(specs, { n: 5, e: true, l: list, t: "text", x: "" });
    expect(draft).toEqual({ n: "5", e: "true", l: ["a"], t: "text" });
    expect(draft["l"]).not.toBe(list);
  });
  it("accepts numbers for integers and reports unreadable ones", () => {
    const specs = [spec({ key: "n", type: "integer" })];
    expect(toParams(specs, { n: 7 }).params).toEqual({ n: 7 });
    expect(toParams(specs, { n: " 8 " }).params).toEqual({ n: 8 });
    expect(toParams(specs, { n: "x1" })).toEqual({ params: { n: "x1" }, invalid: ["n"] });
  });
  it("builds lists from text, arrays and ignores other shapes or empty results", () => {
    const specs = [spec({ key: "l", type: "stringList" })];
    expect(toParams(specs, { l: "a, b\nc" }).params).toEqual({ l: ["a", "b", "c"] });
    expect(toParams(specs, { l: ["a", "", 3] }).params).toEqual({ l: ["a"] });
    expect(toParams(specs, { l: 12 }).params).toEqual({});
    expect(toParams(specs, { l: ["", ""] }).params).toEqual({});
    expect(toParams(specs, { l: " , " }).params).toEqual({});
  });
  it("keeps non-text values of text parameters and trims text", () => {
    const specs = [spec({ key: "t" })];
    expect(toParams(specs, { t: true }).params).toEqual({ t: true });
    expect(toParams(specs, { t: "  v " }).params).toEqual({ t: "v" });
  });
});

describe("validateDraft edge cases", () => {
  it("checks integer bounds, urls and enum options", () => {
    const specs = [
      spec({ key: "n", type: "integer", min: 5, max: 10 }),
      spec({ key: "u", type: "url" }),
      spec({ key: "e", type: "enum", options: [{ value: "a", label: "A", labelEn: "A" }] }),
      spec({ key: "free", type: "enum" }),
    ];
    const issues = (d: Record<string, unknown>) => validateDraft(specs, d).map((i) => `${i.key}:${i.code}`);
    expect(issues({ n: "4" })).toEqual(["n:wrong_type"]);
    expect(issues({ n: "11" })).toEqual(["n:wrong_type"]);
    expect(issues({ n: "7", u: "https://example.org", e: "a", free: "anything" })).toEqual([]);
    expect(issues({ n: "x" })).toEqual(["n:wrong_type"]);
    expect(issues({ u: "http://example.org" })).toEqual(["u:wrong_type"]);
    expect(issues({ u: "not a url" })).toEqual(["u:wrong_type"]);
    expect(issues({ u: 5 })).toEqual(["u:wrong_type"]);
    expect(issues({ e: "zzz" })).toEqual(["e:not_in_options"]);
  });
  it("uses a minimum of 1 for integers without a given minimum and no maximum", () => {
    const specs = [spec({ key: "n", type: "integer" })];
    expect(validateDraft(specs, { n: "0" })).toHaveLength(1);
    expect(validateDraft(specs, { n: "99999" })).toHaveLength(0);
    expect(canSave(specs, { n: "1" })).toBe(true);
  });
  it("accepts non-integers only as problems", () => {
    expect(validateDraft([spec({ key: "n", type: "integer" })], { n: 1.5 })).toHaveLength(1);
  });
});

describe("buildPut", () => {
  it("sends changed values and null for cleared ones", () => {
    const specs = [spec({ key: "a" }), spec({ key: "b" }), spec({ key: "c" })];
    const out = buildPut(specs, { a: "new", b: "" }, { a: "old", b: "was", c: "" });
    expect(out).toEqual({ params: { a: "new", b: null }, changed: true });
    expect(buildPut(specs, { a: "same" }, { a: "same" })).toEqual({ params: {}, changed: false });
  });
});

describe("resources", () => {
  const ok = (over: Record<string, unknown> = {}): ResourceState => ({ status: "ok", options: [{ value: "id1", label: "One" }, { value: "id2", label: "id2", detail: "id2" }], suggested: null, ...over }) as unknown as ResourceState;
  it("reports none and no options for an unknown or failed state", () => {
    expect(resourceStatus(undefined)).toBe("none");
    expect(optionsOf(undefined)).toEqual([]);
    expect(optionsOf({ status: "error" } as unknown as ResourceState)).toEqual([]);
    expect(optionsOf(ok())).toHaveLength(2);
  });
  it("adds a detail only when it says something new", () => {
    expect(optionText({ value: "v", label: "L", detail: "more" } as never)).toBe("L · more");
    expect(optionText({ value: "v", label: "L", detail: "v" } as never)).toBe("L");
    expect(optionText({ value: "v", label: "L", detail: "L" } as never)).toBe("L");
    expect(optionText({ value: "v", label: "L" } as never)).toBe("L");
  });
  it("marks a suggestion only when the option agrees", () => {
    const state = ok({ suggested: "id1", options: [{ value: "id1", label: "One", suggestedFor: true }] });
    expect(isSuggested(state, "id1")).toBe(true);
    expect(isSuggested(state, "other")).toBe(false);
    expect(isSuggested(ok({ suggested: "id1" }), "id1")).toBe(false);
    expect(isSuggested(undefined, "id1")).toBe(false);
  });
  it("flags a value missing from a non-empty discovered list", () => {
    const pick = spec({ key: "p", discover: "x.y" });
    expect(isUnlisted(pick, "zzz", ok())).toBe(true);
    expect(isUnlisted(pick, "id1", ok())).toBe(false);
    expect(isUnlisted(pick, "", ok())).toBe(false);
    expect(isUnlisted(pick, "zzz", ok({ options: [] }))).toBe(false);
    expect(isUnlisted(pick, "zzz", undefined)).toBe(false);
    expect(isUnlisted(spec({ key: "p" }), "zzz", ok())).toBe(false);
  });
  it("describes values by resource name, option label or plain text", () => {
    const pick = spec({ key: "p", discover: "x.y" });
    expect(describeValue(pick, "id1", ok(), "de")).toBe("One (id1)");
    expect(describeValue(pick, "id2", ok(), "de")).toBe("id2");
    expect(describeValue(pick, "other", ok(), "de")).toBe("other");
    expect(describeValue(pick, "", ok(), "de")).toBe("");
    expect(describeValue(pick, ["id1", "id2"], ok(), "de")).toBe("One (id1), id2");
    const en = spec({ key: "e", type: "enum", options: [{ value: "a", label: "Alpha", labelEn: "Alpha EN" }] });
    expect(describeValue(en, "a", undefined, "de")).toBe("Alpha");
    expect(describeValue(en, "a", undefined, "en")).toBe("Alpha EN");
    expect(describeValue(en, "zz", undefined, "en")).toBe("zz");
    expect(describeValue(spec({ key: "e", type: "enum" }), "zz", undefined, "en")).toBe("zz");
  });
});

describe("dependencies", () => {
  it("passes only text and number values and skips lists and other shapes", () => {
    const specs = [spec({ key: "a" }), spec({ key: "b" }), spec({ key: "c" }), spec({ key: "d", type: "stringList" }), spec({ key: "e" })];
    expect(dependencyParams(specs, { a: " x ", b: 5, c: true, d: ["q"], e: "" })).toEqual({ a: "x", b: "5" });
  });
});

describe("presets", () => {
  it("copies scalar and list values into the draft without touching the original", () => {
    const list = ["a"];
    const p = { id: "p", label: "P", labelEn: "P", values: { s: "x", l: list } } as unknown as ParamPreset;
    const draft = { keep: "1" };
    const out = applyPreset(draft, p);
    expect(out).toEqual({ keep: "1", s: "x", l: ["a"] });
    expect(out["l"]).not.toBe(list);
    expect(draft).toEqual({ keep: "1" });
  });
  const preset = (values: Record<string, unknown>, needs?: string[]) => ({ id: "p", label: "P", labelEn: "P", values, ...(needs ? { needs } : {}) }) as unknown as ParamPreset;
  it("is never active without values and compares lists as sets", () => {
    expect(presetActive(preset({}), {})).toBe(false);
    expect(presetActive(preset({ l: ["a", "b"] }), { l: ["b", "a"] })).toBe(true);
    expect(presetActive(preset({ l: ["a", "b"] }), { l: ["a"] })).toBe(false);
    expect(presetActive(preset({ l: ["a"] }), { l: "a" })).toBe(false);
    expect(presetActive(preset({ s: "x" }), { s: "x" })).toBe(true);
    expect(presetActive(preset({ s: "x" }), { s: "y" })).toBe(false);
  });
  it("lists needed parameters that are still blank", () => {
    expect(presetNeeds(preset({}), {})).toEqual([]);
    expect(presetNeeds(preset({}, ["a", "b"]), { a: "set" })).toEqual(["b"]);
  });
});

describe("error mapping", () => {
  const tr = (k: string, v?: Record<string, string | number>) => `${k}:${v?.["label"]}`;
  it("maps server problems and falls back to the message for other codes", () => {
    const out = problemMessages([{ key: "a", code: "missing", message: "m", label: "L", labelEn: "LE" }, { key: "b", code: "custom", message: "own text", label: "L", labelEn: "LE" }] as never, tr, "en");
    expect(out).toEqual({ a: "params.problem.missing:LE", b: "own text" });
    expect(problemMessages([{ key: "a", code: "missing", message: "m", label: "L", labelEn: "LE" }] as never, tr, "de")).toEqual({ a: "params.problem.missing:L" });
  });
  it("names a form issue by its label or by its key", () => {
    const out = issueMessages([{ key: "k", code: "missing" }, { key: "gone", code: "wrong_type" }], [spec({ key: "k" })], tr, "de");
    expect(out).toEqual({ k: "params.problem.missing:Etikett", gone: "params.problem.wrong_type:gone" });
  });
  it("reads problems and findings only from the matching error", () => {
    expect(problemsFromError(null)).toEqual([]);
    expect(problemsFromError({ code: "other" })).toEqual([]);
    expect(problemsFromError({ code: "params_invalid", problems: "x" })).toEqual([]);
    const ttl = { key: "ttlDays", code: "not_in_options", message: "ttlDays wird vom Anbieter nicht angeboten; erlaubt sind 1, 7, 30 Tage", label: "Ablauf (Tage)", labelEn: "Expiry (days)" };
    expect(problemsFromError({ code: "params_invalid", problems: [ttl] })).toEqual([ttl]);
    expect(problemsFromError({ code: "params_invalid", problems: [{ key: "a", code: "missing" }, { key: 1 }, null, "x"] })).toEqual([{ key: "a", code: "missing" }]);
    expect(findingsFromError(null)).toEqual([]);
    expect(findingsFromError({ code: "other" })).toEqual([]);
    expect(findingsFromError({ code: "preflight_failed", findings: "x" })).toEqual([]);
    expect(findingsFromError({ code: "preflight_failed", findings: [{ label: "L" }, { label: 1 }, null] })).toEqual([{ label: "L" }]);
  });
});

describe("preflight text", () => {
  it("maps every status to a tone", () => {
    expect(preflightTone(null)).toBeNull();
    expect(preflightTone({ status: "ok", resource: null, findings: [] })).toBe("success");
    expect(preflightTone({ status: "warn", resource: null, findings: [] })).toBe("info");
    expect(preflightTone({ status: "fail", resource: null, findings: [] })).toBe("error");
    expect(preflightTone({ status: "skipped", resource: null, findings: [] })).toBeNull();
  });
  it("lists findings that are not ok with their detail", () => {
    expect(findingsText([{ level: "ok", label: "fine" }, { level: "warn", label: "A", detail: "d" }, { level: "fail", label: "B" }] as never)).toBe("A (d); B");
  });
});
