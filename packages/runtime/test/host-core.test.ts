import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_PATHS, HostCapabilityError, expandHomeFor, hostHome, readHostEnv, type RuntimeHost } from "../src/host-core.js";
import * as hostModule from "../src/host.js";
import * as hostCore from "../src/host-core.js";
import { nodeHomePaths, nodeRuntimeHost } from "../src/host.js";

type Style = "posix" | "win32";

// The reference: `expandHomeFor` and `expandHome` as they were on the main branch before the split, with the platform as a parameter
// (the old code took `process.platform`; its path module was `path.posix` or `path.win32` by that platform).
function oldExpandHome(p: string, home: string, platform: Style): string {
  const api = platform === "win32" ? win32 : posix;
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return api.join(home, p.slice(2));
  return p;
}
const HOME_MARK = "\u0000home";
function oldExpandHomeFor(host: RuntimeHost | undefined | null, p: string, platform: Style): string {
  if (oldExpandHome(p, HOME_MARK, platform) === p) return p;
  const home = hostHome(host);
  if (!home) throw new HostCapabilityError("homeDir", "Der Pfad beginnt mit ~, aber diese Umgebung stellt keinen Home-Ordner bereit. Einen absoluten Pfad angeben.");
  return oldExpandHome(p, home, platform);
}

/** What a call returned or threw, in a form that can be compared: the class, the capability and the message of an error. */
function outcome(fn: () => string): { value: string } | { error: string; capability: unknown; message: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: (e as Error).constructor.name, capability: (e as HostCapabilityError).capability, message: (e as Error).message };
  }
}

const HOMES: (string | undefined)[] = [undefined, "", "/home/made-up", "/home/made-up/", "/", "/a/b", "/home//made-up", "/h/./x/..", "relative/home", "x", "C:\\Users\\made-up", "C:\\Users\\made-up\\", "C:/Users/made-up", "c:\\", "C:", "\\\\srv\\share\\u", "\\\\srv\\share", "\\\\srv", "\\", ".", ".."];
const TABLE = [
  "", "~", "~/", "~\\", "~/x", "~\\x", "~/x/", "~\\x\\", "~/x\\y", "~\\x/y", "~user", "~user/x", "~~", "~~/x", "a~/b", "/abs/x", "C:\\abs\\x", "rel/x", "rel\\x", "./x", "../x", "~/..", "~\\..", "~/../..", "~/./x", "~//x", "~\\\\x", "~/x/../y", "~\\x\\..\\y", " ~/x", "~ /x", "~/ ", "~\\ ", "/", "\\", "~/.", "~\\.", "~/..x", "~/x//", "~\\x\\\\",
];

/** A small deterministic generator: the same inputs on every run. */
function generated(count: number): string[] {
  let seed = 20261114;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const tokens = ["~", "/", "\\", "x", "y", ".", "..", "u", "", " ", "~u", "a b", "C:", "//", "\\\\"];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = next(3) === 0 ? [] : [["~", "~/", "~\\"][next(3)]!];
    for (let k = next(7); k > 0; k--) parts.push(tokens[next(tokens.length)]!);
    out.push(parts.join(""));
  }
  return out;
}

const hostFor = (home: string | undefined, style: Style | "none"): RuntimeHost | undefined | null =>
  home === undefined ? (style === "none" ? undefined : { label: "t", ...(style === "win32" || style === "posix" ? nodeHomePaths(style) : {}) }) : { label: "t", homeDir: () => home, ...(style === "none" ? {} : nodeHomePaths(style)) };

