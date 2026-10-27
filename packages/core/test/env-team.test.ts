import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { buildEnvFile, formatEnvValue, PromptsRequiredError, writeEnvFile } from "../src/env-export.js";
import { InventoryStore } from "../src/inventory.js";
import { ProviderRegistry } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";
import { exportTeamBundle, mergeTeamBundle, parseTeamBundle } from "../src/team.js";
import { INVENTORY_YAML } from "./fixtures.js";

describe("buildEnvFile", () => {
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const template = inventory.data.envTemplates[0]!;
  const base = { inventory, providers: new ProviderRegistry(), connections: new ConnectionStore() };
  it("verlangt Eingaben fuer prompt-Eintraege", async () => {
    await expect(buildEnvFile(template, base)).rejects.toThrow(PromptsRequiredError);
  });
  it("baut Defaults, Zufallswerte und Eingaben", async () => {
    const r = await buildEnvFile(template, { ...base, prompts: { STRIPE_SECRET_KEY: "rk_test_abc" } });
    expect(r.text).toContain("NEXT_PUBLIC_SITE_URL=http://localhost:3000");
    expect(r.text).toMatch(/LEAD_INTAKE_TOKEN=[0-9a-f]{32}\n/);
    expect(r.text).toContain("STRIPE_SECRET_KEY=rk_test_abc");
    expect(r.sources).toEqual({ NEXT_PUBLIC_SITE_URL: "default", LEAD_INTAKE_TOKEN: "generate", STRIPE_SECRET_KEY: "prompt" });
    expect(JSON.stringify(r.sources)).not.toContain("rk_test");
  });
  it("stellt issue-Eintraege ueber den Anbieter aus", async () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML.replace("{ key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }", "{ key: CF_DEV_TOKEN, from: { type: issue, secret: cf-deploy-acme-app } }"));
    const providers = new ProviderRegistry().register({
      id: "cloudflare-token", label: "CF", kind: "automatic",
      issue: async (ctx) => ({ value: new SecretValue(`dev-${ctx.stage}`) }),
    });
    const r = await buildEnvFile(inv.data.envTemplates[0]!, { inventory: inv, providers, connections: new ConnectionStore(), prompts: { STRIPE_SECRET_KEY: "x" } });
    expect(r.text).toContain("CF_DEV_TOKEN=dev-dev");
    expect(r.issuedSecretIds).toEqual(["cf-deploy-acme-app"]);
  });
  it("quotet Werte mit Sonderzeichen", () => {
    expect(formatEnvValue("a b")).toBe('"a b"');
    expect(formatEnvValue('x"y')).toBe('"x\\"y"');
    expect(formatEnvValue("plain-1.2")).toBe("plain-1.2");
  });
});

describe("writeEnvFile", () => {
  it("schreibt mit Modus 600, ueberschreibt nur mit Erlaubnis und haelt erlaubte Ordner ein", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-"));
    const path = join(dir, "sub", ".env.local");
    const r = await writeEnvFile(path, "A=1\n", { allowedRoots: [dir] });
    if (process.platform !== "win32") expect((await stat(r.path)).mode & 0o777).toBe(0o600); // Windows kennt keine POSIX-Modi
    expect(await readFile(path, "utf8")).toBe("A=1\n");
    await expect(writeEnvFile(path, "B=2\n", { allowedRoots: [dir] })).rejects.toThrow(/existiert/);
    await writeEnvFile(path, "B=2\n", { allowedRoots: [dir], overwrite: true });
    await expect(writeEnvFile("/etc/passwd-test", "x", { allowedRoots: [dir] })).rejects.toThrow(/ausserhalb/);
  });
});

describe("Team-Datei", () => {
  it("exportiert ohne Werte und ohne anbieterinterne Kennungen, Import zusammenfuehren", () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML);
    const text = exportTeamBundle(inv.data);
    expect(text).toContain("KEINE Werte");
    expect(text).not.toContain("old-token-id");
    const bundle = parseTeamBundle(text);
    const target = InventoryStore.fromText("version: 1\nsecrets: []\n");
    const merged = mergeTeamBundle(target, bundle);
    expect(merged.added).toHaveLength(3);
    expect(target.data.envTemplates).toHaveLength(1);
    expect(mergeTeamBundle(target, bundle).skipped).toHaveLength(3);
  });
});
