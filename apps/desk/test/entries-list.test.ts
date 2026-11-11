import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SecretView, VariableView } from "@secret-desk/runtime";
import {
  SECRET_STATUSES, VARIABLE_STATUSES, activeKinds, counts, effectiveFilters, entriesHref, initialNewKind, narrowingFilters, needsComparison, parseKind, parseStatusList, isStatusCombination, SOON_OR_DUE, secretMatches, statusKinds, variableMatches,
  type EntryFilters,
} from "../src/lib/entries-list";
import { buildIndex } from "../src/lib/palette-index";
import { filterBySearch } from "../src/lib/page-search";
import { search } from "../src/lib/smart-search";
import { messages } from "../src/messages";

const none: EntryFilters = { kind: "", status: "", provider: "", params: "" };
const secret = (o: Partial<SecretView> = {}) => ({ id: "s1", name: "S_ONE", status: "ok", automatic: false, params: { status: "none", missing: [] }, places: [], tags: [], stage: "staging", ...o }) as unknown as SecretView;
const variable = (o: Partial<VariableView> = {}) => ({ id: "v1", name: "V_ONE", value: null, places: [], tags: [], stage: "staging", ...o }) as unknown as VariableView;

describe("kind filter in the URL", () => {
  it("parses ?kind= and treats everything else as all", () => {
    expect(parseKind("secret")).toBe("secret");
    expect(parseKind("variable")).toBe("variable");
    for (const v of [null, undefined, "", "secrets", "Variable", "x"]) expect(parseKind(v)).toBe("");
  });
  it("builds links with set filters", () => {
    expect(entriesHref()).toBe("/entries");
    expect(entriesHref({ stage: "production", status: "missing" })).toBe("/entries?stage=production&status=missing");
    expect(entriesHref({ kind: "variable", repo: "my app" })).toBe("/entries?kind=variable&repo=my+app");
    expect(new URLSearchParams(entriesHref({ kind: "secret", q: "a&b" }).split("?")[1]).get("q")).toBe("a&b");
  });
  it("the page reads the kind from the URL and writes it back on a switch", () => {
    const page = readFileSync(join(__dirname, "../src/app/entries/page.tsx"), "utf8");
    expect(page).toContain('parseKind(params.get("kind"))');
    expect(page).toContain('setParam("kind", v)');
    expect(page).toContain("<SegmentSwitch");
    // every other filter that the example link uses is URL-driven as well
    expect(page).toContain('params.get("stage")');
    expect(page).toContain('params.get("status")');
  });
});

describe("new entry", () => {
  it("preselects the kind from ?new=, then from the kind filter, otherwise secret", () => {
    expect(initialNewKind("variable", "secret")).toBe("variable");
    expect(initialNewKind("1", "variable")).toBe("variable");
    expect(initialNewKind(null, "secret")).toBe("secret");
    expect(initialNewKind("1", "")).toBe("secret");
  });
  it("one dialog offers both forms", () => {
    const dialog = readFileSync(join(__dirname, "../src/components/NewEntryDialog.tsx"), "utf8");
    expect(dialog).toContain("<SecretForm");
    expect(dialog).toContain("<VariableForm");
  });
});

describe("counts", () => {
  it("counts the rows per kind", () => {
    const rows = [{ entryKind: "secret" as const }, { entryKind: "variable" as const }, { entryKind: "variable" as const }];
    expect(counts(rows)).toEqual({ secret: 1, variable: 2 });
    expect(counts([])).toEqual({ secret: 0, variable: 0 });
  });
  it("the header text exists in both languages with both numbers", () => {
    for (const l of ["de", "en"] as const) expect(messages[l]["entries.counts"]).toMatch(/\{secrets\}.*\{variables\}/);
    expect(messages.de["entries.counts"]).toBe("{secrets} Secrets, {variables} Variablen");
  });
});

describe("status filter across both kinds", () => {
  it("knows which kind a status value belongs to", () => {
    expect(statusKinds("")).toEqual(["secret", "variable"]);
    expect(statusKinds("ok")).toEqual(["secret", "variable"]);
    expect(statusKinds("missing")).toEqual(["secret", "variable"]);
    expect(statusKinds("expired")).toEqual(["secret"]);
    expect(statusKinds("different")).toEqual(["variable"]);
    expect(statusKinds("nonsense")).toEqual([]);
    for (const s of SECRET_STATUSES) expect(statusKinds(s)).toContain("secret");
    for (const s of VARIABLE_STATUSES) expect(statusKinds(s)).toContain("variable");
  });
  it("matches secrets by expiry state and variables by comparison state", () => {
    expect(secretMatches(secret({ status: "missing" }), { ...none, status: "missing" })).toBe(true);
    expect(secretMatches(secret({ status: "ok" }), { ...none, status: "missing" })).toBe(false);
    const drifts = { v1: [{ state: "missing" }, { state: "in-sync" }], v2: [{ state: "in-sync" }] };
    expect(variableMatches(variable({ id: "v1" }), { ...none, status: "missing" }, drifts)).toBe(true);
    expect(variableMatches(variable({ id: "v2" }), { ...none, status: "ok" }, drifts)).toBe(true);
    expect(variableMatches(variable({ id: "v1" }), { ...none, status: "ok" }, drifts)).toBe(false);
    expect(variableMatches(variable({ id: "v3" }), { ...none, status: "missing" }, drifts)).toBe(false);
    expect(variableMatches(variable({ id: "v3" }), { ...none, status: "not-compared" }, drifts)).toBe(true);
  });
  it("asks for a comparison only where the status needs one", () => {
    expect(needsComparison("")).toBe(false);
    expect(needsComparison("not-compared")).toBe(false);
    expect(needsComparison("expired")).toBe(false);
    expect(needsComparison("missing")).toBe(true);
    expect(needsComparison("ok")).toBe(true);
  });
});

