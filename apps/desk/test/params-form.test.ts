import { describe, expect, it } from "vitest";
import type { ParamSpec } from "@secret-desk/core";
import { ApiError, toApiError } from "../src/lib/api";
import {
  applyPreset,
  buildPut,
  canSave,
  dependencyKey,
  dependencyParams,
  dependencyQuery,
  describeValue,
  effectiveValues,
  fieldKind,
  findingsFromError,
  findingsText,
  isRequiredNow,
  isSuggested,
  isUnlisted,
  issueMessages,
  missingKeys,
  optionText,
  presetActive,
  presetNeeds,
  preflightTone,
  problemMessages,
  problemsFromError,
  suggestionOf,
  toDraft,
  toParams,
  toggleValue,
  validateDraft,
  type ResourceState,
} from "../src/lib/params-form";
import { translate } from "../src/lib/i18n";

const spec = (o: Partial<ParamSpec> & Pick<ParamSpec, "key" | "type">): ParamSpec => ({ label: o.key, labelEn: `${o.key} en`, required: false, help: "", helpEn: "", ...o });

const SPECS: ParamSpec[] = [
  spec({ key: "accountId", type: "string", required: true, discover: "cloudflare.account", integrationDefault: true }),
  spec({ key: "zoneId", type: "string", discover: "cloudflare.zone", requiredWhen: { key: "scope", equals: "zone" } }),
  spec({ key: "scope", type: "enum", defaultValue: "account", options: [{ value: "account", label: "Konto", labelEn: "Account" }, { value: "zone", label: "Zone", labelEn: "Zone" }] }),
  spec({
    key: "permissions",
    type: "stringList",
    required: true,
    discover: "cloudflare.permissionGroups",
    presets: [{ id: "deploy", label: "Worker-Deploy", labelEn: "Worker deploy", values: { permissions: ["p1", "p2"] }, needs: ["zoneId"] }],
  }),
  spec({ key: "baseUrl", type: "url" }),
  spec({ key: "ttl", type: "integer", min: 1, max: 90 }),
];

describe("fieldKind", () => {
  it("chooses the field by spec", () => {
    expect(fieldKind(SPECS[0]!)).toBe("pick");
    expect(fieldKind(SPECS[3]!)).toBe("pickMany");
    expect(fieldKind(SPECS[2]!)).toBe("enum");
    expect(fieldKind(SPECS[4]!)).toBe("url");
    expect(fieldKind(SPECS[5]!)).toBe("integer");
    expect(fieldKind(spec({ key: "x", type: "stringList" }))).toBe("list");
    expect(fieldKind(spec({ key: "x", type: "string" }))).toBe("text");
  });
});

describe("required rules", () => {
  it("requiredWhen follows the other parameter, falling back to its default", () => {
    const zone = SPECS[1]!;
    expect(isRequiredNow(zone, SPECS, {})).toBe(false);
    expect(isRequiredNow(zone, SPECS, { scope: "zone" })).toBe(true);
    expect(isRequiredNow(zone, SPECS, { scope: "account" })).toBe(false);
  });
  it("integration defaults fill blanks, but only where the provider allows it", () => {
    const eff = effectiveValues(SPECS, { permissions: ["p1"] }, { accountId: "acc1", zoneId: "z1" });
    expect(eff["accountId"]).toBe("acc1");
    expect(eff["zoneId"]).toBeUndefined();
    expect(effectiveValues(SPECS, { accountId: "mine" }, { accountId: "acc1" })["accountId"]).toBe("mine");
  });
  it("lists missing required keys", () => {
    expect(missingKeys(validateDraft(SPECS, {}))).toEqual(["accountId", "permissions"]);
    expect(missingKeys(validateDraft(SPECS, {}, { accountId: "acc1" }))).toEqual(["permissions"]);
    expect(missingKeys(validateDraft(SPECS, { accountId: "a", permissions: ["p1"], scope: "zone" }))).toEqual(["zoneId"]);
    expect(canSave(SPECS, { accountId: "a", permissions: ["p1"] })).toBe(true);
  });
  it("treats blank text and empty lists as missing", () => {
    expect(missingKeys(validateDraft(SPECS, { accountId: "  ", permissions: [] }))).toEqual(["accountId", "permissions"]);
  });
});

