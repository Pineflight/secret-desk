import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { filterOptions, optionsFromChildren, SEARCH_FROM } from "../src/lib/select-options";

describe("SelectBox", () => {
  const opt = (value: string, label: string) => createElement("option", { key: value, value }, label);
  it("reads options from children, also in fragments and lists", () => {
    const kids = [opt("a", "Alpha"), createElement("option", { key: "x" }, "Ohne Wert"), [opt("b", "Beta")], createElement("div", { key: "d" }, opt("c", "Gamma"))];
    expect(optionsFromChildren(kids)).toEqual([
      { value: "a", label: "Alpha" },
      { value: "Ohne Wert", label: "Ohne Wert" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ]);
  });
  it("filters by label and value, case-insensitively", () => {
    const o = [{ value: "stripe-restricted-key", label: "Stripe Restricted Key" }, { value: "manual", label: "von Hand" }];
    expect(filterOptions(o, "STRIPE")).toHaveLength(1);
    expect(filterOptions(o, "hand")[0]!.value).toBe("manual");
    expect(filterOptions(o, "  ")).toHaveLength(2);
    expect(filterOptions(o, "zzz")).toHaveLength(0);
  });
  it("search appears only for longer lists", () => expect(SEARCH_FROM).toBeGreaterThan(3));
});
