import { describe, expect, it } from "vitest";
import { FakeDriver, RecipeRunError, runRecipe, selectorProblem, textMatcher, textPattern } from "../src/index.js";
import { TOKEN, VARS, sampleRecipe } from "./helpers.js";

const CREATE = '/^(Create|Erstellen)$/i';

function driver(extra: Partial<ConstructorParameters<typeof FakeDriver>[0]> = {}): FakeDriver {
  return new FakeDriver({
    url: "about:blank",
    visible: ['Feld "Name"', 'Platzhalter "Repo suchen"', 'button "Erstellen"'],
    on: (e, d) => {
      if (e.action === "click" && e.key === 'button "Erstellen"') {
        d.visible.add("css #tok");
        d.texts.set("css #tok", TOKEN);
      }
    },
    ...extra,
  });
}

const recipe = (steps: unknown[]) =>
  sampleRecipe({ login: undefined, steps: [{ goto: "https://example.test/start" }, ...steps, { click: { role: "button", name: CREATE, createsToken: true } }] });

describe("text selectors as /pattern/flags", () => {
  it("reads a pattern with flags and leaves plain texts alone", () => {
    expect(textPattern("/^(Create key|Schlüssel erstellen)$/i")?.test("SCHLÜSSEL ERSTELLEN")).toBe(true);
    expect(textPattern("Create key")).toBeNull();
    expect(textPattern("/path/to")).toBeNull();
    expect(textMatcher("Create key")).toBe("Create key");
    expect(textMatcher("/a|b/")).toBeInstanceOf(RegExp);
    expect(textPattern("/x/g")).toBeNull();
    expect(() => textPattern("/(unclosed/")).toThrow();
  });

  it("rejects an invalid pattern in the schema, ignoring {{variables}}", () => {
    expect(selectorProblem({ role: "button", name: "/(unclosed/" })).toMatch(/Invalid regular expression/);
    expect(selectorProblem({ role: "option", name: "/^{{days}} ?(day|Tag)/i" })).toBeUndefined();
    expect(() => recipe([{ click: { role: "button", name: "/(unclosed/" } }])).toThrow(/Invalid regular expression/);
  });

  it("finds a button by either language and acts on it", async () => {
    const de = driver();
    expect((await runRecipe(recipe([]), VARS, de, {}, { pollMs: 5 })).value.reveal()).toBe(TOKEN);
    const en = driver({ visible: ['Feld "Name"', 'button "Create"'], on: (e, d) => void (e.action === "click" && e.key === 'button "Create"' && (d.visible.add("css #tok"), d.texts.set("css #tok", TOKEN))) });
    expect((await runRecipe(recipe([]), VARS, en, {}, { pollMs: 5 })).value.reveal()).toBe(TOKEN);
  });
});

