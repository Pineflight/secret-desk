import { afterEach, describe, expect, it, vi } from "vitest";
import { groupItems, sortItems, type Browsable } from "../src/lib/browse";
import { ageParts, browserReadiness, newestCheck } from "../src/lib/browser-ready";
import { activityReducer, emptyActivity, isLineBusy } from "../src/lib/card-activity";
import { collapsedMeta } from "../src/lib/card-collapsed";
import { readExpanded } from "../src/lib/card-state";
import { adoptCandidates, filterRows, COMPARE_FILTERS_DEFAULT, needFiles, stageTotals, suggestId, toMarkdown, viewRows, type CompareResult, type MarkdownText, type ViewRow } from "../src/lib/compare-view";
import { NAMES, SOURCE_KEYS, connectionLabel, labelOf, signInHeadingKey, signInSentence } from "../src/lib/connections-shared";
import { effectiveFilters, variableMatches, type EntryFilters } from "../src/lib/entries-list";
import { inputsBody, inputsValid, type FacadeInput } from "../src/lib/facade";
import { formatDate, formatDateTime, placeText } from "../src/lib/format";
import type { ProviderCard } from "../src/lib/provider-cards";

afterEach(() => vi.unstubAllGlobals());

const item = (id: string, over: Partial<Browsable> = {}): Browsable => ({ id, name: id, stage: "staging", places: [], ...over });
const repo = (r: string) => ({ repo: r, scope: "repository" as const });

describe("browse ordering", () => {
  it("sorts by expiry with undated entries last, ties by name", () => {
    const out = sortItems([item("b"), item("a"), item("c", { daysLeft: 2 }), item("d", { daysLeft: 2 })], "expires");
    expect(out.map((i) => i.id)).toEqual(["c", "d", "a", "b"]);
  });
  it("sorts by first repo with repo-less entries first, then by name", () => {
    const out = sortItems([item("z"), item("y", { places: [repo("b")] }), item("x", { places: [repo("a")] }), item("w", { places: [repo("a")] })], "repo");
    expect(out.map((i) => i.id)).toEqual(["z", "w", "x", "y"]);
    expect(sortItems([item("q"), item("p")], "repo").map((i) => i.id)).toEqual(["p", "q"]);
  });
  it("sorts by name for any other key", () => {
    expect(sortItems([item("b"), item("a")], "name").map((i) => i.id)).toEqual(["a", "b"]);
  });
  it("groups by stage with default labels and puts the empty repo group last", () => {
    const groups = groupItems([item("a", { stage: "production" }), item("b", { stage: "staging" })], "stage");
    expect(groups.map((g) => g.label)).toEqual(["production", "staging"]);
    const byRepo = groupItems([item("a"), item("b", { places: [repo("r2")] }), item("c", { places: [repo("r1")] })], "repo");
    expect(byRepo.map((g) => g.key)).toEqual(["r1", "r2", ""]);
    const lone = groupItems([item("a"), item("b", { places: [repo("r1")] })], "repo");
    expect(lone.map((g) => g.key)).toEqual(["r1", ""]);
  });
});

describe("browser readiness edge cases", () => {
  const at = new Date("2026-11-04T10:00:00Z");
  it("ignores checks with an unreadable time and answers unknown", () => {
    const bad = { host: "h", signedIn: true, checkedAt: "garbage" };
    expect(newestCheck([bad], ["h"])).toBeUndefined();
    expect(browserReadiness(bad, at)).toMatchObject({ state: "unknown" });
  });
  it("falls back to the default age for a non-positive limit", () => {
    const check = { host: "h", signedIn: true, checkedAt: "2026-11-04T09:00:00Z" };
    expect(browserReadiness(check, at, 0).state).toBe("ready");
    expect(browserReadiness(check, at, Number.NaN).state).toBe("ready");
  });
  it("formats ages in minutes, hours and days", () => {
    expect(ageParts(0.5)).toEqual({ unit: "now", count: 0 });
    expect(ageParts(90)).toEqual({ unit: "hours", count: 1 });
    expect(ageParts(60 * 50)).toEqual({ unit: "days", count: 2 });
  });
});

describe("card activity", () => {
  it("only reports a line busy for the same card and line", () => {
    const s = activityReducer(emptyActivity(), { type: "start", key: { card: "a", kind: "test", line: "k1" } });
    expect(isLineBusy(s, "a", "k1")).toBe(true);
    expect(isLineBusy(s, "a", "k2")).toBe(false);
    expect(isLineBusy(s, "a")).toBe(false);
    expect(isLineBusy(s, "b", "k1")).toBe(false);
    const whole = activityReducer(emptyActivity(), { type: "start", key: { card: "a", kind: "test" } });
    expect(isLineBusy(whole, "a")).toBe(true);
  });
});

