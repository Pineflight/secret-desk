import { describe, expect, it } from "vitest";
import { readStored, writeStored } from "../src/lib/persisted-state";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), size: () => m.size };
}

describe("persisted-state", () => {
  it("stores deviating values and reads them back", () => {
    const s = memory();
    writeStored("secrets.stage", "staging", "", s);
    expect(readStored("secrets.stage", "", s)).toBe("staging");
    writeStored("secrets.browse", { repo: "acme-app", sort: "name", group: "none" }, { repo: "", sort: "name", group: "none" }, s);
    expect(readStored("secrets.browse", { repo: "", sort: "name", group: "none" }, s)).toEqual({ repo: "acme-app", sort: "name", group: "none" });
  });
  it("deletes the entry when the default applies again", () => {
    const s = memory();
    writeStored("k", "x", "", s);
    expect(s.size()).toBe(1);
    writeStored("k", "", "", s);
    expect(s.size()).toBe(0);
  });
  it("broken JSON and missing storage yield the default value", () => {
    const s = { getItem: () => "{nicht json" };
    expect(readStored("k", "vorgabe", s)).toBe("vorgabe");
    expect(readStored("k", "vorgabe", null)).toBe("vorgabe");
    expect(() => writeStored("k", 1, 0, null)).not.toThrow();
  });
});
