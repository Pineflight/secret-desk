import { RecipeSchema, type Recipe } from "../src/index.js";

export const TOKEN = "tok_s3cr3tvalue99";

/** Rezept fuer die Fake-Laeufe. */
export function sampleRecipe(over: Record<string, unknown> = {}): Recipe {
  return RecipeSchema.parse({
    id: "sample-token",
    label: "Beispiel",
    host: "example.test",
    login: { expect: { url: "^https://example\\.test/tokens" }, message: "Bitte anmelden" },
    steps: [
      { goto: "https://example.test/tokens/new?name={{name}}&owner={{owner}}" },
      { fill: { label: "Name", value: "{{name}}" } },
      { fill: { placeholder: "Repo suchen", value: "{{item}}" }, each: "repos" },
      { screenshot: "vorher" },
      { click: { role: "button", name: "Create", createsToken: true } },
    ],
    capture: {
      token: { find: { css: "#tok" }, pattern: "^(tok_[a-z0-9]+)$", timeoutSeconds: 0.05 },
      externalId: { from: "name" },
      expires: { from: "days" },
    },
    mask: [{ css: "#tok" }],
    ...over,
  });
}

export const VARS = {
  name: "demo-20261027",
  owner: "Pineflight",
  days: "30",
  date: "2026-10-27",
  description: "Test & Co",
  repos: "alpha,beta",
  permissions: "",
  permissionsQuery: "",
  stage: "dev",
  secretId: "demo",
};

export const FORM_VISIBLE = ['Feld "Name"', 'Platzhalter "Repo suchen"', 'button "Create"'];
