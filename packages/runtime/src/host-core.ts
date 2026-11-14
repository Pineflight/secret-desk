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
  /**
   * How `~` paths work on the machine the host runs on (see `HostPaths`). Absent: POSIX, the portable default. The Node host fills
   * it from the platform of the process. It is keyed by a symbol, so it is not one of the named capabilities above and a copy of the
   * host made with `{ ...host }` keeps it.
   */
  readonly [HOME_PATHS]?: HostPaths;
}

/**
 * The key of the path rules of a host (`RuntimeHost[HOME_PATHS]`). It is a registry symbol (`Symbol.for`) on purpose: two loaded
 * copies of this package (a bundle that contains it twice, a host built by one copy and used by another) still find each other's
 * member, which a plain `Symbol()` would not. The host is trusted by definition: it is code handed in by the embedder, so what its
 * path rules return is taken as the answer of the machine (the result of `join` is checked to be text, nothing more).
 */
export const HOME_PATHS: unique symbol = Symbol.for("secret-desk.runtime.homePaths");

/** The path rules a host brings for `~` paths: the style of its platform and the join of its path module. */
export interface HostPaths {
  /** `"win32"`: `~\` is a home path as well. Anything else: only `~` and `~/`. */
  style: "posix" | "win32";
  /** Joins the home folder and the rest of a `~` path the way the path module of the host's platform does (`path.join`). */
  join(base: string, rest: string): string;
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

/**
 * `path.posix.join(base, rest)` without the path module: the default of a host that brings no `joinPath`. Empty parts are skipped,
 * separators collapse, `.` and `..` resolve (a `..` above the root of an absolute path is dropped, above a relative one it is kept)
 * and a trailing separator stays.
 */
function posixJoin(base: string, rest: string): string {
  const joined = rest === "" ? base : `${base}/${rest}`;
  const absolute = joined.startsWith("/");
  const segments: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
    } else {
      segments.push(part);
    }
  }
  const tail = segments.join("/");
  if (tail === "") return absolute ? "/" : joined.endsWith("/") ? "./" : ".";
  return `${absolute ? "/" : ""}${tail}${joined.endsWith("/") ? "/" : ""}`;
}

const JOIN_REFUSAL = "Der Pfad beginnt mit ~, aber der Host konnte ihn nicht mit dem Home-Ordner verbinden.";

/**
 * Expands a leading `~` with the host's home folder. Anything else is returned unchanged. A `~` path without a home folder is
 * refused with a `HostCapabilityError` (never expanded to the home of the process). `~` and `~/x` are home paths on every host.
 * `~\x` depends on the path style of the host (`HOME_PATHS`): `"win32"` expands it, `"posix"` leaves it alone (it is a file name
 * there), and a host that does not say (no path rules, or a style that is neither) is refused with a `HostCapabilityError`
 * (fail closed: the function does not guess which way the path is meant). The path is joined by the host's `join` (by default
 * with POSIX rules); a `join` that throws or does not return text is refused the same way.
 */
export function expandHomeFor(host: RuntimeHost | undefined | null, p: string): string {
  const slash = p === "~" || p.startsWith("~/");
  const backslash = p.startsWith("~\\");
  if (!slash && !backslash) return p;
  const paths = host?.[HOME_PATHS];
  if (backslash) {
    if (paths?.style !== "win32" && paths?.style !== "posix") throw new HostCapabilityError("pathStyle", "Der Pfad beginnt mit ~\\, aber dieser Host sagt nicht, ob er Windows- oder POSIX-Pfade nutzt. Einen absoluten Pfad angeben.");
    if (paths.style === "posix") return p;
  }
  const home = hostHome(host);
  if (!home) throw new HostCapabilityError("homeDir", "Der Pfad beginnt mit ~, aber diese Umgebung stellt keinen Home-Ordner bereit. Einen absoluten Pfad angeben.");
  if (p === "~") return home;
  let joined: unknown;
  try {
    joined = typeof paths?.join === "function" ? paths.join(home, p.slice(2)) : posixJoin(home, p.slice(2));
  } catch {
    throw new HostCapabilityError("homeDir", JOIN_REFUSAL);
  }
  if (typeof joined !== "string") throw new HostCapabilityError("homeDir", JOIN_REFUSAL);
  return joined;
}
