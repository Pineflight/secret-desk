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
  it("requires input for prompt entries", async () => {
    await expect(buildEnvFile(template, base)).rejects.toThrow(PromptsRequiredError);
  });
  it("builds defaults, random values and input", async () => {
    const r = await buildEnvFile(template, { ...base, prompts: { STRIPE_SECRET_KEY: "rk_test_abc" } });
    expect(r.text).toContain("NEXT_PUBLIC_SITE_URL=http://localhost:3000");
    expect(r.text).toMatch(/LEAD_INTAKE_TOKEN=[0-9a-f]{32}\n/);
    expect(r.text).toContain("STRIPE_SECRET_KEY=rk_test_abc");
    expect(r.sources).toEqual({ NEXT_PUBLIC_SITE_URL: "default", LEAD_INTAKE_TOKEN: "generate", STRIPE_SECRET_KEY: "prompt" });
    expect(JSON.stringify(r.sources)).not.toContain("rk_test");
  });
  it("issues issue entries via the provider", async () => {
    const inv = InventoryStore.fromText(INVENTORY_YAML.replace("{ key: LEAD_INTAKE_TOKEN, from: { type: generate, kind: hex, bytes: 16 } }", "{ key: CF_DEV_TOKEN, from: { type: issue, secret: cf-deploy-acme-app } }"));
    const providers = new ProviderRegistry().register({
      id: "cloudflare-token", label: "CF", kind: "automatic",
      issue: async (ctx) => ({ value: new SecretValue(`dev-${ctx.stage}`) }),
    });
    const r = await buildEnvFile(inv.data.envTemplates[0]!, { inventory: inv, providers, connections: new ConnectionStore(), prompts: { STRIPE_SECRET_KEY: "x" } });
    expect(r.text).toContain("CF_DEV_TOKEN=dev-dev");
    expect(r.issuedSecretIds).toEqual(["cf-deploy-acme-app"]);
  });
  it("quotes values with special characters", () => {
    expect(formatEnvValue("a b")).toBe("'a b'");
    expect(formatEnvValue('x"y')).toBe("'x\"y'");
    expect(formatEnvValue("plain-1.2")).toBe("plain-1.2");
  });
});

describe("writeEnvFile", () => {
  it("writes with mode 600, overwrites only with permission and respects allowed folders", async () => {
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

describe("team file", () => {
  it("exports without values and without provider-internal identifiers, import merges", () => {
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

describe("H7: team import atomic", () => {
  const withComment = INVENTORY_YAML.replace("secrets:\n", "secrets:\n  # Kommentar in secrets\n");
  it("merge with conflict in the middle: no partial state", () => {
    const target = InventoryStore.fromText(INVENTORY_YAML);
    const before = target.toString();
    // Neues Secret vorne, danach eine Variable, deren id mit einem vorhandenen Secret kollidiert.
    const bundle = parseTeamBundle(
      `version: 1\nsecrets:\n  - { id: neu-secret, name: NEU_SECRET, service: x, stage: dev, expiry: none, provider: manual }\nvariables:\n  - { id: cf-deploy-acme-app, name: SOME_VAR, stage: shared, places: [ { repo: r, scope: repository } ] }\n`,
    );
    expect(() => mergeTeamBundle(target, bundle)).toThrow();
    expect(target.toString()).toBe(before);
    expect(target.getSecret("neu-secret")).toBeUndefined();
  });
  it("replace keeps externalId, rotatedAt, verifiedAt, verifiedBy of the same ids", () => {
    const target = InventoryStore.fromText(INVENTORY_YAML);
    target.patchSecret("cf-deploy-acme-app", { rotatedAt: "2026-10-01", verifiedAt: "2026-10-02", verifiedBy: "alice" });
    const bundle = parseTeamBundle(exportTeamBundle(target.data));
    expect(bundle.secrets.find((s) => s.id === "cf-deploy-acme-app")!.externalId).toBeUndefined();
    mergeTeamBundle(target, bundle, "replace");
    expect(target.getSecret("cf-deploy-acme-app")).toMatchObject({ externalId: "old-token-id", rotatedAt: "2026-10-01", verifiedAt: "2026-10-02", verifiedBy: "alice" });
  });
  it("replace with conflict changes nothing", () => {
    const target = InventoryStore.fromText(INVENTORY_YAML);
    const before = target.toString();
    const bad = { ...parseTeamBundle(exportTeamBundle(target.data)) };
    bad.variables = [{ id: bad.secrets[0]!.id, name: "X_Y", stage: "shared", value: null, places: [{ repo: "r", scope: "repository" }] } as never];
    expect(() => mergeTeamBundle(target, bad, "replace")).toThrow();
    expect(target.toString()).toBe(before);
  });
  it("comment in secrets: survives addSecret and setStages", () => {
    const s = InventoryStore.fromText(withComment);
    s.addSecret({ id: "neu-x", name: "NEU_X", service: "x", stage: "dev", expiry: "none", provider: "manual" });
    s.setStages(s.stages);
    expect(s.toString()).toContain("# Kommentar in secrets");
    expect(s.toString()).toContain("# Kommentar bleibt erhalten");
  });
});
