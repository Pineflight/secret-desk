import { describe, expect, it } from "vitest";
import { agentStageIds, ConfigSchema } from "../src/config.js";
import { InventoryError, InventoryStore } from "../src/inventory.js";
import { contextKind, DEFAULT_STAGES, effectiveStages, resolvePlaces, stageEnvironment, stageKind, stageLabel, stageTone, StageError } from "../src/stages.js";
import { exportTeamBundle, mergeTeamBundle, parseTeamBundle } from "../src/team.js";
import { INVENTORY_YAML } from "./fixtures.js";

const WITH_STAGES = `${INVENTORY_YAML}stages:
  - { id: dev, kind: dev }
  - { id: staging, kind: test, environment: staging }
  - { id: qa, label: QA, kind: test, tone: warn }
  - { id: prod, kind: live, environment: production-eu }
  - { id: shared, kind: shared }
`;
const MINI = `version: 1
stages:
  - { id: dev, kind: dev }
  - { id: qa, label: QA, kind: test }
  - { id: prod, kind: live, environment: production-eu }
  - { id: gemeinsam, kind: shared }
`;

describe("stage definitions", () => {
  it("missing or empty section yields the default stages", () => {
    expect(InventoryStore.fromText(INVENTORY_YAML).stages).toEqual(DEFAULT_STAGES);
    expect(effectiveStages([])).toEqual(DEFAULT_STAGES);
  });
  it("kind, environment, display name and color come from the definition", () => {
    const defs = InventoryStore.fromText(MINI).stages;
    expect(stageKind(defs, "prod")).toBe("live");
    expect(stageKind(defs, "unbekannt")).toBe("live");
    expect(stageEnvironment(defs[1]!)).toBe("qa");
    expect(stageEnvironment(defs[2]!)).toBe("production-eu");
    expect(stageEnvironment(defs[0]!)).toBeNull();
    expect(stageEnvironment(defs[3]!)).toBeNull();
    expect(stageLabel(defs, "qa")).toBe("QA");
    expect(stageLabel(defs, "prod")).toBe("prod");
    expect(stageTone(defs, "prod")).toBe("stage-prod");
    expect(stageTone(defs, "qa")).toBe("ki");
    expect(contextKind({ stage: "production" })).toBe("live");
    expect(contextKind({ stage: "x", stageKind: "test" })).toBe("test");
  });
  it("checks uniqueness, maximum count and id form", () => {
    expect(() => InventoryStore.fromText("version: 1\nstages:\n  - { id: a, kind: dev }\n  - { id: a, kind: test }\n")).toThrow(/doppelt/);
    const many = Array.from({ length: 13 }, (_, i) => `  - { id: s${i}, kind: test }`).join("\n");
    expect(() => InventoryStore.fromText(`version: 1\nstages:\n${many}\n`)).toThrow(InventoryError);
    expect(() => InventoryStore.fromText("version: 1\nstages:\n  - { id: Gross, kind: test }\n")).toThrow(InventoryError);
    expect(() => InventoryStore.fromText("version: 1\nstages:\n  - { id: a, kind: komisch }\n")).toThrow(InventoryError);
  });
  it("unknown stage in secrets is rejected", () => {
    expect(() => InventoryStore.fromText(`${MINI}secrets:\n  - { id: x, name: A_B, service: s, stage: staging, places: [{ repo: r, scope: repository }] }\n`)).toThrow(/Unbekannte Stage: staging/);
    const s = InventoryStore.fromText(MINI);
    expect(() => s.addSecret({ id: "y", name: "A_B", service: "s", stage: "nope", places: [{ repo: "r", scope: "repository" }] })).toThrow(/Unbekannte Stage/);
  });
  it("only stages of kind dev may be without target", () => {
    const s = InventoryStore.fromText(MINI);
    s.addSecret({ id: "lokal", name: "A_B", service: "s", stage: "dev" });
    expect(() => s.addSecret({ id: "ohne", name: "A_B", service: "s", stage: "qa", places: [] })).toThrow(/places/);
  });
});

