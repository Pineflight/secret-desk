import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ConnectionStore,
  GitHubClient,
  CLOUDFLARE_CONNECTION,
  WorkerSecretsClient,
  InventoryStore,
  ProviderRegistry,
  SecretVault,
  expandHome,
  SessionVault,
  githubAppProvider,
  loadConfig,
  TEAM_SYNC_CONNECTION,
  patProvider,
  type DeskConfig,
  type ExecFn,
  type FetchLike,
  type Provider,
  type SourceSpec,
  type TokenProvider,
} from "@secret-desk/core";
import { createDefaultRegistry } from "@secret-desk/providers";
import { FileEvidenceStore, type EvidenceStore, type IssuanceDeps } from "@secret-desk/core";
import type { BrowserDriver } from "@secret-desk/automation";
import { ApprovalQueue } from "./approvals.js";
import { AutomationManager } from "./automation.js";
import { IssuanceQueue } from "./issuances.js";
import { LIVE_CHECK_NOTIFY_CONNECTION } from "./live-check-store.js";

export interface Runtime {
  config: DeskConfig;
  configPath: string;
  inventory: InventoryStore;
  github: GitHubClient;
  /** Secrets of Cloudflare Workers, written with the token of the `cloudflare` connection. */
  workers: WorkerSecretsClient;
  connections: ConnectionStore;
  providers: ProviderRegistry;
  approvals: ApprovalQueue;
  issuances: IssuanceQueue;
  evidence: EvidenceStore;
  automation: AutomationManager;
  owner: string;
  fetch: FetchLike;
  /** Nur Arbeitsspeicher: Ergebnis der letzten Abfrage des Team-Repositories. */
  teamSyncMemo: { lastCheck: unknown | null; lastError: string | null };
}

export interface RuntimeOptions {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  session?: SessionVault;
  /** Long-running processes (the portal): also watch the inventory directory so changes made by the CLI show up without a read. */
  watchInventory?: boolean;
  /** Eigener Tresor (Tests); sonst nach config.vault. */
  vault?: SecretVault | null;
  /**
   * Long-running processes (the portal): keep the browser sign-in memory in `sign-in-state.json` next to the repository links file
   * (`linksFile`, default `~/.secret-desk/`). Without it the memory lives in the process only.
   */
  persistSignIn?: boolean;
  /** Nur Tests: ersetzt den echten Browser durch einen Treiber ohne Fenster. */
  automationDriver?: () => BrowserDriver | Promise<BrowserDriver>;
  /** Nur Tests: anderer Ordner (oder null = keiner) statt der mitgelieferten Rezepte. */
  bundledRecipes?: string | null;
  /** Tests only: shortens the waits of a "Confirm access" step (GitHub Mobile, code check, tries). */
  automationAccess?: { mobileTimeoutMs?: number; submitTimeoutMs?: number; maxAttempts?: number };
}

/** Verbindungs-Ids, die der Kern fest verwendet. */
export const GITHUB_CONNECTION = "github";
export const GITHUB_APP_KEY_CONNECTION = "github-app-key";