describe("filters that exist for one kind only are never applied silently", () => {
  it("a secret-only status hides variables and says so", () => {
    const f = { ...none, status: "expired" };
    expect(activeKinds(f)).toEqual(["secret"]);
    expect(narrowingFilters(f, "variable")).toEqual(["status"]);
    expect(narrowingFilters(f, "secret")).toEqual([]);
  });
  it("provider and parameter filters narrow to secrets under 'all'", () => {
    const f = { ...none, provider: "auto", params: "missing" };
    expect(activeKinds(f)).toEqual(["secret"]);
    expect(narrowingFilters(f, "variable")).toEqual(["provider", "params"]);
  });
  it("with kind=variable the secret-only filters are dropped, not applied", () => {
    const f = { ...none, kind: "variable" as const, provider: "auto", params: "missing" };
    expect(effectiveFilters(f)).toMatchObject({ provider: "", params: "" });
    expect(narrowingFilters(f, "variable")).toEqual([]);
    expect(activeKinds(effectiveFilters(f))).toEqual(["variable"]);
  });
  it("a status of the other kind under an explicit kind leaves nothing and is reported", () => {
    const f = { ...none, kind: "secret" as const, status: "different" };
    expect(activeKinds(f)).toEqual([]);
    expect(narrowingFilters(f, "secret")).toEqual(["status"]);
  });
  it("provider filter distinguishes automatic and manual secrets", () => {
    expect(secretMatches(secret({ automatic: true }), { ...none, provider: "auto" })).toBe(true);
    expect(secretMatches(secret({ automatic: true }), { ...none, provider: "manual" })).toBe(false);
    expect(secretMatches(secret({ automatic: false }), { ...none, provider: "manual" })).toBe(true);
  });
  it("parameter filter keeps secrets that miss parameters", () => {
    const miss = secret({ params: { status: "missing", missing: ["account"] } });
    expect(secretMatches(miss, { ...none, params: "missing" })).toBe(true);
    expect(secretMatches(secret(), { ...none, params: "missing" })).toBe(false);
  });
});

describe("search and palette find both kinds", () => {
  const sec = secret({ id: "stripe-key", name: "STRIPE_KEY", places: [{ repo: "web", scope: "repository" }] as never });
  const vari = variable({ id: "stripe-mode", name: "STRIPE_MODE", places: [{ repo: "web", scope: "repository" }] as never });
  it("the page search matches names of each kind", () => {
    expect(filterBySearch([sec], "STRIPE").map((x) => x.id)).toEqual(["stripe-key"]);
    expect(filterBySearch([vari], "STRIPE").map((x) => x.id)).toEqual(["stripe-mode"]);
  });
  const docs = buildIndex({ secrets: [sec as never], variables: [vari as never], repos: [{ name: "web", secrets: 1, variables: 1 }], stages: [], connections: [], providers: [{ id: "random-hex", label: "Random hex" }], t: (k) => k });
  it("the palette finds a secret and a variable and links them to the combined page", () => {
    const hits = search(docs, "stripe").map((h) => h.doc);
    const s = hits.find((d) => d.id === "secret:stripe-key")!;
    const v = hits.find((d) => d.id === "variable:stripe-mode")!;
    expect(s.href).toBe("/secrets/stripe-key");
    expect(v.href).toBe("/entries?kind=variable&q=stripe-mode");
  });
  it("pages, actions and repository links point to /entries", () => {
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get("page:entries")!.href).toBe("/entries");
    expect(byId.get("action:new-secret")!.href).toBe("/entries?new=secret");
    expect(byId.get("action:new-variable")!.href).toBe("/entries?new=variable");
    expect(byId.get("repo:web")!.href).toBe("/entries?repo=web");
    expect(docs.some((d) => d.href === "/secrets" || d.href === "/variables" || d.href.startsWith("/secrets?") || d.href.startsWith("/variables?"))).toBe(false);
    // searching for either old page name still finds the combined page
    for (const q of ["secrets", "variablen"]) expect(search(docs, q).some((h) => h.doc.id === "page:entries")).toBe(true);
  });
});

