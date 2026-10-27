import { describe, expect, it } from "vitest";
import { summaryInfo } from "../src/lib/status";
import { DRIFT_FILTERS, anyCompared, countDrift, filterByDrift, progressText, shortValue, summarizeDrift } from "../src/lib/variable-list";

const d = (...states: string[]) => states.map((state) => ({ state }));

describe("variable-list", () => {
  it("fasst den Abgleich zusammen, schlechtester Zustand gewinnt", () => {
    expect(summarizeDrift(undefined)).toBe("not-compared");
    expect(summarizeDrift(null)).toBe("not-compared");
    expect(summarizeDrift([])).toBe("not-compared");
    expect(summarizeDrift(d("in-sync", "in-sync"))).toBe("in-sync");
    expect(summarizeDrift(d("in-sync", "different"))).toBe("different");
    expect(summarizeDrift(d("different", "missing"))).toBe("missing");
    expect(summarizeDrift(d("missing", "unreachable", "in-sync"))).toBe("unreachable");
    expect(summarizeDrift(d("in-sync", "unknown-expected"))).toBe("unknown-expected");
  });
  it("zaehlt Zustaende", () => {
    expect(countDrift(d("in-sync", "different", "different"))).toEqual({ "in-sync": 1, different: 2 });
    expect(countDrift(undefined)).toEqual({});
  });
  it("filtert nach Abgleichstatus", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const drifts = { a: d("in-sync"), b: d("different") };
    expect(filterByDrift(items, drifts, "").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(filterByDrift(items, drifts, "in-sync").map((i) => i.id)).toEqual(["a"]);
    expect(filterByDrift(items, drifts, "different").map((i) => i.id)).toEqual(["b"]);
    expect(filterByDrift(items, drifts, "not-compared").map((i) => i.id)).toEqual(["c"]);
    expect(DRIFT_FILTERS).toContain("unreachable");
  });
  it("erkennt, ob schon verglichen wurde", () => {
    expect(anyCompared({})).toBe(false);
    expect(anyCompared({ a: [] })).toBe(false);
    expect(anyCompared({ a: d("in-sync") })).toBe(true);
    expect(anyCompared({ a: d("in-sync") }, ["b"])).toBe(false);
  });
  it("kuerzt den Sollwert", () => {
    expect(shortValue(null)).toBe("");
    expect(shortValue("https://acme.example")).toBe("https://acme.example");
    expect(shortValue("a\n  b")).toBe("a b");
    expect(shortValue("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
  it("Badge-Info der Zusammenfassung", () => {
    expect(summaryInfo("not-compared").label).toBe("Nicht verglichen");
    expect(summaryInfo("in-sync").tone).toBe("success");
    expect(summaryInfo("unreachable").tone).toBe("danger");
  });
  it("Fortschritt", () => {
    expect(progressText(3, 25)).toBe("3/25");
  });
});
