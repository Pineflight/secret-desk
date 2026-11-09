import { describe, expect, it } from "vitest";
import { RecipeSchema, loginMethodsOf, resolveRecipe, whenVars } from "../src/index.js";

const create = {
  id: "demo",
  label: "Demo",
  host: "example.test",
  steps: [{ click: { role: "button", name: "Create", createsToken: true } }],
  capture: { token: { find: { css: "#t" } } },
};
const readBase = {
  id: "demo-read",
  label: "Demo read",
  kind: "read",
  host: "example.test",
  steps: [{ goto: "https://example.test/keys" }],
  capture: { values: { key: { find: { css: "#k" }, pattern: "^[a-z]+$" } } },
};
const form = (steps: unknown[], over: Record<string, unknown> = {}) => ({
  ...create,
  login: { expect: { url: "^https://example\\.test/" }, form: { start: "https://example.test/login", steps, ...over } },
});

function problems(doc: unknown): string {
  const r = RecipeSchema.safeParse(doc);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
}

describe("whenVars", () => {
  it("is empty without a condition and collects the variables of nested conditions", () => {
    expect(whenVars(undefined)).toEqual([]);
    expect(whenVars({ var: "stage", equals: "dev" })).toEqual(["stage"]);
    expect(whenVars({ visible: { css: "#x" } })).toEqual([]);
    expect(whenVars({ all: [{ var: "a", equals: "1" }, { var: "b", notEquals: "2" }] })).toEqual(["a", "b"]);
  });
});

describe("step schema", () => {
  it("rejects a step that is not an object", () => {
    expect(problems({ ...create, steps: ["goto https://example.test"] })).toContain("steps.0: Schritt muss ein Objekt sein");
    expect(problems({ ...create, steps: [[{ goto: "https://example.test/" }]] })).toContain("Schritt muss ein Objekt sein");
    expect(problems({ ...create, steps: [null] })).toContain("Schritt muss ein Objekt sein");
  });
  it("rejects a step that names no known kind or several kinds", () => {
    expect(problems({ ...create, steps: [{ teleport: "x" }] })).toContain("Schritt braucht genau eine Art");
    expect(problems({ ...create, steps: [{ goto: "https://example.test/", screenshot: "a" }] })).toContain("Schritt braucht genau eine Art");
  });
  it("reports a selector with two kinds of target inside a click step", () => {
    expect(problems({ ...create, steps: [{ click: { role: "button", label: "Create", createsToken: true } }] })).toContain("Genau eines von role, label, text, placeholder, testid oder css angeben");
  });
});

describe("press step", () => {
  it("may press a key on the page, or on an element named by exactly one kind of target", () => {
    expect(problems({ ...create, steps: [{ press: { key: "Enter" } }, ...create.steps] })).toBe("");
    expect(problems({ ...create, steps: [{ press: { key: "Enter", css: "#x" } }, ...create.steps] })).toBe("");
    expect(problems({ ...create, steps: [{ press: { key: "Enter", role: "button", label: "x" } }, ...create.steps] })).toContain("Genau eines von role, label, text, placeholder, testid oder css angeben");
  });
});

describe("recipe host handling", () => {
  it("a multi-host recipe takes its first host as the label host", () => {
    const r = RecipeSchema.parse({
      ...readBase,
      host: undefined,
      hostBy: "portal",
      hosts: { live: "app.example.test", test: "sandbox.example.test" },
      params: [{ key: "portal", label: "Portal", options: ["live", "test"] }],
      steps: [{ goto: "https://app.example.test/keys" }],
    });
    expect(r.host).toBe("app.example.test");
  });
});

describe("kind read: static checks", () => {
  it("needs capture.values", () => {
    expect(problems({ ...readBase, capture: {} })).toContain("capture.values needs one or two values");
  });
  it("one value takes no pick and no companion", () => {
    const withParam = (capture: Record<string, unknown>) => ({
      ...readBase,
      params: [{ key: "which", label: "Which", options: ["key"] }, { key: "target", label: "Target", required: false, pattern: "^[a-z-]+$" }],
      capture: { ...readBase.capture, ...capture },
    });
    expect(problems(withParam({ pick: "which" }))).toContain("capture.pick belongs to two values");
    expect(problems(withParam({ companion: "target" }))).toContain("capture.companion belongs to two values");
    expect(problems(withParam({ companion: "missing" }))).toContain("capture.companion names the parameter missing, which is not declared under params");
  });
});

