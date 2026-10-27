import { describe, expect, it } from "vitest";
import { messages } from "../src/messages";
import { translate } from "../src/lib/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("i18n", () => {
  it("Deutsch und Englisch haben dieselben Schluessel", () => {
    const de = Object.keys(messages.de).sort();
    const en = Object.keys(messages.en).sort();
    expect(en.filter((k) => !(k in messages.de))).toEqual([]);
    expect(de.filter((k) => !(k in messages.en))).toEqual([]);
  });
  it("Platzhalter stimmen in beiden Sprachen ueberein", () => {
    const bad = Object.keys(messages.de).filter((k) => messages.en[k] !== undefined && placeholders(messages.de[k]!) !== placeholders(messages.en[k]!));
    expect(bad).toEqual([]);
  });
  it("kein englischer Text ist leer", () => {
    expect(Object.entries(messages.en).filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });
  it("ersetzt Platzhalter und waehlt Pluralformen", () => {
    expect(translate("unbekannt.{x}", { x: 1 })).toBe("unbekannt.{x}");
  });
});
