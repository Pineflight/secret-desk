import type { StageView } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { groupItems, sortItems, type Browsable } from "../src/lib/browse";
import { rowsToPlaces } from "../src/lib/places";
import { defaultEnvironment, newDraft, toDrafts, toPayload, usageTotal, validateDrafts } from "../src/lib/stage-draft";
import { FALLBACK_STAGES, defaultStageId, environmentOf, kindOf, labelOf, slugifyStage, stageLook, stageOrder, toneOf, type StageDefLite } from "../src/lib/stages";
import { stageInfo } from "../src/lib/status";

const DEFS: StageDefLite[] = [
  { id: "lokal", kind: "dev" },
  { id: "abnahme", kind: "test", label: "Abnahme", tone: "warn" },
  { id: "eu-prod", kind: "live", environmentName: "production-eu" },
  { id: "alle", kind: "shared" },
  { id: "qa", kind: "test" },
];

describe("Stage-Definitionen im UI", () => {
  it("Reihenfolge: live, test, dev, shared; innerhalb einer Art wie definiert", () => {
    expect(stageOrder(DEFS)).toEqual(["eu-prod", "abnahme", "qa", "lokal", "alle"]);
    expect(stageOrder(FALLBACK_STAGES)).toEqual(["production", "staging", "dev", "shared"]);
  });
  it("Anzeigename, Art, Farbe und Environment kommen aus den Definitionen", () => {
    expect(labelOf(DEFS, "abnahme")).toBe("Abnahme");
    expect(labelOf(DEFS, "qa")).toBe("qa");
    expect(kindOf(DEFS, "eu-prod")).toBe("live");
    expect(kindOf(DEFS, "gibt-es-nicht")).toBe("live");
    expect(toneOf(DEFS, "abnahme")).toBe("warn");
    expect(toneOf(DEFS, "qa")).toBe("ki");
    expect(toneOf(DEFS, "eu-prod")).toBe("stage-prod");
    expect(toneOf(DEFS, "lokal")).toBe("info");
    expect(toneOf(DEFS, "alle")).toBe("neutral");
    expect(environmentOf(DEFS, "eu-prod")).toBe("production-eu");
    expect(environmentOf(DEFS, "qa")).toBe("qa");
    expect(environmentOf(DEFS, "lokal")).toBeNull();
    expect(stageLook(DEFS, "eu-prod")).toEqual({ label: "eu-prod", tone: "stage-prod", icon: "shield" });
    expect(stageInfo("abnahme", DEFS)).toEqual({ label: "Abnahme", tone: "warn", icon: "dot" });
    expect(stageInfo("production")).toMatchObject({ tone: "stage-prod" });
  });
  it("Standard-Stage fuer neue Eintraege nach Art", () => {
    expect(defaultStageId(DEFS, "test")).toBe("abnahme");
    expect(defaultStageId(DEFS, "dev")).toBe("lokal");
    expect(slugifyStage("Abnahme Süd 2")).toBe("abnahme-sued-2");
  });
  it("sortieren und gruppieren nach Stage folgen den Definitionen", () => {
    const item = (id: string, stage: string): Browsable => ({ id, name: id, stage, places: [] });
    const items = [item("a", "lokal"), item("b", "qa"), item("c", "eu-prod"), item("d", "abnahme")];
    expect(sortItems(items, "stage", stageOrder(DEFS)).map((i) => i.id)).toEqual(["c", "d", "b", "a"]);
    const g = groupItems(items, "stage", stageOrder(DEFS), (id) => labelOf(DEFS, id));
    expect(g.map((x) => x.label)).toEqual(["eu-prod", "Abnahme", "qa", "lokal"]);
  });
});

describe("Ziele mit Stage", () => {
  it("leerer Umgebungsname = Environment der Stage, der Server setzt sie ein", () => {
    const rows = [{ repo: "r", scope: "environment" as const, environment: "" }];
    expect(rowsToPlaces(rows, { stage: "qa", environment: "qa" }).places).toEqual([{ repo: "r", scope: "environment" }]);
    expect(rowsToPlaces(rows, { stage: "lokal", environment: null }).error).toMatch(/lokal/);
    expect(rowsToPlaces([{ repo: "r", scope: "environment", environment: "x" }], { stage: "lokal", environment: null }).places).toEqual([{ repo: "r", scope: "environment", environment: "x" }]);
  });
});

describe("Einstellungen: Entwurf", () => {
  const view = (extra: Partial<StageView> & Pick<StageView, "id" | "kind">): StageView => ({ environmentName: null, usage: { secrets: 0, variables: 0, templates: 0, policy: false }, ...extra });
  it("Roundtrip zwischen Anzeige und Nutzlast", () => {
    const drafts = toDrafts([view({ id: "dev", kind: "dev", environment: null }), view({ id: "qa", kind: "test", label: "QA", tone: "warn", environment: "qa-eu" }), view({ id: "x", kind: "live" })]);
    expect(drafts.map((d) => [d.noEnvironment, d.environment])).toEqual([[true, ""], [false, "qa-eu"], [false, ""]]);
    expect(toPayload(drafts)).toEqual([{ id: "dev", kind: "dev", environment: null }, { id: "qa", kind: "test", label: "QA", environment: "qa-eu", tone: "warn" }, { id: "x", kind: "live" }]);
  });
  it("Pruefung vor dem Speichern", () => {
    const ok = { ...newDraft(), id: "a" };
    expect(validateDrafts([])).toEqual({ code: "empty" });
    expect(validateDrafts([ok])).toBeNull();
    expect(validateDrafts([ok, { ...ok }])).toEqual({ code: "duplicate", id: "a" });
    expect(validateDrafts([{ ...ok, id: "Gross" }])).toEqual({ code: "id", row: 0 });
    expect(validateDrafts(Array.from({ length: 13 }, (_, i) => ({ ...ok, id: `s${i}` })))).toEqual({ code: "max" });
  });
  it("Standard-Environment und Nutzung", () => {
    expect(defaultEnvironment({ id: "qa", kind: "test" })).toBe("qa");
    expect(defaultEnvironment({ id: "qa", kind: "shared" })).toBeNull();
    expect(usageTotal({ secrets: 1, variables: 0, templates: 0, policy: false })).toBe(1);
    expect(usageTotal({ secrets: 0, variables: 0, templates: 0, policy: true })).toBe(1);
  });
});