describe("host-core is what host.ts re-exports", () => {
  it("the same class and the same functions, not copies", () => {
    expect(hostModule.HostCapabilityError).toBe(hostCore.HostCapabilityError);
    expect(hostModule.expandHomeFor).toBe(hostCore.expandHomeFor);
    expect(hostModule.hostHome).toBe(hostCore.hostHome);
    expect(hostModule.readHostEnv).toBe(hostCore.readHostEnv);
  });

  it("the error carries its capability", () => {
    const err = new HostCapabilityError("homeDir", "no home");
    expect(err).toMatchObject({ name: "HostCapabilityError", capability: "homeDir", message: "no home" });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("expandHomeFor under the Node host returns or throws exactly what the implementation on main did", () => {
  const inputs = [...TABLE, ...generated(3000)];

  it.each(["posix", "win32"] as const)("%s flavour: every table and generated input, with and without a home folder", (style) => {
    let compared = 0;
    for (const home of HOMES) {
      const host = hostFor(home, style);
      for (const p of inputs) {
        expect(outcome(() => expandHomeFor(host, p)), `${style} home=${JSON.stringify(home)} p=${JSON.stringify(p)}`).toEqual(outcome(() => oldExpandHomeFor(host, p, style)));
        compared++;
      }
    }
    expect(compared).toBe(HOMES.length * inputs.length);
  });

  it("no host at all, a host without a home folder, a home folder that is no text and one that throws: the same refusal as before", () => {
    const hosts: (RuntimeHost | undefined | null)[] = [undefined, null, { label: "t" }, { label: "t", ...nodeHomePaths("posix") }, { label: "t", ...nodeHomePaths("win32") }, { label: "t", homeDir: () => 7 as never }, { label: "t", homeDir: () => { throw new Error("no home"); } }];
    for (const host of hosts) {
      const style: Style = host?.[HOME_PATHS]?.style === "win32" ? "win32" : "posix";
      for (const p of TABLE) expect(outcome(() => expandHomeFor(host, p)), `${String(host && Object.keys(host))} ${p}`).toEqual(outcome(() => oldExpandHomeFor(host, p, style)));
    }
  });

  it("a host that brings neither `pathStyle` nor `joinPath` behaves like the POSIX flavour of main", () => {
    for (const home of HOMES) {
      const host = hostFor(home, "none");
      for (const p of inputs.slice(0, 1500)) expect(outcome(() => expandHomeFor(host, p)), `home=${JSON.stringify(home)} p=${JSON.stringify(p)}`).toEqual(outcome(() => oldExpandHomeFor(host, p, "posix")));
    }
  });

  it("the real Node host of this machine agrees with the flavour of this machine", () => {
    const style: Style = process.platform === "win32" ? "win32" : "posix";
    const real = nodeRuntimeHost({ env: {} });
    for (const home of ["/home/made-up", "C:\\Users\\made-up"]) {
      const host = { ...real, homeDir: () => home };
      for (const p of inputs.slice(0, 500)) expect(outcome(() => expandHomeFor(host, p)), `${home} ${p}`).toEqual(outcome(() => oldExpandHomeFor(host, p, style)));
    }
  });

  it("`~\\` is a plain name unless the host says its path style is win32, and a win32 host without a home folder refuses it", () => {
    expect(expandHomeFor({ label: "t", homeDir: () => "/home/made-up" }, "~\\x")).toBe("~\\x");
    expect(expandHomeFor({ label: "t", homeDir: () => "/home/made-up", ...nodeHomePaths("linux") }, "~\\x")).toBe("~\\x");
    expect(expandHomeFor({ label: "t", homeDir: () => "C:\\Users\\u", ...nodeHomePaths("win32") }, "~\\x")).toBe("C:\\Users\\u\\x");
    expect(() => expandHomeFor({ label: "t", ...nodeHomePaths("win32") }, "~\\x")).toThrow(HostCapabilityError);
    expect(hostModule.HOME_PATHS).toBe(HOME_PATHS);
  });
});

describe("the POSIX default join", () => {
  it("is path.posix.join for a home folder and a rest", () => {
    const homes = ["/home/made-up", "/home/made-up/", "/", "/a/b", "/home//made-up", "/h/./x/..", "relative/home", "x", "a/..", "/a/.."];
    const rests = ["", "x", "x/y", "x/", "../x", "x/../..", "./x", "x//y", "..", "../../..", "x/./y/", ".", "a/b/c/../../d", "..hidden", "x/..y", "../", "./"];
    for (const home of homes) for (const rest of rests) expect(expandHomeFor({ label: "t", homeDir: () => home }, `~/${rest}`), `${home} + ${rest}`).toBe(posix.join(home, rest));
  });
});

describe("nodeHomePaths", () => {
  it("fills the path style and the join of the platform it is given, and of the process by default", () => {
    expect(nodeHomePaths("win32")[HOME_PATHS].style).toBe("win32");
    expect(nodeHomePaths("linux")[HOME_PATHS].style).toBe("posix");
    expect(nodeHomePaths("darwin")[HOME_PATHS].style).toBe("posix");
    expect(nodeHomePaths("win32")[HOME_PATHS].join("C:\\a", "b/c")).toBe(win32.join("C:\\a", "b/c"));
    expect(nodeHomePaths("linux")[HOME_PATHS].join("/a", "b/../c")).toBe(posix.join("/a", "b/../c"));
    expect(nodeHomePaths()[HOME_PATHS].style).toBe(process.platform === "win32" ? "win32" : "posix");
    const host = nodeRuntimeHost({ env: {} });
    expect(host[HOME_PATHS]?.style).toBe(nodeHomePaths()[HOME_PATHS].style);
    expect(host[HOME_PATHS]?.join("/a", "b")).toBe(nodeHomePaths()[HOME_PATHS].join("/a", "b"));
    // The symbol key keeps the named members of the Node host as they were, and survives a copy of the host.
    expect(Object.keys(host)).not.toContain("pathStyle");
    expect({ ...host }[HOME_PATHS]).toBe(host[HOME_PATHS]);
    expect(HOME_PATHS).toBe(Symbol.for("secret-desk.runtime.homePaths"));
  });
});

describe("hostHome and readHostEnv", () => {
  it("hostHome answers only a non-empty text", () => {
    expect(hostHome(undefined)).toBeUndefined();
    expect(hostHome(null)).toBeUndefined();
    expect(hostHome({ label: "t" })).toBeUndefined();
    expect(hostHome({ label: "t", homeDir: () => "" })).toBeUndefined();
    expect(hostHome({ label: "t", homeDir: () => 7 as never })).toBeUndefined();
    expect(hostHome({ label: "t", homeDir: () => { throw new Error("no home"); } })).toBeUndefined();
    expect(hostHome({ label: "t", homeDir: () => "/home/made-up" })).toBe("/home/made-up");
  });

  it("readHostEnv asks the host by name and never the process", () => {
    expect(readHostEnv(undefined, "X")).toBeUndefined();
    expect(readHostEnv(null, "X")).toBeUndefined();
    expect(readHostEnv({ label: "t" }, "X")).toBeUndefined();
    expect(readHostEnv({ label: "t", env: () => 5 as never }, "X")).toBeUndefined();
    expect(readHostEnv({ label: "t", env: (name) => `value-of-${name}` }, "X")).toBe("value-of-X");
  });
});
