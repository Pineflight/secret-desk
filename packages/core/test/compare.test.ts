import { describe, expect, it } from "vitest";
import { compareMatrix, locationKey, repoLevelStage, requiredLocations, stageLocation, type LiveReads, type LocationRead } from "../src/compare.js";
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

describe("compareMatrix ohne Live", () => {
  const r = compareMatrix(inv(), {});
  it("Spalten sind alle Stages, Zeilen je Repository und Name", () => {
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
  it("Erwartung ohne Live ist unknown, sonst leer oder nicht anwendbar", () => {
    const s = row(r, "STRIPE_KEY");
    expect(s.cells.staging).toMatchObject({ state: "unknown", expected: true });
    expect(s.cells.production).toMatchObject({ state: "unknown", expected: true });
    expect(s.cells.dev).toEqual({ state: "not-applicable", expected: false });
    expect(s.cells.shared).toMatchObject({ state: "not-expected", expected: false });
    expect(s.ids.sort()).toEqual(["stripe-prod", "stripe-staging"]);
    expect(s.tags).toEqual(["pay"]);
  });
  it("Paritaet: gleich konsistent, sonst Luecke mit fehlender Stage", () => {
    expect(row(r, "STRIPE_KEY")).toMatchObject({ parity: "consistent", missingIn: [] });
    expect(row(r, "DEBUG_TOKEN")).toMatchObject({ parity: "gap", missingIn: ["production"] });
    expect(row(r, "CLOUDFLARE_API_TOKEN").parity).toBe("n/a");
    expect(r.summary.gaps).toBe(3);
    expect(r.summary.perStage.staging).toMatchObject({ expected: 4, present: 0 });
    expect(r.summary.orphans).toBe(0);
  });
  it("Namen mit Stage-Wort werden nicht gleichgesetzt, mit Schalter schon", () => {
    expect(row(r, "SUPABASE_STAGING_URL").parity).toBe("gap");
    const n = compareMatrix(inv(), { normalizeNames: true });
    const u = row(n, "SUPABASE_URL");
    expect(u).toMatchObject({ parity: "consistent", names: ["SUPABASE_PRODUCTION_URL", "SUPABASE_STAGING_URL"] });
    expect(u.ids.sort()).toEqual(["url-prod", "url-staging"]);
    expect(n.rows.some((x) => x.name === "SUPABASE_STAGING_URL")).toBe(false);
  });
  it("compare waehlt die verglichenen Stages", () => {
    const only = compareMatrix(inv(), { compare: ["staging", "shared"] });
    expect(only.compared).toEqual(["staging", "shared"]);
    expect(row(only, "STRIPE_KEY")).toMatchObject({ parity: "gap", missingIn: ["shared"] });
    expect(compareMatrix(inv(), { compare: ["gibt-es-nicht"] }).compared).toEqual(["staging", "production"]);
    expect(compareMatrix(inv(), { compare: ["staging"] }).rows.every((x) => x.parity === "n/a")).toBe(true);
  });
  it("kinds und repo filtern", () => {
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
  it("ok, missing und different", () => {
    expect(row(r, "STRIPE_KEY").cells.production).toMatchObject({ state: "ok", expected: true, present: true });
    expect(row(r, "DEBUG_TOKEN").cells.staging.state).toBe("ok");
    expect(row(r, "DEBUG_TOKEN").cells.production).toMatchObject({ state: "not-expected", expected: false });
    expect(row(r, "SITE_URL", "variable").cells.staging.state).toBe("ok");
    const diff = row(r, "SITE_URL", "variable").cells.production;
    expect(diff).toMatchObject({ state: "different", present: true });
    expect(diff.detail).toMatchObject({ expectedValues: ["https://example.com"], actualValues: ["https://other.example.com"] });
  });
  it("fehlendes Secret ist missing und eine Luecke", () => {
    const gone = base();
    gone.secret.set(k("environment", "production"), names("SUPABASE_PRODUCTION_URL"));
    const m = compareMatrix(inv(), {}, gone);
    const s = row(m, "STRIPE_KEY");
    expect(s.cells.production).toMatchObject({ state: "missing", expected: true, present: false });
    expect(s.cells.production.detail?.missingAt).toEqual(["web/env:production"]);
    expect(s).toMatchObject({ parity: "gap", missingIn: ["production"] });
    expect(m.summary.perStage.production).toMatchObject({ missing: 1 });
  });
  it("Waisen: unbekannte Namen im Ziel sind eigene Zeilen mit unexpected", () => {
    const o = row(r, "LEFTOVER");
    expect(o.ids).toEqual([]);
    expect(o.cells.staging).toMatchObject({ state: "unexpected", present: true, expected: false });
    expect(o.cells.production.state).toBe("not-expected");
    expect(o.parity).toBe("gap");
    expect(row(r, "OLD_REPO_SECRET").cells.shared.state).toBe("unexpected");
    expect(r.summary.orphans).toBe(2);
    expect(r.summary.perStage.staging.unexpected).toBe(1);
  });
  it("vorhandener Name in einer Stage ohne Erwartung ist unexpected", () => {
    const x = base();
    x.secret.set(k("environment", "production"), names("STRIPE_KEY", "DEBUG_TOKEN", "SUPABASE_PRODUCTION_URL"));
    const d = row(compareMatrix(inv(), {}, x), "DEBUG_TOKEN");
    expect(d.cells.production.state).toBe("unexpected");
    expect(d.ids).toEqual(["only-staging"]);
    expect(d.parity).toBe("consistent");
  });
  it("nicht lesbares Ziel ergibt error-Zellen, Paritaet ueberspringt sie", () => {
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
  it("Environment gibt es nicht (404): Name fehlt, notFound gemerkt", () => {
    const x = base();
    x.secret.set(k("environment", "production"), { names: new Map(), notFound: true });
    const c = row(compareMatrix(inv(), {}, x), "STRIPE_KEY").cells.production;
    expect(c.state).toBe("missing");
    expect(c.detail?.notFound).toEqual(["web/env:production"]);
  });
  it("normalisierte Namen fuehren Live-Zeilen zusammen", () => {
    const m = compareMatrix(inv(), { normalizeNames: true }, base());
    const u = row(m, "SUPABASE_URL");
    expect(u.cells.staging.state).toBe("ok");
    expect(u.cells.production.state).toBe("ok");
    expect(u.parity).toBe("consistent");
  });
});

describe("Stage-Definitionen und Ziele", () => {
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
  it("Environment kommt aus der Stage, Repo-Ebene gehoert der shared-Stage", () => {
    expect(repoLevelStage(c.stages)).toBe("common");
    expect(stageLocation(c.stages, "qa", "app")).toEqual({ repo: "app", scope: "environment", environment: "qa" });
    expect(stageLocation(c.stages, "prod", "app")).toEqual({ repo: "app", scope: "environment", environment: "production-eu" });
    expect(stageLocation(c.stages, "dev", "app")).toBeUndefined();
    expect(stageLocation(c.stages, "common", "app")).toEqual({ repo: "app", scope: "repository" });
  });
  it("requiredLocations: jedes Ziel einmal, Organisation einmal", () => {
    const need = requiredLocations(c, {});
    const keys = need.secret.map(locationKey).sort();
    expect(keys).toEqual(["app/environment/production-eu", "app/environment/qa", "app/repository/", "organization"]);
    expect(requiredLocations(c, { kinds: ["variable"] }).secret).toEqual([]);
    expect(requiredLocations(c, { repo: "nope" }).secret).toEqual([]);
  });
  it("mehrere Places: Ziel mit eigenem Namen bekommt eine eigene Zeile, fehlt dort -> missing", () => {
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
