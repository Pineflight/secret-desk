import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ConnectionStore,
  GitHubClient,
  CLOUDFLARE_CONNECTION,
  WorkerSecretsClient,
  InventoryStore,
  ProviderRegistry,
  type SecretVault,
  SessionVault,
  githubAppProvider,
  loadConfig,
  TEAM_SYNC_CONNECTION,
  patProvider,
  type DeskConfig,
  type FetchLike,
  type Provider,
  type SourceSpec,
  type TokenProvider,
} from "@secret-desk/core";
import { createDefaultRegistry } from "@secret-desk/providers";
import { FileEvidenceStore, type EvidenceStore, type IssuanceDeps } from "@secret-desk/core";
import type { BrowserDriver } from "@secret-desk/automation";
import type { Authorize, AuthorizeFault } from "./agent-api.js";
import { ApprovalQueue } from "./approvals.js";
import { AutomationManager } from "./automation.js";
import { HostCapabilityError, expandHomeFor, hostHome, nodeRuntimeHost, readHostEnv, type NodeRuntimeHostOptions, type RuntimeHost } from "./host.js";
import { InstanceState } from "./instance-state.js";
import { IssuanceQueue, type PendingRecord, type PendingStore } from "./issuances.js";
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
  /** The host capability this runtime was built with; absent when there is none (see `RuntimeOptions.host`). */
  host?: RuntimeHost;
  /** Optional authorisation hook, consulted after the built-in policy checks (see `Authorize`). Absent in the local edition. */
  authorize?: Authorize;
  /** How long the hook may take before the action is refused (default 10000 ms). */
  authorizeTimeoutMs?: number;
  /** Called with a class name and a reason (never a message or a value) when the hook faulted and the action was refused. */
  onAuthorizeFault?: (fault: AuthorizeFault) => void;
  /** Nur Arbeitsspeicher: Ergebnis der letzten Abfrage des Team-Repositories. */
  teamSyncMemo: { lastCheck: unknown | null; lastError: string | null };
  /** The clock every deadline of this runtime is checked against (`RuntimeOptions.now`; default: the system clock). */
  now: () => Date;
  /**
   * What this runtime holds while it waits for a person (one-time codes, approvals, credentials in transit). It belongs to this
   * instance alone: two runtimes in one process share no waiter and no answer.
   */
  instance: InstanceState;
  /**
   * Removes everything that has expired (pending reviews, whose unconfirmed new values this process itself issued are also deleted
   * at the provider unless a commit has written them somewhere, and waits for an answer) and returns the earliest deadline that
   * remains, or null when nothing is waiting. For an embedder to call from a timer or an alarm and to re-arm with the result.
   * Correctness never depends on it: every access checks its deadline itself, so a missed sweep never extends the life of a value.
   * It is not behind the authorisation hook on purpose. It never revokes the value of a record it does not hold the review for
   * (see `Runtime.issuances.orphans()` and `revokeOrphan`).
   */
  sweep(now?: Date): Promise<Date | null>;
}

