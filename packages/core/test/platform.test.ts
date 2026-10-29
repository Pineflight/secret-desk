import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnvFile } from "../src/env-export.js";
import { EvidenceError, EvidenceStore } from "../src/evidence.js";
import {
  ensurePrivateDir,
  expandHome,
  isPathInside,
  isPathInsideOrSame,
  isReservedWindowsName,
  isUncPath,
  localPathProblem,
  realpathLoose,
  sanitizeFileName,
  securePrivateFile,
  writePrivateFile,
} from "../src/platform.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "sd-plat-")));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("file permissions", () => {
  it.skipIf(process.platform === "win32")("POSIX: Datei 600, Ordner 700", async () => {
    const dir = await tmp();
    await ensurePrivateDir(join(dir, "a", "b"));
    await writePrivateFile(join(dir, "a", "b", "f"), "x");
    expect((await stat(join(dir, "a", "b"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "a", "b", "f"))).mode & 0o777).toBe(0o600);
  });
  it("Windows (simulated): no chmod, nothing is promised, file is written anyway", async () => {
    const dir = await tmp();
    const f = join(dir, "w");
    await writeFile(f, "x", { mode: 0o644 });
    await securePrivateFile(f, "win32");
    if (process.platform !== "win32") expect((await stat(f)).mode & 0o777).toBe(0o644);
    await ensurePrivateDir(join(dir, "wd"), "win32");
    await writePrivateFile(join(dir, "wd", "g"), "y", "win32");
    expect((await stat(join(dir, "wd", "g"))).isFile()).toBe(true);
  });
});

describe("paths with path.win32 / path.posix", () => {
  it("isPathInside: Windows case-insensitive, drives separate", () => {
    expect(isPathInside("C:\\Users\\Ann", "c:\\users\\ann\\projekte\\x", "win32")).toBe(true);
    expect(isPathInside("C:\\Users\\Ann", "C:\\Users\\Ann", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Ann", "C:\\Users\\Anna\\x", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Ann", "D:\\Users\\Ann\\x", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Ann", "C:\\Users\\Ann\\..\\Bob", "win32")).toBe(false);
    expect(isPathInside("C:\\Users\\Ann", "C:\\Users\\Ann\\..foo", "win32")).toBe(true);
    expect(isPathInsideOrSame("C:\\Users\\Ann", "c:\\USERS\\ann", "win32")).toBe(true);
  });
  it("isPathInside: POSIX is case-sensitive and distinguishes prefixes", () => {
    expect(isPathInside("/home/ann", "/home/ann/x", "linux")).toBe(true);
    expect(isPathInside("/home/ann", "/home/anna/x", "linux")).toBe(false);
    expect(isPathInside("/home/ann", "/home/Ann/x", "linux")).toBe(false);
    expect(isPathInside("/home/ann", "/home/ann/../bob", "linux")).toBe(false);
    expect(isPathInsideOrSame("/home/ann", "/home/ann", "linux")).toBe(true);
  });
  it("expandHome knows ~ and on Windows ~\\", () => {
    expect(expandHome("~", "C:\\Users\\Ann", "win32")).toBe("C:\\Users\\Ann");
    expect(expandHome("~/p", "C:\\Users\\Ann", "win32")).toBe("C:\\Users\\Ann\\p");
    expect(expandHome("~\\p\\q", "C:\\Users\\Ann", "win32")).toBe("C:\\Users\\Ann\\p\\q");
    expect(expandHome("~/p", "/home/ann", "linux")).toBe("/home/ann/p");
    expect(expandHome("~\\p", "/home/ann", "linux")).toBe("~\\p");
    expect(expandHome("~ann/p", "/home/ann", "linux")).toBe("~ann/p");
  });
  it("UNC and device paths are rejected on Windows, not on POSIX", () => {
    for (const p of ["\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x"]) {
      expect(isUncPath(p, "win32")).toBe(true);
      expect(localPathProblem(p, "win32")).toMatch(/UNC/);
    }
    expect(isUncPath("C:\\x", "win32")).toBe(false);
    expect(localPathProblem("//a/b", "linux")).toBeNull();
    expect(localPathProblem("C:\\Users\\Ann\\proj", "win32")).toBeNull();
  });
  it("reserved names and forbidden characters", () => {
    for (const n of ["CON", "nul", "Aux.txt", "COM1", "lpt9.log", "con.", "prn "]) expect(isReservedWindowsName(n)).toBe(true);
    for (const n of ["console", "com10", "nulls", "auxiliary.txt", "x.con"]) expect(isReservedWindowsName(n)).toBe(false);
    expect(localPathProblem("C:\\proj\\NUL\\x", "win32")).toMatch(/reservierten/);
    expect(localPathProblem("C:\\proj\\a?b", "win32")).toMatch(/Zeichen/);
    expect(localPathProblem("C:\\proj\\a:b", "win32")).toMatch(/Zeichen/);
  });
  it("sanitizeFileName makes names valid on all systems", () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFileName("bericht. ")).toBe("bericht");
    expect(sanitizeFileName("NUL")).toBe("_NUL");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("")).toBe("file");
  });
});

describe("realpathLoose and writeEnvFile", () => {
  it("resolves the existing beginning and appends the rest", async () => {
    const dir = await tmp();
    expect(await realpathLoose(join(dir, "neu", "x.env"))).toBe(join(dir, "neu", "x.env"));
  });
  it.skipIf(process.platform === "win32")("ein Symlink aus dem erlaubten Ordner heraus wird nicht als innerhalb gewertet", async () => {
    const dir = await tmp();
    const outside = await tmp();
    await mkdir(join(dir, "root"));
    await symlink(outside, join(dir, "root", "link"));
    await expect(writeEnvFile(join(dir, "root", "link", ".env"), "A=1\n", { allowedRoots: [join(dir, "root")] })).rejects.toThrow(/ausserhalb/);
    await writeEnvFile(join(dir, "root", "ok", ".env"), "A=1\n", { allowedRoots: [join(dir, "root")] });
  });
  it("sibling folder with the same prefix is not inside", async () => {
    const dir = await tmp();
    await expect(writeEnvFile(join(`${dir}-evil`, ".env"), "A=1\n", { allowedRoots: [dir] })).rejects.toThrow(/ausserhalb/);
  });
});

describe("Evidence: Windows-safe names", () => {
  it("rejects reserved names and trailing dot", async () => {
    const store = new EvidenceStore(await tmp());
    for (const id of ["nul", "CON", "aux.txt", "report."]) await expect(store.get(id, "r1")).rejects.toBeInstanceOf(EvidenceError);
    await expect(store.get("ok-id", "r1")).resolves.toBeNull();
  });
});
