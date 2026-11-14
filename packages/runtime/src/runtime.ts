import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ConnectionStore, FileEvidenceStore, GitHubClient, InventoryStore, loadConfig, patProvider, type SecretVault } from "@secret-desk/core";
import { createDefaultRegistry } from "@secret-desk/providers";
import type { BrowserDriver } from "@secret-desk/automation";
import { AutomationManager } from "./automation.js";
import { NODE_GITHUB_DEFAULTS } from "./github-crypto.js";
import { HostCapabilityError, expandHomeFor, hostHome, nodeRuntimeHost, type NodeRuntimeHostOptions } from "./host.js";
import { assertAuthorizeTimeout, buildRuntime, type PortableRuntimeOptions, type RuntimeCore } from "./runtime-core.js";

// The runtime of the local edition: the Node module on top of the portable builder in `runtime-core.ts`. It loads the configuration,
// opens the inventory file and the evidence folder, creates the browser automation and hands all of it to the internal builder, with
// the Node parts (the Node facades and the defaults for sealing and signing) that the public `createPortableRuntime` does not take.
export { GITHUB_APP_KEY_CONNECTION, GITHUB_CONNECTION, issuanceDeps } from "./runtime-core.js";

/** The runtime of the local edition: the portable runtime with the file inventory and the browser automation. */
export interface Runtime extends RuntimeCore {
  configPath: string;
  inventory: InventoryStore;
  connections: ConnectionStore;
  automation: AutomationManager;
}

export interface RuntimeOptions extends Omit<PortableRuntimeOptions, "vault" | "providers" | "automation"> {
  /**
   * The vault. Left out: the host's `openVault` opens the default one when the configuration has the vault on; a runtime without
   * that capability has no vault. `null`: no vault at all. An embedder without a host passes its own vault here (for example a `SecretVault` with its own store and key source).
   */
  vault?: SecretVault | null;
  /**
   * Long-running processes (the portal): keep the browser sign-in memory in `sign-in-state.json` next to the repository links file
   * (`linksFile`, default `~/.secret-desk/`). Without it the memory lives in the process only.
   */
  persistSignIn?: boolean;
  /**
   * Replaces the browser with the driver the function returns (tests use a window-less one). This is a public option: with it a
   * browser is available whatever the host offers, the caller owns what the driver does, and the reachability probe (`status()`)
   * of a configured remote address still runs.
   */
  automationDriver?: () => BrowserDriver | Promise<BrowserDriver>;
  /** Nur Tests: anderer Ordner (oder null = keiner) statt der mitgelieferten Rezepte. */
  bundledRecipes?: string | null;
  /** Tests only: shortens the waits of a "Confirm access" step (GitHub Mobile, code check, tries). */
  automationAccess?: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
}

/** Baut alles zusammen, was CLI, Portal und MCP-Server brauchen. Liest Konfiguration und Inventar, keine Werte. */
export async function createRuntime(configPath: string, options: RuntimeOptions = {}): Promise<Runtime> {
  // A timeout of 0 or NaN would silently become 1 ms in setTimeout and refuse everything: reject it before any file is read.
  assertAuthorizeTimeout(options.authorizeTimeoutMs);
  const path = resolve(configPath);
  const config = await loadConfig(path);
  const inventory = await InventoryStore.open(resolve(dirname(path), config.inventory));
  const evidence = new FileEvidenceStore(resolve(dirname(path), config.evidenceDir));
  const host = options.host ?? undefined;
  const { persistSignIn, automationDriver, bundledRecipes, automationAccess } = options;

  const core = await buildRuntime(
    { config, configPath: path, inventory, evidence },
    {
      // The options are named one by one: a key of an untyped caller that is not one of them (the Node parts below, for example) goes nowhere.
      host: options.host,
      fetch: options.fetch,
      seal: options.seal,
      sign: options.sign,
      session: options.session,
      watchInventory: options.watchInventory,
      vault: options.vault,
      authorize: options.authorize,
      authorizeTimeoutMs: options.authorizeTimeoutMs,
      onAuthorizeFault: options.onAuthorizeFault,
      now: options.now,
      pendingStore: options.pendingStore,
      onRevokeAbandoned: options.onRevokeAbandoned,
      onNeedsDecision: options.onNeedsDecision,
      providers: createDefaultRegistry,
      automation: async ({ providers }) => {
        // The folder of the state files (sign-in memory, live check) is next to the repository links file. Only needed when persisting;
        // without a home folder there is no default location, so the links file must be named.
        let dataDir: string | undefined;
        if (persistSignIn) {
          const home = hostHome(host);
          const linksFile = config.linksFile ? expandHomeFor(host, config.linksFile) : home ? join(home, ".secret-desk", "repo-links.json") : undefined;
          if (!linksFile) throw new HostCapabilityError("homeDir", "persistSignIn braucht einen Ablageort: linksFile in der Konfiguration angeben oder einen Host mit Home-Ordner uebergeben.");
          dataDir = dirname(resolve(linksFile));
        }
        const manager = new AutomationManager({
          config,
          configDir: dirname(path),
          inventoryDir: dirname(resolve(dirname(path), config.inventory)),
          providers,
          evidence,
          ...(host ? { host } : {}),
          ...(dataDir ? { signInStateFile: join(dataDir, "sign-in-state.json"), liveCheckStateFile: join(dataDir, "live-check-state.json") } : {}),
          ...(automationDriver ? { driverFactory: automationDriver } : {}),
          ...(bundledRecipes !== undefined ? { bundledDir: bundledRecipes } : {}),
          ...(automationAccess ? { access: automationAccess } : {}),
          ...(options.now ? { now: options.now } : {}),
        });
        await manager.load();
        return manager;
      },
    },
    {
      // A runtime with a host seals with libsodium and signs with the Node crypto module unless something was injected.
      ...(host ? { githubDefaults: NODE_GITHUB_DEFAULTS } : {}),
      // The client is an instance of the Node facade of the core, as it always was.
      githubClientClass: GitHubClient,
      // The store is the Node facade of the core, with the same options as before. The builder always says `host` (null: no host).
      createConnections: (parts) => new ConnectionStore(parts),
    },
  );
  // The builder was given the file inventory, the manager and a configuration path, so the result has exactly these types.
  return core as Runtime;
}

/**
 * The single-user local edition (portal, CLI, MCP server): `createRuntime` with the Node host passed explicitly. `env` and `exec`
 * only shape that host (tests); they are not a way to reach the process from a runtime that has no host.
 */
export async function createLocalRuntime(configPath: string, options: Omit<RuntimeOptions, "host"> & NodeRuntimeHostOptions = {}): Promise<Runtime> {
  const { env, exec, ...rest } = options;
  return createRuntime(configPath, { ...rest, host: nodeRuntimeHost({ ...(env ? { env } : {}), ...(exec ? { exec } : {}) }) });
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export { patProvider };
