import {
  CLOUDFLARE_CONNECTION,
  ConnectionStoreCore,
  type ConnectionStoreCoreOptions,
  TEAM_SYNC_CONNECTION,
  WorkerSecretsClient,
  type AppJwtSigner,
  type DeskConfig,
  type EvidenceStore,
  type FetchLike,
  type GitHubClient,
  type InventoryStoreCore,
  type IssuanceDeps,
  type Provider,
  type ProviderRegistry,
  type SecretSealer,
  type SourceSpec,
  type TokenProvider,
  type Vault,
  type SessionVault,
} from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import type { Authorize, AuthorizeFault } from "./agent-api.js";
import { ApprovalQueue } from "./approvals.js";
import { noAutomation, type AutomationPort } from "./automation-port.js";
import { createAppTokenProvider, createGitHubClient, type GitHubClientClass, type GitHubCryptoDefaults } from "./github-crypto-core.js";
import { expandHomeFor, readHostEnv, type RuntimeHost } from "./host-core.js";
import { InstanceState } from "./instance-state.js";
import { IssuanceQueue, type PendingRecord, type PendingStore } from "./issuances.js";
import { LIVE_CHECK_NOTIFY_CONNECTION } from "./live-check-notify.js";

// The runtime on the portable parts only: no Node built-ins, no file system, no process. `createPortableRuntime` takes the parts that
// are the same everywhere (the configuration, the inventory, the evidence store) and builds the rest. The local edition (`runtime.ts`)
// opens the files, creates the browser automation and calls this builder. Nothing here may keep state in module scope: what a runtime
// holds lives in the object this builder returns (`state-guard.test.ts`).

/** Verbindungs-Ids, die der Kern fest verwendet. */
export const GITHUB_CONNECTION = "github";
export const GITHUB_APP_KEY_CONNECTION = "github-app-key";

/** What a runtime is built from: the parts the embedder opens itself. */
export interface PortableRuntimeSource<I extends InventoryStoreCore = InventoryStoreCore> {
  config: DeskConfig;
  inventory: I;
  evidence: EvidenceStore;
  /** Where the configuration came from, when it came from a file. Absent for a runtime that has no files. */
  configPath?: string;
}

/** What the browser automation of a runtime is built from (`PortableRuntimeOptions.automation`). */
export interface PortableAutomationContext {
  config: DeskConfig;
  /** The providers of this runtime, manual providers of the inventory included: the automation registers its browser providers here. */
  providers: ProviderRegistry;
  inventory: InventoryStoreCore;
  evidence: EvidenceStore;
  host: RuntimeHost | undefined;
  now: () => Date;
}

