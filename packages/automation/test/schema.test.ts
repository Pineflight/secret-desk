import { describe, expect, it } from "vitest";
import { RecipeSchema, hostAllowed } from "../src/index.js";
import { sampleRecipe } from "./helpers.js";

const base = () => ({
  id: "x",
  label: "X",
  host: "example.test",
  steps: [{ goto: "https://example.test/a" }, { click: { role: "button", name: "Go", createsToken: true } }],
  capture: { token: { find: { css: "#t" } } },
});

function errors(doc: unknown): string {
  const r = RecipeSchema.safeParse(doc);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("RecipeSchema", () => {
  it("accepts a valid recipe", () => {
    expect(RecipeSchema.safeParse(base()).success).toBe(true);
    expect(sampleRecipe().steps).toHaveLength(5);
  });
  it("requires exactly one lookup kind in the selector", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { click: { role: "button", css: "#a", createsToken: true } } as never];
    expect(errors(d)).toMatch(/steps\.1\.click.*Genau eines/);
  });
  it("name belongs to role only", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { fill: { label: "A", name: "B", value: "x" } } as never, d.steps[1] as never];
    expect(errors(d)).toMatch(/name gehoert nur zu role/);
  });
  it("requires createsToken", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }];
    expect(errors(d)).toMatch(/createsToken/);
  });
  it("rejects unknown variables", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a?x={{nope}}" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/Unbekannte Variable \{\{nope\}\}/);
  });
  it("rejects foreign hosts and variables in the host", () => {
    const d = base();
    d.steps = [{ goto: "https://evil.test/a" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/evil\.test/);
    d.steps = [{ goto: "https://{{name}}.example.test/" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/festem Host/);
  });
  it("allows allowHosts and http locally only", () => {
    const d = { ...base(), allowHosts: ["auth.example.test"] };
    d.steps = [{ goto: "https://auth.example.test/a" }, d.steps[1] as never];
    expect(errors(d)).toBe("");
    d.steps = [{ goto: "http://example.test/a" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/http nur fuer localhost/);
  });
  it("reports unknown step kinds clearly", () => {
    const d = base();
    d.steps = [{ hover: "x" } as never, d.steps[1] as never];
    expect(errors(d)).toMatch(/Schritt braucht genau eine Art/);
  });
  it("rejected invalid regex and missing until", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { waitFor: { url: "(" } } as never, { pause: { human: "x" } } as never, d.steps[1] as never];
    const e = errors(d);
    expect(e).toMatch(/Ungueltiger regulaerer Ausdruck/);
    expect(e).toMatch(/until/);
  });
});

describe("RecipeSchema params", () => {
  const withParams = (params: unknown[], extra: Record<string, unknown> = {}) => ({ ...base(), params, ...extra });
  const param = (over: Record<string, unknown> = {}) => ({ key: "projectId", label: "Projekt", pattern: "^[a-z0-9]{6,20}$", ...over });

  it("accepts declared params with defaults and makes the keys known variables", () => {
    const d = withParams([param(), param({ key: "level", label: "Stufe", pattern: undefined, options: ["A", "B"], default: "A", required: false })]);
    d.steps = [{ goto: "https://example.test/p/{{projectId}}" }, { fill: { css: "#a", value: "{{level}}" } } as never, d.steps[1] as never];
    expect(errors(d)).toBe("");
    const r = RecipeSchema.parse(d);
    expect(r.params.map((p) => [p.key, p.required])).toEqual([["projectId", true], ["level", false]]);
  });
  it("params default to an empty list", () => {
    expect(RecipeSchema.parse(base()).params).toEqual([]);
  });
  it("rejects invalid keys", () => {
    for (const key of ["Project", "1abc", "a-b", "a_b", "", "a".repeat(32)]) expect(errors(withParams([param({ key })])), key).toMatch(/params\.0\.key/);
  });
  it("rejects keys that collide with fixed variables and duplicates", () => {
    expect(errors(withParams([param({ key: "name" })]))).toMatch(/params\.0\.key: .*name.*feste Rezeptvariable/);
    expect(errors(withParams([param({ key: "owner" })]))).toMatch(/feste Rezeptvariable/);
    expect(errors(withParams([param(), param()]))).toMatch(/params\.1\.key: .*doppelt/);
  });
  it("rejects an invalid pattern, empty options and a default outside pattern/options", () => {
    expect(errors(withParams([param({ pattern: "(" })]))).toMatch(/Ungueltiger regulaerer Ausdruck/);
    expect(errors(withParams([param({ options: [] })]))).toMatch(/params\.0\.options/);
    expect(errors(withParams([param({ default: "BAD!" })]))).toMatch(/params\.0\.default/);
    expect(errors(withParams([param({ pattern: undefined, options: ["A"], default: "B" })]))).toMatch(/params\.0\.default/);
  });
  it("rejects unknown fields in a param", () => {
    expect(errors(withParams([param({ extra: 1 })]))).not.toBe("");
  });
  it("an undeclared parameter variable is still unknown", () => {
    const d = withParams([param()]);
    d.steps = [{ goto: "https://example.test/p/{{other}}" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/Unbekannte Variable \{\{other\}\}/);
  });
  it("checks variables in capture and mask selectors too", () => {
    expect(errors({ ...base(), capture: { token: { find: { css: "#t-{{nope}}" } } } })).toMatch(/capture.*Unbekannte Variable \{\{nope\}\}/);
    expect(errors({ ...base(), mask: [{ css: "#t-{{nope}}" }] })).toMatch(/mask.*Unbekannte Variable/);
    expect(errors({ ...base(), capture: { token: { find: { css: "#t-{{name}}" } } }, mask: [{ css: "#t-{{name}}" }] })).toBe("");
  });
  it("a regular expression with braces in pattern is not read as a variable", () => {
    expect(errors({ ...base(), capture: { token: { find: { css: "#t" }, pattern: "^a{{2}}$" } } })).toBe("");
  });
});

describe("hidden condition", () => {
  it("is exactly one of url, visible, hidden, text, all or any", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { waitFor: { hidden: { css: "#row" } } } as never, d.steps[1] as never];
    expect(errors(d)).toBe("");
    d.steps = [{ goto: "https://example.test/a" }, { waitFor: { hidden: { css: "#row" }, text: "x" } } as never, d.steps[1] as never];
    expect(errors(d)).toMatch(/Genau eines von url, visible, hidden, text, all oder any/);
  });
});

