import { describe, expect, it } from "vitest";
import { chipTiers, splitPlaceChips } from "../src/lib/place-chips";

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

describe("chipTiers", () => {
  const tags = ["auth", "billing", "deploy", "cloudflare", "signing"];
  it("builds one split per allowed count, ascending", () => {
    const tiers = chipTiers(tags);
    expect(tiers.map((x) => x.shown.length)).toEqual([1, 2, 3]);
    expect(tiers.map((x) => x.hidden)).toEqual([4, 3, 2]);
  });
  it("never hides anything when everything fits", () => {
    expect(chipTiers(["a", "b"]).map((x) => x.hidden)).toEqual([1, 0, 0]);
    expect(chipTiers([])).toEqual([{ shown: [], hidden: 0 }, { shown: [], hidden: 0 }, { shown: [], hidden: 0 }]);
  });
  it("keeps every tag reachable: shown plus hidden is the full count in every tier", () => {
    for (const tier of chipTiers(tags)) expect(tier.shown.length + tier.hidden).toBe(tags.length);
  });
});