export interface RuntimeOptions {
  fetch?: FetchLike;
  /**
   * What the runtime may reach on the machine that runs it (see `RuntimeHost`): environment variables by name, `op`, the
   * allow-listed template commands, `git`, the home folder, the default vault, a local or remote browser. Omitted or `null`
   * means no host: every path that needs one is unavailable (an `env` or `op` connection source, the team token and start-up
   * settings from the environment, the browser address from the environment, template commands, Git remote checks, `~` paths and
   * default locations in the home folder, the default vault, any browser) and nothing reads the process environment or the home
   * folder or starts a process. There is no fallback to the process; the local edition passes `nodeRuntimeHost()` (or uses
   * `createLocalRuntime`).
   */
  host?: RuntimeHost | null;
  session?: SessionVault;
  /** Long-running processes (the portal): also watch the inventory directory so changes made by the CLI show up without a read. */
  watchInventory?: boolean;
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
  /**
   * Optional hook called before sensitive actions, after the built-in policy checks have passed (it can refuse, never allow
   * what the built-in rules refuse). Without it nothing changes. This repository ships no rules for it.
   */
  authorize?: Authorize;
  /** Time limit for the hook in milliseconds; when it does not settle in time the action is refused (default 10000). */
  authorizeTimeoutMs?: number;
  /**
   * Told when the hook faulted (threw something that is not a `PolicyError`, returned anything but `undefined`, did not
   * settle in time, or is not a function). Carries the action, a reason and at most the class name of the foreign error:
   * never its message and never a value. A throwing callback changes nothing.
   */
  onAuthorizeFault?: (fault: AuthorizeFault) => void;
  /** The clock for every deadline (pending reviews, waits for an answer, browser runs). Default: the system clock. Tests and embedders inject their own. */
  now?: () => Date;
  /**
   * Where the records of pending reviews are kept (default: memory of this runtime). The store only ever sees metadata (a
   * `PendingRecord`: identifier, deadline, the provider's identifier of the new value), never the value, which the runtime keeps
   * in memory itself. See `PendingStore`.
   */
  pendingStore?: PendingStore;
  /**
   * Told (with a record: ids and times, never a value) when the sweep gave up on deleting the new value of an unconfirmed review at
   * the provider after several tries. The record stays as an orphan; the value stays valid at the provider until it expires or
   * someone deletes it. A throwing callback changes nothing.
   */
  onRevokeAbandoned?: (record: PendingRecord) => void;
  /**
   * Told (with a record: ids and times, never a value) when the revoke gate refused to revoke the new value of a review because a
   * write of it was started (it may be in use at some place): a person has to decide, by rejecting with the acknowledgement or by
   * `IssuanceQueue.revokeOrphan(..., { acceptPartial: true })`. Also told when such a review expires. A throwing callback changes nothing.
   */
  onNeedsDecision?: (record: PendingRecord) => void;
}

/** Verbindungs-Ids, die der Kern fest verwendet. */
export const GITHUB_CONNECTION = "github";
export const GITHUB_APP_KEY_CONNECTION = "github-app-key";