export interface PortableRuntimeOptions<A extends AutomationPort = AutomationPort> {
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
  /**
   * Seals a value for the GitHub secret store (the same `SecretSealer` the portable GitHub client takes). Without it, a runtime
   * with a host seals with the libsodium default of the core, and a runtime without a host cannot seal: writing a GitHub secret
   * (`putSecret` and the write probe) is refused with a `HostCapabilityError` before any request is made, the public key
   * request included. (`createPortableRuntime` has no libsodium: there the default comes from `githubDefaults`.)
   */
  seal?: SecretSealer;
  /**
   * Signs the GitHub App token request (the same `AppJwtSigner` the portable GitHub client takes), so the App private key never
   * enters this process and is not read. The signer must sign for the GitHub App named by `github.auth.appId` of the configuration
   * (the issuer comes from the configuration; GitHub refuses a signer of another App). Without it, a runtime with a host signs with the key of the `github-app-key`
   * connection, and a runtime without a host refuses to build an App token with a `HostCapabilityError`.
   * (`createPortableRuntime` has no Node crypto: there the default comes from `githubDefaults`.)
   */
  sign?: AppJwtSigner;
  /**
   * Meant for the Node entry (`createRuntime`), not for a portable embedder: what to use for sealing and for signing with a stored
   * private key when `seal` and `sign` are not given (the local edition hands in libsodium and the Node crypto module). Without a
   * default the operation is refused with a `HostCapabilityError`. An embedder injects `seal` and `sign` instead.
   */
  githubDefaults?: GitHubCryptoDefaults;
  /**
   * Meant for the Node entry (`createRuntime`), not for a portable embedder: the class of the GitHub client the runtime builds (it
   * derives its own subclass from it). Left out: the portable client of the core. The local edition passes the Node facade of the
   * core, so the client is an instance of the class it has always had.
   */
  githubClientClass?: GitHubClientClass;
  /**
   * Meant for the Node entry (`createRuntime`), not for a portable embedder: makes the connection store from the parts the builder
   * collected (sources, session, vault, host). Left out: a `ConnectionStoreCore`. The local edition passes a function that builds
   * the Node `ConnectionStore`, so the store is an instance of the class it has always had.
   */
  createConnections?: (options: ConnectionStoreCoreOptions) => ConnectionStoreCore;
  session?: SessionVault;
  /** Long-running processes (the portal): also watch the inventory directory so changes made by the CLI show up without a read. */
  watchInventory?: boolean;
  /**
   * The vault. Left out: the host's `openVault` opens the default one when the configuration has the vault on; a runtime that has no
   * such capability has no vault. `null`: no vault at all. An embedder without a host passes its own vault here (for example a `Vault` with its own store and key source).
   */
  vault?: Vault | null;
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
  /**
   * The providers of the runtime: a registry, or a function that makes one (called once per runtime). Left out: the portable
   * providers (`createPortableRegistry()`). The manual providers of the inventory are registered on top in either case.
   */
  providers?: ProviderRegistry | (() => ProviderRegistry);
  /**
   * Makes the browser automation of the runtime. It is a function because the automation needs the providers this builder creates
   * (it registers its browser providers there). Left out: `noAutomation`, which offers nothing and refuses to run anything.
   */
  automation?: (context: PortableAutomationContext) => A | Promise<A>;
}

