import { execFile } from "node:child_process";
import { gitCheckIgnored, nodeConnectionHost, runEnvCommand, type ConnectionHost, type EnvCommand, type ExecFn } from "@secret-desk/core";

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
}

/**
 * Reads one environment variable through the host. Anything but a string, an absent host and a host without `env` all count
 * as "not set", so the process environment is never consulted.
 */
export function readHostEnv(host: ConnectionHost | undefined | null, name: string): string | undefined {
  const value: unknown = host?.env?.(name);
  return typeof value === "string" ? value : undefined;
}

export interface NodeRuntimeHostOptions {
  /** Environment object for `env` (default: the process environment). */
  env?: NodeJS.ProcessEnv;
  /** Replaces the start of `op` (tests). */
  exec?: ExecFn;
}

/**
 * The host of the local, single-user edition: the process environment, the `op` tool, the allow-listed template commands
 * and `git` on the machine. Pass it explicitly to `createRuntime`; the runtime never picks it up on its own.
 */
export function nodeRuntimeHost(options: NodeRuntimeHostOptions = {}): RuntimeHost {
  return {
    ...nodeConnectionHost(options.env ?? process.env, options.exec),
    runCommand: (command, cwd) => runEnvCommand(command, cwd),
    gitOrigin: (dir) =>
      new Promise((res) => {
        execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => {
          const url = err ? "" : String(out).trim();
          res(url || null);
        });
      }),
    gitCheckIgnored,
  };
}
