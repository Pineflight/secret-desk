import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, RecipeSchema, conditionMet, loadRecipes, resolveCondition, runRecipe } from "../src/index.js";
import { FORM_VISIBLE, TOKEN, VARS, sampleRecipe } from "./helpers.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");

const recipe = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  sampleRecipe({
    login: undefined,
    steps: [{ goto: "https://example.test/start" }, ...steps, { click: { role: "button", name: "Create", createsToken: true } }],
    capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }, externalId: { from: "name" } },
    ...extra,
  });

const driver = (visible: string[] = [], extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}) =>
  new FakeDriver({
    pollMs: 2,
    visible: ["css #a", "css #b", ...FORM_VISIBLE, ...visible],
    on: (e, d) => {
      if (e.action === "click" && e.key === 'button "Create"') {
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
    ...extra,
  });

const run = (r: ReturnType<typeof recipe>, d: FakeDriver) => runRecipe(r, VARS, d, {}, { pollMs: 2 });

describe("when: visible", () => {
  const steps = [{ click: { css: "#a" }, when: { visible: { css: "#variant-one" } } }, { click: { css: "#b" }, when: { visible: { css: "#variant-two" } } }];

  it("runs the step whose element is visible now and skips the other", async () => {
    const d = driver(["css #variant-two"]);
    await run(recipe(steps), d);
    expect(d.calls).toContain("click css #b");
    expect(d.calls).not.toContain("click css #a");
  });

  it("looks once by default and does not wait", async () => {
    const d = driver(["css #variant-one"], { on: (e, drv) => { if (e.action === "goto") setTimeout(() => drv.visible.add("css #variant-two"), 30); if (e.action === "click" && e.key === 'button "Create"') { drv.visible.add("css #tok"); drv.texts.set("css #tok", TOKEN); } } });
    await run(recipe(steps), d);
    expect(d.calls).toContain("click css #a");
    expect(d.calls).not.toContain("click css #b");
  });

  it("waits up to timeoutSeconds for the element, and a missing element means no", async () => {
    const waiting = [{ click: { css: "#b" }, when: { visible: { css: "#late" }, timeoutSeconds: 1 } }];
    const late = driver([], { on: (e, drv) => { if (e.action === "goto") setTimeout(() => drv.visible.add("css #late"), 30); if (e.action === "click" && e.key === 'button "Create"') { drv.visible.add("css #tok"); drv.texts.set("css #tok", TOKEN); } } });
    await run(recipe(waiting), late);
    expect(late.calls).toContain("click css #b");
    const never = driver();
    await run(recipe([{ click: { css: "#b" }, when: { visible: { css: "#late" }, timeoutSeconds: 0.03 } }]), never);
    expect(never.calls).not.toContain("click css #b");
  });

  it("renders variables in the selector", async () => {
    const d = driver([`css tr:has-text("${VARS.name}")`]);
    await run(recipe([{ click: { css: "#a" }, when: { visible: { css: 'tr:has-text("{{name}}")' } } }]), d);
    expect(d.calls).toContain("click css #a");
  });

  it("a conditional createsToken step that is skipped does not stop the dry run early", async () => {
    const r = recipe([{ click: { role: "button", name: "Create", createsToken: true }, when: { visible: { css: "#nope" } } }, { click: { css: "#a" } }]);
    const d = driver();
    await run(r, d);
    expect(d.calls).toContain("click css #a");
  });
});

describe("when: all, set and fail", () => {
  it("all needs every part to hold", async () => {
    const step = (v: string) => ({ click: { css: "#a" }, when: { all: [{ var: "stage", equals: v }, { visible: { css: "#b" } }] } });
    const yes = driver();
    await run(recipe([step("dev")]), yes);
    expect(yes.calls).toContain("click css #a");
    const no = driver();
    await run(recipe([step("prod")]), no);
    expect(no.calls).not.toContain("click css #a");
  });

  it("set records a value for later steps and does not touch the caller's variables", async () => {
    const vars = { ...VARS };
    const steps = [
      { set: { var: "variant", value: "one" }, when: { visible: { css: "#a" } } },
      { set: { var: "variant", value: "two" }, when: { all: [{ var: "variant", equals: "" }, { visible: { css: "#b" } }] } },
      { click: { css: "#a" }, when: { var: "variant", equals: "one" } },
      { click: { css: "#b" }, when: { var: "variant", equals: "two" } },
    ];
    const d = driver();
    await runRecipe(recipe(steps), vars, d, {}, { pollMs: 2 });
    expect(d.calls).toContain("click css #a");
    expect(d.calls).not.toContain("click css #b");
    expect(Object.hasOwn(vars, "variant")).toBe(false);
  });

  it("fail ends the run before the creating click and creates nothing", async () => {
    const d = driver();
    const err = (await run(recipe([{ fail: "Not supported here." }]), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.kind).toBe("step");
    expect(err.message).toBe("Not supported here.");
    expect(err.createdName).toBeUndefined();
    expect(d.calls).not.toContain('click button "Create"');
  });

  it("the schema rejects an unknown variable in when, a set of an existing variable and an empty all", () => {
    const parse = (steps: unknown[]) => RecipeSchema.safeParse({ ...sampleRecipe(), steps: [{ goto: "https://example.test/x" }, ...steps, { click: { role: "button", name: "Create", createsToken: true } }] });
    expect(parse([{ click: { css: "#a" }, when: { var: "unknownThing", equals: "x" } }]).success).toBe(false);
    expect(parse([{ set: { var: "name", value: "x" } }]).success).toBe(false);
    expect(parse([{ click: { css: "#a" }, when: { all: [{ var: "stage", equals: "dev" }] } }]).success).toBe(false);
    expect(parse([{ set: { var: "variant", value: "x" } }, { click: { css: "#a" }, when: { var: "variant", equals: "x" } }]).success).toBe(true);
  });
});

describe("waitFor any and conditions with all", () => {
  it("any holds as soon as one of the conditions holds", async () => {
    const r = recipe([{ waitFor: { any: [{ text: "First" }, { visible: { css: "#b" } }], timeoutSeconds: 1 } }]);
    await run(r, driver());
    const timeout = recipe([{ waitFor: { any: [{ text: "First" }, { text: "Second" }], timeoutSeconds: 0.03 } }]);
    const err = (await run(timeout, driver()).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
  });

  it("all of a condition holds only when every part holds", async () => {
    const d = new FakeDriver({ url: "https://example.test/settings", visible: ["css #x"] });
    const cond = (hidden: string) => resolveCondition({ all: [{ url: "^https://example\\.test/" }, { hidden: { css: hidden } }] }, {});
    expect(await conditionMet(d, cond("#x"))).toBe(false);
    expect(await conditionMet(d, cond("#y"))).toBe(true);
    d.url = "https://elsewhere.test/";
    expect(await conditionMet(d, cond("#y"))).toBe(false);
  });

  it("the schema wants a condition with all to be the only kind and to list at least two", () => {
    const login = (expect: unknown) => RecipeSchema.safeParse({ ...sampleRecipe(), login: { expect } });
    expect(login({ all: [{ url: "^https://example\\.test/" }, { hidden: { css: "#x" } }] }).success).toBe(true);
    expect(login({ all: [{ url: "^https://example\\.test/" }, { hidden: { css: "#x" } }], text: "x" }).success).toBe(false);
    expect(login({ all: [{ url: "^https://example\\.test/" }] }).success).toBe(false);
    expect(login({ all: [{ url: "^https://example\\.test/", text: "x" }, { hidden: { css: "#x" } }] }).success).toBe(false);
  });
});

describe("capture.token.alternatives", () => {
  const capture = { token: { find: { css: "#first" }, attribute: "data-text", alternatives: [{ find: { css: "#second" } }], pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 }, externalId: { from: "name" } };
  const on = (show: string) => (e: { action: string; key: string }, d: FakeDriver) => {
    if (e.action === "click" && e.key === 'button "Create"') {
      d.visible.add(show);
      d.texts.set("css #second", TOKEN);
      d.attributes.set("css #first@data-text", "tok_fromfirst1");
    }
  };

  it("takes the first visible candidate, each with its own attribute", async () => {
    const second = await run(recipe([], { capture }), driver([], { on: on("css #second") }));
    expect(second.value.reveal()).toBe(TOKEN);
    const both = driver([], { on: (e, d) => { if (e.action === "click" && e.key === 'button "Create"') { d.visible.add("css #first").add("css #second"); d.texts.set("css #second", TOKEN); d.attributes.set("css #first@data-text", "tok_fromfirst1"); } } });
    expect((await run(recipe([], { capture }), both)).value.reveal()).toBe("tok_fromfirst1");
  });

  it("fails closed when no candidate shows up, and masks every candidate in the receipt", async () => {
    const err = (await run(recipe([], { capture }), driver()).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    const d = driver([], { on: on("css #second") });
    await run(recipe([], { capture }), d);
    expect(d.shots.at(-1)?.masks).toEqual(expect.arrayContaining(["css #first", "css #second"]));
  });
});

describe("Anthropic Console sign-in check", () => {
  for (const id of ["anthropic-api-key", "anthropic-admin-key"]) {
    it(`${id}: the sign-in screen at a settings address counts as signed out, a signed-in page as signed in`, async () => {
      const r = (await loadRecipes([RECIPES])).find((x) => x.id === id)!;
      const cond = resolveCondition(r.login!.expect, {});
      const url = id === "anthropic-api-key" ? "https://platform.claude.com/settings/keys" : "https://platform.claude.com/settings/admin-keys";
      const signedOut = new FakeDriver({ url, visible: ['button "Continue with Google"', 'button "Continue with email"'] });
      expect(await conditionMet(signedOut, cond)).toBe(false);
      const onlyEmail = new FakeDriver({ url, visible: ['button "Continue with email"'] });
      expect(await conditionMet(onlyEmail, cond)).toBe(false);
      const signedIn = new FakeDriver({ url, visible: ['button "Create Key"'] });
      expect(await conditionMet(signedIn, cond)).toBe(true);
      const elsewhere = new FakeDriver({ url: "https://platform.claude.com/login", visible: [] });
      expect(await conditionMet(elsewhere, cond)).toBe(false);
    });

    it(`${id}: rejects the cookie banner and never accepts it`, async () => {
      const r = (await loadRecipes([RECIPES])).find((x) => x.id === id)!;
      const banner = r.steps.find((s) => "click" in s && s.click.name === "Reject all cookies");
      expect(banner).toMatchObject({ click: { role: "button", name: "Reject all cookies", optional: true } });
      expect(JSON.stringify(r)).not.toMatch(/accept/i);
    });
  }
});
