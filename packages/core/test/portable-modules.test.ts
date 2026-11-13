import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portableEntry from "../src/portable.js";
import * as secret from "../src/secret.js";
import * as stages from "../src/stages.js";
import * as types from "../src/types.js";
import * as inventoryStore from "../src/inventory-store.js";
import * as inventoryErrors from "../src/inventory-errors.js";
import * as inventoryBackend from "../src/inventory-backend.js";
import * as evidence from "../src/evidence.js";
import * as vaultCore from "../src/vault-core.js";
import * as connectionsCore from "../src/connections-core.js";
import * as variableSources from "../src/variable-sources.js";
import * as githubCore from "../src/github-core.js";

// These modules run in runtimes without Node built-ins. This test is a tripwire, not a proof: it catches the common
// ways Node APIs sneak in (imports, process, Buffer, require, Node types) but cannot see everything (for example
// indirect access through a variable). Real portability is only proven by running the code in such a runtime.
const MODULE_ROOTS = ["vault-core.ts", "evidence.ts", "secret.ts", "inventory-backend.ts", "inventory-errors.ts", "inventory-store.ts", "connections-core.ts", "github-core.ts"];
// The portable entry point is a root too: it may not reach anything the modules above do not already reach.
const ROOTS = [...MODULE_ROOTS, "portable.ts"];
const EXPECTED_CLOSURE = ["base64.ts", "connections-core.ts", "evidence.ts", "git-names.ts", "github-core.ts", "inventory-backend.ts", "inventory-errors.ts", "inventory-store.ts", "place-key.ts", "reserved-names.ts", "secret.ts", "stages.ts", "types.ts", "variable-sources.ts", "vault-core.ts"];
// npm packages that are pure JavaScript (no Node built-ins, no native or WASM code). Anything else, notably
// `libsodium-wrappers`, fails the guard.
const PURE_PACKAGES = ["yaml", "zod"];
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

/** Package names of bare (non-relative) value imports and re-exports; `node:` specifiers are reported as they are. */
function bareImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;]*?\s*from\s+)?["']([^."'][^"']*)["']/gm)) {
    if (m[2]) continue;
    const spec = m[3]!;
    found.push(spec.startsWith("node:") ? spec : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
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
    expect([...files.keys()].sort()).toEqual([...EXPECTED_CLOSURE, "portable.ts"].sort());
    for (const [name, source] of files) {
      const where = `in ${name}`;
      for (const pkg of bareImports(source)) expect(PURE_PACKAGES, `${where}: ${pkg}`).toContain(pkg);
      expect(source, where).not.toMatch(/libsodium/);
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

  it("portable.ts reaches exactly the files the portable modules reach", async () => {
    const own = [...(await closureOf(["portable.ts"])).keys()].filter((n) => n !== "portable.ts").sort();
    const union = [...(await closureOf(MODULE_ROOTS)).keys()].sort();
    expect(union).toEqual(EXPECTED_CLOSURE);
    expect(own).toEqual(EXPECTED_CLOSURE);
  });

  it("portable.ts re-exports every runtime name of the portable modules, with the same bindings", async () => {
    const portable: Record<string, unknown> = { ...portableEntry };
    const modules: Record<string, Record<string, unknown>> = {
      secret, stages, types, "inventory-store": inventoryStore, "inventory-errors": inventoryErrors, "inventory-backend": inventoryBackend,
      evidence, "vault-core": vaultCore, "connections-core": connectionsCore, "variable-sources": variableSources, "github-core": githubCore,
    };
    for (const [mod, ns] of Object.entries(modules)) {
      for (const [key, value] of Object.entries(ns)) expect(portable[key], `${mod}.${key}`).toBe(value);
    }
    for (const key of ["SecretValue", "Vault", "MemoryVaultStore", "MemoryEvidenceStore", "InventoryStoreCore", "MemoryInventoryBackend", "ConnectionStoreCore", "InventoryError", "InventorySchema", "DEFAULT_STAGES", "GitHubClient", "githubAppProvider", "GitHubError", "patProvider"]) {
      expect(portable, key).toHaveProperty(key);
    }
    // The portable client is the one from github-core; the Node facade is a subclass that adds the default sealer.
    expect(portable.GitHubClient).toBe(githubCore.GitHubClient);
    expect(portable).not.toHaveProperty("sealForGitHub");
    expect(portable).not.toHaveProperty("SecretVault");
    expect(portable).not.toHaveProperty("InventoryStore");
    expect(portable).not.toHaveProperty("ConnectionStore");
  });

  it("the GitHub client reaches neither the zod schemas nor the status module", async () => {
    const reached = [...(await closureOf(["github-core.ts"])).keys()].sort();
    expect(reached).toEqual(["base64.ts", "git-names.ts", "github-core.ts", "place-key.ts", "secret.ts"]);
    const source = await sourceOf("github-core.ts");
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(valueImports(source)).toEqual(["base64.ts", "git-names.ts", "place-key.ts", "secret.ts"]);
  });

  it("the package declares the portable subpath and the build produces its files", async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.exports["./portable"]).toEqual({ types: "./dist/portable.d.ts", default: "./dist/portable.js" });
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    // tsc maps src/portable.ts to dist/portable.js and dist/portable.d.ts (rootDir src, outDir dist).
    await expect(readFile(fileURLToPath(new URL("../src/portable.ts", import.meta.url)), "utf8")).resolves.toContain("export *");
  });

  it("the import scanners report bare packages, not relative or type-only ones", () => {
    expect(bareImports(`import { a } from "./a.js";\nimport type { T } from "zod";\nimport { z } from "zod";\nimport s from "libsodium-wrappers";\nexport * from "yaml/util";\nimport { x } from "@scope/pkg/sub";\nimport fs from "node:fs";\nimport "side-effect";`)).toEqual(["zod", "libsodium-wrappers", "yaml", "@scope/pkg", "node:fs", "side-effect"]);
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
