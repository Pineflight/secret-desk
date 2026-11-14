import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalRuntime } from "../src/runtime.js";
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
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { ...(vaultOff ? { vault: null } : {}), env: { GH_TEST: "ghp_testwert_nie_zeigen_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null });
  return { rt, dir };
}

describe("shortenHome", () => {
  it("shortens home prefixes to ~", () => {
    expect(shortenHome("/home/anna/Projekte/x")).toBe("~/Projekte/x");
    expect(shortenHome("/home/bob")).toBe("~");
    expect(shortenHome("C:\\Users\\carl\\x")).toBe("~\\x");
    expect(shortenHome("/opt/data")).toBe("/opt/data");
    expect(shortenHome("/Userset/x")).toBe("/Userset/x");
  });
  it("respects path boundaries with the home of the host too (not /Users/alice2/x -> ~2/x)", () => {
    const home = "/srv/alice";
    expect(shortenHome("/srv/alice/x", home)).toBe("~/x");
    expect(shortenHome("/srv/alice", home)).toBe("~");
    expect(shortenHome("/srv/alice2/x", home)).toBe("/srv/alice2/x");
    expect(shortenHome("/srv/alice-alt", home)).toBe("/srv/alice-alt");
    expect(shortenHome("/data/srv/alice/x", home)).toBe("/data/srv/alice/x");
    expect(shortenHome("Datei /srv/alice/a und /srv/alice2/b", home)).toBe("Datei ~/a und /srv/alice2/b");
  });
  it("does not ask the process for a home folder: without one only the general patterns apply", () => {
    vi.stubEnv("HOME", "/srv/alice");
    expect(shortenHome("/srv/alice/x")).toBe("/srv/alice/x");
    vi.unstubAllEnvs();
  });
});

describe("getSettings", () => {
  it("without policy: agents only on stages of kind dev", async () => {
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
  it("with policy: live still requires approval", async () => {
    const { rt } = await setup("policy:\n  agentStages: [abnahme, eu-prod]\n  envRoots: [/opt/wurzel]\n");
    const s = getSettings(rt);
    expect(s.policy.agentStages).toEqual(["abnahme"]);
    expect(s.policy.agentStagesSource).toBe("policy");
    expect(s.policy.envRoots).toEqual(["/opt/wurzel"]);
  });
  it("vault on: file name and key source as label, without home prefix", async () => {
    const { rt } = await setup("vault:\n  file: ~/sd-test/vault.json\n  keyFile: ~/sd-test/vault.key\n", false);
    const s = getSettings(rt);
    expect(s.vault.enabled).toBe(true);
    expect(s.vault.file).toBe("~/sd-test/vault.json");
    expect(s.vault.keySourceLabel).toContain("~/sd-test/vault.key");
  });
  it("contains neither token values nor variable names of the sources", async () => {
    const { rt } = await setup("connections:\n  cloudflare: { type: env, name: CF_GEHEIM_NAME }\n");
    const text = JSON.stringify(getSettings(rt));
    expect(text).not.toContain("ghp_testwert_nie_zeigen_1");
    expect(text).not.toContain("GH_TEST");
    expect(text).not.toContain("CF_GEHEIM_NAME");
  });
});
