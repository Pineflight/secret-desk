import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretValue, redact } from "../src/secret.js";

describe("SecretValue", () => {
  const s = new SecretValue("geheim-123456");
  it("shows the value in no output", () => {
    expect(String(s)).toBe("[SecretValue]");
    expect(`${s}`).toBe("[SecretValue]");
    expect(JSON.stringify({ s })).toBe('{"s":"[SecretValue]"}');
    expect(inspect(s)).toBe("[SecretValue]");
    expect(inspect({ nested: { s } })).not.toContain("geheim");
  });
  it("hands out the value only via reveal", () => {
    expect(s.reveal()).toBe("geheim-123456");
    expect(s.length).toBe(13);
  });
  it("redact replaces known values", () => {
    expect(redact("Fehler mit geheim-123456 im Text", [s])).toBe("Fehler mit *** im Text");
    expect(redact("kurz abc", ["abc"])).toBe("kurz abc");
  });
});