describe("environment from the stage", () => {
  it("sets the name when creating secret and variable", () => {
    const s = InventoryStore.fromText(MINI);
    const sec = s.addSecret({ id: "a", name: "A_B", service: "s", stage: "prod", places: [{ repo: "r", scope: "environment" }] });
    expect(sec.places[0]!.environment).toBe("production-eu");
    expect(s.toString()).toContain("production-eu");
    const v = s.addVariable({ id: "v", name: "V_B", stage: "qa", places: [{ repo: "r", scope: "environment" }] });
    expect(v.places[0]!.environment).toBe("qa");
  });
  it("explicit deviation stays", () => {
    const s = InventoryStore.fromText(MINI);
    const sec = s.addSecret({ id: "a", name: "A_B", service: "s", stage: "qa", places: [{ repo: "r", scope: "environment", environment: "qa-eu" }] });
    expect(sec.places[0]!.environment).toBe("qa-eu");
  });
  it("stage without environment: environment scope is an error", () => {
    const s = InventoryStore.fromText(MINI);
    expect(() => s.addSecret({ id: "a", name: "A_B", service: "s", stage: "gemeinsam", places: [{ repo: "r", scope: "environment" }] })).toThrow(/keine GitHub-Environment/);
    expect(() => resolvePlaces(DEFAULT_STAGES, "dev", [{ scope: "environment" as const }])).toThrow(StageError);
    expect(() => resolvePlaces(DEFAULT_STAGES, "x", [])).toThrow(/Unbekannte Stage/);
  });
  it("fills in missing names on load in hand-written YAML", () => {
    const s = InventoryStore.fromText(`${MINI}secrets:\n  - { id: x, name: A_B, service: s, stage: qa, places: [{ repo: r, scope: environment }] }\n`);
    expect(s.getSecret("x")!.places[0]!.environment).toBe("qa");
  });
});

describe("setStages", () => {
  it("preserves comments and refuses removing used stages", () => {
    const s = InventoryStore.fromText(INVENTORY_YAML);
    s.setStages([...DEFAULT_STAGES, { id: "qa", kind: "test" }]);
    expect(s.stages.map((d) => d.id)).toContain("qa");
    expect(s.toString()).toContain("# Kommentar bleibt erhalten");
    expect(() => s.setStages(DEFAULT_STAGES.filter((d) => d.id !== "staging"))).toThrow(/Unbekannte Stage: staging/);
    expect(s.stages.map((d) => d.id)).toContain("staging");
  });
});

describe("policy and team", () => {
  it("agentStages: without input all stages of kind dev", () => {
    const c = ConfigSchema.parse({ inventory: "i", github: { owner: "o", auth: { type: "pat" } } });
    expect(agentStageIds(c, InventoryStore.fromText(MINI).stages)).toEqual(["dev"]);
    expect(agentStageIds({ policy: { agentStages: ["qa"], envRoots: [] } }, [])).toEqual(["qa"]);
  });
  it("export contains the stages, import adopts new ones and keeps existing ones", () => {
    const src = InventoryStore.fromText(WITH_STAGES);
    const text = exportTeamBundle(src.data);
    expect(text).toContain("stages:");
    const bundle = parseTeamBundle(text);
    expect(bundle.stages.map((d) => d.id)).toEqual(["dev", "staging", "qa", "prod", "shared"]);
    const target = InventoryStore.fromText("version: 1\nstages:\n  - { id: dev, kind: dev }\n  - { id: qa, label: Eigenes, kind: live }\n");
    const r = mergeTeamBundle(target, bundle);
    expect(r.addedStages).toEqual(["staging", "prod", "shared"]);
    expect(target.stages.find((d) => d.id === "qa")).toMatchObject({ label: "Eigenes", kind: "live" });
  });
  it("replace adopts the stages completely", () => {
    const src = InventoryStore.fromText(MINI);
    const target = InventoryStore.fromText(INVENTORY_YAML);
    target.replaceData(parseTeamBundle(exportTeamBundle(src.data)).secrets.length === 0 ? parseTeamBundle(exportTeamBundle(src.data)) : src.data);
    expect(target.stages.map((d) => d.id)).toEqual(["dev", "qa", "prod", "gemeinsam"]);
  });
});
