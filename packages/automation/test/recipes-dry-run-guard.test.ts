import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSelector, loadRecipes, type Selector } from "../src/index.js";

const RECIPES = resolve(import.meta.dirname, "../../../recipes");

// A dry run (also the weekly live check against real accounts) runs every step up to the first `createsToken` or `stopsDryRun`
// click and must create or change nothing at the provider. This guard lists every click before that point whose name or
// selector looks state-changing. Each one is allowed on purpose, with the reason it is harmless. A click that really changes
// state gets `stopsDryRun: true` in the recipe instead of an entry here.
const LOOKS_STATE_CHANGING = /\b(?:create|generat|save|submit|confirm|add|delet|revok|apply|roll|erstell|speicher|bestätig|hinzufüg|lösch|generier)\w*/i;

const ALLOWED: Record<string, string> = {
  "anthropic-admin-key | button \"/^(Create Admin Key|Create key|Admin-Schlüssel erstellen|Schlüssel erstellen)$/i\"": "opens the key dialog only; the submit inside it carries createsToken",
  "anthropic-api-key | button \"/^(Create key|Schlüssel erstellen)$/i\"": "opens the key dialog only; the submit inside it carries createsToken",
  "openai-admin-key | button \"Create new Admin key\" (exact)": "opens the key dialog only; \"Create admin key\" inside it carries createsToken",
  "openai-api-key | Text \"Create new secret key\"": "opens the key dialog only; \"Create secret key\" inside it carries createsToken",
  "supabase-access-token | button \"Generate new token\"": "opens the token dialog only; \"Create token\" inside it carries createsToken",
  "stripe-restricted-key | button \"Create restricted key\" (exact)": "opens the key wizard only; \"Create key\" at its end carries createsToken",
  "grafana-cloud-access-policy | Text \"Add scope\"": "adds a scope row to the unsaved policy form; nothing exists until \"Create access policy\" (stopsDryRun)",
  "grafana-cloud-access-policy | checkbox \"delete accesspolicies\" (exact)": "ticks a scope checkbox in the unsaved policy form; it deletes nothing",
};

interface Hit {
  key: string;
  recipe: string;
}

async function hits(): Promise<Hit[]> {
  const out: Hit[] = [];
  for (const recipe of await loadRecipes([RECIPES])) {
    for (const step of recipe.steps) {
      if (!("click" in step)) continue;
      if (step.click.createsToken || step.click.stopsDryRun) break;
      const selector = step.click as Selector;
      const described = describeSelector(selector);
      if (LOOKS_STATE_CHANGING.test(described)) out.push({ key: `${recipe.id} | ${described}`, recipe: recipe.id });
    }
  }
  return out;
}

describe("bundled recipes: a dry run changes nothing", () => {
  it("every click that looks state-changing before the first stop marker is allowed on purpose, with a reason", async () => {
    const found = (await hits()).map((h) => h.key);
    expect([...new Set(found)].filter((k) => !(k in ALLOWED))).toEqual([]);
  });

  it("the allowlist holds no stale entry, and every entry has a reason", async () => {
    const found = new Set((await hits()).map((h) => h.key));
    expect(Object.keys(ALLOWED).filter((k) => !found.has(k))).toEqual([]);
    for (const [key, reason] of Object.entries(ALLOWED)) expect(reason.length, key).toBeGreaterThan(15);
  });

  it("every create recipe has a stop marker, and the policy recipe stops at its policy form", async () => {
    const recipes = await loadRecipes([RECIPES]);
    for (const recipe of recipes.filter((r) => r.kind === "create")) {
      expect(recipe.steps.some((s) => "click" in s && (s.click.createsToken || s.click.stopsDryRun)), recipe.id).toBe(true);
    }
    const grafana = recipes.find((r) => r.id === "grafana-cloud-access-policy")!;
    const first = grafana.steps.find((s) => "click" in s && (s.click.createsToken || s.click.stopsDryRun));
    expect(first).toMatchObject({ click: { name: "Create access policy", stopsDryRun: true } });
  });

  it("the detection catches the English and German verbs", () => {
    for (const word of ["Create key", "Generate", "Save", "Submit", "Confirm", "Add scope", "Delete", "Revoke", "Apply", "Roll key", "Schlüssel erstellen", "Speichern", "Bestätigen", "Hinzufügen", "Löschen", "Generieren"]) {
      expect(LOOKS_STATE_CHANGING.test(`button "${word}"`), word).toBe(true);
    }
    expect(LOOKS_STATE_CHANGING.test('button "Continue"')).toBe(false);
  });
});
