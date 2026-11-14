import { execFile } from "node:child_process";
import { ConnectionStoreCore, type ConnectionHost, type SessionVault, type SourceSpec } from "./connections-core.js";
import type { SecretVault } from "./vault.js";

export * from "./connections-core.js";

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** A 1Password reference always starts with this scheme; anything else is never handed to `op`. */
const OP_REFERENCE_PREFIX = "op://";

/**
 * The host capability of the local edition: the process environment and the `op` command line tool.
 *
 * `env` answers only for an own property of the environment object whose value is a string: names such as `toString`,
 * `constructor` or `__proto__` find inherited members on a plain object and count as not set. `readReference` refuses
 * anything that does not start with `op://` before a process is started (the error does not repeat the reference) and
 * passes `--` before the reference, so it can never be read as an option.
 */
export function nodeConnectionHost(env: NodeJS.ProcessEnv = process.env, exec: ExecFn = defaultExec): ConnectionHost {
  return {
    label: "local process",
    env: (name) => {
      if (!Object.prototype.hasOwnProperty.call(env, name)) return undefined;
      const value: unknown = env[name];
      return typeof value === "string" ? value : undefined;
    },
    readReference: (ref) => {
      if (typeof ref !== "string" || !ref.startsWith(OP_REFERENCE_PREFIX)) return Promise.reject(new Error("The reference is not a 1Password reference (op://...)."));
      return exec("op", ["read", "--", ref]);
    },
  };
}

export interface ConnectionStoreOptions {
  specs?: Record<string, SourceSpec>;
  session?: SessionVault;
  /** Dauerhafter, verschluesselter Tresor (optional). */
  vault?: SecretVault;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  /**
   * Explicit host capability. Wins over `env` and `exec`; `null` means no host (restricted mode: `env` and `op` sources are unavailable).
   * Omitting it grants the process environment and the `op` tool. A runtime that serves several users must pass `null` or use `ConnectionStoreCore`.
   */
  host?: ConnectionHost | null;
  /** Uhr fuer die Ablaufpruefung (Tests). */
  now?: () => Date;
}

/** The store of the local edition: a `ConnectionStoreCore` whose default host is the Node process. */
export class ConnectionStore extends ConnectionStoreCore {
  constructor(options: ConnectionStoreOptions = {}) {
    const { env, exec, host, ...rest } = options;
    const resolved = host === null ? undefined : (host ?? nodeConnectionHost(env, exec));
    super({ ...rest, ...(resolved ? { host: resolved } : {}) });
  }
}
