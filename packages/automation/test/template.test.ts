import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/index.js";

describe("renderTemplate", () => {
  it("replaces variables also with spaces", () => {
    expect(renderTemplate("a {{x}} b {{ y }}", { x: "1", y: "2" })).toBe("a 1 b 2");
  });
  it("unknown variable is an error", () => {
    expect(() => renderTemplate("{{nope}}", {})).toThrow(/Unbekannte Variable \{\{nope\}\}/);
  });
  it("encodes in URLs, otherwise not", () => {
    expect(renderTemplate("https://h/?d={{d}}", { d: "a b&c=d" }, { url: true })).toBe("https://h/?d=a%20b%26c%3Dd");
    expect(renderTemplate("{{d}}", { d: "a b&c" })).toBe("a b&c");
  });
  it("does not encode permissionsQuery twice", () => {
    expect(renderTemplate("?{{permissionsQuery}}", { permissionsQuery: "contents=read&metadata=read" }, { url: true })).toBe("?contents=read&metadata=read");
  });
});
