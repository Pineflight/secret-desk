import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { filterOptions, optionsFromChildren, SEARCH_FROM, showSearchField, typeaheadChar } from "../src/lib/select-options";

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

describe("SelectBox type-ahead", () => {
  it("shows the search field for every list with more than one option", () => {
    expect(showSearchField(1)).toBe(false);
    expect(showSearchField(2)).toBe(true);
    expect(showSearchField(SEARCH_FROM + 5)).toBe(true);
  });
  it("lets an explicit searchable setting win", () => {
    expect(showSearchField(2, false)).toBe(false);
    expect(showSearchField(1, true)).toBe(true);
  });
  it("turns printable keys into a first query", () => {
    expect(typeaheadChar({ key: "s" })).toBe("s");
    expect(typeaheadChar({ key: "S" })).toBe("S");
    expect(typeaheadChar({ key: "ä" })).toBe("ä");
    expect(typeaheadChar({ key: "5" })).toBe("5");
  });
  it("ignores space, special keys and shortcuts", () => {
    expect(typeaheadChar({ key: " " })).toBeNull();
    expect(typeaheadChar({ key: "Enter" })).toBeNull();
    expect(typeaheadChar({ key: "ArrowDown" })).toBeNull();
    expect(typeaheadChar({ key: "Tab" })).toBeNull();
    expect(typeaheadChar({ key: "a", ctrlKey: true })).toBeNull();
    expect(typeaheadChar({ key: "a", metaKey: true })).toBeNull();
    expect(typeaheadChar({ key: "a", altKey: true })).toBeNull();
    expect(typeaheadChar({ key: "a", isComposing: true })).toBeNull();
  });
  it("the first typed character filters the options right away", () => {
    const o = [{ value: "staging", label: "Staging" }, { value: "production", label: "Produktion" }, { value: "dev", label: "Dev" }];
    expect(filterOptions(o, typeaheadChar({ key: "p" })!).map((x) => x.value)).toEqual(["production"]);
  });
});
