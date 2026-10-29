import { describe, expect, it } from "vitest";
import { EMPTY_SOURCE, applyBody, clip, describeFrom, draftOf, fieldAllowed, fromBody, pickKind, retryParams, sourceComplete, splitSuggestions, type SourceDef, type SuggestionRow } from "../src/lib/variable-source";

const SOURCES: SourceDef[] = [
  { kind: "supabase.project", connection: "supabase", label: "Supabase-Projekt", labelEn: "Supabase project", connected: true, fields: [{ field: "url", label: "URL", labelEn: "URL" }, { field: "ref", label: "Referenz", labelEn: "Reference" }] },
  { kind: "resend.domain", connection: "resend", label: "Resend-Domain", labelEn: "Resend domain", connected: false, fields: [{ field: "name", label: "Name", labelEn: "Name" }] },
];

describe("source selection", () => {
  it("drops resource and field when the kind changes, keeps a single field", () => {
    expect(pickKind(SOURCES, "supabase.project")).toEqual({ kind: "supabase.project", resource: "", field: "" });
    expect(pickKind(SOURCES, "resend.domain")).toEqual({ kind: "resend.domain", resource: "", field: "name" });
    expect(pickKind(SOURCES, "")).toEqual(EMPTY_SOURCE);
  });
  it("is complete only with kind, resource and field", () => {
    expect(sourceComplete({ kind: "a", resource: "b", field: "c" })).toBe(true);
    expect(sourceComplete({ kind: "a", resource: "", field: "c" })).toBe(false);
  });
  it("offers only fields from the server allowlist", () => {
    expect(fieldAllowed(SOURCES, { kind: "supabase.project", resource: "r", field: "url" })).toBe(true);
    expect(fieldAllowed(SOURCES, { kind: "supabase.project", resource: "r", field: "service_role_key" })).toBe(false);
    expect(fieldAllowed(SOURCES, { kind: "nope", resource: "r", field: "url" })).toBe(false);
  });
  it("builds the from object with the connection of the source, or null", () => {
    expect(fromBody(SOURCES, { kind: "supabase.project", resource: "ref1", field: "url" })).toEqual({ connection: "supabase", kind: "supabase.project", resource: "ref1", field: "url" });
    expect(fromBody(SOURCES, { kind: "supabase.project", resource: "ref1", field: "jwt_secret" })).toBeNull();
    expect(fromBody(SOURCES, { kind: "supabase.project", resource: "", field: "url" })).toBeNull();
    expect(fromBody(SOURCES, EMPTY_SOURCE)).toBeNull();
  });
  it("reads a stored source back and describes it in both languages", () => {
    const from = { connection: "supabase", kind: "supabase.project", resource: "ref1", field: "url" };
    expect(draftOf(from)).toEqual({ kind: "supabase.project", resource: "ref1", field: "url" });
    expect(draftOf(null)).toEqual(EMPTY_SOURCE);
    expect(describeFrom(from, SOURCES, "de")).toBe("Supabase-Projekt · URL");
    expect(describeFrom(from, SOURCES, "en")).toBe("Supabase project · URL");
    expect(describeFrom({ ...from, kind: "gone", field: "x" }, SOURCES, "de")).toBe("gone · x");
  });
});

describe("retry with integration defaults", () => {
  it("retries once with the defaults when discovery needs a parameter", () => {
    expect(retryParams("cloudflare.zone", { defaults: { accountId: "acc1" }, resources: { "cloudflare.zone": { status: "needs-params" } } })).toEqual({ accountId: "acc1" });
  });
  it("does not retry without defaults, non-text defaults or another status", () => {
    expect(retryParams("cloudflare.zone", { defaults: {}, resources: { "cloudflare.zone": { status: "needs-params" } } })).toBeNull();
    expect(retryParams("cloudflare.zone", { defaults: { n: 5, blank: "" }, resources: { "cloudflare.zone": { status: "needs-params" } } })).toBeNull();
    expect(retryParams("cloudflare.zone", { defaults: { accountId: "a" }, resources: { "cloudflare.zone": { status: "ok" } } })).toBeNull();
    expect(retryParams("cloudflare.zone", { defaults: { accountId: "a" }, resources: {} })).toBeNull();
  });
});

describe("suggestions for variables", () => {
  const from = { connection: "supabase", kind: "supabase.project", resource: "ref1", field: "url" };
  const rows: SuggestionRow[] = [
    { variableId: "a", from, current: "old", proposed: "new", resourceLabel: "wake-miles-staging", changed: true, status: "ok" },
    { variableId: "b", from, current: "same", proposed: "same", resourceLabel: "x", changed: false, status: "ok" },
    { variableId: "c", from, status: "error", error: "nicht gefunden" },
  ];
  it("splits changed, unchanged and failed rows", () => {
    const sp = splitSuggestions(rows);
    expect(sp.changed.map((r) => r.variableId)).toEqual(["a"]);
    expect(sp.same.map((r) => r.variableId)).toEqual(["b"]);
    expect(sp.failed.map((r) => r.variableId)).toEqual(["c"]);
  });
  it("applies the stored source with apply:true, acknowledgement only on request", () => {
    expect(applyBody(from)).toEqual({ kind: "supabase.project", resource: "ref1", field: "url", apply: true });
    expect(applyBody(from, true)).toEqual({ kind: "supabase.project", resource: "ref1", field: "url", apply: true, acknowledgedPublic: true });
  });
  it("clips long values", () => {
    expect(clip(null)).toBe("");
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("abcdefgh", 5)).toBe("abcd…");
  });
});