describe("no value and no token in the list", () => {
  const page = readFileSync(join(__dirname, "../src/app/entries/page.tsx"), "utf8");
  it("the secret row shows metadata only", () => {
    const row = page.slice(page.indexOf("function SecretRowView"), page.indexOf("function VariableRowView"));
    for (const bad of ["reveal(", "token", "notes", ".link", "guide", "connection"]) expect(row).not.toContain(bad);
  });
  it("the view types behind the list carry no secret value field", () => {
    const keys = Object.keys(secret());
    expect(keys.some((k) => /value|token|secret$/i.test(k))).toBe(false);
  });
  it("the list never reaches for the secret guard bypass", () => {
    expect(page).not.toContain("acknowledgedPublic");
    expect(page).not.toContain("reveal");
  });
});

describe("navigation", () => {
  it("has one entry for both kinds and no old list links", () => {
    const shell = readFileSync(join(__dirname, "../src/components/Shell.tsx"), "utf8");
    expect(shell).toContain('href: "/entries"');
    expect(shell).not.toContain('href: "/secrets"');
    expect(shell).not.toContain('href: "/variables"');
    expect(messages.de["common.nav.entries"]).toBe("Secrets und Variablen");
    expect(messages.en["common.nav.entries"]).toBe("Secrets and variables");
  });
});

describe("status list (?status=soon,due)", () => {
  it("parses a single value exactly as before and an empty one as no filter", () => {
    expect(parseStatusList("soon")).toEqual({ mode: "list", statuses: ["soon"] });
    expect(parseStatusList("nonsense")).toEqual({ mode: "list", statuses: ["nonsense"] });
    for (const v of ["", null, undefined]) expect(parseStatusList(v)).toEqual({ mode: "none" });
  });

  it("splits a list, drops unknown tokens, blanks and duplicates", () => {
    expect(parseStatusList("soon,due")).toEqual({ mode: "list", statuses: ["soon", "due"] });
    expect(parseStatusList(" soon , bogus,,due,soon")).toEqual({ mode: "list", statuses: ["soon", "due"] });
    expect(parseStatusList("soon,foo")).toEqual({ mode: "list", statuses: ["soon"] });
  });

  it("a non-empty list without any valid token is invalid, not 'no filter'", () => {
    for (const v of ["foo,bar", ",", "foo,", "bogus,"]) expect(parseStatusList(v)).toEqual({ mode: "invalid" });
  });

  it("an invalid status list matches nothing, like a single unknown value", () => {
    for (const status of ["foo,bar", ",", "foo,", "foo"]) {
      const f = { ...none, status };
      expect(secretMatches(secret({ status: "ok" }), f)).toBe(false);
      expect(variableMatches(variable(), f, { v1: [{ state: "in-sync" }] })).toBe(false);
      expect(statusKinds(status)).toEqual([]);
      expect(needsComparison(status)).toBe(false);
    }
    expect(isStatusCombination("foo,bar", SOON_OR_DUE)).toBe(false);
    expect(statusKinds("soon,foo")).toEqual(["secret"]);
    expect(secretMatches(secret({ status: "soon" }), { ...none, status: "soon,foo" })).toBe(true);
  });

  it("recognises a combination in any order", () => {
    expect(isStatusCombination("due,soon", SOON_OR_DUE)).toBe(true);
    expect(isStatusCombination("soon,due", SOON_OR_DUE)).toBe(true);
    expect(isStatusCombination("soon", SOON_OR_DUE)).toBe(false);
    expect(isStatusCombination("soon,expired", SOON_OR_DUE)).toBe(false);
    expect(isStatusCombination("", SOON_OR_DUE)).toBe(false);
  });

  it("filters secrets by any status of the list", () => {
    const f = { ...none, status: "soon,due" };
    expect(secretMatches(secret({ status: "soon" }), f)).toBe(true);
    expect(secretMatches(secret({ status: "due" }), f)).toBe(true);
    expect(secretMatches(secret({ status: "ok" }), f)).toBe(false);
    expect(secretMatches(secret({ status: "ok" }), { ...none, status: "bogus," })).toBe(false);
  });

  it("filters variables by any state of the list and maps ok to in-sync", () => {
    const drifts = { v1: [{ state: "different" }], v2: [{ state: "in-sync" }] };
    const f = { ...none, status: "ok,different" };
    expect(variableMatches(variable({ id: "v1" }), f, drifts)).toBe(true);
    expect(variableMatches(variable({ id: "v2" }), f, drifts)).toBe(true);
    expect(variableMatches(variable({ id: "v3" }), f, drifts)).toBe(false);
  });

  it("derives the kinds and the comparison need from the whole list", () => {
    expect(statusKinds("soon,due")).toEqual(["secret"]);
    expect(statusKinds("soon,different")).toEqual(["secret", "variable"]);
    expect(statusKinds("bogus,")).toEqual([]);
    expect(needsComparison("soon,due")).toBe(false);
    expect(needsComparison("soon,different")).toBe(true);
    expect(needsComparison("not-compared,expired")).toBe(false);
  });

  it("hides variables for the soon-or-due combination and says so", () => {
    const f = { ...none, status: SOON_OR_DUE };
    expect(activeKinds(f)).toEqual(["secret"]);
    expect(narrowingFilters(f, "variable")).toEqual(["status"]);
  });
});
