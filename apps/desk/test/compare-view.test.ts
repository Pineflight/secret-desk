import { describe, expect, it } from "vitest";
import { COMPARE_FILTERS_DEFAULT, adoptCandidates, adoptLink, adoptRequest, cellLook, missingOnGitHub, needFiles, reposWithoutEntries, suggestId, defaultCompared, effectiveCompared, filterRows, groupByRepo, repoList, rowParity, sortRows, stageTotals, toMarkdown, viewRows, type CompareCell, type CompareRepo, type CompareResult, type MarkdownText } from "../src/lib/compare-view";

const c = (state: CompareCell["state"], expected = false, present?: boolean): CompareCell => ({ state, expected, ...(present !== undefined ? { present } : {}) });
const NA = c("not-applicable");
const row = (repo: string, name: string, cells: Record<string, CompareCell>, over: Record<string, unknown> = {}) => ({ repo, name, kind: "secret" as const, ids: [`${name.toLowerCase()}`], cells: { dev: NA, shared: NA, ...cells }, parity: "n/a" as const, missingIn: [], tags: [], neededMissing: false, ...over });
const stages = [
  { id: "dev", label: "dev", kind: "dev" as const, environment: null },
  { id: "staging", label: "Staging", kind: "test" as const, environment: "staging" },
  { id: "production", label: "Production", kind: "live" as const, environment: "production" },
  { id: "shared", label: "shared", kind: "shared" as const, environment: null },
];
const live: CompareResult = {
  stages,
  compared: ["staging", "production"],
  live: true,
  errors: [],
  summary: { perStage: {}, gaps: 0, orphans: 0, neededMissing: 0 },
  repos: [],
  rows: [
    row("web", "A_KEY", { staging: c("ok", true, true), production: c("ok", true, true) }),
    row("web", "B_KEY", { staging: c("ok", true, true), production: c("missing", true, false) }),
    row("api", "C_VAR", { staging: c("ok", true, true), production: c("different", true, true) }, { kind: "variable", ids: ["c-var"], tags: ["pay"] }),
    row("api", "D_KEY", { staging: c("unexpected", false, true), production: c("not-expected") }),
    row("api", "E_KEY", { staging: c("error", true), production: c("ok", true, true) }),
  ],
};

describe("Stage-Auswahl", () => {
  it("Standard ist test und live, unbekannte Ids fallen weg", () => {
    expect(defaultCompared(stages)).toEqual(["staging", "production"]);
    expect(effectiveCompared(stages, [])).toEqual(["staging", "production"]);
    expect(effectiveCompared(stages, ["dev", "nope"])).toEqual(["dev"]);
    expect(effectiveCompared(stages, ["nope"])).toEqual(["staging", "production"]);
  });
});

describe("rowParity", () => {
  it("live zaehlt den Ist-Zustand, Fehler scheiden aus", () => {
    expect(rowParity(live.rows[0]!, ["staging", "production"], true)).toEqual({ parity: "consistent", missingIn: [] });
    expect(rowParity(live.rows[1]!, ["staging", "production"], true)).toEqual({ parity: "gap", missingIn: ["production"] });
    expect(rowParity(live.rows[3]!, ["staging", "production"], true)).toEqual({ parity: "gap", missingIn: ["production"] });
    expect(rowParity(live.rows[4]!, ["staging", "production"], true).parity).toBe("n/a");
  });
  it("ohne Live zaehlt die Erwartung", () => {
    const r = row("w", "X", { staging: c("unknown", true), production: c("not-expected") });
    expect(rowParity(r, ["staging", "production"], false)).toEqual({ parity: "gap", missingIn: ["production"] });
  });
  it("andere Auswahl, weniger als zwei Stages, nirgends vorhanden", () => {
    expect(rowParity(live.rows[1]!, ["staging"], true).parity).toBe("n/a");
    expect(rowParity(live.rows[1]!, ["staging", "dev"], true).parity).toBe("n/a");
    expect(rowParity(row("w", "Y", { staging: c("not-expected"), production: c("not-expected") }), ["staging", "production"], true).parity).toBe("n/a");
  });
});