describe("hostAllowed", () => {
  it("compares exactly, wildcard only via *.", () => {
    const r = { host: "github.com", allowHosts: ["*.githubusercontent.com"] };
    expect(hostAllowed("github.com", r)).toBe(true);
    expect(hostAllowed("evil-github.com", r)).toBe(false);
    expect(hostAllowed("github.com.evil.test", r)).toBe(false);
    expect(hostAllowed("a.githubusercontent.com", r)).toBe(true);
  });
});

describe("when, optional and attribute", () => {
  const doc = (steps: unknown[], extra: Record<string, unknown> = {}, token: Record<string, unknown> = {}) => ({
    id: "t",
    label: "T",
    host: "example.test",
    params: [{ key: "mode", label: "Modus", options: ["a", "b"] }],
    steps: [...steps, { click: { role: "button", name: "Go", createsToken: true } }],
    capture: { token: { find: { css: "#t" }, ...token } },
    ...extra,
  });
  it("accepts when on every step kind and knows its variable", () => {
    const when = { var: "mode", equals: "a" };
    const steps = [{ goto: "https://example.test/x", when }, { fill: { label: "N", value: "v" }, when }, { waitFor: { text: "x" }, when }, { pause: { human: "h", until: { text: "x" } }, when }, { screenshot: "s", when }];
    expect(() => RecipeSchema.parse(doc(steps))).not.toThrow();
  });
  it("rejects an unknown when variable", () => {
    expect(() => RecipeSchema.parse(doc([{ goto: "https://example.test/x", when: { var: "nope", equals: "a" } }]))).toThrow(/Unbekannte Variable nope/);
  });
  it("optional click excludes createsToken and needs optional for a timeout", () => {
    expect(() => RecipeSchema.parse(doc([{ click: { css: "#b", optional: true, timeoutSeconds: 4 } }]))).not.toThrow();
    expect(() => RecipeSchema.parse(doc([{ click: { css: "#b", optional: true, createsToken: true } }]))).toThrow(/schliessen sich aus/);
    expect(() => RecipeSchema.parse(doc([{ click: { css: "#b", timeoutSeconds: 4 } }]))).toThrow(/nur zu optional/);
  });
  it("token attribute must look like an attribute name", () => {
    expect(() => RecipeSchema.parse(doc([], {}, { attribute: "data-text" }))).not.toThrow();
    expect(() => RecipeSchema.parse(doc([], {}, { attribute: "x y" }))).toThrow();
  });
  it("exact belongs to a label too", () => {
    expect(() => RecipeSchema.parse(doc([{ fill: { label: "Name", exact: true, value: "v" } }]))).not.toThrow();
    expect(() => RecipeSchema.parse(doc([{ fill: { css: "#x", exact: true, value: "v" } }]))).toThrow();
  });
});
