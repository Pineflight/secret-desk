import { describe, expect, it } from "vitest";
import { splitPlaceChips } from "../src/lib/place-chips";

describe("splitPlaceChips", () => {
  it("shows everything up to the limit", () => {
    expect(splitPlaceChips([])).toEqual({ shown: [], hidden: 0 });
    expect(splitPlaceChips(["a / b", "c / d"])).toEqual({ shown: ["a / b", "c / d"], hidden: 0 });
  });
  it("hides the rest behind a count", () => {
    expect(splitPlaceChips(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b"], hidden: 2 });
    expect(splitPlaceChips(["a", "b"], 1)).toEqual({ shown: ["a"], hidden: 1 });
  });
  it("never shows fewer than one chip", () => {
    expect(splitPlaceChips(["a", "b"], 0)).toEqual({ shown: ["a"], hidden: 1 });
  });
});