describe("Filter, Abweichungen, Gruppen", () => {
  const rows = viewRows(live, ["staging", "production"]);
  it("markiert Abweichungen (Luecke oder auffaellige Zelle)", () => {
    expect(rows.map((r) => [r.name, r.deviation])).toEqual([["A_KEY", false], ["B_KEY", true], ["C_VAR", true], ["D_KEY", true], ["E_KEY", true]]);
  });
  it("Nur Abweichungen, Art, Repository, Suche", () => {
    const f = (o: Partial<typeof COMPARE_FILTERS_DEFAULT>) => filterRows(rows, { ...COMPARE_FILTERS_DEFAULT, ...o }).map((r) => r.name);
    expect(f({})).toHaveLength(5);
    expect(f({ onlyDeviations: true })).toEqual(["B_KEY", "C_VAR", "D_KEY", "E_KEY"]);
    expect(f({ kind: "variable" })).toEqual(["C_VAR"]);
    expect(f({ repo: "web" })).toEqual(["A_KEY", "B_KEY"]);
    expect(f({ q: " c_VAR " })).toEqual(["C_VAR"]);
    expect(f({ q: "pay" })).toEqual(["C_VAR"]);
    expect(f({ q: "b_key", onlyDeviations: true, repo: "api" })).toEqual([]);
  });
  it("ohne Live ist nur die Luecke eine Abweichung", () => {
    const off = viewRows({ ...live, live: false }, ["staging", "production"]);
    expect(off.filter((r) => r.deviation)).toEqual([]);
    const gap = viewRows({ ...live, live: false, rows: [row("w", "G", { staging: c("unknown", true), production: c("not-expected") })] }, ["staging", "production"]);
    expect(gap[0]).toMatchObject({ parity: "gap", deviation: true, missingIn: ["production"] });
  });
  it("Luecken zuerst und Gruppen je Repository mit Zaehlern", () => {
    const sorted = sortRows(rows, true);
    expect(sorted.map((r) => r.name)).toEqual(["D_KEY", "B_KEY", "C_VAR", "E_KEY", "A_KEY"]);
    expect(sorted[0]!.parity).toBe("gap");
    expect(sorted.at(-1)!.name).toBe("A_KEY");
    const groups = groupByRepo(sortRows(rows, false));
    expect(groups.map((g) => [g.repo, g.rows.length, g.gaps, g.deviations])).toEqual([["api", 3, 1, 3], ["web", 2, 1, 1]]);
    expect(repoList(rows)).toEqual(["api", "web"]);
  });
  it("Summen je Stage ueber sichtbare Zeilen", () => {
    const t = stageTotals(rows, ["staging", "production"]);
    expect(t.staging).toEqual({ expected: 4, present: 4, missing: 0, unexpected: 1, error: 1, needed: 0 });
    expect(t.production).toEqual({ expected: 4, present: 3, missing: 1, unexpected: 0, error: 0, needed: 0 });
  });
});

describe("Markdown und Aussehen", () => {
  const text: MarkdownText = {
    repo: "Repository",
    name: "Name",
    kind: "Art",
    parity: "Paritaet",
    cell: (x) => x.state,
    kindText: (k) => (k === "secret" ? "Secret" : "Variable"),
    parityText: (r) => (r.parity === "gap" ? `fehlt in ${r.missingIn.join(", ")}` : r.parity),
    stageLabel: (id) => id.toUpperCase(),
  };
  it("exportiert nur Abweichungen, maskiert Pipes", () => {
    const rows = viewRows(live, ["staging", "production"]);
    const md = toMarkdown(rows, ["staging", "production"], text).split("\n");
    expect(md[0]).toBe("| Repository | Name | Art | STAGING | PRODUCTION | Paritaet |");
    expect(md[1]).toBe("| --- | --- | --- | --- | --- | --- |");
    expect(md).toContain("| web | B_KEY | Secret | ok | missing | fehlt in production |");
    expect(md).toContain("| api | C_VAR | Variable | ok | different | consistent |");
    expect(md.some((l) => l.includes("A_KEY"))).toBe(false);
    const piped = viewRows({ ...live, rows: [row("w", "P|Q", { staging: c("ok", true, true), production: c("missing", true, false) })] }, ["staging", "production"]);
    expect(toMarkdown(piped, ["staging"], text)).toContain("P\\|Q");
  });
  it("jeder Zustand hat ein Aussehen, leere Zellen sind still", () => {
    expect(cellLook("ok")).toMatchObject({ tone: "success", icon: "check", quiet: false });
    expect(cellLook("missing").tone).toBe("danger");
    expect(cellLook("unexpected").tone).toBe("warn");
    expect(cellLook("not-expected").quiet).toBe(true);
    expect(cellLook("not-applicable").quiet).toBe(true);
    expect(cellLook("bogus" as never).quiet).toBe(true);
  });
});

const repoInfo = (name: string, over: Partial<CompareRepo> = {}): CompareRepo => ({ name, inInventory: false, private: true, archived: false, pushedAt: "2026-10-01T10:00:00Z", onGitHub: true, found: { secrets: 0, variables: 0 }, needed: 0, notes: [], ...over });

