import { describe, expect, it } from "vitest";
import { InventoryStore, compareMatrix, locationKey, repoLevelStage, stageLocation } from "../src/index.js";
import type { CompareExtras, LiveReads, LocationRead, WorkflowNeeds } from "../src/index.js";

const inv = (yaml: string) => InventoryStore.fromText(`version: 1\n${yaml}`).data;
const secret = (id: string, name: string, stage: string, places: string, extra = "") => `  - { id: ${id}, name: ${name}, stage: ${stage}, service: x, expiry: none${extra}, places: [${places}] }\n`;
const variable = (id: string, name: string, stage: string, value: string | null, places: string, extra = "") => `  - { id: ${id}, name: ${name}, stage: ${stage}, ${value === null ? "" : `value: "${value}", `}places: [${places}]${extra} }\n`;
const env = (repo: string, environment: string) => `{ repo: ${repo}, scope: environment, environment: ${environment} }`;
const repoPlace = (repo: string) => `{ repo: ${repo}, scope: repository }`;
const loc = (repo: string, scope: "repository" | "environment", environment?: string) => locationKey({ repo, scope, ...(environment ? { environment } : {}) });
const names = (...n: string[]): LocationRead => ({ names: new Map(n.map((x) => [x, null])) });
const vars = (o: Record<string, string>): LocationRead => ({ names: new Map(Object.entries(o)) });
const reads = (secret: [string, LocationRead][] = [], variable: [string, LocationRead][] = []): LiveReads => ({ secret: new Map(secret), variable: new Map(variable) });
const row = (r: ReturnType<typeof compareMatrix>, name: string, kind: "secret" | "variable" = "secret") => r.rows.find((x) => x.name === name && x.kind === kind)!;

describe("stage helpers", () => {
  it("the repository level belongs to the first stage without an environment when none is shared", () => {
    expect(repoLevelStage([{ id: "a", kind: "dev" }, { id: "b", kind: "test", environment: "b" }] as never)).toBe("a");
    expect(repoLevelStage([{ id: "d", kind: "dev" }] as never)).toBe("d");
    expect(repoLevelStage([{ id: "s", kind: "shared" }, { id: "d", kind: "dev" }] as never)).toBe("s");
    expect(repoLevelStage([])).toBeUndefined();
  });
  it("an unknown stage has no location", () => {
    expect(stageLocation([{ id: "dev", kind: "dev" }] as never, "nope", "web")).toBeUndefined();
  });
});

describe("rows", () => {
  it("a name that consists only of stage words keeps its name when names are normalized", () => {
    const r = compareMatrix(inv(`secrets:\n${secret("s1", "STAGING", "staging", env("web", "staging"))}`), { normalizeNames: true });
    expect(r.rows[0]!.name).toBe("STAGING");
  });

  it("a variable without a target value is compared by presence only; the first product of a row wins", () => {
    const yaml = `variables:\n${variable("v1", "SITE_URL", "staging", null, env("web", "staging"), ", product: alpha")}${variable("v2", "SITE_URL", "production", null, env("web", "production"), ", product: beta")}`;
    const r = compareMatrix(inv(yaml), {}, reads([], [[loc("web", "environment", "staging"), vars({ SITE_URL: "x" })], [loc("web", "environment", "production"), vars({ SITE_URL: "y" })]]));
    expect(row(r, "SITE_URL", "variable")).toMatchObject({ product: "alpha", parity: "consistent" });
    expect(row(r, "SITE_URL", "variable").cells.staging).toMatchObject({ state: "ok" });
  });

  it("the same value twice is listed once; a different live value is listed once", () => {
    const yaml = `variables:\n${variable("v1", "SITE_URL", "staging", "https://a.example.com", env("web", "staging"))}${variable("v2", "SITE_URL", "staging", "https://a.example.com", env("web", "staging"))}`;
    const r = compareMatrix(inv(yaml), {}, reads([], [[loc("web", "environment", "staging"), vars({ SITE_URL: "https://b.example.com" })]]));
    expect(row(r, "SITE_URL", "variable").cells.staging).toMatchObject({ state: "different", detail: { expectedValues: ["https://a.example.com"], actualValues: ["https://b.example.com"] } });
  });

  it("rows are sorted by repository, then secrets before variables, then name", () => {
    const yaml = `secrets:\n${secret("s1", "B_KEY", "shared", repoPlace("web"))}${secret("s2", "A_KEY", "shared", repoPlace("web"))}${secret("s3", "C_KEY", "shared", repoPlace("api"))}\nvariables:\n${variable("v1", "A_VAR", "shared", "x", repoPlace("web"))}${variable("v2", "B_VAR", "shared", "x", repoPlace("web"))}`;
    const expected = ["api:secret:C_KEY", "web:secret:A_KEY", "web:secret:B_KEY", "web:variable:A_VAR", "web:variable:B_VAR"];
    expect(compareMatrix(inv(yaml)).rows.map((r) => `${r.repo}:${r.kind}:${r.name}`)).toEqual(expected);
    // The order the kinds are asked for does not change the result.
    expect(compareMatrix(inv(yaml), { kinds: ["variable", "secret"] }).rows.map((r) => `${r.repo}:${r.kind}:${r.name}`)).toEqual(expected);
  });
});