describe("login form: static checks", () => {
  const fillUser = { fill: { label: "Email", value: "{{login.username}}" } };
  const fillPass = { fill: { label: "Password", value: "{{login.password}}" } };
  it("a sign-in step neither repeats nor depends on a condition, and may only fill, click or wait", () => {
    const msg = problems(form([{ ...fillUser, each: "repos" }, { ...fillPass, when: { var: "stage", equals: "dev" } }, { goto: "https://example.test/x" }]));
    expect(msg).toContain("login.form.steps.0.each: A sign-in step must not repeat per item");
    expect(msg).toContain("login.form.steps.1.when: A sign-in step must not be conditional");
    expect(msg).toContain("login.form.steps.2: A sign-in step is fill, click or waitFor");
  });
  it("accepts a plain form", () => {
    expect(problems(form([fillUser, fillPass]))).toBe("");
  });
});

describe("login methods: static checks", () => {
  const base = (methods: unknown[]) => ({
    ...form([{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }]),
    login: {
      expect: { url: "^https://example\\.test/" },
      form: { start: "https://example.test/login", steps: [{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }] },
      methods,
    },
  });
  it("single-sign-on steps neither repeat nor depend on a condition, nor create, and are only click or wait", () => {
    const msg = problems(
      base([
        {
          id: "github",
          steps: [
            { click: { role: "button", name: "GitHub" }, each: "repos" },
            { click: { role: "button", name: "Continue" }, when: { var: "stage", equals: "dev" } },
            { click: { role: "button", name: "Create", createsToken: true } },
            { fill: { label: "Email", value: "x" } },
          ],
        },
      ]),
    );
    expect(msg).toContain("login.methods.0.steps.0.each: A sign-in step must not repeat per item");
    expect(msg).toContain("login.methods.0.steps.1.when: A sign-in step must not be conditional");
    expect(msg).toContain("login.methods.0.steps.2: A sign-in step must not create a token");
    expect(msg).toContain("login.methods.0.steps.3: A single-sign-on step is click or waitFor");
  });
});

describe("loginMethodsOf and resolveRecipe", () => {
  const steps = [{ fill: { label: "Email", value: "{{login.username}}" } }, { fill: { label: "Password", value: "{{login.password}}" } }];
  it("lists the email method first with its labels, then the declared single-sign-on methods with theirs", () => {
    const r = RecipeSchema.parse({
      ...create,
      login: {
        expect: { url: "^https://example\\.test/" },
        form: { start: "https://example.test/login", steps },
        methods: [
          { id: "github", label: "GitHub", labelEn: "GitHub EN", steps: [{ click: { role: "button", name: "GitHub" } }] },
          { id: "email", label: "E-Mail" },
          { id: "google", steps: [{ click: { role: "button", name: "Google" } }] },
          { id: "apple", label: "Apple", steps: [{ click: { role: "button", name: "Apple" } }] },
        ],
      },
    });
    expect(loginMethodsOf(r)).toEqual([
      { id: "email", label: "E-Mail", labelEn: "E-Mail" },
      { id: "github", label: "GitHub", labelEn: "GitHub EN" },
      { id: "google", label: null, labelEn: null },
      { id: "apple", label: "Apple", labelEn: "Apple" },
    ]);
    expect(loginMethodsOf(RecipeSchema.parse(create))).toEqual([]);
    expect(loginMethodsOf(RecipeSchema.parse({ ...create, login: { expect: { url: "^https://example\\.test/" }, form: { start: "https://example.test/login", steps } } }))).toEqual([{ id: "email", label: null, labelEn: null }]);
  });
  it("substitutes {{host}} deeply in login.expect (lists, flags, plain texts) and in the sign-in addresses", () => {
    const r = RecipeSchema.parse({
      ...create,
      host: undefined,
      hostBy: "portal",
      hosts: { live: "app.example.test", test: "sandbox.example.test" },
      params: [{ key: "portal", label: "Portal", options: ["live", "test"] }],
      login: {
        expect: { all: [{ url: "^https://{{host}}/home" }, { visible: { role: "button", name: "Account {{host}}", exact: true } }] },
        form: { start: "https://{{host}}/login", home: "https://{{host}}/", steps },
      },
    });
    const live = resolveRecipe(r, "live");
    expect(live.host).toBe("app.example.test");
    expect(live.login!.expect).toEqual({ all: [{ url: "^https://app\\.example\\.test/home" }, { visible: { role: "button", name: "Account app.example.test", exact: true } }] });
    expect(live.login!.form).toMatchObject({ start: "https://app.example.test/login", home: "https://app.example.test/" });
    expect(live.hosts).toBeUndefined();
  });
  it("a single-host recipe without a home page keeps its form addresses", () => {
    const r = RecipeSchema.parse({ ...create, login: { expect: { url: "^https://example\\.test/" }, form: { start: "https://example.test/login", steps } } });
    expect(resolveRecipe(r).login!.form).toMatchObject({ start: "https://example.test/login" });
    expect(resolveRecipe(r).login!.form).not.toHaveProperty("home");
  });
});