export interface RuntimeCore {
  config: DeskConfig;
  /** The configuration file this runtime was built from; absent for a runtime that has no files. */
  configPath?: string;
  inventory: InventoryStoreCore;
  github: GitHubClient;
  /** Secrets of Cloudflare Workers, written with the token of the `cloudflare` connection. */
  workers: WorkerSecretsClient;
  connections: ConnectionStoreCore;
  providers: ProviderRegistry;
  approvals: ApprovalQueue;
  issuances: IssuanceQueue;
  evidence: EvidenceStore;
  /** Browser automation; `noAutomation` when the runtime was built without any. */
  automation: AutomationPort;
  owner: string;
  fetch: FetchLike;
  /** The host capability this runtime was built with; absent when there is none (see `PortableRuntimeOptions.host`). */
  host?: RuntimeHost;
  /** The injected sealer the GitHub clients of this runtime use (`PortableRuntimeOptions.seal`); absent when none was given. */
  seal?: SecretSealer;
  /** The injected signer for GitHub App tokens (`PortableRuntimeOptions.sign`); absent when none was given. */
  sign?: AppJwtSigner;
  /** Optional authorisation hook, consulted after the built-in policy checks (see `Authorize`). Absent in the local edition. */
  authorize?: Authorize;
  /** How long the hook may take before the action is refused (default 10000 ms). */
  authorizeTimeoutMs?: number;
  /** Called with a class name and a reason (never a message or a value) when the hook faulted and the action was refused. */
  onAuthorizeFault?: (fault: AuthorizeFault) => void;
  /** Nur Arbeitsspeicher: Ergebnis der letzten Abfrage des Team-Repositories. */
  teamSyncMemo: { lastCheck: unknown | null; lastError: string | null };
  /** The clock every deadline of this runtime is checked against (`PortableRuntimeOptions.now`; default: the system clock). */
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

/**
 * A timeout of 0 or NaN would silently become 1 ms in setTimeout and refuse everything: it is rejected where the runtime is built.
 * Called by `createPortableRuntime` and, before it opens any file, by `createRuntime`.
 */
export function assertAuthorizeTimeout(value: unknown): void {
  if (value !== undefined && !(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2147483647)) {
    throw new Error("Konfiguration ungueltig: authorizeTimeoutMs: eine ganze Zahl von 1 bis 2147483647");
  }
}

/**
 * Builds everything the CLI, the portal, the MCP server or an embedder needs from parts that need no Node API. Reads no value.
 * The result carries the type of the inventory and of the automation it was given.
 */
export async function createPortableRuntime<I extends InventoryStoreCore = InventoryStoreCore, A extends AutomationPort = AutomationPort>(
  source: PortableRuntimeSource<I>,
  options: PortableRuntimeOptions<A> = {},
): Promise<RuntimeCore & { inventory: I; automation: A }> {
  assertAuthorizeTimeout(options.authorizeTimeoutMs);
  const { config, inventory, evidence } = source;

  const specs: Record<string, SourceSpec> = { ...config.connections };
  if (config.github.auth.type === "pat") specs[GITHUB_CONNECTION] = config.github.auth.source;
  else specs[GITHUB_APP_KEY_CONNECTION] = config.github.auth.privateKey;

  // Where the live check reads its notification address from: the same sources as a connection token (never shown, never logged).
  if (config.automation.liveCheckNotify) specs[LIVE_CHECK_NOTIFY_CONNECTION] = config.automation.liveCheckNotify.url;

  // Headless: the token of the team repository comes from the environment of the host only (never shown). Without a host nothing is read.
  const host = options.host ?? undefined;
  const crypto = { host, seal: options.seal, sign: options.sign, defaults: options.githubDefaults };
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
  // Without a host the store reads no environment variable and starts no process: an `env` or `op` source is unavailable.
  const connectionParts: ConnectionStoreCoreOptions = {
    specs,
    ...(vault ? { vault } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(host ? { host } : {}),
  };
  const connections = options.createConnections ? options.createConnections(connectionParts) : new ConnectionStoreCore(connectionParts);
  const f = options.fetch ?? fetch;

  let auth: TokenProvider;
  if (config.github.auth.type === "pat") {
    auth = () => connections.token(GITHUB_CONNECTION);
  } else {
    const app = config.github.auth;
    auth = createAppTokenProvider(
      crypto,
      {
        appId: app.appId,
        owner: config.github.owner,
        ...(app.repositories ? { repositories: app.repositories } : {}),
        permissions: { secrets: "write", environments: "read", metadata: "read" },
        fetch: f,
      },
      () => connections.token(GITHUB_APP_KEY_CONNECTION),
    );
  }

  const given = options.providers;
  const providers = given === undefined ? createPortableRegistry() : typeof given === "function" ? given() : given;
  for (const def of inventory.data.providers) {
    const manual: Provider = { id: def.id, label: def.label, kind: "manual", guide: { url: def.url, steps: def.steps } };
    providers.register(manual);
  }

  const now = options.now ?? ((): Date => new Date());
  const automation = (options.automation ? await options.automation({ config, providers, inventory, evidence, host, now }) : noAutomation) as A;

  const approvals = new ApprovalQueue();
  const teamSyncMemo: RuntimeCore["teamSyncMemo"] = { lastCheck: null, lastError: null };
  // The inventory follows its file. When it was changed from outside, state derived from the old content is dropped:
  // open approvals whose entry changed become stale, and the cached team-sync comparison is no longer valid.
  inventory.onExternalChange(() => {
    approvals.revalidate(inventory);
    teamSyncMemo.lastCheck = null;
  });
  if (options.watchInventory) inventory.watch();

  const issuances = new IssuanceQueue({ now, ...(options.pendingStore ? { store: options.pendingStore } : {}), ...(options.onRevokeAbandoned ? { onRevokeAbandoned: options.onRevokeAbandoned } : {}), ...(options.onNeedsDecision ? { onNeedsDecision: options.onNeedsDecision } : {}) });
  const instance = new InstanceState();

  const rt: RuntimeCore & { inventory: I; automation: A } = {
    config,
    ...(source.configPath !== undefined ? { configPath: source.configPath } : {}),
    inventory,
    github: createGitHubClient(crypto, { auth, fetch: f }, options.githubClientClass),
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
    ...(options.seal ? { seal: options.seal } : {}),
    ...(options.sign ? { sign: options.sign } : {}),
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

/** Abhaengigkeiten fuer die Funktionen des Kerns, die Ausstellung und Bestaetigung steuern. */
export function issuanceDeps(rt: RuntimeCore): IssuanceDeps {
  return { inventory: rt.inventory, github: rt.github, workers: rt.workers, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch, evidence: rt.evidence, providerConfig: rt.config.providers, now: rt.now };
}
