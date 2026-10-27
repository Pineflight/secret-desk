import { describe, expect, it } from "vitest";
import { SecretSchema, type IssueContext, type RevokeContext } from "@secret-desk/core";
import { FakeDriver, createBrowserProvider, recipeVars } from "../src/index.js";
import { FORM_VISIBLE, TOKEN, sampleRecipe } from "./helpers.js";

const secret = SecretSchema.parse({
  id: "demo",
  name: "DEMO_TOKEN",
  service: "example",
  stage: "dev",
  ttlDays: 30,
  owner: "team",
  description: "Zum Testen",
  params: { owner: "acme", permissions: { contents: "read", metadata: "read" } },
  places: [{ repo: "acme/alpha", scope: "repository" }, { repo: "beta", scope: "repository" }],
});
const now = new Date("2026-10-27T10:00:00Z");

describe("recipeVars", () => {
  it("baut Variablen aus dem Eintrag", () => {
    expect(recipeVars(secret, "dev", now)).toMatchObject({
      name: "demo-20261027",
      owner: "acme",
      days: "30",
      date: "2026-10-27",
      repos: "alpha,beta",
      permissions: "contents=read,metadata=read",
      permissionsQuery: "contents=read&metadata=read",
      stage: "dev",
      secretId: "demo",
    });
  });
});

describe("createBrowserProvider", () => {
  const make = () =>
    createBrowserProvider({
      recipe: sampleRecipe(),
      driverFactory: () =>
        new FakeDriver({
          visible: FORM_VISIBLE,
          on: (e, d) => {
            if (e.action === "goto") d.url = "https://example.test/tokens/new";
            if (e.action === "click") {
              d.visible.add("css #tok");
              d.texts.set("css #tok", TOKEN);
            }
          },
        }),
    });

  it("passt zum Provider-Interface und erzeugt", async () => {
    const p = make();
    expect(p).toMatchObject({ id: "sample-token", kind: "automatic", automation: { recipeId: "sample-token" } });
    const issued = await p.issue?.({ secret, params: secret.params, stage: "dev", now, label: "x" } as unknown as IssueContext);
    expect(issued?.value.reveal()).toBe(TOKEN);
    expect(issued?.externalId).toBe("demo-20261027");
    expect(issued?.expiresAt).toBe("2026-11-26");
    expect(p.takeScreenshots("demo").map((s) => s.name)).toEqual(["vorher", "nach-erzeugen"]);
    expect(p.takeScreenshots("demo")).toEqual([]);
  });

  it("revoke ohne Rezept sagt, dass von Hand zu widerrufen ist", async () => {
    await expect(make().revoke?.({ externalId: "abc", secret } as unknown as RevokeContext)).rejects.toThrow(/von Hand/);
  });
});
