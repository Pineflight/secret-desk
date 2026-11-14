import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire for the rule behind `Runtime.instance`: nothing a runtime holds while it works may live in module scope, because two
// runtimes in one process (several tenants, or a runtime that is evicted and rebuilt) would share it. A waiter map, a cache or a
// flag at module level is exactly how a code typed for one runtime ends up consumed by another. State belongs in the runtime
// instance or in an object it owns. Frozen constants are fine: a lookup table that is built once and only read.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function sourceFiles(dir = SRC): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Declarations at the top level of a module (column 0) that can change after import. One finding per declaration. */
export function stateFindings(source: string): string[] {
  const found: string[] = [];
  for (const line of stripComments(source).split("\n")) {
    // Only declarations that start in column 0 are module scope; everything indented is inside a function, class or block.
    const decl = /^(?:export\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(:[^=]*)?=?\s*(.*)$/.exec(line);
    if (decl) {
      const [, kind, name, annotation = "", rest = ""] = decl as unknown as [string, string, string, string?, string?];
      const readonlyType = /\bReadonly(Map|Set|Array)\b|\breadonly\b/.test(annotation);
      if (kind !== "const") found.push(`${name}: ${kind} at module level`);
      else if (/^new\s+(Map|Set|WeakMap|WeakSet|WeakRef|Array)\b/.test(rest) && !readonlyType) found.push(`${name}: mutable ${/new\s+(\w+)/.exec(rest)![1]} at module level`);
      else if (/^(\[\s*\]|\{\s*\}|Object\.create\()/.test(rest) && !/\bas\s+const\b/.test(rest) && !readonlyType) found.push(`${name}: empty container at module level`);
    }
    // A class field that every instance of the class would share.
    const field = /^\s+static\s+(?!readonly\b|async\b|get\b|set\b)(#?[A-Za-z_$][\w$]*)\s*(?::[^=(]*)?(=|;)/.exec(line);
    if (field) found.push(`${field[1]}: mutable static class field`);
  }
  return found;
}

describe("the runtime holds no mutable state in module scope", () => {
  it("no source file declares module-level let/var, a mutable Map/Set/WeakMap/WeakSet/array/object, or a mutable static field", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) for (const finding of stateFindings(await readFile(file, "utf8"))) offenders.push(`${file.slice(SRC.length)}: ${finding}`);
    expect(offenders).toEqual([]);
  });

  it("the scanner finds the usual shapes and lets frozen constants through", () => {
    expect(stateFindings("let cache = 0;")).toEqual(["cache: let at module level"]);
    expect(stateFindings("export var seen;")).toEqual(["seen: var at module level"]);
    expect(stateFindings("const waiters = new Map<string, number>();")).toEqual(["waiters: mutable Map at module level"]);
    expect(stateFindings("const flags = new WeakSet<object>();")).toEqual(["flags: mutable WeakSet at module level"]);
    expect(stateFindings("export const seen = new Set();")).toEqual(["seen: mutable Set at module level"]);
    expect(stateFindings("const rows = [];")).toEqual(["rows: empty container at module level"]);
    expect(stateFindings("const slots: { a?: number } = {};")).toEqual(["slots: empty container at module level"]);
    expect(stateFindings("class A {\n  static count = 0;\n}")).toEqual(["count: mutable static class field"]);
    expect(stateFindings("class A {\n  static #cache: Map<string, string>;\n}")).toEqual(["#cache: mutable static class field"]);
    // Allowed: constants that are built once and only read, and everything that is not module scope.
    expect(stateFindings("const NAMES: ReadonlySet<string> = new Set([\"a\"]);")).toEqual([]);
    expect(stateFindings("const TABLE: ReadonlyMap<string, string> = new Map([[\"a\", \"b\"]]);")).toEqual([]);
    expect(stateFindings("const LIST = [\"a\", \"b\"];")).toEqual([]);
    expect(stateFindings("export const DEFAULTS = { a: 1 };")).toEqual([]);
    expect(stateFindings("const NONE = [] as const;")).toEqual([]);
    expect(stateFindings("const EMPTY: readonly string[] = [];")).toEqual([]);
    expect(stateFindings("const rx = /a/;\nconst n = 5;\nconst f = () => new Map();")).toEqual([]);
    expect(stateFindings("function f() {\n  let x = 0;\n  const m = new Map();\n  return [x, m];\n}")).toEqual([]);
    expect(stateFindings("class A {\n  static readonly NAME = \"a\";\n  static create(): A { return new A(); }\n}")).toEqual([]);
    expect(stateFindings("// let hidden = 1;\n/* const m = new Map(); */")).toEqual([]);
  });

  it("the state the facade and the team token flow used to keep at module level is in the runtime instance now", async () => {
    for (const name of ["facade.ts", "team-token.ts", "live-check.ts"]) {
      const code = stripComments(await readFile(join(SRC, name), "utf8"));
      // Only as a member of the instance (`rt.instance.codeWaiters`), never as a bare module-level name.
      expect(code, name).not.toMatch(/(?<![.\w])(codeWaiters|confirmWaiters|accessWaiters)\b/);
      expect(code, name).not.toMatch(/^const (waiting|running)\b/m);
    }
    expect(stripComments(await readFile(join(SRC, "runtime.ts"), "utf8"))).toMatch(/new InstanceState\(\)/);
  });
});
