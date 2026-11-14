import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire for the rule behind `Runtime.instance`: nothing a runtime holds while it works may live in module scope, because two
// runtimes in one process (several tenants, or a runtime that is evicted and rebuilt) would share it. A waiter map, a cache or a
// flag at module level is exactly how a code typed for one runtime ends up consumed by another. State belongs in the runtime
// instance or in an object it owns. Constants that are built once and only read are fine, if they say so: a type that is
// `readonly`/`Readonly*`, `as const`, or `Object.freeze(...)`.
//
// The scan covers `packages/runtime/src` and `packages/core/src`. It reads each top-level declaration as a whole (an initialiser
// may span lines and an annotation may contain an arrow type). It cannot see what a called function returns, so
// `const x = makeMap()` is out of its reach; the instance tests are the proof, this is the tripwire.
const RUNTIME_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE_SRC = fileURLToPath(new URL("../../core/src/", import.meta.url));

/** Constructors whose instances are immutable for our purposes; every other `new X(...)` at module level is flagged. */
const IMMUTABLE_CONSTRUCTORS: ReadonlySet<string> = new Set(["RegExp", "TextEncoder", "TextDecoder"]);

/**
 * Module-level state that is allowed on purpose, by file and name, with the reason. Everything else must be frozen or move into
 * the runtime instance.
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "issuance.ts:committing": "WeakSet keyed by the pending item itself: it cannot carry anything from one runtime to another (an object belongs to one runtime), and an entry dies with its object.",
  "issuance.ts:committed": "Same as `committing`: object-keyed WeakSet.",
  "issuance.ts:discarded": "Same as `committing`: object-keyed WeakSet.",
  "issuance.ts:partial": "Same as `committing`: object-keyed WeakSet.",
  "evidence-store-contract.ts:PNG": "Test fixture of the importable contract suite (`@secret-desk/core/testing`): three made-up bytes handed to a store under test, read only, never runtime state.",
  "vault-store-contract.ts:FAKE_KEY": "Test fixture of the importable contract suite: a made-up key for the vault under test, read only, never runtime state.",
});

async function sourceFiles(dir: string): Promise<string[]> {
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

/** Top-level statements: a statement starts at a line in column 0 and runs over the lines that follow while they are indented or close a bracket. */
function topLevel(source: string): string[] {
  const out: string[] = [];
  for (const line of stripComments(source).split("\n")) {
    if (line.trim() === "") continue;
    if (/^[^\s})\]]/.test(line) || out.length === 0) out.push(line);
    else out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/** Splits `: Annotation = initialiser` at the first `=` that is not part of `=>` or `==` and not inside brackets. */
function splitDeclaration(rest: string): { annotation: string; init: string } {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "=" && rest[i + 1] === ">") {
      i++;
      continue;
    }
    if ("<([{".includes(c)) depth++;
    else if (">)]}".includes(c)) depth--;
    else if (c === "=" && depth === 0 && rest[i + 1] !== "=") return { annotation: rest.slice(0, i), init: rest.slice(i + 1).trim().replace(/;$/, "").trim() };
  }
  return { annotation: rest, init: "" };
}