describe("Repositories ohne Eintraege und umbenannte", () => {
  const repos = [
    repoInfo("costs"),
    repoInfo("night-before-landingpage", { found: { secrets: 0, variables: 0 }, needed: 3 }),
    repoInfo("status", { found: { secrets: 1, variables: 0 } }),
    repoInfo("web", { inInventory: true }),
    repoInfo("leitfaden", { inInventory: true, onGitHub: false, renamedTo: "night-before" }),
  ];
  it("nur Repositories ohne Inventar und ohne jeden Fund", () => {
    expect(reposWithoutEntries(repos).map((r) => r.name)).toEqual(["costs"]);
    expect(reposWithoutEntries(repos, { repo: "status", q: "" })).toEqual([]);
    expect(reposWithoutEntries(repos, { repo: "", q: " CO " }).map((r) => r.name)).toEqual(["costs"]);
  });
  it("Repository-Filter listet alle Repositories, auch ohne Zeilen", () => {
    expect(repoList([{ repo: "web" }], repos)).toEqual(["costs", "leitfaden", "night-before-landingpage", "status", "web"]);
  });
  it("Inventar-Repositories, die GitHub nicht mehr kennt", () => {
    expect(missingOnGitHub(repos).map((r) => [r.name, r.renamedTo])).toEqual([["leitfaden", "night-before"]]);
  });
});

describe("Von Workflows benoetigt", () => {
  const needed = c("needed");
  const nRow = (repo: string, name: string, extra: Partial<CompareCell["detail"] & object> = {}) =>
    row(repo, name, { staging: { ...needed, detail: { ids: [], targets: [], neededBy: ["deploy.yml"], actualNames: [name], ...extra } }, production: c("not-expected") }, { ids: [], neededMissing: true, needs: [{ file: "deploy.yml", environment: "staging" }] });
  const rows = viewRows({ ...live, live: false, rows: [nRow("night-before", "RESEND_API_KEY"), row("web", "OTHER", { staging: c("unknown", true), production: c("unknown", true) })] }, ["staging", "production"]);
  it("needed ist auch ohne Live eine Abweichung und hat ein Aussehen", () => {
    expect(rows[0]).toMatchObject({ deviation: true });
    expect(rows[1]).toMatchObject({ deviation: false });
    expect(cellLook("needed")).toMatchObject({ tone: "warn-strong", quiet: false });
  });
  it("Filter: nur von Workflows benoetigt", () => {
    const f = filterRows(rows, { ...COMPARE_FILTERS_DEFAULT, onlyNeeded: true });
    expect(f.map((r) => r.name)).toEqual(["RESEND_API_KEY"]);
    expect(needFiles(f[0]!)).toEqual(["deploy.yml"]);
    expect(stageTotals(rows, ["staging"]).staging!.needed).toBe(1);
  });
  it("Kandidaten fuer die Aufnahme: Name, Repo, Stage, Dateien, eindeutige Id", () => {
    const cands = adoptCandidates(viewRows({ ...live, live: false, rows: [nRow("night-before", "RESEND_API_KEY"), nRow("night-before-landingpage", "CLOUDFLARE_API_TOKEN")] }, ["staging"]));
    expect(cands.map((x) => [x.repo, x.name, x.stage, x.files, x.id])).toEqual([
      ["night-before", "RESEND_API_KEY", "staging", ["deploy.yml"], "night-before-resend-api-key-staging"],
      ["night-before-landingpage", "CLOUDFLARE_API_TOKEN", "staging", ["deploy.yml"], "night-before-landingpage-cloudflare-api-token-staging"],
    ]);
    expect(adoptCandidates([nRow("r", "bad_name")])[0]!.invalidName).toBe(true);
    const taken = new Set(["a-x-staging"]);
    expect(suggestId("a", "X", "staging", taken)).toBe("a-x-staging-2");
  });
  it("Anfrage: nur Metadaten; Secret manuell mit unbekanntem Ablauf, Variable ohne Wert", () => {
    const base = { repo: "night-before", name: "RESEND_API_KEY", stage: "staging", id: "x" };
    const sec = adoptRequest({ ...base, kind: "secret" }, { environment: "staging", description: "Von deploy.yml benoetigt" });
    expect(sec.path).toBe("secrets");
    expect(sec.body).toMatchObject({ provider: "manual", expiry: "unknown", places: [{ repo: "night-before", scope: "environment" }] });
    expect(JSON.stringify(sec.body)).not.toContain("value");
    const v = adoptRequest({ ...base, name: "NEXT_PUBLIC_APP_URL", kind: "variable" }, { environment: null, description: "d" });
    expect(v.path).toBe("variables");
    expect(v.body).toMatchObject({ places: [{ repo: "night-before", scope: "repository" }] });
    expect(v.body).not.toHaveProperty("value");
  });
  it("Link zum Neu-Dialog mit Vorbelegung", () => {
    const link = adoptLink({ repo: "r", name: "N", kind: "secret", stage: "staging", id: "r-n", files: [] }, "Von ci.yml benoetigt");
    expect(link.startsWith("/secrets?")).toBe(true);
    const q = new URLSearchParams(link.split("?")[1]);
    expect(Object.fromEntries(q)).toEqual({ neu: "1", pf_name: "N", pf_repo: "r", pf_stage: "staging", pf_id: "r-n", pf_desc: "Von ci.yml benoetigt" });
    expect(adoptLink({ repo: "r", name: "N", kind: "variable", stage: "s", id: "i", files: [] }, "d").startsWith("/variablen?")).toBe(true);
  });
});