describe("conversion", () => {
  it("builds API values from the draft", () => {
    const { params, invalid } = toParams(SPECS, { accountId: " acc1 ", permissions: "p1, p2\np3", ttl: "30", baseUrl: "", scope: "" });
    expect(params).toEqual({ accountId: "acc1", permissions: ["p1", "p2", "p3"], ttl: 30 });
    expect(invalid).toEqual([]);
    expect(toParams(SPECS, { ttl: "abc" }).invalid).toEqual(["ttl"]);
  });
  it("round-trips stored values into a draft", () => {
    expect(toDraft(SPECS, { ttl: 30, permissions: ["p1"], accountId: "" })).toEqual({ ttl: "30", permissions: ["p1"] });
  });
  it("validates type, range and options like the server", () => {
    const base = { accountId: "a", permissions: ["p"] };
    expect(validateDraft(SPECS, { ...base, baseUrl: "http://x" })).toEqual([{ key: "baseUrl", code: "wrong_type" }]);
    expect(validateDraft(SPECS, { ...base, baseUrl: "https://grafana.example.com" })).toEqual([]);
    expect(validateDraft(SPECS, { ...base, ttl: "0" })).toEqual([{ key: "ttl", code: "wrong_type" }]);
    expect(validateDraft(SPECS, { ...base, ttl: "91" })).toEqual([{ key: "ttl", code: "wrong_type" }]);
    expect(validateDraft(SPECS, { ...base, ttl: "x" })).toEqual([{ key: "ttl", code: "wrong_type" }]);
    expect(validateDraft(SPECS, { ...base, scope: "planet" })).toEqual([{ key: "scope", code: "not_in_options" }]);
  });
  it("builds a minimal PUT body: changed keys only, cleared keys as null", () => {
    const original = { accountId: "acc1", permissions: ["p1"], ttl: 30 };
    expect(buildPut(SPECS, toDraft(SPECS, original), original)).toEqual({ params: {}, changed: false });
    const draft = { accountId: "acc2", permissions: ["p1"], ttl: "" };
    expect(buildPut(SPECS, draft, original)).toEqual({ params: { accountId: "acc2", ttl: null }, changed: true });
    expect(buildPut(SPECS, { permissions: ["p1", "p2"], accountId: "acc1", ttl: "30" }, original).params).toEqual({ permissions: ["p1", "p2"] });
  });
});

