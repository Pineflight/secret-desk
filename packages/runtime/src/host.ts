import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { PlaywrightDriver, chromeInstallHint, findChrome, type BrowserDriver } from "@secret-desk/automation";
import { SecretVault, commandEnv, expandHome, gitCheckIgnored, nodeConnectionHost, runEnvCommand, type ConnectionHost, type EnvCommand, type ExecFn } from "@secret-desk/core";

/**
 * What the process that runs the runtime lets it reach. Every member is optional and an absent member means "not available":
 * the runtime then refuses that path or reports a documented "not available" result, and never falls back to the process.
 * The host is handed in by the embedder in code (`RuntimeOptions.host`); no configuration file or request can add a member
 * or widen one. Members take values (a name, a command key, a folder), never a command line.
 *
 * Extends the connection host of the core: `env(name)` reads ONE environment variable by name (the team token, the team
 * start-up settings, the remote browser address) and `readReference(ref)` reads one 1Password reference.
 */
export interface RuntimeHost extends ConnectionHost {
  /** Runs one allow-listed command of the environment-file templates in a folder and returns its KEY=VALUE output. */
  runCommand?(command: EnvCommand, cwd: string): Promise<Map<string, string>>;
  /** The URL of the Git remote `origin` of a working folder, or null when there is none. */
  gitOrigin?(dir: string): Promise<string | null>;
  /** Whether Git ignores a file: true, false, or null when that cannot be checked. */
  gitCheckIgnored?(path: string): Promise<boolean | null>;
  /** The home folder of the user the host runs as. Without it `~` paths and default data locations are refused. */
  homeDir?(): string | undefined;
  /** Opens the persistent vault (file store plus key source such as the OS key store). Without it the runtime has no default vault. */
  openVault?(options: { file?: string; keyFile?: string }): SecretVault;
  /** Starts a local Chrome with its own profile folder and returns the driver. Without it no local browser is started. */
  launchLocalBrowser?(options: { chromePath?: string; profileDir: string; slowMoMs?: number }): BrowserDriver | Promise<BrowserDriver>;
  /** Attaches to a remote browser at a configured DevTools endpoint (an outbound connection, no process). Without it a configured endpoint is refused. */
  connectRemoteBrowser?(options: { cdpEndpoint: string; slowMoMs?: number }): BrowserDriver | Promise<BrowserDriver>;
  /** Looks for a local Chrome (`preferred` = the configured path). Only called when `launchLocalBrowser` exists. */
  findChrome?(preferred?: string): { path: string | null; hint: string | null };
}

/** A path of the runtime needs a capability the host does not offer (for example `~` without a home folder). */
export class HostCapabilityError extends Error {
  readonly capability: string;
  constructor(capability: string, message: string) {
    super(message);
    this.name = "HostCapabilityError";
    this.capability = capability;
  }
}

/**
 * Reads one environment variable through the host. Anything but a string, an absent host and a host without `env` all count
 * as "not set", so the process environment is never consulted.
 */
export function readHostEnv(host: ConnectionHost | undefined | null, name: string): string | undefined {
  const value: unknown = host?.env?.(name);
  return typeof value === "string" ? value : undefined;
}

/** The home folder the host reports, or undefined (no host, no `homeDir`, or a non-text answer). */
export function hostHome(host: RuntimeHost | undefined | null): string | undefined {
  const home: unknown = host?.homeDir?.();
  return typeof home === "string" && home !== "" ? home : undefined;
}

const HOME_MARK = "\u0000home";

/**
 * Expands a leading `~` with the host's home folder. Anything else is returned unchanged. A `~` path without a home folder is
 * refused with a `HostCapabilityError` (never expanded to the home of the process).
 */
export function expandHomeFor(host: RuntimeHost | undefined | null, p: string): string {
  if (expandHome(p, HOME_MARK) === p) return p;
  const home = hostHome(host);
  if (!home) throw new HostCapabilityError("homeDir", "Der Pfad beginnt mit ~, aber diese Umgebung stellt keinen Home-Ordner bereit. Einen absoluten Pfad angeben.");
  return expandHome(p, home);
}

export interface NodeRuntimeHostOptions {
  /** Environment object for `env` (default: the process environment). */
  env?: NodeJS.ProcessEnv;
  /** Replaces the start of `op` (tests). */
  exec?: ExecFn;
}

/** The environment Git gets: system basics (like template commands) plus the Git configuration switches of the embedder. */
function gitEnv(): Record<string, string> {
  const out = commandEnv();
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return { ...out, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * The host of the local, single-user edition: the process environment, the `op` tool, the allow-listed template commands,
 * `git`, the home folder, the OS vault and the local browser. Pass it explicitly to `createRuntime`; the runtime never picks
 * it up on its own.
 */
export function nodeRuntimeHost(options: NodeRuntimeHostOptions = {}): RuntimeHost {
  return {
    ...nodeConnectionHost(options.env ?? process.env, options.exec),
    runCommand: (command, cwd) => runEnvCommand(command, cwd),
    gitOrigin: (dir) =>
      new Promise((res) => {
        execFile("git", ["-C", dir, "remote", "get-url", "--", "origin"], { timeout: 5000, windowsHide: true, env: gitEnv() }, (err, out) => {
          const url = err ? "" : String(out).trim();
          res(url || null);
        });
      }),
    gitCheckIgnored: (path) => gitCheckIgnored(path, gitEnv()),
    homeDir: () => homedir(),
    openVault: (vaultOptions) => new SecretVault(vaultOptions),
    launchLocalBrowser: (o) => new PlaywrightDriver({ ...(o.chromePath ? { chromePath: o.chromePath } : {}), profileDir: o.profileDir, ...(o.slowMoMs !== undefined ? { slowMoMs: o.slowMoMs } : {}) }),
    connectRemoteBrowser: (o) => new PlaywrightDriver({ cdpEndpoint: o.cdpEndpoint, ...(o.slowMoMs !== undefined ? { slowMoMs: o.slowMoMs } : {}) }),
    findChrome: (preferred) => {
      const path = findChrome(preferred) ?? null;
      return { path, hint: path ? null : chromeInstallHint() };
    },
  };
}
