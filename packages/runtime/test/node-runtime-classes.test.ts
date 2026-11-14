import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionStore, FileEvidenceStore, GitHubClient, InventoryStore, ProviderRegistry, SecretVault, WorkerSecretsClient } from "@secret-desk/core";
import { createDefaultRegistry } from "@secret-desk/providers";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals.js";
import { AutomationManager } from "../src/automation.js";
import { nodeRuntimeHost } from "../src/host.js";
import { InstanceState } from "../src/instance-state.js";
import { IssuanceQueue } from "../src/issuances.js";
import { createLocalRuntime, createRuntime, type Runtime } from "../src/runtime.js";

// The Node runtime is built on the portable builder, but what it returns has to be made of the classes it was made of before. Each
// field whose class could have changed is checked here, for `createLocalRuntime` and for `createRuntime` with and without a host.
async function config(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sd-classes-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nvault: { enabled: true, file: ${JSON.stringify(join(dir, "vault.json"))}, keyFile: ${JSON.stringify(join(dir, "vault.key"))} }\n`);
  return join(dir, "c.yaml");
}

function expectNodeClasses(rt: Runtime, vault: boolean): void {
  expect(rt.connections).toBeInstanceOf(ConnectionStore);
  expect(rt.github).toBeInstanceOf(GitHubClient);
  expect(rt.inventory).toBeInstanceOf(InventoryStore);
  expect(rt.evidence).toBeInstanceOf(FileEvidenceStore);
  expect(rt.workers).toBeInstanceOf(WorkerSecretsClient);
  expect(rt.providers).toBeInstanceOf(ProviderRegistry);
  // The default registry of the local edition (the Node-only providers included), not the portable one.
  expect(rt.providers.list().map((p) => p.id)).toEqual(createDefaultRegistry().list().map((p) => p.id));
  expect(rt.providers.list().length).toBeGreaterThan(createPortableRegistry().list().length);
  expect(rt.approvals).toBeInstanceOf(ApprovalQueue);
  expect(rt.issuances).toBeInstanceOf(IssuanceQueue);
  expect(rt.instance).toBeInstanceOf(InstanceState);
  expect(rt.automation).toBeInstanceOf(AutomationManager);
  if (vault) expect(rt.connections.vault).toBeInstanceOf(SecretVault);
  else expect(rt.connections.vault).toBeUndefined();
  expect(typeof rt.configPath).toBe("string");
}

describe("the Node runtime keeps the classes it always had", () => {
  it("createLocalRuntime", async () => {
    expectNodeClasses(await createLocalRuntime(await config(), { env: {}, bundledRecipes: null }), true);
  });

  it("createRuntime with a host", async () => {
    expectNodeClasses(await createRuntime(await config(), { host: nodeRuntimeHost({ env: {} }), bundledRecipes: null }), true);
  });

  it("createRuntime without a host: the same classes, no default vault", async () => {
    const rt = await createRuntime(await config(), { bundledRecipes: null });
    expectNodeClasses(rt, false);
    expect(rt.host).toBeUndefined();
  });

  it("the store of a runtime without a host reads no environment variable (host: null, as before)", async () => {
    const rt = await createRuntime(await config(), { bundledRecipes: null, vault: null });
    await expect(rt.connections.token("github")).rejects.toThrow();
  });
});
