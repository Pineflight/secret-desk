import { describe, expect, it } from "vitest";
import { compareMatrix, compareRepos, locationKey, repoLevelStage, requiredLocations, stageLocation, type LiveReads, type LocationRead } from "../src/compare.js";
import { InventoryStore } from "../src/inventory.js";

const YAML = `version: 1
secrets:
  - id: stripe-staging
    name: STRIPE_KEY
    stage: staging
    service: stripe
    expiry: none
    tags: [pay]
    places: [{ repo: web, scope: environment }]
  - id: stripe-prod
    name: STRIPE_KEY
    stage: production
    service: stripe
    expiry: none
    places: [{ repo: web, scope: environment }]
  - id: only-staging
    name: DEBUG_TOKEN
    stage: staging
    service: intern
    expiry: none
    places: [{ repo: web, scope: environment }]
  - id: shared-cf
    name: CLOUDFLARE_API_TOKEN
    stage: shared
    service: cloudflare
    expiry: none
    places: [{ repo: web, scope: repository }]
  - id: url-staging
    name: SUPABASE_STAGING_URL
    stage: staging
    service: supabase
    expiry: none
    places: [{ repo: web, scope: environment }]
  - id: url-prod
    name: SUPABASE_PRODUCTION_URL
    stage: production
    service: supabase
    expiry: none
    places: [{ repo: web, scope: environment }]
variables:
  - id: site-staging
    name: SITE_URL
    stage: staging
    value: https://staging.example.com
    places: [{ repo: web, scope: environment }]
  - id: site-prod
    name: SITE_URL
    stage: production
    value: https://example.com
    places: [{ repo: web, scope: environment }]
`;
const inv = () => InventoryStore.fromText(YAML).data;

const names = (...n: string[]): LocationRead => ({ names: new Map(n.map((x) => [x, null])) });
const vars = (o: Record<string, string>): LocationRead => ({ names: new Map(Object.entries(o)) });
const k = (scope: "repository" | "environment", environment?: string, repo = "web"): string => locationKey({ repo, scope, ...(environment ? { environment } : {}) });
function reads(secret: [string, LocationRead][], variable: [string, LocationRead][] = []): LiveReads {
  return { secret: new Map(secret), variable: new Map(variable) };
}
const row = (r: ReturnType<typeof compareMatrix>, name: string, kind: "secret" | "variable" = "secret") => r.rows.find((x) => x.name === name && x.kind === kind)!;

describe("compareMatrix without live", () => {
  const r = compareMatrix(inv(), {});
  it("columns are all stages, rows per repository and name", () => {
    expect(r.stages.map((s) => s.id)).toEqual(["dev", "staging", "production", "shared"]);
    expect(r.live).toBe(false);
    expect(r.rows.map((x) => `${x.kind}:${x.name}`)).toEqual([
      "secret:CLOUDFLARE_API_TOKEN",
      "secret:DEBUG_TOKEN",
      "secret:STRIPE_KEY",
      "secret:SUPABASE_PRODUCTION_URL",
      "secret:SUPABASE_STAGING_URL",
      "variable:SITE_URL",
    ]);
  });
  it("expectation without live is unknown, otherwise empty or not applicable", () => {
    const s = row(r, "STRIPE_KEY");
    expect(s.cells.staging).toMatchObject({ state: "unknown", expected: true });
    expect(s.cells.production).toMatchObject({ state: "unknown", expected: true });
    expect(s.cells.dev).toEqual({ state: "not-applicable", expected: false });
    expect(s.cells.shared).toMatchObject({ state: "not-expected", expected: false });
    expect(s.ids.sort()).toEqual(["stripe-prod", "stripe-staging"]);
    expect(s.tags).toEqual(["pay"]);
  });
  it("parity: equal is consistent, otherwise gap with the missing stage", () => {
    expect(row(r, "STRIPE_KEY")).toMatchObject({ parity: "consistent", missingIn: [] });
    expect(row(r, "DEBUG_TOKEN")).toMatchObject({ parity: "gap", missingIn: ["production"] });
    expect(row(r, "CLOUDFLARE_API_TOKEN").parity).toBe("n/a");
    expect(r.summary.gaps).toBe(3);
    expect(r.summary.perStage.staging).toMatchObject({ expected: 4, present: 0 });
    expect(r.summary.orphans).toBe(0);
  });
  it("names with a stage word are not equated, with the switch they are", () => {
    expect(row(r, "SUPABASE_STAGING_URL").parity).toBe("gap");
    const n = compareMatrix(inv(), { normalizeNames: true });
    const u = row(n, "SUPABASE_URL");
    expect(u).toMatchObject({ parity: "consistent", names: ["SUPABASE_PRODUCTION_URL", "SUPABASE_STAGING_URL"] });
    expect(u.ids.sort()).toEqual(["url-prod", "url-staging"]);
    expect(n.rows.some((x) => x.name === "SUPABASE_STAGING_URL")).toBe(false);
  });
  it("compare picks the compared stages", () => {
    const only = compareMatrix(inv(), { compare: ["staging", "shared"] });
    expect(only.compared).toEqual(["staging", "shared"]);
    expect(row(only, "STRIPE_KEY")).toMatchObject({ parity: "gap", missingIn: ["shared"] });
    expect(compareMatrix(inv(), { compare: ["gibt-es-nicht"] }).compared).toEqual(["staging", "production"]);
    expect(compareMatrix(inv(), { compare: ["staging"] }).rows.every((x) => x.parity === "n/a")).toBe(true);
  });
  it("kinds and repo filter", () => {
    expect(compareMatrix(inv(), { kinds: ["variable"] }).rows.map((x) => x.name)).toEqual(["SITE_URL"]);
    expect(compareMatrix(inv(), { repo: "anderes" }).rows).toEqual([]);
  });
});

