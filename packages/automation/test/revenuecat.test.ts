import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretSchema, validateEntryParams, type IssueContext, type RevokeContext } from "@secret-desk/core";
import { FakeDriver, RecipeRunError, createBrowserProvider, dryRunRecipe, loadRecipeFile, recipeParamSpecs, recipeParamVars, revokeRecipe, runRecipe, type Recipe } from "../src/index.js";
import { TOKEN, VARS, sampleRecipe } from "./helpers.js";

const FILE = resolve(import.meta.dirname, "../../../recipes/revenuecat-secret-api-key.yaml");
const NAME = "rc-key-20261102-1000";
const KEY = "sk_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
const LIST = "https://app.revenuecat.com/projects/proj1a2b3c/api-keys";
const ROW = `[role=row]:has-text("${NAME}")`;
const DISPLAY = `css ${ROW} [data-testid=api-key-display]`;

const vars = (over: Record<string, string> = {}) => ({
  ...VARS,
  name: NAME,
  projectId: "proj1a2b3c",
  projectConfiguration: "Read & write",
  customerInformation: "Read only",
  chartsMetrics: "No access",
  audiences: "No access",
  iam: "No access",
  ...over,
});

/** A fake RevenueCat dashboard: the new-key form, then the key list with a hidden key that "Show key" reveals. */
function dashboard(extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}): FakeDriver {
  return new FakeDriver({
    url: "about:blank",
    visible: [
      'css input[name="label"]',
      "css main [role=combobox] >> nth=0",
      'option "V2"',
      ...["Project configuration", "Customer information", "Charts metrics", "Audiences", "Iam"].map((s) => `combobox "${s} permissions"`),
      ...["No access", "Read only", "Read & write"].map((o) => `option "${o}"`),
      'button "Generate"',
    ],
    on: (e, d) => {
      if (e.action === "goto") d.url = e.key;
      if (e.action === "click" && e.key === 'button "Generate"') {
        d.url = LIST;
        d.visible.add(`css ${ROW} button[aria-label="Show key"]`);
        d.visible.add(`css ${ROW} button[aria-label="More"]`);
        d.visible.add(`css ${ROW}`);
      }
      if (e.action === "click" && e.key === `css ${ROW} button[aria-label="Show key"]`) {
        d.visible.add(DISPLAY);
        d.texts.set(DISPLAY, KEY);
      }
    },
    ...extra,
  });
}

