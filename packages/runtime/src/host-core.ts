import type { BrowserDriver } from "@secret-desk/automation";
import type { ConnectionHost, EnvCommand, Vault } from "@secret-desk/core/portable";

// The host capability without any Node API: the interface, its error and the helpers that read from it. The Node host that
// fills the interface (`nodeRuntimeHost`) lives in `host.ts`, which re-exports everything here. This file is part of the
// portable entry (`@secret-desk/runtime/portable`); `portable-modules.test.ts` guards that it stays free of Node APIs. The
// scanner of `host-guard.test.ts` does not look at it: the interface below names host members (`findChrome`, `gitCheckIgnored`)
// that the scanner would flag, although a name in a type declaration reaches nothing.

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
  openVault?(options: { file?: string; keyFile?: string }): Vault;
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
  let home: unknown;
  try {
    home = host?.homeDir?.();
  } catch {
    return undefined; // a host whose home lookup throws has no home folder
  }
  return typeof home === "string" && home !== "" ? home : undefined;
}

/** A Windows home folder (a drive letter or a UNC share): paths below it are joined with the Windows rules. */
const WINDOWS_HOME = /^(?:[A-Za-z]:(?:[\\/]|$)|[\\/]{2}[^\\/])/;

/**
 * Joins a folder and a relative path and normalises the result the way `path.join` does (collapsed separators, resolved `.` and
 * `..`, a kept trailing separator), without the path module: the rules of Windows when the folder is a Windows folder, else the
 * rules of POSIX.
 */
function joinBelow(home: string, rest: string): string {
  const win = WINDOWS_HOME.test(home);
  const joined = rest === "" ? home : `${home}${win ? "\\" : "/"}${rest}`;
  const sep = win ? "\\" : "/";
  let prefix = "";
  let body = joined;
  if (win) {
    // A drive letter and/or the root separator, or the device root of a UNC share (`\\server\share`).
    const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(joined);
    if (unc) {
      prefix = `\\\\${unc[1]}\\${unc[2]}\\`;
      body = joined.slice(unc[0].length);
    } else {
      const drive = /^([A-Za-z]:)?([\\/])?/.exec(joined)!;
      prefix = `${drive[1] ?? ""}${drive[2] ? "\\" : ""}`;
      body = joined.slice(drive[0].length);
    }
  } else if (joined.startsWith("/")) {
    prefix = "/";
  }
  const rooted = prefix.endsWith(sep);
  const trailing = joined.endsWith("/") || (win && joined.endsWith("\\"));
  const segments: string[] = [];
  for (const part of body.split(win ? /[\\/]+/ : /\/+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!rooted) segments.push("..");
    } else {
      segments.push(part);
    }
  }
  const tail = segments.join(sep);
  if (tail === "") return prefix !== "" ? prefix : trailing ? `.${sep}` : ".";
  return `${prefix}${tail}${trailing ? sep : ""}`;
}

/**
 * Expands a leading `~` with the host's home folder. Anything else is returned unchanged. A `~` path without a home folder is
 * refused with a `HostCapabilityError` (never expanded to the home of the process). `~\` is read as the home folder only when the
 * home folder is a Windows folder.
 */
export function expandHomeFor(host: RuntimeHost | undefined | null, p: string): string {
  const slash = p === "~" || p.startsWith("~/");
  const backslash = p.startsWith("~\\");
  if (!slash && !backslash) return p;
  const home = hostHome(host);
  if (!home) {
    if (backslash) return p; // only a Windows host knows `~\`; without a home folder it is just a name
    throw new HostCapabilityError("homeDir", "Der Pfad beginnt mit ~, aber diese Umgebung stellt keinen Home-Ordner bereit. Einen absoluten Pfad angeben.");
  }
  if (backslash && !WINDOWS_HOME.test(home)) return p;
  return p === "~" ? home : joinBelow(home, p.slice(2));
}