/** Baut alles zusammen, was CLI, Portal und MCP-Server brauchen. Liest Konfiguration und Inventar, keine Werte. */
export async function createRuntime(configPath: string, options: RuntimeOptions = {}): Promise<Runtime> {
  const path = resolve(configPath);
  const config = await loadConfig(path);
  const inventory = await InventoryStore.open(resolve(dirname(path), config.inventory));

  const specs: Record<string, SourceSpec> = { ...config.connections };
  if (config.github.auth.type === "pat") specs[GITHUB_CONNECTION] = config.github.auth.source;
  else specs[GITHUB_APP_KEY_CONNECTION] = config.github.auth.privateKey;

  // Where the live check reads its notification address from: the same sources as a connection token (never shown, never logged).
  if (config.automation.liveCheckNotify) specs[LIVE_CHECK_NOTIFY_CONNECTION] = config.automation.liveCheckNotify.url;

  // Headless: Token fuer das Team-Repository nur aus der Umgebung (Wert wird nie angezeigt).
  const env = options.env ?? process.env;
  if (env["SECRET_DESK_TEAM_TOKEN"] && !specs[TEAM_SYNC_CONNECTION]) specs[TEAM_SYNC_CONNECTION] = { type: "env", name: "SECRET_DESK_TEAM_TOKEN" };

  const vault = options.vault === undefined ? (config.vault.enabled ? new SecretVault({ ...(config.vault.file ? { file: expandHome(config.vault.file) } : {}), ...(config.vault.keyFile ? { keyFile: expandHome(config.vault.keyFile) } : {}) }) : undefined) : (options.vault ?? undefined);
  const connections = new ConnectionStore({
    specs,
    ...(vault ? { vault } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
  });
  const f = options.fetch ?? fetch;

  let auth: TokenProvider;
  if (config.github.auth.type === "pat") {
    auth = () => connections.token(GITHUB_CONNECTION);
  } else {
    const app = config.github.auth;
    let cached: TokenProvider | null = null;
    auth = async () => {
      if (!cached) {
        cached = githubAppProvider({
          appId: app.appId,
          privateKey: await connections.token(GITHUB_APP_KEY_CONNECTION),
          owner: config.github.owner,
          ...(app.repositories ? { repositories: app.repositories } : {}),
          permissions: { secrets: "write", environments: "read", metadata: "read" },
          fetch: f,
        });
      }
      return cached();
    };
  }

  const providers = createDefaultRegistry();
  for (const def of inventory.data.providers) {
    const manual: Provider = { id: def.id, label: def.label, kind: "manual", guide: { url: def.url, steps: def.steps } };
    providers.register(manual);
  }

  const evidence = new FileEvidenceStore(resolve(dirname(path), config.evidenceDir));
  const dataDir = dirname(resolve(expandHome(config.linksFile ?? join(homedir(), ".secret-desk", "repo-links.json"))));
  const automation = new AutomationManager({
    config,
    configDir: dirname(path),
    inventoryDir: dirname(resolve(dirname(path), config.inventory)),
    providers,
    evidence,
    env,
    ...(options.persistSignIn ? { signInStateFile: join(dataDir, "sign-in-state.json"), liveCheckStateFile: join(dataDir, "live-check-state.json") } : {}),
    ...(options.automationDriver ? { driverFactory: options.automationDriver } : {}),
    ...(options.bundledRecipes !== undefined ? { bundledDir: options.bundledRecipes } : {}),
    ...(options.automationAccess ? { access: options.automationAccess } : {}),
  });
  await automation.load();

  const approvals = new ApprovalQueue();
  const teamSyncMemo: Runtime["teamSyncMemo"] = { lastCheck: null, lastError: null };
  // The inventory follows its file. When it was changed from outside, state derived from the old content is dropped:
  // open approvals whose entry changed become stale, and the cached team-sync comparison is no longer valid.
  inventory.onExternalChange(() => {
    approvals.revalidate(inventory);
    teamSyncMemo.lastCheck = null;
  });
  if (options.watchInventory) inventory.watch();

  return {
    config,
    configPath: path,
    inventory,
    github: new GitHubClient({ auth, fetch: f }),
    workers: new WorkerSecretsClient({ auth: () => connections.token(CLOUDFLARE_CONNECTION), fetch: f }),
    connections,
    providers,
    approvals,
    issuances: new IssuanceQueue(),
    evidence,
    automation,
    owner: config.github.owner,
    fetch: f,
    teamSyncMemo,
  };
}

/** Abhaengigkeiten fuer die Funktionen des Kerns, die Ausstellung und Bestaetigung steuern. */
export function issuanceDeps(rt: Runtime): IssuanceDeps {
  return { inventory: rt.inventory, github: rt.github, workers: rt.workers, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch, evidence: rt.evidence, providerConfig: rt.config.providers };
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export { patProvider };
