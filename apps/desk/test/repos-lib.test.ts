import { describe, expect, it } from "vitest";
import { buildSuggestions, defaultEnvPath, filterSuggestions, linkState } from "../src/lib/repos";

const all = buildSuggestions({
  repos: [
    { name: "acme-app", secrets: 1, variables: 0, templates: 0, inInventory: true, github: { private: true, archived: false, pushedAt: null }, link: { path: "/p/wm", exists: true, remote: null, remoteMatches: null } },
    { name: "acme-app-landing", secrets: 0, variables: 0, templates: 0, inInventory: false, github: { private: false, archived: false, pushedAt: null }, link: null },
    { name: "acme-api", secrets: 2, variables: 0, templates: 0, inInventory: true, github: null, link: null },
    { name: "my-acme-app", secrets: 0, variables: 0, templates: 0, inInventory: false, github: { private: false, archived: true, pushedAt: null }, link: null },
  ],
});

describe("Repository-Vorschlaege", () => {
  it("fuehrt die Quellen je Repository zusammen", () => {
    expect(all.find((s) => s.name === "acme-app")?.sources).toEqual(["inventory", "github", "linked"]);
    expect(all.find((s) => s.name === "acme-api")?.sources).toEqual(["inventory"]);
    expect(buildSuggestions(null)).toEqual([]);
  });
  it("leere Eingabe zeigt alles alphabetisch, begrenzt", () => {
    expect(filterSuggestions(all, "").map((s) => s.name)).toEqual(["acme-api", "acme-app", "acme-app-landing", "my-acme-app"]);
    expect(filterSuggestions(all, "", 2)).toHaveLength(2);
  });
  it("filtert ohne Gross-/Kleinschreibung, genau vor Praefix vor Teilstring", () => {
    expect(filterSuggestions(all, "ACME-APP").map((s) => s.name)).toEqual(["acme-app", "acme-app-landing", "my-acme-app"]);
    expect(filterSuggestions(all, "my-acme").map((s) => s.name)).toEqual(["my-acme-app"]);
    expect(filterSuggestions(all, "  acme-api ").map((s) => s.name)).toEqual(["acme-api"]);
  });
  it("liefert nichts bei Nichttreffer (freie Eingabe bleibt Sache des Feldes)", () => {
    expect(filterSuggestions(all, "zzz")).toEqual([]);
  });
});

describe("Verknuepfungs-Status und Standardpfad", () => {
  it("ordnet Zustaende ein", () => {
    expect(linkState(null)).toBe("none");
    expect(linkState({ exists: false, remote: null, remoteMatches: null })).toBe("missing");
    expect(linkState({ exists: true, remote: null, remoteMatches: null })).toBe("no-remote");
    expect(linkState({ exists: true, remote: "x", remoteMatches: false })).toBe("mismatch");
    expect(linkState({ exists: true, remote: "x", remoteMatches: true })).toBe("ok");
  });
  it("baut den Standardpfad aus Ordner und Vorlagendatei", () => {
    expect(defaultEnvPath("/p/wm/", ".env.local")).toBe("/p/wm/.env.local");
    expect(defaultEnvPath(null, ".env.local")).toBeNull();
  });
});
