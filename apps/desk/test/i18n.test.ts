import { describe, expect, it } from "vitest";
import { messages } from "../src/messages";
import { translate } from "../src/lib/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("i18n", () => {
  it("German and English have the same keys", () => {
    const de = Object.keys(messages.de).sort();
    const en = Object.keys(messages.en).sort();
    expect(en.filter((k) => !(k in messages.de))).toEqual([]);
    expect(de.filter((k) => !(k in messages.en))).toEqual([]);
  });
  it("placeholders match in both languages", () => {
    const bad = Object.keys(messages.de).filter((k) => messages.en[k] !== undefined && placeholders(messages.de[k]!) !== placeholders(messages.en[k]!));
    expect(bad).toEqual([]);
  });
  it("no English text is empty", () => {
    expect(Object.entries(messages.en).filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });
  it("replaces placeholders and picks plural forms", () => {
    expect(translate("common.days.future", { count: 1 }, "de")).toBe("in 1 Tag");
    expect(translate("common.days.future", { count: 3 }, "de")).toBe("in 3 Tagen");
    expect(translate("common.days.future", { count: 1 }, "en")).toBe("in 1 day");
    expect(translate("common.days.past", { count: 2 }, "en")).toBe("expired 2 days ago");
    expect(translate("gibt.es.nicht", undefined, "en")).toBe("gibt.es.nicht");
  });
});
