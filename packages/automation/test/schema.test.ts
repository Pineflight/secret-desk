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
  it("nimmt ein gueltiges Rezept an", () => {
    expect(RecipeSchema.safeParse(base()).success).toBe(true);
    expect(sampleRecipe().steps).toHaveLength(5);
  });
  it("verlangt genau eine Suchart im Selektor", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { click: { role: "button", css: "#a", createsToken: true } } as never];
    expect(errors(d)).toMatch(/steps\.1\.click.*Genau eines/);
  });
  it("name gehoert nur zu role", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { fill: { label: "A", name: "B", value: "x" } } as never, d.steps[1] as never];
    expect(errors(d)).toMatch(/name gehoert nur zu role/);
  });
  it("verlangt createsToken", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }];
    expect(errors(d)).toMatch(/createsToken/);
  });
  it("lehnt unbekannte Variablen ab", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a?x={{nope}}" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/Unbekannte Variable \{\{nope\}\}/);
  });
  it("lehnt fremde Hosts und Variablen im Host ab", () => {
    const d = base();
    d.steps = [{ goto: "https://evil.test/a" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/evil\.test/);
    d.steps = [{ goto: "https://{{name}}.example.test/" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/festem Host/);
  });
  it("erlaubt allowHosts und http nur lokal", () => {
    const d = { ...base(), allowHosts: ["auth.example.test"] };
    d.steps = [{ goto: "https://auth.example.test/a" }, d.steps[1] as never];
    expect(errors(d)).toBe("");
    d.steps = [{ goto: "http://example.test/a" }, d.steps[1] as never];
    expect(errors(d)).toMatch(/http nur fuer localhost/);
  });
  it("meldet unbekannte Schrittarten verstaendlich", () => {
    const d = base();
    d.steps = [{ hover: "x" } as never, d.steps[1] as never];
    expect(errors(d)).toMatch(/Schritt braucht genau eine Art/);
  });
  it("pruefte ungueltige Regex und fehlendes until", () => {
    const d = base();
    d.steps = [{ goto: "https://example.test/a" }, { waitFor: { url: "(" } } as never, { pause: { human: "x" } } as never, d.steps[1] as never];
    const e = errors(d);
    expect(e).toMatch(/Ungueltiger regulaerer Ausdruck/);
    expect(e).toMatch(/until/);
  });
});

describe("hostAllowed", () => {
  it("vergleicht exakt, Platzhalter nur per *.", () => {
    const r = { host: "github.com", allowHosts: ["*.githubusercontent.com"] };
    expect(hostAllowed("github.com", r)).toBe(true);
    expect(hostAllowed("evil-github.com", r)).toBe(false);
    expect(hostAllowed("github.com.evil.test", r)).toBe(false);
    expect(hostAllowed("a.githubusercontent.com", r)).toBe(true);
  });
});