/** Declarations at the top level of a module that can change after import, and class fields every instance would share. One finding per declaration. */
export function stateFindings(source: string): { name: string; why: string }[] {
  const found: { name: string; why: string }[] = [];
  for (const statement of topLevel(source)) {
    const decl = /^(?:export\s+)?(?:declare\s+)?(let|var|const)\s+([A-Za-z_$][\w$]*)\s*(.*)$/.exec(statement);
    if (decl) {
      const [, kind, name, rest] = decl as unknown as [string, string, string, string];
      const { annotation, init } = splitDeclaration(rest);
      const frozenType = /\breadonly\b|\bReadonly(Map|Set|Array)?\b/.test(annotation);
      const frozenValue = /^Object\.freeze\(/.test(init) || /\bas\s+const$/.test(init);
      const ctor = /^new\s+([A-Za-z_$][\w$.]*)/.exec(init)?.[1];
      if (kind !== "const") found.push({ name, why: `${kind} at module level` });
      else if (!frozenType && !frozenValue) {
        if (ctor !== undefined && !IMMUTABLE_CONSTRUCTORS.has(ctor)) found.push({ name, why: `mutable ${ctor} at module level` });
        else if (/^[[{]/.test(init)) found.push({ name, why: `${init.startsWith("[") ? "array" : "object"} literal at module level that is not frozen` });
        else if (/^Object\.create\(/.test(init)) found.push({ name, why: "Object.create at module level" });
      }
    }
    // A class field that every instance of the class would share.
    for (const field of statement.matchAll(/\bstatic\s+(?!readonly\b|async\b|get\b|set\b)(#?[A-Za-z_$][\w$]*)\s*(?::[^=(;]*)?(=|;)/g)) found.push({ name: field[1]!, why: "mutable static class field" });
  }
  return found;
}

const findingsOf = async (dir: string): Promise<string[]> => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(dir)) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    for (const f of stateFindings(await readFile(file, "utf8"))) if (!(`${base}:${f.name}` in EXCEPTIONS)) offenders.push(`${file.slice(dir.length)}: ${f.name}: ${f.why}`);
  }
  return offenders;
};

describe("no mutable state in module scope", () => {
  it("packages/runtime/src declares no module-level let/var, mutable collection, unfrozen literal or mutable static field", async () => {
    expect((await sourceFiles(RUNTIME_SRC)).length).toBeGreaterThan(20);
    expect(await findingsOf(RUNTIME_SRC)).toEqual([]);
  });

  it("packages/core/src declares none either, apart from the listed and justified exceptions", async () => {
    expect((await sourceFiles(CORE_SRC)).length).toBeGreaterThan(40);
    expect(await findingsOf(CORE_SRC)).toEqual([]);
  });

  it("every exception is still there (a stale entry hides nothing)", async () => {
    const seen = new Set<string>();
    for (const file of await sourceFiles(CORE_SRC)) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      for (const f of stateFindings(await readFile(file, "utf8"))) seen.add(`${base}:${f.name}`);
    }
    expect([...seen].filter((k) => k in EXCEPTIONS).sort()).toEqual(Object.keys(EXCEPTIONS).sort());
    for (const reason of Object.values(EXCEPTIONS)) expect(reason.length).toBeGreaterThan(20);
  });

  it("the scanner finds the usual shapes and lets frozen constants through", () => {
    const why = (code: string): string[] => stateFindings(code).map((f) => `${f.name}: ${f.why}`);
    expect(why("let cache = 0;")).toEqual(["cache: let at module level"]);
    expect(why("export var seen;")).toEqual(["seen: var at module level"]);
    expect(why("const waiters = new Map<string, number>();")).toEqual(["waiters: mutable Map at module level"]);
    expect(why("const flags = new WeakSet<object>();")).toEqual(["flags: mutable WeakSet at module level"]);
    expect(why("export const bytes = new Uint8Array(16);")).toEqual(["bytes: mutable Uint8Array at module level"]);
    expect(why("const hub = new Foo.Bar();")).toEqual(["hub: mutable Foo.Bar at module level"]);
    expect(why("const rows = [];")).toEqual(["rows: array literal at module level that is not frozen"]);
    expect(why("const names = [\"a\", \"b\"];")).toEqual(["names: array literal at module level that is not frozen"]);
    expect(why("const slots: { a?: number } = {};")).toEqual(["slots: object literal at module level that is not frozen"]);
    expect(why("export const DEFAULTS = { a: 1 };")).toEqual(["DEFAULTS: object literal at module level that is not frozen"]);
    expect(why("const bag = Object.create(null);")).toEqual(["bag: Object.create at module level"]);
    // A multi-line initialiser and an arrow type in the annotation are read as one declaration.
    expect(why("const table: Record<string, number> =\n  {\n    a: 1,\n  };")).toEqual(["table: object literal at module level that is not frozen"]);
    expect(why("const handlers: Record<string, (x: number) => void> = {\n  a: () => undefined,\n};")).toEqual(["handlers: object literal at module level that is not frozen"]);
    expect(why("const shared: Map<string, () => void> =\n  new Map();")).toEqual(["shared: mutable Map at module level"]);
    expect(why("class A {\n  static count = 0;\n}")).toEqual(["count: mutable static class field"]);
    expect(why("class A {\n  static #cache: Map<string, string>;\n}")).toEqual(["#cache: mutable static class field"]);
    // Allowed: constants that say they are only read, and everything that is not module scope.
    expect(why("const NAMES: ReadonlySet<string> = new Set([\"a\"]);")).toEqual([]);
    expect(why("const TABLE: ReadonlyMap<string, string> = new Map([[\"a\", \"b\"]]);")).toEqual([]);
    expect(why("const LIST: readonly string[] = [\"a\", \"b\"];")).toEqual([]);
    expect(why("const CONFIG: Readonly<Record<string, number>> = { a: 1 };")).toEqual([]);
    expect(why("const NONE = [] as const;")).toEqual([]);
    expect(why("const FROZEN = Object.freeze({ a: 1 });")).toEqual([]);
    expect(why("const rx = new RegExp(\"a\");\nconst n = 5;\nconst f = () => new Map();\nconst g = (x: number) => {\n  return [x];\n};")).toEqual([]);
    expect(why("function f() {\n  let x = 0;\n  const m = new Map();\n  return [x, m];\n}")).toEqual([]);
    expect(why("class A {\n  static readonly NAME = \"a\";\n  static create(): A { return new A(); }\n}")).toEqual([]);
    expect(why("// let hidden = 1;\n/* const m = new Map(); */")).toEqual([]);
  });

  it("the state the facade and the team token flow used to keep at module level is in the runtime instance now", async () => {
    for (const name of ["facade.ts", "team-token.ts", "live-check.ts"]) {
      const code = stripComments(await readFile(join(RUNTIME_SRC, name), "utf8"));
      // Only as a member of the instance (`rt.instance.codeWaiters`), never as a bare module-level name.
      expect(code, name).not.toMatch(/(?<![.\w])(codeWaiters|confirmWaiters|accessWaiters)\b/);
      expect(code, name).not.toMatch(/^const (waiting|running)\b/m);
    }
    expect(stripComments(await readFile(join(RUNTIME_SRC, "runtime.ts"), "utf8"))).toMatch(/new InstanceState\(\)/);
  });
});