/** Baut alles zusammen, was CLI, Portal und MCP-Server brauchen. Liest Konfiguration und Inventar, keine Werte. */
export async function createRuntime(configPath: string, options: RuntimeOptions = {}): Promise<Runtime> {
  // A timeout of 0 or NaN would silently become 1 ms in setTimeout and refuse everything: reject it where the runtime is built.
  const timeoutMs: unknown = options.authorizeTimeoutMs;
  if (timeoutMs !== undefined && !(typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 2147483647)) {
    throw new Error("Konfiguration ungueltig: authorizeTimeoutMs: eine ganze Zahl von 1 bis 2147483647");
  }
  const path = resolve(configPath);
  const config = await loadConfig(path);
  const inventory = await InventoryStore.open(resolve(dirname(path), config.inventory));

  const specs: Record<string, SourceSpec> = { ...config.connections };
  if (config.github.auth.type === "pat") specs[GITHUB_CONNECTION] = config.github.auth.source;
  else specs[GITHUB_APP_KEY_CONNECTION] = config.github.auth.privateKey;

  // Where the live check reads its notification address from: the same sources as a connection token (never shown, never logged).
  if (config.automation.liveCheckNotify) specs[LIVE_CHECK_NOTIFY_CONNECTION] = config.automation.liveCheckNotify.url;

  // Headless: the token of the team repository comes from the environment of the host only (never shown). Without a host nothing is read.
  const host = options.host ?? undefined;
  if (readHostEnv(host, "SECRET_DESK_TEAM_TOKEN") && !specs[TEAM_SYNC_CONNECTION]) specs[TEAM_SYNC_CONNECTION] = { type: "env", name: "SECRET_DESK_TEAM_TOKEN" };

  // The default vault (a file plus the key source of the OS, which reads the environment and starts the OS key tools) is part of the
  // host: without `host.openVault` there is no default vault, and an embedder passes `vault` itself.
  const expand = (p: string): string => expandHomeFor(host, p);
  const vault =
    options.vault === undefined
      ? config.vault.enabled && host?.openVault
        ? host.openVault({ ...(config.vault.file ? { file: expand(config.vault.file) } : {}), ...(config.vault.keyFile ? { keyFile: expand(config.vault.keyFile) } : {}) })
        : undefined
      : (options.vault ?? undefined);
  const connections = new ConnectionStore({
    specs,
    ...(vault ? { vault } : {}),
    ...(options.session ? { session: options.session } : {}),
    // `null` keeps the store out of the Node default: without a host an `env` or `op` source is unavailable.
    host: host ?? null,
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
  // The folder of the state files (sign-in memory, live check) is next to the repository links file. Only needed when persisting;
  // without a home folder there is no default location, so the links file must be named.
  let dataDir: string | undefined;
  if (options.persistSignIn) {
    const home = hostHome(host);
    const linksFile = config.linksFile ? expand(config.linksFile) : home ? join(home, ".secret-desk", "repo-links.json") : undefined;
    if (!linksFile) throw new HostCapabilityError("homeDir", "persistSignIn braucht einen Ablageort: linksFile in der Konfiguration angeben oder einen Host mit Home-Ordner uebergeben.");
    dataDir = dirname(resolve(linksFile));
  }
  const automation = new AutomationManager({
    config,
    configDir: dirname(path),
    inventoryDir: dirname(resolve(dirname(path), config.inventory)),
    providers,
    evidence,
    ...(host ? { host } : {}),
    ...(dataDir ? { signInStateFile: join(dataDir, "sign-in-state.json"), liveCheckStateFile: join(dataDir, "live-check-state.json") } : {}),
    ...(options.automationDriver ? { driverFactory: options.automationDriver } : {}),
    ...(options.bundledRecipes !== undefined ? { bundledDir: options.bundledRecipes } : {}),
    ...(options.automationAccess ? { access: options.automationAccess } : {}),
    ...(options.now ? { now: options.now } : {}),
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

  const now = options.now ?? ((): Date => new Date());
  const issuances = new IssuanceQueue({ now, ...(options.pendingStore ? { store: options.pendingStore } : {}), ...(options.onRevokeAbandoned ? { onRevokeAbandoned: options.onRevokeAbandoned } : {}), ...(options.onNeedsDecision ? { onNeedsDecision: options.onNeedsDecision } : {}) });
  const instance = new InstanceState();

  const rt: Runtime = {
    config,
    configPath: path,
    inventory,
    github: new GitHubClient({ auth, fetch: f }),
    workers: new WorkerSecretsClient({ auth: () => connections.token(CLOUDFLARE_CONNECTION), fetch: f }),
    connections,
    providers,
    approvals,
    issuances,
    evidence,
    automation,
    owner: config.github.owner,
    fetch: f,
    ...(host ? { host } : {}),
    ...(options.authorize !== undefined ? { authorize: options.authorize } : {}),
    ...(options.authorizeTimeoutMs !== undefined ? { authorizeTimeoutMs: options.authorizeTimeoutMs } : {}),
    ...(options.onAuthorizeFault ? { onAuthorizeFault: options.onAuthorizeFault } : {}),
    teamSyncMemo,
    now,
    instance,
    sweep: async (at) => {
      // Deliberately not asked of the authorisation hook: clean-up only discards values and answers, so a hook can never extend a life.
      const when = at ?? rt.now();
      await rt.issuances.sweep(issuanceDeps(rt), when);
      const reviews = rt.issuances.nextDeadline()?.getTime() ?? null;
      const waits = instance.sweepWaiters(when);
      const next = reviews === null ? waits : waits === null ? reviews : Math.min(reviews, waits);
      return next === null ? null : new Date(next);
    },
  };
  return rt;
}

/**
 * The single-user local edition (portal, CLI, MCP server): `createRuntime` with the Node host passed explicitly. `env` and `exec`
 * only shape that host (tests); they are not a way to reach the process from a runtime that has no host.
 */
export async function createLocalRuntime(configPath: string, options: Omit<RuntimeOptions, "host"> & NodeRuntimeHostOptions = {}): Promise<Runtime> {
  const { env, exec, ...rest } = options;
  return createRuntime(configPath, { ...rest, host: nodeRuntimeHost({ ...(env ? { env } : {}), ...(exec ? { exec } : {}) }) });
}

/** Abhaengigkeiten fuer die Funktionen des Kerns, die Ausstellung und Bestaetigung steuern. */
export function issuanceDeps(rt: Runtime): IssuanceDeps {
  return { inventory: rt.inventory, github: rt.github, workers: rt.workers, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch, evidence: rt.evidence, providerConfig: rt.config.providers, now: rt.now };
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export { patProvider };
