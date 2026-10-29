import { describe, expect, it } from "vitest";
import { ParamsInvalidError, effectiveParams, mappedResource, markSuggestions, paramsMessage, validateEntryParams, type ParamSpec } from "../src/index.js";

const spec = (extra: Partial<ParamSpec> & { key: string }): ParamSpec => ({ label: extra.key, labelEn: extra.key, type: "string", required: false, help: "", helpEn: "", ...extra });

describe("validateEntryParams", () => {
  const provider = {
    params: [
      spec({ key: "accountId", label: "Cloudflare-Konto", required: true, integrationDefault: true }),
      spec({ key: "permissions", label: "Berechtigungen", type: "stringList", required: true }),
      spec({ key: "type", type: "enum", options: [{ value: "a", label: "A", labelEn: "A" }] }),
      spec({ key: "permission", type: "enum", defaultValue: "sending_access", options: [{ value: "sending_access", label: "s", labelEn: "s" }, { value: "full_access", label: "f", labelEn: "f" }] }),
      spec({ key: "domainId", requiredWhen: { key: "permission", equals: "sending_access" } }),
      spec({ key: "n", type: "integer", min: 8, max: 128 }),
      spec({ key: "u", type: "url" }),
    ],
  };
  it("names missing required parameters with their labels", () => {
    const problems = validateEntryParams(provider, { params: { permission: "full_access" } });
    expect(problems.map((p) => p.key)).toEqual(["accountId", "permissions"]);
    expect(paramsMessage(problems)).toBe("Pflichtparameter fehlen: accountId (Cloudflare-Konto), permissions (Berechtigungen)");
    expect(new ParamsInvalidError(problems).code).toBe("params_invalid");
  });
  it("reports wrong types and values outside the options", () => {
    const problems = validateEntryParams(provider, { params: { accountId: "a", permissions: ["x"], type: "zzz", permission: "full_access", n: 3, u: "http://x.example" } });
    expect(problems.map((p) => [p.key, p.code])).toEqual([["type", "not_in_options"], ["n", "wrong_type"], ["u", "wrong_type"]]);
    expect(validateEntryParams(provider, { params: { accountId: 5, permissions: "x", permission: "full_access" } }).map((p) => p.code)).toEqual(["wrong_type", "wrong_type"]);
  });
  it("requires domainId for sending_access (also by default) but not for full_access", () => {
    const base = { accountId: "a", permissions: ["x"] };
    expect(validateEntryParams(provider, { params: base }).map((p) => p.key)).toEqual(["domainId"]);
    expect(validateEntryParams(provider, { params: { ...base, permission: "sending_access" } }).map((p) => p.key)).toEqual(["domainId"]);
    expect(validateEntryParams(provider, { params: { ...base, permission: "full_access" } })).toEqual([]);
  });
  it("uses the integration default as fallback and keeps unknown keys", () => {
    const entry = { params: { permissions: ["x"], permission: "full_access", custom: 1 } };
    expect(validateEntryParams(provider, entry).map((p) => p.key)).toEqual(["accountId"]);
    expect(validateEntryParams(provider, entry, { accountId: "acc" })).toEqual([]);
    expect(effectiveParams(provider, entry.params, { accountId: "acc", other: 1 })).toEqual({ ...entry.params, accountId: "acc" });
    expect(validateEntryParams(provider, entry, { accountId: "acc" }, { strict: true }).map((p) => p.code)).toEqual(["unknown_key"]);
  });
  it("providers without a specification accept anything", () => {
    expect(validateEntryParams({}, { params: { x: 1 } })).toEqual([]);
  });
});