describe("dependencies of discovery", () => {
  it("collects single values only (lists do not affect other lists)", () => {
    expect(dependencyParams(SPECS, { accountId: " acc1 ", permissions: ["p1"], baseUrl: "", ttl: "5" })).toEqual({ accountId: "acc1", ttl: "5" });
  });
  it("changes its key only when a dependent value changes", () => {
    const a = dependencyKey(dependencyParams(SPECS, { accountId: "acc1", permissions: ["p1"] }));
    const b = dependencyKey(dependencyParams(SPECS, { accountId: "acc1", permissions: ["p1", "p2"] }));
    const c = dependencyKey(dependencyParams(SPECS, { accountId: "acc2", permissions: ["p1"] }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("builds param.<key> query parameters, encoded and sorted", () => {
    expect(dependencyQuery({ b: "x y", accountId: "a&b" }).toString()).toBe("param.accountId=a%26b&param.b=x+y");
  });
});

describe("resources and suggestions", () => {
  const state: ResourceState = {
    status: "ok",
    suggested: "acc1",
    options: [
      { value: "acc1", label: "Pineflight", detail: "acc1", suggestedFor: { score: 1, reason: "einzige Option" } },
      { value: "acc2", label: "Privat", detail: "Konto" },
    ],
  };
  it("returns the one suggestion and never an unmarked option", () => {
    expect(suggestionOf(state)?.value).toBe("acc1");
    expect(suggestionOf({ ...state, suggested: "acc2" })).toBeNull();
    expect(suggestionOf({ ...state, suggested: null })).toBeNull();
    expect(suggestionOf({ ...state, status: "error", options: [] })).toBeNull();
    expect(suggestionOf(undefined)).toBeNull();
  });
  it("marks the chosen value as suggested only if it is the suggestion", () => {
    expect(isSuggested(state, "acc1")).toBe(true);
    expect(isSuggested(state, "acc2")).toBe(false);
    expect(isSuggested(state, "")).toBe(false);
  });
  it("shows name and detail, hides detail that repeats the id", () => {
    expect(optionText(state.options[0]!)).toBe("Pineflight");
    expect(optionText(state.options[1]!)).toBe("Privat · Konto");
  });
  it("reads values as resource names", () => {
    expect(describeValue(SPECS[0]!, "acc1", state, "de")).toBe("Pineflight (acc1)");
    expect(describeValue(SPECS[0]!, "other", state, "de")).toBe("other");
    expect(describeValue(SPECS[3]!, ["acc1", "x"], state, "de")).toBe("Pineflight (acc1), x");
    expect(describeValue(SPECS[2]!, "zone", undefined, "en")).toBe("Zone");
    expect(describeValue(SPECS[0]!, "", state, "de")).toBe("");
  });
  it("flags a value that is not in the list", () => {
    expect(isUnlisted(SPECS[0]!, "acc9", state)).toBe(true);
    expect(isUnlisted(SPECS[0]!, "acc1", state)).toBe(false);
    expect(isUnlisted(SPECS[0]!, "acc9", { status: "error", options: [], suggested: null })).toBe(false);
    expect(isUnlisted(SPECS[3]!, ["x"], state)).toBe(false);
  });
  it("toggles list values", () => {
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleValue("not a list", "a")).toEqual(["a"]);
  });
});

describe("presets", () => {
  const preset = SPECS[3]!.presets![0]!;
  it("sets the preset values in the draft without touching others", () => {
    const next = applyPreset({ accountId: "a", permissions: ["old"] }, preset);
    expect(next).toEqual({ accountId: "a", permissions: ["p1", "p2"] });
    expect(next["permissions"]).not.toBe(preset.values["permissions"]);
  });
  it("detects an active preset regardless of order and names missing needs", () => {
    expect(presetActive(preset, { permissions: ["p2", "p1"] })).toBe(true);
    expect(presetActive(preset, { permissions: ["p1"] })).toBe(false);
    expect(presetNeeds(preset, {})).toEqual(["zoneId"]);
    expect(presetNeeds(preset, { zoneId: "z" })).toEqual([]);
  });
});

describe("error mapping", () => {
  const body = { error: "Pflichtparameter fehlen", code: "params_invalid", problems: [{ key: "accountId", code: "missing" as const, message: "accountId fehlt", label: "Cloudflare-Konto", labelEn: "Cloudflare account" }] };
  it("keeps problems and findings on the API error", () => {
    const e = toApiError(400, body);
    expect(e).toBeInstanceOf(ApiError);
    expect(problemsFromError(e)).toHaveLength(1);
    const pre = toApiError(409, { error: "x", code: "preflight_failed", findings: [{ id: "a", level: "fail", label: "Token fehlt Recht", detail: "zone:read" }] });
    expect(findingsFromError(pre)[0]?.label).toBe("Token fehlt Recht");
    expect(findingsText(findingsFromError(pre))).toBe("Token fehlt Recht (zone:read)");
    expect(problemsFromError(pre)).toEqual([]);
    expect(problemsFromError(new Error("x"))).toEqual([]);
    expect(problemsFromError(null)).toEqual([]);
  });
  it("maps problems to a message per field in both languages", () => {
    const p = body.problems;
    const de = problemMessages(p, (k, v) => translate(k, v, "de"), "de");
    const en = problemMessages(p, (k, v) => translate(k, v, "en"), "en");
    expect(de["accountId"]).toBe("Cloudflare-Konto fehlt.");
    expect(en["accountId"]).toBe("Cloudflare account is missing.");
    expect(problemMessages([{ ...p[0]!, code: "weird" as never, message: "Server sagt nein" }], (k) => k, "de")["accountId"]).toBe("Server sagt nein");
  });
  it("maps local issues with the spec label", () => {
    const m = issueMessages([{ key: "ttl", code: "wrong_type" }], SPECS, (k, v) => translate(k, v, "en"), "en");
    expect(m["ttl"]).toBe("ttl en has an invalid format.");
  });
});

describe("preflight report", () => {
  const f = (level: "ok" | "warn" | "fail") => ({ id: level, level, label: level });
  it("decides how the result is announced", () => {
    expect(preflightTone({ status: "ok", resource: "r", findings: [] })).toBe("success");
    expect(preflightTone({ status: "warn", resource: null, findings: [f("warn")] })).toBe("info");
    expect(preflightTone({ status: "fail", resource: null, findings: [f("fail")] })).toBe("error");
    expect(preflightTone({ status: "skipped", resource: null, findings: [] })).toBeNull();
    expect(preflightTone({ status: "not-connected", resource: null, findings: [] })).toBeNull();
    expect(preflightTone(null)).toBeNull();
  });
  it("lists only findings that are not ok", () => {
    expect(findingsText([f("ok"), f("warn"), f("fail")])).toBe("warn; fail");
  });
});