describe("read errors", () => {
  it("an unreadable target is an error cell with the status when there is one; an unreadable expected target too", () => {
    const yaml = `secrets:\n${secret("s1", "API_KEY", "staging", env("web", "staging"))}${secret("s2", "API_KEY", "production", env("web", "production"))}`;
    const withStatus = compareMatrix(inv(yaml), {}, reads([[loc("web", "environment", "staging"), { error: "forbidden", status: 403 }], [loc("web", "environment", "production"), names("API_KEY")]]));
    expect(row(withStatus, "API_KEY").cells.staging).toMatchObject({ state: "error", detail: { error: { target: "web/env:staging", message: "forbidden", status: 403 } } });
    const noStatus = compareMatrix(inv(yaml), {}, reads([[loc("web", "environment", "staging"), { error: "network" }], [loc("web", "environment", "production"), names("API_KEY")]]));
    const cell = row(noStatus, "API_KEY").cells.staging!;
    expect(cell).toMatchObject({ state: "error" });
    expect((cell.detail as { error: object }).error).not.toHaveProperty("status");
  });

  it("an unreadable target without an expectation is an error cell", () => {
    const yaml = `secrets:\n${secret("s1", "API_KEY", "staging", env("web", "staging"))}`;
    const r = compareMatrix(inv(yaml), {}, reads([[loc("web", "environment", "staging"), names("API_KEY")], [loc("web", "environment", "production"), { error: "forbidden", status: 403 }]]));
    expect(row(r, "API_KEY").cells.production).toMatchObject({ state: "error", detail: { error: { status: 403 } } });
    const plain = compareMatrix(inv(yaml), {}, reads([[loc("web", "environment", "staging"), names("API_KEY")], [loc("web", "environment", "production"), { error: "network" }]]));
    expect((row(plain, "API_KEY").cells.production!.detail as { error: object }).error).not.toHaveProperty("status");
  });
});