const key = (daysLeft: number | null, expires: string | null = null) => ({ id: "k", label: "K", connected: true, role: "primary" as const, daysLeft, expires, level: daysLeft === null ? null : daysLeft < 0 ? ("expired" as const) : daysLeft < 7 ? ("critical" as const) : daysLeft <= 14 ? ("soon" as const) : ("ok" as const) });
const card = (rest: Partial<ProviderCard> = {}): ProviderCard => ({
  id: "acme", label: "Acme", category: "other", icon: null, custom: false, status: "connected",
  signIn: { state: "facade", facade: null, recipes: [], available: true }, keys: [key(85, "2027-01-28")], byHand: [], prefixes: [],
  browser: null, worksWithoutBrowser: false, browserSignedIn: false, produces: [], secrets: 2, variables: 8, ...rest,
});
const NOW = new Date("2026-11-04T10:00:00Z");

describe("collapsed meta edge cases", () => {
  it("a failed sign-in answer on a card without API connection needs sign-in", () => {
    expect(collapsedMeta(card({ status: "none", secrets: 0, keys: [] }), { signIn: "no", now: NOW })).toMatchObject({ kind: "signin-needed" });
  });
  it("derives the expiry day from the days left when the key has no date", () => {
    expect(collapsedMeta(card({ keys: [key(10, null)] }), { signIn: null, now: NOW })).toMatchObject({ kind: "expiry", date: "2026-11-14", days: 10 });
  });
  it("says nothing for an unused card without secrets", () => {
    expect(collapsedMeta(card({ status: "none", secrets: 0, keys: [] }), { signIn: null, now: NOW })).toBeNull();
  });
  it("names a single missing connection without a count", () => {
    const off = { ...key(null), id: "grafana", label: "Grafana", connected: false };
    expect(collapsedMeta(card({ keys: [key(85), off], secrets: 0 }), { signIn: null, now: NOW })).toMatchObject({ key: "providers.meta.missingKey", vars: { connection: "grafana", count: 0 } });
  });
  it("counts further accounts that lack a mode", () => {
    const acct = (a: string) => ({ ...key(85, "2027-01-28"), id: `stripe:${a}:sandbox`, label: `Stripe ${a} (sandbox)` });
    const m = collapsedMeta(card({ id: "stripe", prefixes: ["stripe:"], keys: [acct("acct_1"), acct("acct_2")], secrets: 0 }), { signIn: null, now: NOW });
    expect(m).toMatchObject({ key: "providers.meta.missingModeMore", vars: { account: "Stripe acct_1", mode: "live", count: 1 } });
  });
});

describe("card state without a window", () => {
  it("reads an empty set when there is no browser storage", () => {
    expect(readExpanded().size).toBe(0);
  });
  it("reads the stored set from window.localStorage", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => '["card:a"]' } });
    expect([...readExpanded()]).toEqual(["card:a"]);
  });
  it("treats blocked storage as empty", () => {
    vi.stubGlobal("window", { get localStorage(): never { throw new Error("blocked"); } });
    expect(readExpanded().size).toBe(0);
  });
});

describe("compare view edge cases", () => {
  const cell = (state: string, extra: Record<string, unknown> = {}) => ({ state, expected: true, present: true, ...extra }) as never;
  const row = (over: Record<string, unknown> = {}) => ({ repo: "web", name: "A_KEY", kind: "secret", ids: [], cells: { staging: cell("ok") }, parity: "n/a", missingIn: [], tags: [], deviation: true, ...over }) as unknown as ViewRow;

  it("searches names, product and tags of a row", () => {
    const rows = viewRows({ live: false, rows: [row({ names: ["ALIAS_NAME"], product: "Stripe", ids: ["id-1"], tags: ["pay"] }) as never] } as Pick<CompareResult, "rows" | "live">, ["staging"]);
    for (const q of ["alias_name", "stripe", "id-1"]) expect(filterRows(rows, { ...COMPARE_FILTERS_DEFAULT, q })).toHaveLength(1);
    expect(filterRows(rows, { ...COMPARE_FILTERS_DEFAULT, q: "nothing-like-this" })).toHaveLength(0);
  });
  it("lists no files for a row without needs", () => {
    expect(needFiles({})).toEqual([]);
  });
  it("marks a missing stage cell with a dash in the markdown table", () => {
    const text: MarkdownText = { repo: "Repo", name: "Name", kind: "Kind", parity: "Parity", cell: () => "ok", kindText: () => "secret", parityText: () => "gap", stageLabel: (id) => id };
    expect(toMarkdown([row()], ["staging", "production"], text).split("\n")[2]).toBe("| web | A_KEY | secret | ok | – | gap |");
  });
  it("skips stages a row has no cell for in the totals", () => {
    expect(stageTotals([row()], ["production"])["production"]).toMatchObject({ expected: 0, present: 0 });
  });
  it("falls back to a fixed id when the suggestion has no usable characters", () => {
    expect(suggestId("--", "__", "!!", new Set())).toBe("eintrag");
  });
  it("adopts a needed cell without details under the row name", () => {
    const out = adoptCandidates([{ repo: "web", name: "A_KEY", kind: "secret", ids: [], cells: { staging: { state: "needed", expected: false } } } as never]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "A_KEY", files: [], invalidName: false });
  });
});

