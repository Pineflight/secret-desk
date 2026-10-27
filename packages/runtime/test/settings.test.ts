import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { getSettings, shortenHome } from "../src/settings.js";

const INVENTORY = `version: 1
stages:
  - { id: lokal, kind: dev }
  - { id: abnahme, kind: test }
  - { id: eu-prod, kind: live }
secrets: []
`;

async function setup(policy: string, vaultOff = true) {
  const dir = await mkdtemp(join(tmpdir(), "sd-set-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nserver: { port: 5151 }\ngithub:\n  owner: P\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${policy}`);
  const rt = await createRuntime(join(dir, "c.yaml"), { ...(vaultOff ? { vault: null } : {}), env: { GH_TEST: "ghp_testwert_nie_zeigen_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  return { rt, dir };
}

describe("shortenHome", () => {
  it("kuerzt Home-Praefixe zu ~", () => {
    expect(shortenHome("/home/anna/Projekte/x")).toBe("~/Projekte/x");
    expect(shortenHome("/home/bob")).toBe("~");
    expect(shortenHome("C:\\Users\\carl\\x")).toBe("~\\x");
    expect(shortenHome("/opt/data")).toBe("/opt/data");
    expect(shortenHome("/Userset/x")).toBe("/Userset/x");
  });
  it("beachtet Pfadgrenzen auch beim echten Home (nicht /Users/niklas2/x -> ~2/x)", () => {
    const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
    process.env["HOME"] = "/srv/niklas";
    process.env["USERPROFILE"] = "/srv/niklas";
    try {
      expect(shortenHome("/srv/niklas/x")).toBe("~/x");
      expect(shortenHome("/srv/niklas")).toBe("~");
      expect(shortenHome("/srv/niklas2/x")).toBe("/srv/niklas2/x");
      expect(shortenHome("/srv/niklas-alt")).toBe("/srv/niklas-alt");
      expect(shortenHome("/data/srv/niklas/x")).toBe("/data/srv/niklas/x");
      expect(shortenHome("Datei /srv/niklas/a und /srv/niklas2/b")).toBe("Datei ~/a und /srv/niklas2/b");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("getSettings", () => {
  it("ohne Richtlinie: Agenten nur auf Stages der Art dev", async () => {
    const { rt } = await setup("");
    const s = getSettings(rt);
    expect(s.policy).toEqual({ agentStages: ["lokal"], agentStagesSource: "default", envRoots: [] });
    expect(s.stages).toEqual([
      { id: "lokal", kind: "dev", agentAccess: "direct" },
      { id: "abnahme", kind: "test", agentAccess: "approval" },
      { id: "eu-prod", kind: "live", agentAccess: "approval" },
    ]);
    expect(s.vault).toMatchObject({ enabled: false, keySourceLabel: null });
    expect(s.server.port).toBe(5151);
    expect(s.automation).toEqual({ enabled: rt.automation.enabled, chromeFound: rt.automation.info().chrome.found });
  });
  it("mit Richtlinie: live bleibt auch dann freigabepflichtig", async () => {
    const { rt } = await setup("policy:\n  agentStages: [abnahme, eu-prod]\n  envRoots: [/opt/wurzel]\n");
    const s = getSettings(rt);
    expect(s.policy.agentStages).toEqual(["abnahme"]);
    expect(s.policy.agentStagesSource).toBe("policy");
    expect(s.policy.envRoots).toEqual(["/opt/wurzel"]);
  });
  it("Tresor an: Dateiname und Schluesselquelle als Beschriftung, ohne Home-Praefix", async () => {
    const { rt } = await setup("vault:\n  file: ~/sd-test/vault.json\n  keyFile: ~/sd-test/vault.key\n", false);
    const s = getSettings(rt);
    expect(s.vault.enabled).toBe(true);
    expect(s.vault.file).toBe("~/sd-test/vault.json");
    expect(s.vault.keySourceLabel).toContain("~/sd-test/vault.key");
  });
  it("enthaelt weder Tokenwerte noch Variablennamen der Quellen", async () => {
    const { rt } = await setup("connections:\n  cloudflare: { type: env, name: CF_GEHEIM_NAME }\n");
    const text = JSON.stringify(getSettings(rt));
    expect(text).not.toContain("ghp_testwert_nie_zeigen_1");
    expect(text).not.toContain("GH_TEST");
    expect(text).not.toContain("CF_GEHEIM_NAME");
  });
});
