import { execFile } from "node:child_process";
import { devNull, homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PlaywrightDriver, chromeInstallHint, findChrome } from "@secret-desk/automation";
import { SecretVault, commandEnv, gitCheckIgnored, nodeConnectionHost, runEnvCommand, type ExecFn } from "@secret-desk/core";
import { HOME_PATHS, type HostPaths, type RuntimeHost } from "./host-core.js";

// The interface, the error and the helpers that read from a host have no Node API and live in `host-core.ts` (part of the portable
// entry). They are re-exported here, so every import of `host.js` keeps working and sees the same classes and functions.
export { HOME_PATHS, HostCapabilityError, expandHomeFor, hostHome, readHostEnv, type HostPaths, type RuntimeHost } from "./host-core.js";

export interface NodeRuntimeHostOptions {
  /** Environment object for `env` (default: the process environment). */
  env?: NodeJS.ProcessEnv;
  /** Replaces the start of `op` (tests). */
  exec?: ExecFn;
}

/**
 * The environment Git gets, built from the host's own environment source: system basics (like template commands), no provider
 * tokens, no prompts, and neither the system nor the user's global Git configuration (they can name programs to run). A
 * repository's own `.git/config` still applies; the `-c` switches below turn off the settings that would run a program for the
 * two commands the host starts.
 */
function gitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return { ...commandEnv(env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** `-c` switches for every Git call of the host: no file system monitor hook, no untracked cache. */
const GIT_SAFE_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

/**
 * The path rules of the host (`HOME_PATHS`) that tell the portable `expandHomeFor` how paths work on this machine: the path style
 * and the join of the path module of the platform. `platform` is only for tests (default: the platform of the process).
 */
export function nodeHomePaths(platform: NodeJS.Platform = process.platform): { [HOME_PATHS]: HostPaths } {
  const api = platform === "win32" ? win32 : posix;
  return { [HOME_PATHS]: { style: platform === "win32" ? "win32" : "posix", join: (base, rest) => api.join(base, rest) } };
}

/**
 * The host of the local, single-user edition: the process environment, the `op` tool, the allow-listed template commands,
 * `git`, the home folder, the OS vault and the local browser. Pass it explicitly to `createRuntime`; the runtime never picks
 * it up on its own.
 */
export function nodeRuntimeHost(options: NodeRuntimeHostOptions = {}): RuntimeHost {
  const env = options.env ?? process.env;
  return {
    ...nodeConnectionHost(env, options.exec),
    runCommand: (command, cwd) => runEnvCommand(command, cwd),
    gitOrigin: (dir) =>
      new Promise((res) => {
        execFile("git", [...GIT_SAFE_CONFIG, "-C", dir, "remote", "get-url", "--", "origin"], { timeout: 5000, windowsHide: true, env: gitEnv(env) }, (err, out) => {
          const url = err ? "" : String(out).trim();
          res(url || null);
        });
      }),
    gitCheckIgnored: (path) => gitCheckIgnored(path, gitEnv(env)),
    homeDir: () => homedir(),
    ...nodeHomePaths(),
    // The vault file is named explicitly from the host's home folder when the configuration names none.
    openVault: (vaultOptions) => new SecretVault({ ...vaultOptions, file: vaultOptions.file ?? join(homedir(), ".secret-desk", "vault.json") }),
    launchLocalBrowser: (o) => new PlaywrightDriver({ ...(o.chromePath ? { chromePath: o.chromePath } : {}), profileDir: o.profileDir, ...(o.slowMoMs !== undefined ? { slowMoMs: o.slowMoMs } : {}) }),
    connectRemoteBrowser: (o) => new PlaywrightDriver({ cdpEndpoint: o.cdpEndpoint, ...(o.slowMoMs !== undefined ? { slowMoMs: o.slowMoMs } : {}) }),
    findChrome: (preferred) => {
      const path = findChrome(preferred) ?? null;
      return { path, hint: path ? null : chromeInstallHint() };
    },
  };
}