describe("compareMatrix live", () => {
  const base = (): LiveReads =>
    reads(
      [
        [k("environment", "staging"), names("STRIPE_KEY", "DEBUG_TOKEN", "SUPABASE_STAGING_URL", "LEFTOVER")],
        [k("environment", "production"), names("STRIPE_KEY", "SUPABASE_PRODUCTION_URL")],
        [k("repository"), names("CLOUDFLARE_API_TOKEN", "OLD_REPO_SECRET")],
      ],
      [
        [k("environment", "staging"), vars({ SITE_URL: "https://staging.example.com" })],
        [k("environment", "production"), vars({ SITE_URL: "https://other.example.com" })],
        [k("repository"), vars({})],
      ],
    );
  const r = compareMatrix(inv(), {}, base());
  it("ok, missing and different", () => {
    expect(row(r, "STRIPE_KEY").cells.production).toMatchObject({ state: "ok", expected: true, present: true });
    expect(row(r, "DEBUG_TOKEN").cells.staging.state).toBe("ok");
    expect(row(r, "DEBUG_TOKEN").cells.production).toMatchObject({ state: "not-expected", expected: false });
    expect(row(r, "SITE_URL", "variable").cells.staging.state).toBe("ok");
    const diff = row(r, "SITE_URL", "variable").cells.production;
    expect(diff).toMatchObject({ state: "different", present: true });
    expect(diff.detail).toMatchObject({ expectedValues: ["https://example.com"], actualValues: ["https://other.example.com"] });
  });
  it("missing secret is missing and a gap", () => {
    const gone = base();
    gone.secret.set(k("environment", "production"), names("SUPABASE_PRODUCTION_URL"));
    const m = compareMatrix(inv(), {}, gone);
    const s = row(m, "STRIPE_KEY");
    expect(s.cells.production).toMatchObject({ state: "missing", expected: true, present: false });
    expect(s.cells.production.detail?.missingAt).toEqual(["web/env:production"]);
    expect(s).toMatchObject({ parity: "gap", missingIn: ["production"] });
    expect(m.summary.perStage.production).toMatchObject({ missing: 1 });
  });
  it("orphans: unknown names in the target are own rows with unexpected", () => {
    const o = row(r, "LEFTOVER");
    expect(o.ids).toEqual([]);
    expect(o.cells.staging).toMatchObject({ state: "unexpected", present: true, expected: false });
    expect(o.cells.production.state).toBe("not-expected");
    expect(o.parity).toBe("gap");
    expect(row(r, "OLD_REPO_SECRET").cells.shared.state).toBe("unexpected");
    expect(r.summary.orphans).toBe(2);
    expect(r.summary.perStage.staging.unexpected).toBe(1);
  });
  it("existing name in a stage without expectation is unexpected", () => {
    const x = base();
    x.secret.set(k("environment", "production"), names("STRIPE_KEY", "DEBUG_TOKEN", "SUPABASE_PRODUCTION_URL"));
    const d = row(compareMatrix(inv(), {}, x), "DEBUG_TOKEN");
    expect(d.cells.production.state).toBe("unexpected");
    expect(d.ids).toEqual(["only-staging"]);
    expect(d.parity).toBe("consistent");
  });
  it("unreadable target yields error cells, parity skips them", () => {
    const x = base();
    x.secret.set(k("environment", "production"), { error: "GitHub GET /x -> 403: no", status: 403 });
    const m = compareMatrix(inv(), {}, x);
    const s = row(m, "STRIPE_KEY");
    expect(s.cells.production).toMatchObject({ state: "error", expected: true });
    expect(s.cells.production.detail?.error).toMatchObject({ status: 403, target: "web/env:production" });
    expect(s.parity).toBe("n/a");
    expect(row(m, "DEBUG_TOKEN").cells.production.state).toBe("error");
    expect(m.errors).toEqual([{ target: "secret web/environment/production", message: "GitHub GET /x -> 403: no" }]);
    expect(m.summary.perStage.production.error).toBeGreaterThan(0);
  });
  it("environment does not exist (404): name missing, notFound remembered", () => {
    const x = base();
    x.secret.set(k("environment", "production"), { names: new Map(), notFound: true });
    const c = row(compareMatrix(inv(), {}, x), "STRIPE_KEY").cells.production;
    expect(c.state).toBe("missing");
    expect(c.detail?.notFound).toEqual(["web/env:production"]);
  });
  it("normalized names merge live rows", () => {
    const m = compareMatrix(inv(), { normalizeNames: true }, base());
    const u = row(m, "SUPABASE_URL");
    expect(u.cells.staging.state).toBe("ok");
    expect(u.cells.production.state).toBe("ok");
    expect(u.parity).toBe("consistent");
  });
});