describe("optional click that cannot act", () => {
  const banner = { click: { css: "#banner", optional: true, timeoutSeconds: 0.03 } };
  const blocked = (calls: string[]) =>
    driver({
      visible: ["css #banner", 'Feld "Name"', 'button "Erstellen"'],
      on: (e, d) => {
        if (e.action === "click" && e.key === "css #banner") {
          calls.push("banner");
          throw new Error("Aktion nicht moeglich");
        }
        if (e.action === "click" && e.key === 'button "Erstellen"') {
          d.visible.add("css #tok");
          d.texts.set("css #tok", TOKEN);
        }
      },
    });

  it("is skipped, not failed, when the element is there but the click does not work", async () => {
    const calls: string[] = [];
    const res = await runRecipe(recipe([banner]), VARS, blocked(calls), {}, { pollMs: 5 });
    expect(calls).toEqual(["banner"]);
    expect(res.value.reveal()).toBe(TOKEN);
  });

  it("is skipped, not failed, when looking for the element breaks with an unexpected error", async () => {
    const d = blocked([]);
    const waitFor = d.waitFor.bind(d);
    d.waitFor = async (cond, ms, signal) => {
      if (cond.visible?.css === "#banner") throw new Error("page is navigating");
      return waitFor(cond, ms, signal);
    };
    const res = await runRecipe(recipe([banner]), VARS, d, {}, { pollMs: 5 });
    expect(res.value.reveal()).toBe(TOKEN);
  });

  it("a click that is not optional still fails when it cannot act", async () => {
    const calls: string[] = [];
    const err = (await runRecipe(recipe([{ click: { css: "#banner" } }]), VARS, blocked(calls), {}, { pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("step");
  });

  it("an abort during the optional click still ends the run", async () => {
    const ctrl = new AbortController();
    const d = driver({
      visible: ["css #banner", 'button "Erstellen"'],
      on: (e) => {
        if (e.key === "css #banner") {
          ctrl.abort();
          throw new Error("Aktion nicht moeglich");
        }
      },
    });
    const err = (await runRecipe(recipe([banner]), VARS, d, {}, { pollMs: 5, signal: ctrl.signal }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err.kind).toBe("abort");
  });
});

describe("when absent / notEquals and fail unsupported", () => {
  const missing = { absent: { role: "button", name: "/^(Create Admin Key|Admin-Schlüssel erstellen)$/i", first: true }, timeoutSeconds: 0.05 };
  const withFail = recipe([{ fail: "Admin keys need an organization.", unsupported: true, when: missing }]);

  it("ends as unsupported (kind, not step) when the create button never shows up", async () => {
    const err = (await runRecipe(withFail, VARS, driver(), {}, { pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError;
    expect(err).toBeInstanceOf(RecipeRunError);
    expect(err.kind).toBe("unsupported");
    expect(err.message).toContain("Admin keys need an organization");
  });

  it("goes on when the create button is there, in either language", async () => {
    const d = driver({
      visible: ['button "Admin-Schlüssel erstellen"', 'button "Erstellen"'],
      on: (e, dd) => void (e.key === 'button "Erstellen"' && (dd.visible.add("css #tok"), dd.texts.set("css #tok", TOKEN))),
    });
    expect((await runRecipe(withFail, VARS, d, {}, { pollMs: 5 })).value.reveal()).toBe(TOKEN);
  });

  it("without a timeout it looks once, now", async () => {
    const once = recipe([{ fail: "gone", unsupported: true, when: { absent: { css: "#x" } } }]);
    expect(((await runRecipe(once, VARS, driver(), {}, { pollMs: 5 }).catch((e: unknown) => e)) as RecipeRunError).kind).toBe("unsupported");
    const present = driver({ visible: ["css #x", 'button "Erstellen"'], on: (e, dd) => void (e.key === 'button "Erstellen"' && (dd.visible.add("css #tok"), dd.texts.set("css #tok", TOKEN))) });
    expect((await runRecipe(once, VARS, present, {}, { pollMs: 5 })).value.reveal()).toBe(TOKEN);
  });

  it("notEquals runs a step only when the variable differs (30 days is the default and is not clicked)", async () => {
    const step = { click: { css: "#days" }, when: { var: "days", notEquals: "30" } };
    const run = (days: string) => {
      const d = driver({ visible: ["css #days", 'button "Erstellen"'], on: (e, dd) => void (e.key === 'button "Erstellen"' && (dd.visible.add("css #tok"), dd.texts.set("css #tok", TOKEN))) });
      return runRecipe(recipe([step]), { ...VARS, days }, d, {}, { pollMs: 5 }).then(() => d.calls);
    };
    expect(await run("30")).not.toContain("click css #days");
    expect(await run("60")).toContain("click css #days");
  });

  it("a when on a variable needs exactly one of equals and notEquals", () => {
    expect(() => recipe([{ click: { css: "#a" }, when: { var: "days" } }])).toThrow(/exactly one of equals and notEquals/);
    expect(() => recipe([{ click: { css: "#a" }, when: { var: "days", equals: "1", notEquals: "2" } }])).toThrow(/exactly one of equals and notEquals/);
  });

  it("`first` lets a selector that matches twice act on the first one", () => {
    expect(() => recipe([{ click: { role: "button", name: "x", first: true } }])).not.toThrow();
  });
});
