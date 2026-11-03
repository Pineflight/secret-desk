import { describe, expect, it } from "vitest";
import { EXPANDED_STORAGE_KEY, allExpanded, cardKey, collapseAll, connectionKey, expandAll, readExpanded, toggled, writeExpanded } from "../src/lib/card-state";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

describe("card state", () => {
  it("toggles one key without touching the others", () => {
    const a = toggled(new Set(), cardKey("stripe"));
    expect([...a]).toEqual(["card:stripe"]);
    const b = toggled(a, connectionKey("stripe:acct_1:live"));
    expect(b.has("card:stripe") && b.has("key:stripe:acct_1:live")).toBe(true);
    expect([...toggled(b, cardKey("stripe"))]).toEqual(["key:stripe:acct_1:live"]);
    expect(a.has("key:stripe:acct_1:live")).toBe(false);
  });

  it("expands all given cards, keeps open keys, and collapses everything", () => {
    const open = expandAll(new Set([connectionKey("github")]), ["github", "stripe"]);
    expect([...open].sort()).toEqual(["card:github", "card:stripe", "key:github"]);
    expect(allExpanded(open, ["github", "stripe"])).toBe(true);
    expect(allExpanded(open, ["github", "stripe", "resend"])).toBe(false);
    expect(allExpanded(open, [])).toBe(false);
    expect(collapseAll().size).toBe(0);
  });

  it("stores the open set and reads it back", () => {
    const st = memory();
    writeExpanded(new Set(["card:stripe", "card:github"]), st);
    expect(JSON.parse(st.data.get(EXPANDED_STORAGE_KEY)!)).toEqual(["card:github", "card:stripe"]);
    expect([...readExpanded(st)].sort()).toEqual(["card:github", "card:stripe"]);
    writeExpanded(new Set(), st);
    expect(st.data.has(EXPANDED_STORAGE_KEY)).toBe(false);
  });

  it("falls back to all collapsed when storage is missing, blocked or broken", () => {
    expect(readExpanded(null).size).toBe(0);
    expect(readExpanded(memory({ [EXPANDED_STORAGE_KEY]: "{not json" })).size).toBe(0);
    expect(readExpanded(memory({ [EXPANDED_STORAGE_KEY]: '{"a":1}' })).size).toBe(0);
    expect([...readExpanded(memory({ [EXPANDED_STORAGE_KEY]: '["card:a", 3, null]' }))]).toEqual(["card:a"]);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readExpanded(blocked).size).toBe(0);
    expect(() => writeExpanded(new Set(["card:a"]), blocked)).not.toThrow();
    expect(() => writeExpanded(new Set(), blocked)).not.toThrow();
  });
});
