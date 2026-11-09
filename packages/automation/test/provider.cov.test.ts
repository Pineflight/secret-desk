import { describe, expect, it, vi } from "vitest";
import { SecretSchema, type EvidenceStore, type IssueContext, type RevokeContext } from "@secret-desk/core";
import { FakeDriver, RecipeSchema, createBrowserProvider, recipeParamSpecs, recipeVars } from "../src/index.js";
import { FORM_VISIBLE, TOKEN, sampleRecipe } from "./helpers.js";

const now = new Date("2026-11-04T10:00:00Z");
const entry = (over: Record<string, unknown> = {}) => SecretSchema.parse({ id: "demo", name: "DEMO_TOKEN", service: "example", stage: "dev", places: [{ repo: "acme/alpha", scope: "repository" }], ...over });
const issueCtx = (secret: ReturnType<typeof entry>) => ({ secret, params: secret.params, stage: "dev", now, label: "demo" }) as unknown as IssueContext;

const readRecipe = (over: Record<string, unknown> = {}) =>
  RecipeSchema.parse({
    id: "read-one",
    label: "Read one",
    kind: "read",
    host: "example.test",
    steps: [{ goto: "https://example.test/keys" }],
    capture: { values: { key: { find: { css: "#k" }, pattern: "^[a-z0-9]{6,}$", timeoutSeconds: 0.05 } } },
    ...over,
  });
const readDriver = () => new FakeDriver({ visible: ["css #k"], texts: { "css #k": "abc123def" } });

const createDriver = (fail = false) =>
  new FakeDriver({
    visible: FORM_VISIBLE,
    on: (e, d) => {
      if (e.action === "goto") d.url = "https://example.test/tokens/new";
      if (e.action === "click") {
        if (fail) throw new Error("click failed");
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
  });

describe("recipeParamSpecs", () => {
  it("falls back to the label for a missing English label and fills help, defaults and patterns", () => {
    const specs = recipeParamSpecs({
      params: [
        { key: "a", label: "Alpha", required: true, help: "Help text" },
        { key: "b", label: "Beta", labelEn: "Beta EN", required: true, default: "x", pattern: "^x$" },
        { key: "c", label: "Gamma", required: false, options: ["one", "two"] },
      ],
    } as never);
    expect(specs[0]).toMatchObject({ key: "a", label: "Alpha", labelEn: "Alpha", type: "string", required: true, help: "Help text", helpEn: "Help text" });
    expect(specs[1]).toMatchObject({ labelEn: "Beta EN", required: false, defaultValue: "x", pattern: "^x$", help: "" });
    expect(specs[2]).toMatchObject({ type: "enum", options: [{ value: "one", label: "one", labelEn: "one" }, { value: "two", label: "two", labelEn: "two" }] });
    expect(specs[2]).not.toHaveProperty("pattern");
  });
});

describe("recipeVars without places", () => {
  it("takes no repositories from a secret that has no GitHub places, and ignores non-text permission levels", () => {
    const v = recipeVars(entry({ places: [], params: { permissions: { contents: "read", bad: 5 }, repos: 42 } }), "dev", now);
    expect(v["repos"]).toBe("");
    expect(v["permissions"]).toBe("contents=read");
    expect(v["owner"]).toBe("");
    expect(recipeVars(entry({ params: { permissions: ["x"] } }), "dev", now)["permissions"]).toBe("");
  });
  it("passes the external id on when one is given", () => {
    expect(recipeVars(entry(), "dev", now, { externalId: "ext-1" })["externalId"]).toBe("ext-1");
    expect(recipeVars(entry(), "dev", now)).not.toHaveProperty("externalId");
  });
});

describe("browser provider: create recipe", () => {
  it("lists what the human has to check, with the owner and permissions when set, and with fallbacks when not", () => {
    const p = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver() });
    const set = p.reviewChecklist!(entry({ owner: "team", params: { permissions: { contents: "read" } } }));
    expect(set[1]).toContain("owner: team");
    expect(set[2]).toContain("contents=read");
    const unset = p.reviewChecklist!(entry());
    expect(unset[1]).toContain("owner: nicht gesetzt");
    expect(unset[2]).toContain("keine angegeben");
    expect(set[0]).toBe('Name beim Anbieter beginnt mit "demo" und traegt das heutige Datum');
  });
  it("returns an issue without external id and expiry when the recipe captures none", async () => {
    const recipe = sampleRecipe({ capture: { token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 } } });
    const p = createBrowserProvider({ recipe, driverFactory: () => createDriver() });
    const issued = await p.issue!(issueCtx(entry()));
    expect(issued.value.reveal()).toBe(TOKEN);
    expect(issued).not.toHaveProperty("externalId");
    expect(issued.expiresAt).toBeNull();
  });
  it("forgets the screenshots of a failed run and passes the error on", async () => {
    const p = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver(true) });
    await expect(p.issue!(issueCtx(entry()))).rejects.toThrow();
    expect(p.takeScreenshots("demo")).toEqual([]);
  });
  it("hooks and run options may depend on the secret", async () => {
    const hooks = vi.fn(() => ({}));
    const runOptions = vi.fn(() => ({}));
    const p = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver(), hooks, runOptions });
    await p.issue!(issueCtx(entry()));
    expect(hooks).toHaveBeenCalledWith("demo");
    expect(runOptions).toHaveBeenCalledWith("demo");
    const fixed = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver(), hooks: {}, runOptions: {} });
    expect((await fixed.issue!(issueCtx(entry()))).value.reveal()).toBe(TOKEN);
  });
  it("revokes through the recipe's revoke steps", async () => {
    const recipe = sampleRecipe({ revoke: { steps: [{ goto: "https://example.test/tokens/{{externalId}}" }] } });
    const d = new FakeDriver({ visible: FORM_VISIBLE });
    const p = createBrowserProvider({ recipe, driverFactory: () => d });
    await p.revoke!({ externalId: "ext-9", secret: entry() } as unknown as RevokeContext);
    expect(d.calls).toContain("goto https://example.test/tokens/ext-9");
    expect(d.closed).toBe(true);
  });
});

