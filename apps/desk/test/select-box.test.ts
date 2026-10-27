import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { filterOptions, optionsFromChildren, SEARCH_FROM } from "../src/lib/select-options";

describe("SelectBox", () => {
  const opt = (value: string, label: string) => createElement("option", { key: value, value }, label);
  it("liest Optionen aus Kindern, auch in Fragmenten und Listen", () => {
    const kids = [opt("a", "Alpha"), createElement("option", { key: "x" }, "Ohne Wert"), [opt("b", "Beta")], createElement("div", { key: "d" }, opt("c", "Gamma"))];
    expect(optionsFromChildren(kids)).toEqual([
      { value: "a", label: "Alpha" },
      { value: "Ohne Wert", label: "Ohne Wert" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ]);
  });
  it("filtert nach Label und Wert, ohne Gross-/Kleinschreibung", () => {
    const o = [{ value: "stripe-restricted-key", label: "Stripe Restricted Key" }, { value: "manual", label: "von Hand" }];
    expect(filterOptions(o, "STRIPE")).toHaveLength(1);
    expect(filterOptions(o, "hand")[0]!.value).toBe("manual");
    expect(filterOptions(o, "  ")).toHaveLength(2);
    expect(filterOptions(o, "zzz")).toHaveLength(0);
  });
  it("Suche erscheint erst bei laengeren Listen", () => expect(SEARCH_FROM).toBeGreaterThan(3));
});
