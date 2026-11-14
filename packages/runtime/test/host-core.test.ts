import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { HostCapabilityError, expandHomeFor, hostHome, readHostEnv } from "../src/host-core.js";
import * as hostModule from "../src/host.js";
import * as hostCore from "../src/host-core.js";

// `host-core.ts` has no Node API, so it joins the home folder with a path by itself. These tests compare that join with the path module
// of Node (`posix.join`, `win32.join`) over many inputs: this is the behaviour the local edition had before the split.
const at = (home: string) => ({ label: "t", homeDir: () => home });

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

describe("expandHomeFor", () => {
  const POSIX_HOMES = ["/home/made-up", "/home/made-up/", "/", "/a/b", "/home//made-up", "/h/./x/..", "relative/home", "x"];
  const POSIX_RESTS = ["", "x", "x/y", "x/", "../x", "x/../..", "./x", "x//y", "..", "../../..", "x/./y/", ".", "a/b/c/../../d", "..hidden", "x/..y"];

  it("joins a POSIX home folder like posix.join", () => {
    for (const home of POSIX_HOMES) {
      for (const rest of POSIX_RESTS) expect(expandHomeFor(at(home), `~/${rest}`), `${home} + ${rest}`).toBe(posix.join(home, rest));
    }
  });

  const WINDOWS_HOMES = ["C:\\Users\\made-up", "C:\\Users\\made-up\\", "C:/Users/made-up", "c:\\", "C:\\a\\b", "\\\\srv\\share\\u", "\\\\srv\\share", "\\\\srv\\share\\", "\\\\srv"];
  const WINDOWS_RESTS = ["", "x", "x\\y", "x/y", "..\\x", "..\\..\\..", ".\\x", "x\\", "x\\..\\y", "x/", "..", "a\\b\\..\\..\\..\\c"];

  it("joins a Windows home folder like win32.join, for both `~/` and `~\\`", () => {
    for (const home of WINDOWS_HOMES) {
      for (const rest of WINDOWS_RESTS) {
        expect(expandHomeFor(at(home), `~/${rest}`), `${home} + ~/${rest}`).toBe(win32.join(home, rest));
        expect(expandHomeFor(at(home), `~\\${rest}`), `${home} + ~\\${rest}`).toBe(win32.join(home, rest));
      }
    }
  });

  it("`~` alone is the home folder as the host reports it", () => {
    expect(expandHomeFor(at("/home/made-up/"), "~")).toBe("/home/made-up/");
    expect(expandHomeFor(at("C:\\Users\\made-up"), "~")).toBe("C:\\Users\\made-up");
  });

  it("anything that does not begin with `~/` or `~` alone is returned as it is, without asking the host", () => {
    const asked: string[] = [];
    const host = { label: "t", homeDir: () => (asked.push("asked"), "/home/made-up") };
    for (const p of ["/abs/x", "rel/x", "~other/x", "~x", "", "a~/b", "~~/x"]) expect(expandHomeFor(host, p)).toBe(p);
    expect(asked).toEqual([]);
  });

  it("a `~` path without a home folder is refused, and is never expanded to the home of the process", () => {
    for (const host of [undefined, null, { label: "t" }, { label: "t", homeDir: () => "" }, { label: "t", homeDir: () => 7 as never }, { label: "t", homeDir: () => { throw new Error("no home"); } }]) {
      expect(() => expandHomeFor(host, "~/x")).toThrow(HostCapabilityError);
      expect(() => expandHomeFor(host, "~")).toThrow("Home-Ordner");
    }
  });

  it("`~\\` is a name, not the home folder, unless the home folder is a Windows folder", () => {
    expect(expandHomeFor(at("/home/made-up"), "~\\x")).toBe("~\\x");
    expect(expandHomeFor(undefined, "~\\x")).toBe("~\\x");
    expect(expandHomeFor({ label: "t" }, "~\\x")).toBe("~\\x");
    expect(expandHomeFor(at("C:\\Users\\made-up"), "~\\x")).toBe("C:\\Users\\made-up\\x");
  });

  it("a trailing separator is kept and a result that has nothing left is `.` or the root", () => {
    expect(expandHomeFor(at("home"), "~/..")).toBe(".");
    expect(expandHomeFor(at("home"), "~/../")).toBe("./");
    expect(expandHomeFor(at("/"), "~/..")).toBe("/");
    expect(expandHomeFor(at("C:\\"), "~\\..")).toBe("C:\\");
    expect(expandHomeFor(at("C:\\Users\\u"), "~\\x\\")).toBe("C:\\Users\\u\\x\\");
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
