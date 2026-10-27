import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ConnectionStore,
  GitHubClient,
  InventoryStore,
  ProviderRegistry,
  SessionVault,
  githubAppProvider,
  loadConfig,
  patProvider,
  type DeskConfig,
  type ExecFn,
  type FetchLike,
  type Provider,
  type SourceSpec,
  type TokenProvider,
} from "@secret-desk/core";
import { createDefaultRegistry } from "@secret-desk/providers";
import { EvidenceStore, type IssuanceDeps } from "@secret-desk/core";
import { ApprovalQueue } from "./approvals.js";
import { IssuanceQueue } from "./issuances.js";

export interface Runtime {
  config: DeskConfig;
  configPath: string;
  inventory: InventoryStore;
  github: GitHubClient;
  connections: ConnectionStore;
  providers: ProviderRegistry;
  approvals: ApprovalQueue;
  issuances: IssuanceQueue;
  evidence: EvidenceStore;
  owner: string;
  fetch: FetchLike;
}

export interface RuntimeOptions {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  session?: SessionVault;
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

  const connections = new ConnectionStore({
    specs,
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

  return {
    config,
    configPath: path,
    inventory,
    github: new GitHubClient({ auth, fetch: f }),
    connections,
    providers,
    approvals: new ApprovalQueue(),
    issuances: new IssuanceQueue(),
    evidence: new EvidenceStore(resolve(dirname(path), config.evidenceDir)),
    owner: config.github.owner,
    fetch: f,
  };
}

/** Abhaengigkeiten fuer die Funktionen des Kerns, die Ausstellung und Bestaetigung steuern. */
export function issuanceDeps(rt: Runtime): IssuanceDeps {
  return { inventory: rt.inventory, github: rt.github, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch, evidence: rt.evidence };
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export { patProvider };