describe("browser provider: evidence", () => {
  it("attaches the screenshots of the last run to a report, or counts them when there is no evidence store", async () => {
    const attach = vi.fn(async () => undefined);
    const evidence = { attach } as unknown as EvidenceStore;
    const withStore = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver(), evidence });
    await withStore.issue!(issueCtx(entry()));
    expect(await withStore.attachScreenshots("demo", "report-1")).toBe(2);
    expect(attach.mock.calls.map((c) => [c[0], c[1], c[3], c[4]])).toEqual([
      ["demo", "report-1", "image/png", "Browser: vorher"],
      ["demo", "report-1", "image/png", "Browser: nach-erzeugen"],
    ]);
    expect(await withStore.attachScreenshots("demo", "report-1")).toBe(0);

    const without = createBrowserProvider({ recipe: sampleRecipe(), driverFactory: () => createDriver() });
    await without.issue!(issueCtx(entry()));
    expect(await without.attachScreenshots("demo", "report-1")).toBe(0);
    expect(without.takeScreenshots("demo")).toEqual([]);
  });
});

describe("browser provider: read recipe", () => {
  it("without a pick parameter the one value is the main value, and there is no companion", async () => {
    const p = createBrowserProvider({ recipe: readRecipe(), driverFactory: readDriver });
    expect(p.params).toBeUndefined();
    expect(p.companionParams).toBeUndefined();
    const issued = await p.issue!(issueCtx(entry()));
    expect(issued.value.reveal()).toBe("abc123def");
    expect(issued.expiresAt).toBeNull();
    expect(issued).not.toHaveProperty("companions");
  });
  it("with two values and a companion parameter the other value goes to the named entry, and nowhere when none is named", async () => {
    const recipe = readRecipe({
      params: [
        { key: "value", label: "Value", options: ["a", "b"] },
        { key: "target", label: "Target", required: false, pattern: "^[a-z-]+$" },
      ],
      capture: { pick: "value", companion: "target", values: { a: { find: { css: "#a" }, pattern: "^[a-z0-9]+$", timeoutSeconds: 0.05 }, b: { find: { css: "#b" }, pattern: "^[a-z0-9]+$", timeoutSeconds: 0.05 } } },
    });
    const driver = () => new FakeDriver({ visible: ["css #a", "css #b"], texts: { "css #a": "aaa111", "css #b": "bbb222" } });
    const p = createBrowserProvider({ recipe, driverFactory: driver });
    expect(p.companionParams).toEqual(["target"]);
    const withTarget = await p.issue!(issueCtx(entry({ params: { value: "a", target: "other-entry" } })));
    expect(withTarget.value.reveal()).toBe("aaa111");
    expect(withTarget.companions).toHaveLength(1);
    expect(withTarget.companions![0]).toMatchObject({ entryId: "other-entry" });
    expect(withTarget.companions![0]!.value.reveal()).toBe("bbb222");
    const without = await p.issue!(issueCtx(entry({ params: { value: "b" } })));
    expect(without.value.reveal()).toBe("bbb222");
    expect(without).not.toHaveProperty("companions");
  });
  it("the checklist for a read recipe shows only the choice parameters that are not the pick", () => {
    const recipe = readRecipe({
      params: [
        { key: "portal", label: "Portal", options: ["live", "test"], required: false, default: "live" },
        { key: "value", label: "Value", options: ["a", "b"] },
        { key: "free", label: "Free text", required: false },
      ],
      capture: { pick: "value", values: { a: { find: { css: "#a" }, pattern: "^[a-z]+$" }, b: { find: { css: "#b" }, pattern: "^[a-z]+$" } } },
    });
    const p = createBrowserProvider({ recipe, driverFactory: readDriver });
    const items = p.reviewChecklist!(entry({ params: { value: "a", portal: "test" } }));
    expect(items[0]).toContain("(portal: test)");
    expect(p.reviewChecklist!(entry({ params: { value: "a" } }))[0]).toContain("(portal: live)");
    const noDefault = createBrowserProvider({ recipe: readRecipe({ params: [{ key: "portal", label: "Portal", options: ["live", "test"], required: false }] }), driverFactory: readDriver });
    expect(noDefault.reviewChecklist!(entry())[0]).toContain("(portal: not set)");
    expect(createBrowserProvider({ recipe: readRecipe(), driverFactory: readDriver }).reviewChecklist!(entry())[0]).not.toContain("(");
  });
});