describe("stage definitions and targets", () => {
  const CUSTOM = `version: 1
stages:
  - { id: dev, kind: dev }
  - { id: qa, label: QA, kind: test }
  - { id: prod, kind: live, environment: production-eu }
  - { id: common, kind: shared }
secrets:
  - { id: a-qa, name: API_KEY, stage: qa, service: x, expiry: none, places: [{ repo: app, scope: environment }, { repo: app, scope: repository, name: API_KEY_QA }] }
  - { id: a-prod, name: API_KEY, stage: prod, service: x, expiry: none, places: [{ repo: app, scope: environment }] }
  - { id: org, name: ORG_TOKEN, stage: common, service: x, expiry: none, places: [{ repo: app, scope: organization }] }
`;
  const c = InventoryStore.fromText(CUSTOM).data;
  it("environment comes from the stage, repo level belongs to the shared stage", () => {
    expect(repoLevelStage(c.stages)).toBe("common");
    expect(stageLocation(c.stages, "qa", "app")).toEqual({ repo: "app", scope: "environment", environment: "qa" });
    expect(stageLocation(c.stages, "prod", "app")).toEqual({ repo: "app", scope: "environment", environment: "production-eu" });
    expect(stageLocation(c.stages, "dev", "app")).toBeUndefined();
    expect(stageLocation(c.stages, "common", "app")).toEqual({ repo: "app", scope: "repository" });
  });
  it("requiredLocations: every target once, organization once", () => {
    const need = requiredLocations(c, {});
    const keys = need.secret.map(locationKey).sort();
    expect(keys).toEqual(["app/environment/production-eu", "app/environment/qa", "app/repository/", "organization"]);
    expect(requiredLocations(c, { kinds: ["variable"] }).secret).toEqual([]);
    expect(requiredLocations(c, { repo: "nope" }).secret).toEqual([]);
  });
  it("several places: target with its own name gets its own row, missing there -> missing", () => {
    const live = reads([
      [k("environment", "qa", "app"), names("API_KEY")],
      [k("environment", "production-eu", "app"), names("API_KEY")],
      [k("repository", undefined, "app"), names("OTHER")],
      ["organization", names("ORG_TOKEN")],
    ]);
    const m = compareMatrix(c, { kinds: ["secret"] }, live);
    const r = m.rows.find((x) => x.name === "API_KEY")!;
    expect(r.cells.qa.state).toBe("ok");
    expect(r.cells.prod.state).toBe("ok");
    const own = m.rows.find((x) => x.name === "API_KEY_QA")!;
    expect(own.cells.qa.state).toBe("missing");
    expect(own.cells.qa.detail?.missingAt).toEqual(["app/repo"]);
    expect(m.rows.find((x) => x.name === "ORG_TOKEN")!.cells.common.state).toBe("ok");
    expect(m.rows.find((x) => x.name === "OTHER")!.cells.common.state).toBe("unexpected");
    expect(m.compared).toEqual(["qa", "prod"]);
  });
});

