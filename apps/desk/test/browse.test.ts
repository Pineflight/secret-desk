import { describe, expect, it } from "vitest";
import { allRepos, groupItems, sortItems, type Browsable } from "../src/lib/browse";

const item = (id: string, over: Partial<Browsable> = {}): Browsable => ({ id, name: id, stage: "staging", places: [], ...over });
const repo = (r: string) => ({ repo: r, scope: "repository" as const });

describe("browse", () => {
  const items = [
    item("b", { places: [repo("wake-miles"), repo("lupe")], daysLeft: 20 }),
    item("a", { places: [repo("lupe")], stage: "production", daysLeft: 3 }),
    item("c", { daysLeft: null }),
  ];
  it("listet alle Repositories", () => expect(allRepos(items)).toEqual(["lupe", "wake-miles"]));
  it("sortiert nach Ablauf, unbekannt zuletzt", () => expect(sortItems(items, "expires").map((i) => i.id)).toEqual(["a", "b", "c"]));
  it("sortiert nach Stage, Produktion zuerst", () => expect(sortItems(items, "stage")[0]!.id).toBe("a"));
  it("gruppiert nach Repository, Mehrfachziele in jeder Gruppe, Rest zuletzt", () => {
    const g = groupItems(items, "repo");
    expect(g.map((x) => x.label)).toEqual(["lupe", "wake-miles", "Ohne Repository"]);
    expect(g[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(g[1]!.items.map((i) => i.id)).toEqual(["b"]);
  });
  it("ohne Gruppierung eine Gruppe", () => expect(groupItems(items, "none")).toHaveLength(1));
});