describe("connections shared", () => {
  const conn = (over: Record<string, unknown>) => ({ id: "github", label: "", ...over }) as never;
  it("names vendors and sources", () => {
    expect(NAMES["github"]).toBe("GitHub");
    expect(SOURCE_KEYS["session"]).toBe("connections.srcSession");
  });
  it("labels a connection by label, known name or id", () => {
    expect(labelOf(conn({ label: "Mine" }))).toBe("Mine");
    expect(labelOf(conn({}))).toBe("GitHub");
    expect(labelOf(conn({ id: "unknown-id" }))).toBe("unknown-id");
  });
  it("picks the sign-in sentence for facade, recipe and coming soon", () => {
    const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${v["name"]}` : k);
    const facade = (id: string | null) => card({ signIn: { state: "facade", facade: id ? ({ id } as never) : null, recipes: [], available: true } });
    expect(signInSentence(facade("stripe"), t)).toBe("providers.signIn.facadeScoped");
    expect(signInSentence(facade("grafana"), t)).toBe("providers.signIn.facadeGrafana");
    expect(signInSentence(facade(null), t)).toBe("providers.signIn.facade");
    expect(signInSentence(card({ signIn: { state: "recipe", facade: null, recipes: [], available: true } }), t)).toBe("providers.signIn.recipe:Acme");
    expect(signInSentence(card({ signIn: { state: "recipe", facade: null, recipes: [], available: false } }), t)).toBe("providers.signIn.recipeOff:Acme");
    expect(signInSentence(card({ signIn: { state: "coming" } as never }), t)).toBe("providers.signIn.coming:Acme");
  });
  it("labels a connection for display", () => {
    const t = (k: string) => `T(${k})`;
    expect(connectionLabel({ id: "github", label: "Custom" }, t)).toBe("Custom");
    expect(connectionLabel({ id: "github", label: "github" }, t)).toBe("T(connectionName.github)");
    expect(connectionLabel({ id: "stripe", label: "" }, t)).toBe("T(connectionName.stripeLegacy)");
    expect(connectionLabel({ id: "nothing-known", label: "" }, t)).toBe("nothing-known");
    expect(connectionLabel({ id: "github-app", label: "" }, t)).toBe("github-app");
  });
  it("picks the sign-in heading by facade", () => {
    expect(signInHeadingKey({ signIn: { state: "facade" } } as never)).toBe("providers.way.signInFacade");
    expect(signInHeadingKey({ signIn: { state: "recipe" } } as never)).toBe("providers.way.signInRecipe");
  });
});

describe("entries list edge cases", () => {
  const none: EntryFilters = { kind: "", status: "", provider: "", params: "" };
  it("keeps secret-only filters unless the kind is variable", () => {
    const f = { ...none, kind: "secret" as const, provider: "auto" };
    expect(effectiveFilters(f)).toBe(f);
    expect(effectiveFilters({ ...f, kind: "variable" })).toMatchObject({ provider: "", params: "" });
  });
  it("matches every variable when no status filter is set", () => {
    expect(variableMatches({ id: "v" } as never, none, {})).toBe(true);
  });
});

describe("facade inputs", () => {
  const input = (over: Partial<FacadeInput>): FacadeInput => ({ param: "p", label: "P", labelEn: "P", options: null, pattern: null, help: null, ...over });
  it("rejects values outside the options or the pattern", () => {
    expect(inputsValid([input({ options: ["a", "b"] })], { p: "c" })).toBe(false);
    expect(inputsValid([input({ options: ["a", "b"] })], { p: " a " })).toBe(true);
    expect(inputsValid([input({ pattern: "^[0-9]+$" })], { p: "x1" })).toBe(false);
    expect(inputsValid([input({ pattern: "^[0-9]+$" })], { p: "12" })).toBe(true);
  });
  it("sends trimmed values and empty strings for missing ones", () => {
    expect(inputsBody([input({ param: "a" }), input({ param: "b" })], { a: " x " })).toEqual({ a: "x", b: "" });
  });
});

describe("format edge cases", () => {
  it("formats date-times in local time and falls back for unreadable ones", () => {
    expect(formatDateTime("2026-11-04T09:05:00")).toBe("04.11.2026, 09:05");
    expect(formatDateTime("garbage")).toBe("–");
    expect(formatDateTime(null)).toBe("–");
    expect(formatDate("2026-11-04T09:05:00")).toBe("04.11.2026");
    expect(formatDate("garbage")).toBe("–");
    expect(formatDate(null)).toBe("–");
  });
  it("describes places without optional names", () => {
    expect(placeText({ scope: "cloudflare-worker" })).toBe(" / Cloudflare Worker");
    expect(placeText({ scope: "repository" })).toBe(" / Repository");
    expect(placeText({ scope: "environment" })).toBe(" / Umgebung");
    expect(placeText({ scope: "environment", repo: "r", environment: "prod" })).toBe("r / prod");
    expect(placeText({ scope: "organization", repo: "o" })).toBe("o / Organisation");
  });
});