describe("compareMatrix: repositories without inventory and workflows", () => {
  const meta = (name: string, over: Partial<{ private: boolean; archived: boolean; pushedAt: string | null }> = {}) => ({ name, private: true, archived: false, pushedAt: "2026-10-20T08:00:00Z", ...over });
  const repos = [meta("web"), meta("night-before"), meta("costs"), meta("old", { archived: true }), meta(".github"), meta("status")];
  const kn = (repo: string, scope: "repository" | "environment", env?: string) => k(scope, env, repo);

  it("findings in repos without an entry are unexpected, also in other environments; empty repos appear in the list", () => {
    const extra = {
      repos,
      readRepos: ["night-before", "costs", "status"],
      envs: new Map([["night-before", ["staging", "preview"]], ["costs", []], ["status", []]]),
      reads: reads(
        [
          [kn("night-before", "repository"), names("CLOUDFLARE_API_TOKEN")],
          [kn("night-before", "environment", "staging"), names("RESEND_API_KEY")],
          [kn("night-before", "environment", "preview"), names("PREVIEW_ONLY")],
          [kn("costs", "repository"), names()],
          [kn("status", "repository"), { error: "HTTP 403", status: 403 }],
        ],
        [[kn("night-before", "repository"), vars({ SITE: "x" })], [kn("costs", "repository"), vars({})]],
      ),
    };
    const r = compareMatrix(inv(), {}, reads([]), extra);
    const nb = r.rows.filter((x) => x.repo === "night-before");
    expect(nb.map((x) => `${x.kind}:${x.name}`).sort()).toEqual(["secret:CLOUDFLARE_API_TOKEN", "secret:PREVIEW_ONLY", "secret:RESEND_API_KEY", "variable:SITE"]);
    expect(row({ ...r, rows: nb }, "RESEND_API_KEY").cells.staging!.state).toBe("unexpected");
    expect(row({ ...r, rows: nb }, "CLOUDFLARE_API_TOKEN").cells.shared!.state).toBe("unexpected");
    expect(row({ ...r, rows: nb }, "PREVIEW_ONLY").other).toEqual({ present: ["preview"], needed: [] });
    // Repository-Liste: archivierte und .github fehlen, costs hat keine Funde, status hat einen Lesefehler als Hinweis
    expect(r.repos.map((x) => x.name)).toEqual(["costs", "night-before", "status", "web"]);
    const costs = r.repos.find((x) => x.name === "costs")!;
    expect(costs).toMatchObject({ inInventory: false, private: true, found: { secrets: 0, variables: 0 }, needed: 0, onGitHub: true });
    expect(r.repos.find((x) => x.name === "night-before")!.found).toEqual({ secrets: 3, variables: 1 });
    expect(r.repos.find((x) => x.name === "status")!.notes).toMatchObject([{ code: "read-error", status: 403 }]);
    expect(r.repos.find((x) => x.name === "web")!.inInventory).toBe(true);
    // Fehler der Zusatz-Repos landen nicht in der globalen Fehlerliste
    expect(r.errors).toEqual([]);
  });

  it("needed: workflow needs the name, it is missing in inventory and in GitHub; inventory rows only get the badge", () => {
    const needs = new Map([
      [
        "web",
        {
          refs: [
            { kind: "secret" as const, name: "STRIPE_KEY", file: "deploy.yml", environment: "staging" },
            { kind: "secret" as const, name: "NEW_KEY", file: "deploy.yml", environment: "production" },
            { kind: "variable" as const, name: "NEXT_PUBLIC_APP_URL", file: "ci.yml" },
            { kind: "secret" as const, name: "ORG_KEY", file: "ci.yml", environment: "staging" },
            { kind: "secret" as const, name: "REPO_KEY", file: "ci.yml", environment: "staging" },
          ],
          notes: [{ code: "inherit" as const, file: "ci.yml", job: "call" }],
        },
      ],
    ]);
    const live = reads(
      [
        [k("environment", "staging"), names("STRIPE_KEY", "DEBUG_TOKEN", "SUPABASE_STAGING_URL")],
        [k("environment", "production"), names("STRIPE_KEY", "SUPABASE_PRODUCTION_URL")],
        [k("repository"), names("CLOUDFLARE_API_TOKEN", "REPO_KEY")],
      ],
      [[k("environment", "staging"), vars({ SITE_URL: "https://staging.example.com" })], [k("environment", "production"), vars({ SITE_URL: "https://example.com" })], [k("repository"), vars({})]],
    );
    const r = compareMatrix(inv(), {}, live, { needs, org: { secret: names("ORG_KEY") } });
    const nk = row(r, "NEW_KEY");
    expect(nk.cells.production).toMatchObject({ state: "needed", expected: false, detail: { neededBy: ["deploy.yml"], actualNames: ["NEW_KEY"] } });
    expect(nk.neededMissing).toBe(true);
    expect(nk.needs).toEqual([{ file: "deploy.yml", environment: "production" }]);
    // Variable ohne Environment -> Repo-Ebene (Stage shared)
    expect(row(r, "NEXT_PUBLIC_APP_URL", "variable").cells.shared!.state).toBe("needed");
    // im Inventar und vorhanden: ok, nur das Abzeichen
    const sk = row(r, "STRIPE_KEY");
    expect(sk.cells.staging!.state).toBe("ok");
    expect(sk.needs).toEqual([{ file: "deploy.yml", environment: "staging" }]);
    expect(sk.neededMissing).toBe(false);
    // von Organisation bzw. Repo-Ebene gedeckt: kein needed, aber das Abzeichen bleibt
    expect(row(r, "ORG_KEY").cells.staging!.state).toBe("not-expected");
    expect(row(r, "ORG_KEY").neededMissing).toBe(false);
    expect(row(r, "REPO_KEY").cells.staging!.state).toBe("not-expected");
    expect(r.summary.neededMissing).toBe(2);
    expect(r.summary.perStage.production!.needed).toBe(1);
    expect(r.repos.find((x) => x.name === "web")!.needed).toBe(2);
    expect(r.repos.find((x) => x.name === "web")!.notes).toEqual([{ code: "inherit", file: "ci.yml", job: "call" }]);
  });

  it("without live: needed without GitHub knowledge; kind filter and repo filter apply to workflows too", () => {
    const needs = new Map([["web", { refs: [{ kind: "secret" as const, name: "NEW_KEY", file: "a.yml", environment: "staging" }, { kind: "variable" as const, name: "NEW_VAR", file: "a.yml", environment: "staging" }], notes: [] }], ["other", { refs: [{ kind: "secret" as const, name: "X", file: "a.yml" }], notes: [] }]]);
    const r = compareMatrix(inv(), { kinds: ["secret"] }, undefined, { needs });
    expect(row(r, "NEW_KEY").cells.staging!.state).toBe("needed");
    expect(r.rows.some((x) => x.name === "NEW_VAR")).toBe(false);
    expect(r.rows.some((x) => x.repo === "other")).toBe(false);
  });

  it("environment without stage: for a read repo the name is missing -> other.needed, otherwise not counted", () => {
    const needs = new Map([["night-before", { refs: [{ kind: "secret" as const, name: "PREVIEW_KEY", file: "p.yml", environment: "preview" }, { kind: "secret" as const, name: "GONE_KEY", file: "p.yml", environment: "nope" }], notes: [] }]]);
    const extra = {
      repos: [meta("night-before")],
      readRepos: ["night-before"],
      envs: new Map([["night-before", ["preview"]]]),
      reads: reads([[kn("night-before", "environment", "preview"), names("PREVIEW_KEY")]], [[kn("night-before", "environment", "preview"), vars({})]]),
      needs,
    };
    const r = compareMatrix(inv(), {}, reads([]), extra);
    expect(row(r, "PREVIEW_KEY").other).toEqual({ present: ["preview"], needed: [] });
    expect(row(r, "PREVIEW_KEY").neededMissing).toBe(false);
    expect(row(r, "GONE_KEY").other).toEqual({ present: [], needed: ["nope"] });
    expect(row(r, "GONE_KEY").neededMissing).toBe(true);
  });

  it("renamed and missing inventory repositories", () => {
    const r = compareMatrix(inv(), {}, reads([]), { repos: [meta("web2")], renames: { web: "web2" } });
    const web = r.repos.find((x) => x.name === "web")!;
    expect(web).toMatchObject({ inInventory: true, onGitHub: false, renamedTo: "web2" });
    expect(r.repos.find((x) => x.name === "web2")!.inInventory).toBe(false);
  });

  it("without extras the repository list stays limited to the inventory", () => {
    const r = compareMatrix(inv(), {});
    expect(r.repos).toEqual([{ name: "web", inInventory: true, private: null, archived: null, pushedAt: null, onGitHub: null, found: { secrets: 0, variables: 0 }, needed: 0, notes: [] }]);
  });
});