describe("markSuggestions", () => {
  const opt = (label: string, value: string = label) => ({ value, label });
  const staging = { repos: ["wake-miles"], stage: "staging", stageKind: "test" as const };
  it("suggests exactly one clear match by repository and stage", () => {
    const r = markSuggestions("supabase.project", [opt("wake-miles-staging"), opt("wake-miles-production"), opt("other-staging")], staging);
    expect(r.suggested).toBe("wake-miles-staging");
    expect(r.options.filter((o) => o.suggestedFor)).toHaveLength(1);
  });
  it("suggests nothing when ambiguous", () => {
    const r = markSuggestions("supabase.project", [opt("wake-miles-staging"), opt("wake-miles-staging-2")], staging);
    expect(r.suggested).toBeNull();
    expect(r.options.some((o) => o.suggestedFor)).toBe(false);
  });
  it("suggests nothing when none matches or the match is only weak or for another stage", () => {
    expect(markSuggestions("supabase.project", [opt("acme-staging")], staging).suggested).toBeNull();
    expect(markSuggestions("supabase.project", [opt("wake-miles")], staging).suggested).toBeNull();
    expect(markSuggestions("supabase.project", [opt("wake-miles-production")], staging).suggested).toBeNull();
  });
  it("zones match by repository only, accounts only when single, other kinds never", () => {
    expect(markSuggestions("cloudflare.zone", [opt("wakemiles.com", "z1"), opt("pineflight.com", "z2")], staging).suggested).toBe("z1");
    expect(markSuggestions("cloudflare.account", [opt("A", "1")], staging).suggested).toBe("1");
    expect(markSuggestions("cloudflare.account", [opt("A", "1"), opt("B", "2")], staging).suggested).toBeNull();
    expect(markSuggestions("cloudflare.permissionGroups", [opt("A")], staging).suggested).toBeNull();
  });
});

describe("markSuggestions with a resource map", () => {
  const opt = (label: string, value: string = label) => ({ value, label });
  const entry = (extra: Record<string, unknown>) => ({ kind: "resend.domain", repo: "acme-app", value: "d2", ...extra }) as never;
  const hint = (map: unknown[], stage = "staging") => ({ repos: ["acme-app"], stage, stageKind: "test" as const, resourceMap: map as never });
  const domains = [opt("example.com", "d1"), opt("mail.example.net", "d2")];
  it("takes precedence over the name rules and marks exactly that option", () => {
    // Namensregel allein: "acme-app" passt zu keiner Domain; mit Zuordnung ist die Wahl eindeutig.
    expect(markSuggestions("resend.domain", domains, hint([])).suggested).toBeNull();
    const r = markSuggestions("resend.domain", domains, hint([entry({})]));
    expect(r.suggested).toBe("d2");
    expect(r.options.filter((o) => o.suggestedFor)).toEqual([{ value: "d2", label: "mail.example.net", suggestedFor: { score: 4, reason: "Zuordnung" } }]);
    expect(r.mapMismatch).toBeUndefined();
  });
  it("beats a name match that points elsewhere", () => {
    const r = markSuggestions("resend.domain", [opt("acme-app.com", "d3"), ...domains], hint([entry({})]));
    expect(r.suggested).toBe("d2");
  });
  it("resolves ambiguous names", () => {
    const projects = [opt("acme-app-staging", "p1"), opt("acme-app-staging-2", "p2")];
    expect(markSuggestions("supabase.project", projects, hint([])).suggested).toBeNull();
    expect(markSuggestions("supabase.project", projects, hint([entry({ kind: "supabase.project", value: "p2" })])).suggested).toBe("p2");
  });
  it("prefers the entry with the matching stage over the one without a stage", () => {
    const map = [entry({ value: "d1" }), entry({ stage: "production", value: "d2" })];
    expect(markSuggestions("resend.domain", domains, hint(map, "staging")).suggested).toBe("d1");
    expect(markSuggestions("resend.domain", domains, hint(map, "production")).suggested).toBe("d2");
    expect(markSuggestions("resend.domain", domains, hint([entry({ stage: "production" })], "staging")).suggested).toBeNull();
  });
  it("ignores other repositories and kinds", () => {
    expect(markSuggestions("resend.domain", domains, hint([entry({ repo: "other" })])).suggested).toBeNull();
    expect(markSuggestions("resend.domain", domains, hint([entry({ kind: "cloudflare.zone" })])).suggested).toBeNull();
  });
  it("suggests nothing but reports a mismatch when the value is not in the list", () => {
    const r = markSuggestions("resend.domain", domains, hint([entry({ value: "gone", label: "old.example.com" })]));
    expect(r.suggested).toBeNull();
    expect(r.options.some((o) => o.suggestedFor)).toBe(false);
    expect(r.mapMismatch).toEqual({ value: "gone", label: "old.example.com" });
    expect(markSuggestions("resend.domain", [], hint([entry({})])).mapMismatch).toEqual({ value: "d2" });
  });
  it("falls back to the name rules when repositories map to different resources", () => {
    const multi = { repos: ["acme-app", "acme-web"], resourceMap: [entry({ value: "d1" }), entry({ repo: "acme-web", value: "d2" })] as never };
    expect(mappedResource("resend.domain", multi)).toBeNull();
    expect(mappedResource("resend.domain", { repos: ["acme-app"], resourceMap: multi.resourceMap })?.value).toBe("d1");
  });
});