describe("repositories without inventory", () => {
  const base = `secrets:\n${secret("s1", "API_KEY", "staging", env("web", "staging"))}`;
  const needs = (...files: [string, WorkflowNeeds["refs"], WorkflowNeeds["notes"]?][]): Map<string, WorkflowNeeds> => new Map(files.map(([repo, refs, notes]) => [repo, { refs, notes: notes ?? [] }]));

  it("reads of extra repositories give 'only in GitHub' names; the repository filter and the ignore list apply; no environment list is fine", () => {
    const live = reads([[loc("web", "environment", "staging"), names("API_KEY")]]);
    const extras: CompareExtras = {
      readRepos: ["extra", "skipme", "elsewhere"],
      reads: reads([[loc("extra", "environment", "staging"), names("STRAY")], [loc("extra", "environment", "production"), { error: "forbidden", status: 403 }], [loc("extra", "environment", "preview"), names("PREVIEW_ONLY")]], []),
      envs: new Map([["extra", ["preview"]]]),
      repos: [{ name: "extra", private: true, archived: false, pushedAt: null }],
    };
    const r = compareMatrix(inv(base), { ignoreRepos: ["skipme"] }, live, extras);
    expect(r.rows.some((x) => x.repo === "extra" && x.name === "STRAY")).toBe(true);
    expect(row({ ...r, rows: r.rows.filter((x) => x.repo === "extra") }, "PREVIEW_ONLY").other).toEqual({ present: ["preview"], needed: [] });
    expect(r.repos.find((x) => x.name === "extra")!.notes).toEqual([{ code: "read-error", target: "extra/env:production", message: "forbidden", status: 403 }]);
    const filtered = compareMatrix(inv(base), { repo: "extra" }, live, { readRepos: ["extra", "other"], reads: extras.reads! });
    expect(filtered.rows.every((x) => x.repo === "extra")).toBe(true);
    const noEnvs = compareMatrix(inv(base), {}, live, { readRepos: ["extra"], reads: reads([[loc("extra", "environment", "staging"), names("STRAY")]]) });
    expect(noEnvs.rows.some((x) => x.name === "STRAY")).toBe(true);
  });

  it("a read error without a status is noted without one", () => {
    const r = compareMatrix(inv(base), {}, reads(), { readRepos: ["extra"], reads: reads([[loc("extra", "environment", "staging"), { error: "network" }]]), repos: [{ name: "extra", private: true, archived: false, pushedAt: null }] });
    expect(r.repos.find((x) => x.name === "extra")!.notes).toEqual([{ code: "read-error", target: "extra/env:staging", message: "network" }]);
  });

  it("notes are listed once, with and without a job; given notes are added", () => {
    const wn = needs(["web", [], [{ code: "inherit", file: "ci.yml", job: "call" }, { code: "inherit", file: "ci.yml", job: "call" }, { code: "all-secrets", file: "ci.yml" }]]);
    const r = compareMatrix(inv(base), {}, undefined, { needs: wn, notes: new Map([["web", [{ code: "inherit", file: "ci.yml", job: "call" }, { code: "read-error", target: "web/repo", message: "x" }]]]) });
    expect(r.repos.find((x) => x.name === "web")!.notes).toEqual([
      { code: "inherit", file: "ci.yml", job: "call" },
      { code: "all-secrets", file: "ci.yml" },
      { code: "read-error", target: "web/repo", message: "x" },
    ]);
  });

  it("needs of out-of-scope repositories and of kinds that are not compared are ignored; a need becomes a row of its own", () => {
    const wn = needs(["web", [{ kind: "secret", name: "NEW_KEY", file: "ci.yml", environment: "staging" }, { kind: "variable", name: "A_VAR", file: "ci.yml" }]], ["unknown", [{ kind: "secret", name: "X", file: "ci.yml" }]]);
    const r = compareMatrix(inv(base), { kinds: ["secret"] }, reads([[loc("web", "environment", "staging"), names("API_KEY")]]), { needs: wn });
    expect(r.rows.map((x) => x.name)).toEqual(["API_KEY", "NEW_KEY"]);
    expect(row(r, "NEW_KEY").cells.staging).toMatchObject({ state: "needed" });
  });

  it("a name needed in an environment without a stage is missing when it is neither in that environment, on the repository nor in the organization", () => {
    const wn = needs(["extra", [
      { kind: "secret", name: "PREVIEW_KEY", file: "ci.yml", environment: "preview" },
      { kind: "secret", name: "PREVIEW_KEY", file: "ci.yml", environment: "preview" },
      { kind: "secret", name: "OTHER_KEY", file: "ci.yml", environment: "Unlisted" },
      { kind: "secret", name: "ORG_KEY", file: "ci.yml", environment: "preview" },
      { kind: "secret", name: "OPTIONAL_KEY", file: "ci.yml", environment: "preview", optional: true },
    ]]);
    const extras: CompareExtras = {
      readRepos: ["extra"],
      reads: reads([[loc("extra", "environment", "preview"), names("OTHER")]]),
      envs: new Map([["extra", ["preview"]]]),
      needs: wn,
      org: { secret: names("ORG_KEY") },
    };
    const r = compareMatrix(inv(base), {}, reads([[loc("web", "environment", "staging"), names("API_KEY")]]), extras);
    const needed = (n: string) => r.rows.find((x) => x.repo === "extra" && x.name === n)!;
    expect(needed("PREVIEW_KEY")).toMatchObject({ neededMissing: true, other: { needed: ["preview"] } });
    expect(needed("PREVIEW_KEY").needs).toEqual([{ file: "ci.yml", environment: "preview" }]);
    expect(needed("OTHER_KEY").other!.needed).toEqual(["Unlisted"]);
    expect(needed("ORG_KEY").neededMissing).toBe(false);
    expect(needed("OPTIONAL_KEY").neededMissing).toBe(false);
  });

  it("needs in an environment without a stage are only judged for repositories whose targets were read, and only live", () => {
    const wn = needs(["web", [{ kind: "secret", name: "PREVIEW_KEY", file: "ci.yml", environment: "preview" }]], ["extra", [{ kind: "secret", name: "PREVIEW_KEY", file: "ci.yml", environment: "preview" }]]);
    const live = reads([[loc("web", "environment", "staging"), names("API_KEY")]]);
    const inScope = compareMatrix(inv(base), {}, live, { needs: wn });
    expect(inScope.rows.find((x) => x.repo === "web" && x.name === "PREVIEW_KEY")!.neededMissing).toBe(false);
    const offline = compareMatrix(inv(base), {}, undefined, { readRepos: ["extra"], reads: reads(), needs: wn });
    expect(offline.rows.find((x) => x.repo === "extra")!.neededMissing).toBe(false);
    const noEnvList = compareMatrix(inv(base), {}, live, { readRepos: ["extra"], reads: reads(), needs: wn });
    expect(noEnvList.rows.find((x) => x.repo === "extra")).toMatchObject({ neededMissing: true, other: { needed: ["preview"] } });
  });

  it("without a stage for the repository level, a name needed there is looked up on the repository", () => {
    const yaml = `stages:\n  - { id: staging, kind: test }\n  - { id: production, kind: live }\nsecrets:\n${secret("s1", "API_KEY", "staging", env("web", "staging"))}`;
    const wn = needs(["extra", [{ kind: "secret", name: "REPO_KEY", file: "ci.yml" }, { kind: "secret", name: "HAS_KEY", file: "ci.yml" }]]);
    const r = compareMatrix(inv(yaml), {}, reads([[loc("web", "environment", "staging"), names("API_KEY")]]), { readRepos: ["extra"], reads: reads([[loc("extra", "repository"), names("HAS_KEY")]]), needs: wn });
    expect(r.rows.find((x) => x.name === "REPO_KEY")).toMatchObject({ neededMissing: true, other: { needed: [""] } });
    expect(r.rows.find((x) => x.name === "HAS_KEY")!.neededMissing).toBe(false);
  });

  it("the repository list: filter, ignore list, renames and archived repositories", () => {
    const repos = [
      { name: "web", private: true, archived: false, pushedAt: "2026-03-01" },
      { name: "old", private: false, archived: true, pushedAt: null },
      { name: "skipme", private: false, archived: false, pushedAt: null },
      { name: "other", private: false, archived: false, pushedAt: null },
    ];
    const all = compareMatrix(inv(base), { ignoreRepos: ["skipme"] }, undefined, { repos, renames: { web: "web-next" } });
    expect(all.repos.map((x) => x.name)).toEqual(["other", "web"]);
    expect(all.repos.find((x) => x.name === "web")).toMatchObject({ renamedTo: "web-next", onGitHub: true, private: true });
    expect(all.ignored).toEqual(["skipme"]);
    const filtered = compareMatrix(inv(base), { repo: "web", ignoreRepos: ["skipme"] }, undefined, { repos });
    expect(filtered.repos.map((x) => x.name)).toEqual(["web"]);
    expect(filtered.ignored).toEqual([]);
    const ignoredFiltered = compareMatrix(inv(base), { repo: "skipme", ignoreRepos: ["skipme", "web"] }, undefined, { repos });
    expect(ignoredFiltered.ignored).toEqual(["skipme"]);
  });
});