describe("compareMatrix: level mismatch, optional, ignored repositories", () => {
  const wfNeeds = (repo: string, refs: { kind: "secret" | "variable"; name: string; file: string; environment?: string; optional?: boolean }[]) => new Map([[repo, { refs, notes: [] }]]);
  const liveReads = reads(
    [
      [k("environment", "staging"), names("STRIPE_KEY")],
      [k("environment", "production"), names("STRIPE_KEY")],
      [k("repository"), names()],
    ],
    [[k("environment", "staging"), vars({})], [k("environment", "production"), vars({})], [k("repository"), vars({})]],
  );

  it("level-mismatch: name is in the inventory on another stage; without adoption state, counted separately", () => {
    const needs = wfNeeds("web", [
      { kind: "secret", name: "STRIPE_KEY", file: "provision.yml" },
      { kind: "secret", name: "BRAND_NEW", file: "provision.yml" },
    ]);
    const r = compareMatrix(inv(), {}, liveReads, { needs });
    const sk = row(r, "STRIPE_KEY");
    expect(sk.cells.shared).toMatchObject({ state: "level-mismatch", expected: false, detail: { neededBy: ["provision.yml"], inventoryStages: ["staging", "production"] } });
    expect(sk.neededMissing).toBe(false);
    expect(sk.levelMismatch).toBe(true);
    expect(row(r, "BRAND_NEW").cells.shared!.state).toBe("needed");
    expect(row(r, "BRAND_NEW").levelMismatch).toBe(false);
    expect(r.summary).toMatchObject({ neededMissing: 1, levelMismatch: 1 });
    expect(r.summary.perStage.shared).toMatchObject({ needed: 1, levelMismatch: 1 });
    expect(r.repos.find((x) => x.name === "web")!.needed).toBe(1);
  });

  it("level-mismatch applies without live too; when covered by the repo level it stays not-expected", () => {
    const needs = wfNeeds("web", [{ kind: "secret", name: "STRIPE_KEY", file: "provision.yml" }]);
    expect(row(compareMatrix(inv(), {}, undefined, { needs }), "STRIPE_KEY").cells.shared!.state).toBe("level-mismatch");
    const covered = reads([[k("environment", "staging"), names("STRIPE_KEY")], [k("environment", "production"), names("STRIPE_KEY")], [k("repository"), names("STRIPE_KEY")]]);
    const r = compareMatrix(inv(), {}, covered, { needs });
    expect(row(r, "STRIPE_KEY").cells.shared!.state).not.toBe("level-mismatch");
    expect(row(r, "STRIPE_KEY").levelMismatch).toBe(false);
  });

  it("optional: only checked, never needed or level-mismatch, not even for names in the inventory", () => {
    const needs = wfNeeds("web", [
      { kind: "secret", name: "STRIPE_KEY", file: "up.yml", optional: true },
      { kind: "secret", name: "SLACK_HOOK", file: "up.yml", optional: true },
      { kind: "secret", name: "MIXED", file: "up.yml", optional: true },
      { kind: "secret", name: "MIXED", file: "other.yml" },
    ]);
    const r = compareMatrix(inv(), {}, liveReads, { needs });
    expect(row(r, "STRIPE_KEY").cells.shared!.state).toBe("optional");
    expect(row(r, "SLACK_HOOK").cells.shared).toMatchObject({ state: "optional", detail: { neededBy: ["up.yml"] } });
    expect(row(r, "SLACK_HOOK").neededMissing).toBe(false);
    expect(row(r, "SLACK_HOOK").levelMismatch).toBe(false);
    // zusammen mit einer verbindlichen Nennung in einer anderen Datei bleibt es needed
    expect(row(r, "MIXED").cells.shared!.state).toBe("needed");
    expect(r.summary).toMatchObject({ neededMissing: 1, levelMismatch: 0 });
  });

  it("optional: environment without stage does not count as missing", () => {
    const needs = wfNeeds("web", [{ kind: "secret", name: "GONE_KEY", file: "a.yml", environment: "nope", optional: true }]);
    const r = compareMatrix(inv(), {}, liveReads, { needs, readRepos: ["web"], envs: new Map([["web", []]]), reads: liveReads });
    expect(row(r, "GONE_KEY").neededMissing).toBe(false);
  });

  it("ignoreRepos: no rows, no repo entries, not in required locations; list of the ignored", () => {
    const text = YAML.replace("\nvariables:", `\n  - id: tpl\n    name: TPL_SECRET\n    stage: shared\n    service: x\n    expiry: none\n    places: [{ repo: status, scope: repository }]\nvariables:`);
    const i = InventoryStore.fromText(text.replace("variables:", "variables:")).data;
    expect(compareRepos(i, {})).toEqual(["status", "web"]);
    expect(compareRepos(i, { ignoreRepos: ["status"] })).toEqual(["web"]);
    expect(requiredLocations(i, { ignoreRepos: ["status"] }).secret.some((l) => l.repo === "status")).toBe(false);
    const needs = new Map([["status", { refs: [{ kind: "secret" as const, name: "UPTIME_TOKEN", file: "u.yml" }], notes: [] }], ["web", { refs: [], notes: [] }]]);
    const repos = [{ name: "status", private: false, archived: false, pushedAt: null }, { name: ".github", private: false, archived: false, pushedAt: null }, { name: "web", private: true, archived: false, pushedAt: null }];
    const r = compareMatrix(i, { ignoreRepos: ["status", ".github"] }, undefined, { needs, repos });
    expect(r.rows.some((x) => x.repo === "status")).toBe(false);
    expect(r.repos.map((x) => x.name)).toEqual(["web"]);
    expect(r.ignored).toEqual([".github", "status"]);
    // Standard: .github und .github-private
    const d = compareMatrix(i, {}, undefined, { repos });
    expect(d.ignored).toEqual([".github"]);
    expect(d.rows.some((x) => x.repo === "status")).toBe(true);
  });
});

describe("requiredLocations and ignoreRepos", () => {
  it("does not read targets of ignored inventory repositories", () => {
    const text = YAML.replace("\nvariables:", `\n  - id: tpl\n    name: TPL_SECRET\n    stage: shared\n    service: x\n    expiry: none\n    places: [{ repo: status, scope: repository }]\nvariables:`);
    const i = InventoryStore.fromText(text).data;
    expect(requiredLocations(i, {}).secret.some((l) => l.repo === "status")).toBe(true);
    expect(requiredLocations(i, { ignoreRepos: ["status"] }).secret.some((l) => l.repo === "status")).toBe(false);
  });
});
