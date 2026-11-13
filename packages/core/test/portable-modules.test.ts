import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// These modules run in runtimes without Node built-ins. This test is a tripwire, not a proof: it catches the common
// ways Node APIs sneak in (imports, process, Buffer, require, Node types) but cannot see everything (for example
// indirect access through a variable). Real portability is only proven by running the code in such a runtime.
const ROOTS = ["vault-core.ts", "evidence.ts", "secret.ts", "inventory-backend.ts", "inventory-errors.ts", "connections-core.ts"];
const NODE_BUILTINS = ["assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path", "stream", "tls", "url", "util", "zlib"];

async function sourceOf(name: string): Promise<string> {
  const text = await readFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Relative imports and re-exports of values (type-only ones are erased at build time and exempt). */
function valueImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["'](\.[^"']*)["']/gm)) {
    if (!m[2]) found.push(m[4]!.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
  }
  return found;
}

async function closureOf(roots: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop()!;
    if (files.has(name)) continue;
    const source = await sourceOf(name);
    files.set(name, source);
    queue.push(...valueImports(source));
  }
  return files;
}

describe("portable modules stay free of Node APIs", () => {
  it("follows relative value imports and checks every file it reaches", async () => {
    const files = await closureOf(ROOTS);
    expect([...files.keys()].sort()).toEqual(["connections-core.ts", "evidence.ts", "inventory-backend.ts", "inventory-errors.ts", "reserved-names.ts", "secret.ts", "vault-core.ts"]);
    for (const [name, source] of files) {
      const where = `in ${name}`;
      expect(source, where).not.toMatch(/from\s+["']node:/);
      expect(source, where).not.toMatch(/import\s*\(\s*["']node:/);
      for (const mod of NODE_BUILTINS) expect(source, `${where}: ${mod}`).not.toMatch(new RegExp(`from\\s+["']${mod}(/[^"']*)?["']`));
      expect(source, where).not.toMatch(/\bprocess\./);
      expect(source, where).not.toMatch(/\bglobalThis\.process\b/);
      expect(source, where).not.toMatch(/\bBuffer\b/);
      expect(source, where).not.toMatch(/\brequire\(/);
      expect(source, where).not.toMatch(/\bNodeJS\./);
      expect(source, where).not.toMatch(/\bErrnoException\b/);
    }
  });

  it("evidence.ts imports the verification types with import type only", async () => {
    const source = await sourceOf("evidence.ts");
    expect(source).toMatch(/^import type \{[^}]*\} from "\.\/verification\.js";/m);
    expect(source.match(/from\s+["']\.\/verification(\.js)?["']/g)).toHaveLength(1);
    expect(valueImports(source)).toEqual(["reserved-names.ts"]);
  });

  it("the import scanner tells value imports from type imports", () => {
    expect(valueImports(`import { a } from "./a.js";\nimport type { B } from "./b.js";\nexport * from "./c.js";\nexport type { D } from "./d.js";\nimport x from "node:fs";`)).toEqual(["a.ts", "c.ts"]);
  });
});
