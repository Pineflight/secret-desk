import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addSecret, addVariable, overview, requestIssuance } from "../src/agent-api.js";
import { listStages, setStages, stageUsage } from "../src/stages.js";
import { createRuntime } from "../src/runtime.js";

const INVENTORY = `version: 1
stages:
  - { id: lokal, kind: dev }
  - { id: abnahme, label: Abnahme, kind: test }
  - { id: eu-prod, kind: live, environment: production-eu }
  - { id: alle, kind: shared }
secrets:
  - id: hmac-lokal
    name: HMAC_A
    stage: lokal
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: r, scope: repository }
  - id: hmac-prod
    name: HMAC_B
    stage: eu-prod
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: r, scope: environment }
`;

async function setup(agentStages = "") {
  const dir = await mkdtemp(join(tmpdir(), "sd-stg-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(
    join(dir, "c.yaml"),
    `inventory: ./inventory.yaml\ngithub:\n  owner: P\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${agentStages ? `policy:\n  agentStages: ${agentStages}\n` : ""}`,
  );
  const fetchMock = (async () => new Response(JSON.stringify({ key_id: "k", key: "AAAA" }), { status: 200 })) as unknown as typeof fetch;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock });
  return { rt, dir };
}
const agent = { kind: "agent", name: "claude" } as const;

describe("Stages in der Laufzeit", () => {
  it("listStages liefert Definitionen, Environment-Namen und Nutzung", async () => {
    const { rt } = await setup();
    const list = listStages(rt);
    expect(list.map((s) => [s.id, s.environmentName])).toEqual([["lokal", null], ["abnahme", "abnahme"], ["eu-prod", "production-eu"], ["alle", null]]);
    expect(list.find((s) => s.id === "eu-prod")!.usage).toMatchObject({ secrets: 1 });
    expect(stageUsage(rt, "lokal").secrets).toBe(1);
  });
  it("Uebersicht zaehlt je konfigurierter Stage", async () => {
    const { rt } = await setup();
    const o = await overview(rt);
    expect(o.byStage).toEqual({ lokal: 1, abnahme: 0, "eu-prod": 1, alle: 0 });
  });
  it("Agent darf in dev-Stages direkt, in live nie ohne Freigabe (auch wenn die Richtlinie sie nennt)", async () => {
    const { rt } = await setup();
    expect((await requestIssuance(rt, agent, "hmac-lokal")).status).toBe("awaiting-review");
    expect((await requestIssuance(rt, agent, "hmac-prod")).status).toBe("pending-approval");
    const strict = await setup("[eu-prod]");
    expect((await requestIssuance(strict.rt, agent, "hmac-prod")).status).toBe("pending-approval");
  });
  it("Anlegen mit Bereich Umgebung nimmt den Namen aus der Stage; ohne Environment ist es ein Fehler", async () => {
    const { rt } = await setup();
    const v = await addVariable(rt, { kind: "human", name: "n" }, { id: "v1", name: "V_ONE", stage: "abnahme", value: "x", places: [{ repo: "r", scope: "environment" }] });
    expect(v.places[0]!.environment).toBe("abnahme");
    await expect(addSecret(rt, { id: "s1", name: "S_ONE", service: "x", stage: "alle", places: [{ repo: "r", scope: "environment" }] })).rejects.toThrow(/keine GitHub-Environment/);
    await expect(addSecret(rt, { id: "s2", name: "S_TWO", service: "x", stage: "gibt-es-nicht", places: [{ repo: "r", scope: "repository" }] })).rejects.toThrow(/Unbekannte Stage/);
  });
  it("setStages speichert, blockiert Entfernen genutzter Stages mit Zaehlern", async () => {
    const { rt, dir } = await setup();
    const defs = listStages(rt).map(({ id, label, kind, environment, tone }) => ({ id, ...(label ? { label } : {}), kind, ...(environment !== undefined ? { environment } : {}), ...(tone ? { tone } : {}) }));
    await expect(setStages(rt, defs.filter((d) => d.id !== "eu-prod"))).rejects.toThrow(/eu-prod wird noch genutzt \(1 Secrets, 0 Variablen, 0 Vorlagen\)/);
    await expect(setStages(rt, [])).rejects.toThrow(/Mindestens eine Stage/);
    await setStages(rt, [...defs.filter((d) => d.id !== "alle"), { id: "qa", kind: "test" }]);
    expect(listStages(rt).map((s) => s.id)).toEqual(["lokal", "abnahme", "eu-prod", "qa"]);
    expect(await readFile(join(dir, "inventory.yaml"), "utf8")).toContain("id: qa");
  });
  it("Stage in der Agenten-Richtlinie laesst sich nicht entfernen", async () => {
    const { rt } = await setup("[abnahme]");
    const defs = listStages(rt).filter((s) => s.id !== "abnahme").map(({ id, kind, environment }) => ({ id, kind, ...(environment !== undefined ? { environment } : {}) }));
    await expect(setStages(rt, defs)).rejects.toThrow(/Agenten-Richtlinie/);
  });
});
