import { describe, expect, it } from "vitest";
import { allRepos, groupItems, sortItems, type Browsable } from "../src/lib/browse";

const item = (id: string, over: Partial<Browsable> = {}): Browsable => ({ id, name: id, stage: "staging", places: [], ...over });
const repo = (r: string) => ({ repo: r, scope: "repository" as const });

describe("browse", () => {
  const items = [
    item("b", { places: [repo("acme-app"), repo("acme-api")], daysLeft: 20 }),
    item("a", { places: [repo("acme-api")], stage: "production", daysLeft: 3 }),
    item("c", { daysLeft: null }),
  ];
  it("lists all repositories", () => expect(allRepos(items)).toEqual(["acme-api", "acme-app"]));
  it("sorts by expiry, unknown last", () => expect(sortItems(items, "expires").map((i) => i.id)).toEqual(["a", "b", "c"]));
  it("sorts by stage, production first", () => expect(sortItems(items, "stage")[0]!.id).toBe("a"));
  it("groups by repository, multi-target secrets in every group, rest last", () => {
    const g = groupItems(items, "repo");
    expect(g.map((x) => x.label)).toEqual(["acme-api", "acme-app", "Ohne Repository"]);
    expect(g[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(g[1]!.items.map((i) => i.id)).toEqual(["b"]);
  });
  it("without grouping yields one group", () => expect(groupItems(items, "none")).toHaveLength(1));
});