describe("recipe revenuecat-secret-api-key", () => {
  it("fills the form per section and reads the key from the row of its name", async () => {
    const recipe = await loadRecipeFile(FILE);
    const d = dashboard();
    const r = await runRecipe(recipe, vars(), d);
    expect(r.value.reveal()).toBe(KEY);
    expect(r.externalId).toBe(NAME);
    expect(d.calls).toContain(`goto ${LIST}/new`);
    expect(d.filled.get('css input[name="label"]')).toBe(NAME);
    // Section by section: open the combobox, then pick the option from the parameter.
    const picks = d.calls.filter((c) => c.startsWith("click combobox") || c.startsWith("click option"));
    expect(picks).toEqual([
      'click option "V2"',
      'click combobox "Project configuration permissions"',
      'click option "Read & write"',
      'click combobox "Customer information permissions"',
      'click option "Read only"',
      'click combobox "Charts metrics permissions"',
      'click option "No access"',
      'click combobox "Audiences permissions"',
      'click option "No access"',
      'click combobox "Iam permissions"',
      'click option "No access"',
    ]);
    expect(d.calls.indexOf('click button "Generate"')).toBeGreaterThan(d.calls.indexOf('click option "No access"'));
    expect(r.screenshots.map((s) => s.name)).toEqual(["formular-vorher", "nach-erzeugen"]);
    // The display element is masked in every screenshot, including the one before the key exists.
    for (const s of d.shots) expect(s.masks).toContain("css [data-testid=api-key-display]");
    expect(d.shots[1]?.masks).toContain(DISPLAY);
    expect(JSON.stringify({ ...r, value: undefined })).not.toContain(KEY);
  });

  it("the dry run stops before Generate", async () => {
    const recipe = await loadRecipeFile(FILE);
    const d = dashboard();
    const r = await dryRunRecipe(recipe, vars(), d);
    expect(r.screenshots.map((s) => s.name)).toEqual(["formular-vorher"]);
    expect(d.calls).not.toContain('click button "Generate"');
  });

  it("rejects a key that does not look like sk_...", async () => {
    const recipe = await loadRecipeFile(FILE);
    const d = dashboard({
      on: (e, dd) => {
        if (e.action === "goto") dd.url = e.key;
        if (e.action === "click" && e.key === 'button "Generate"') {
          dd.url = LIST;
          dd.visible.add(`css ${ROW} button[aria-label="Show key"]`);
        }
        if (e.action === "click" && e.key === `css ${ROW} button[aria-label="Show key"]`) {
          dd.visible.add(DISPLAY);
          dd.texts.set(DISPLAY, "\u2022\u2022\u2022\u2022\u2022\u2022");
        }
      },
    });
    const err = (await runRecipe(recipe, vars(), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("capture");
    expect(err.createdName).toBe(NAME);
  });

  it("fails before the browser opens when projectId is missing, malformed or a section value is not allowed", async () => {
    const recipe = await loadRecipeFile(FILE);
    for (const [over, what] of [
      [{ projectId: "" }, /Pflichtparameter projectId/],
      [{ projectId: "Bad Id!" }, /projectId.*Format/],
      [{ iam: "Admin" }, /iam.*nicht erlaubt/],
    ] as const) {
      const d = dashboard();
      const err = (await runRecipe(recipe, vars(over), d).catch((e: unknown) => e)) as RecipeRunError;
      expect(err).toBeInstanceOf(RecipeRunError);
      expect(err.kind).toBe("params");
      expect(err.message).toMatch(what);
      expect(d.opened).toBe(false);
      expect(d.calls).toEqual([]);
    }
  });

  it("revokes the row of the captured name and waits until the row is gone", async () => {
    const recipe = await loadRecipeFile(FILE);
    const d = new FakeDriver({
      url: "about:blank",
      visible: [`css ${ROW}`, `css ${ROW} button[aria-label="More"]`, 'menuitem "Revoke"', `css [role=dialog] button:has-text("Confirm")`],
      on: (e, dd) => {
        if (e.action === "goto") dd.url = e.key;
        if (e.action === "click" && e.key === `css [role=dialog] button:has-text("Confirm")`) dd.visible.delete(`css ${ROW}`);
      },
    });
    await revokeRecipe(recipe, vars({ externalId: NAME }), d);
    expect(d.calls.filter((c) => c.startsWith("click"))).toEqual([`click css ${ROW} button[aria-label="More"]`, 'click menuitem "Revoke"', `click css [role=dialog] button:has-text("Confirm")`]);
    expect(d.calls).toContain(`goto ${LIST}`);
  });

  it("revoke times out when the row stays", async () => {
    const recipe = await loadRecipeFile(FILE);
    const d = new FakeDriver({
      url: "about:blank",
      visible: [`css ${ROW}`, `css ${ROW} button[aria-label="More"]`, 'menuitem "Revoke"', `css [role=dialog] button:has-text("Confirm")`],
      on: (e, dd) => void (e.action === "goto" && (dd.url = e.key)),
    });
    const slow: Recipe = { ...recipe, revoke: { steps: recipe.revoke!.steps.map((s) => ("waitFor" in s ? { waitFor: { ...s.waitFor, timeoutSeconds: 0.05 } } : s)) } };
    const err = (await revokeRecipe(slow, vars({ externalId: NAME }), d).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("step");
  });
});

describe("recipe parameters", () => {
  const recipe = (params: unknown[]) =>
    sampleRecipe({
      login: undefined,
      params,
      steps: [{ goto: "https://example.test/p/{{projectId}}/new" }, { fill: { label: "Name", value: "{{level}}" } }, { click: { role: "button", name: "Create", createsToken: true } }],
    });
  const declared = [
    { key: "projectId", label: "Projekt", pattern: "^[a-z0-9]{6,20}$" },
    { key: "level", label: "Stufe", options: ["Read only", "Read & write"], default: "Read only" },
  ];

  it("recipeParamVars: reads strings, stringifies numbers, applies defaults", () => {
    const r = recipe(declared);
    expect(recipeParamVars(r, { projectId: "abc123", level: "Read & write", extra: "ignored" })).toEqual({ projectId: "abc123", level: "Read & write" });
    expect(recipeParamVars(r, { projectId: 123456 })).toEqual({ projectId: "123456", level: "Read only" });
    expect(recipeParamVars(r, { projectId: "  abc123  " }).projectId).toBe("abc123");
  });
  it("recipeParamVars: missing required value names the key, not the value", () => {
    const r = recipe(declared);
    expect(() => recipeParamVars(r, {})).toThrow(/Pflichtparameter projectId/);
    expect(() => recipeParamVars(r, { projectId: ["x"] })).toThrow(/Pflichtparameter projectId/);
    expect(() => recipeParamVars(r, { projectId: "SECRETVALUE" })).toThrow(/projectId/);
    try {
      recipeParamVars(r, { projectId: "SECRETVALUE" });
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRETVALUE");
    }
    expect(() => recipeParamVars(r, { projectId: "abc123", level: "Admin" })).toThrow(/level.*nicht erlaubt/);
  });
  it("an optional parameter without default or value is an empty variable", () => {
    const r = recipe([{ key: "projectId", label: "Projekt", required: false }, declared[1]]);
    expect(recipeParamVars(r, {})).toEqual({ projectId: "", level: "Read only" });
  });
  it("renders into goto (URL-encoded) and into fill", async () => {
    const d = new FakeDriver({ url: "https://example.test/", visible: ['Feld "Name"', 'button "Create"'], on: (e, dd) => void (e.action === "click" && (dd.visible.add("css #tok"), dd.texts.set("css #tok", TOKEN))) });
    await runRecipe(recipe([{ key: "projectId", label: "Projekt" }, declared[1]]), { ...VARS, projectId: "a b/c", level: "Read & write" }, d);
    expect(d.calls).toContain("goto https://example.test/p/a%20b%2Fc/new");
    expect(d.filled.get('Feld "Name"')).toBe("Read & write");
  });
  it("runRecipe also refuses vars that skip the provider (no browser opened)", async () => {
    const d = new FakeDriver();
    await expect(runRecipe(recipe(declared), VARS, d)).rejects.toThrow(/Pflichtparameter projectId/);
    expect(d.opened).toBe(false);
    await expect(dryRunRecipe(recipe(declared), VARS, new FakeDriver())).rejects.toThrow(/projectId/);
  });
});

describe("browser provider params", () => {
  it("maps recipe params onto provider specs", async () => {
    const specs = recipeParamSpecs(await loadRecipeFile(FILE));
    expect(specs.map((s) => s.key)).toEqual(["projectId", "projectConfiguration", "customerInformation", "chartsMetrics", "audiences", "iam"]);
    expect(specs[0]).toMatchObject({ key: "projectId", type: "string", required: true, pattern: "^[a-z0-9]{6,20}$", labelEn: "RevenueCat project ID" });
    expect(specs[0]).not.toHaveProperty("options");
    expect(specs[1]).toMatchObject({ type: "enum", required: false, defaultValue: "No access", options: [{ value: "No access" }, { value: "Read only" }, { value: "Read & write" }] });
  });
  it("a recipe without params exposes none", () => {
    const p = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => new FakeDriver() });
    expect(p.params).toBeUndefined();
  });
  it("validateEntryParams (params_invalid) uses the specs, including the pattern", async () => {
    const p = createBrowserProvider({ recipe: await loadRecipeFile(FILE), driverFactory: () => new FakeDriver() });
    expect(p.id).toBe("revenuecat-secret-api-key");
    const problems = (params: Record<string, unknown>) => validateEntryParams(p, { params }).map((x) => `${x.key}:${x.code}`);
    expect(problems({})).toEqual(["projectId:missing"]);
    expect(problems({ projectId: "proj1a2b3c" })).toEqual([]);
    expect(problems({ projectId: "Bad Id" })).toEqual(["projectId:wrong_type"]);
    expect(problems({ projectId: "proj1a2b3c", iam: "Admin" })).toEqual(["iam:not_in_options"]);
    expect(problems({ projectId: "proj1a2b3c", iam: "Read only" })).toEqual([]);
  });
  it("issue fails closed before the driver factory is called", async () => {
    let opened = 0;
    const p = createBrowserProvider({ recipe: await loadRecipeFile(FILE), driverFactory: () => (opened++, new FakeDriver()) });
    const secret = SecretSchema.parse({ id: "rc", name: "RC_KEY", service: "revenuecat", stage: "dev", params: {}, places: [] });
    const ctx = { secret, params: secret.params, stage: "dev", now: new Date("2026-11-02T10:00:00Z"), label: "x" } as unknown as IssueContext;
    await expect(p.issue?.(ctx)).rejects.toThrow(/Pflichtparameter projectId/);
    await expect(p.revoke?.({ externalId: "x", secret } as unknown as RevokeContext)).rejects.toThrow(/Pflichtparameter projectId/);
    expect(opened).toBe(0);
  });
  it("issue passes the entry's parameters to the recipe", async () => {
    const d = dashboard();
    const p = createBrowserProvider({ recipe: await loadRecipeFile(FILE), driverFactory: () => d });
    const secret = SecretSchema.parse({ id: "rc-key", name: "RC_KEY", service: "revenuecat", stage: "dev", params: { projectId: "proj1a2b3c", audiences: "Read only" }, places: [] });
    const issued = await p.issue?.({ secret, params: secret.params, stage: "dev", now: new Date("2026-11-02T10:00:00Z"), label: "x" } as unknown as IssueContext);
    expect(issued?.value.reveal()).toBe(KEY);
    expect(d.calls).toContain(`goto ${LIST}/new`);
    expect(d.calls).toContain('click option "Read only"');
  });
});
