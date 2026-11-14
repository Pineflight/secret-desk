import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portableEntry from "../src/portable.js";

// Same mechanism as `packages/core/test/portable-modules.test.ts`: a tripwire, not a proof. It follows every relative value
// import of `src/portable.ts`, resolves `@secret-desk/core/portable` into the core's source and follows it from there, and
// checks each file it reaches. Real portability is only proven by running the code in a runtime without Node built-ins.
const CORE_PORTABLE = "@secret-desk/core/portable";
const EXPECTED_PROVIDER_FILES = [
  "anthropic.ts", "checks.ts", "cloudflare-access.ts", "cloudflare.ts", "discover.ts", "grafana.ts", "http.ts", "manual.ts", "openai.ts", "portable.ts", "resend.ts", "revenuecat.ts", "stripe.ts",
  "variable-sources.ts",
];
const EXPECTED_CORE_FILES = [
  "base64.ts", "config-core.ts", "connections-core.ts", "env-export-errors.ts", "evidence.ts", "git-names.ts", "github-core.ts", "guards.ts", "inventory-backend.ts", "inventory-errors.ts",
  "inventory-store.ts", "issuance.ts", "params.ts", "patch.ts", "place-io.ts", "place-key.ts", "portable.ts", "preflight.ts", "provider.ts", "reserved-names.ts", "rotate.ts", "secret.ts", "sha256.ts",
  "snapshot.ts", "stages.ts", "status.ts", "stripe-accounts.ts", "team.ts", "types.ts", "variable-sources.ts", "variables.ts", "vault-core.ts", "vendors.ts", "verification.ts", "worker-secrets.ts",
];
// Pure JavaScript only (no Node built-ins, no native or WASM code): what the core's portable closure may import.
const PURE_PACKAGES = ["yaml", "zod", "@noble/hashes"];
const NODE_BUILTINS = ["assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path", "stream", "tls", "url", "util", "zlib"];

type Pkg = "providers" | "core";
const DIRS: Record<Pkg, URL> = { providers: new URL("../src/", import.meta.url), core: new URL("../../core/src/", import.meta.url) };

async function sourceOf(pkg: Pkg, name: string): Promise<string> {
  const text = await readFile(fileURLToPath(new URL(name, DIRS[pkg])), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const STATEMENT = /^\s*(import|export)\s+(type\s+)?(?:[^;]*?\s*from\s+)?["']([^"']+)["']/gm;

/** Specifiers of value imports and re-exports (type-only ones are erased at build time and exempt). */
function valueSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(STATEMENT)) if (!m[2]) found.push(m[3]!);
  return found;
}

const packageOf = (spec: string): string => (spec.startsWith("node:") ? spec : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

/** Every file reached from the roots, keyed `<package>:<file>`. Core files are reached only through `@secret-desk/core/portable`. */
async function closureOf(roots: string[]): Promise<Map<string, { pkg: Pkg; name: string; source: string }>> {
  const files = new Map<string, { pkg: Pkg; name: string; source: string }>();
  const queue: { pkg: Pkg; name: string }[] = roots.map((name) => ({ pkg: "providers", name }));
  while (queue.length) {
    const { pkg, name } = queue.pop()!;
    const key = `${pkg}:${name}`;
    if (files.has(key)) continue;
    const source = await sourceOf(pkg, name);
    files.set(key, { pkg, name, source });
    for (const spec of valueSpecifiers(source)) {
      if (spec.startsWith(".")) queue.push({ pkg, name: posix.normalize(posix.join(posix.dirname(name), spec.replace(/\.js$/, ".ts"))) });
      else if (spec === CORE_PORTABLE && pkg === "providers") queue.push({ pkg: "core", name: "portable.ts" });
    }
  }
  return files;
}

function expectPortable(files: Map<string, { pkg: Pkg; name: string; source: string }>): void {
  for (const [key, { pkg, source }] of files) {
    const where = `in ${key}`;
    for (const spec of valueSpecifiers(source)) {
      if (spec.startsWith(".")) continue;
      if (pkg === "providers" && spec === CORE_PORTABLE) continue;
      expect(pkg === "core" ? PURE_PACKAGES : [], `${where}: ${spec}`).toContain(packageOf(spec));
    }
    expect(source, where).not.toMatch(/libsodium/);
    expect(source, where).not.toMatch(/from\s+["']node:/);
    expect(source, where).not.toMatch(/import\s*\(\s*["']node:/);
    for (const mod of NODE_BUILTINS) expect(source, `${where}: ${mod}`).not.toMatch(new RegExp(`from\\s+["']${mod}(/[^"']*)?["']`));
    expect(source, where).not.toMatch(/\bprocess\./);
    expect(source, where).not.toMatch(/\bprocess\s*\[/);
    expect(source, where).not.toMatch(/\bglobalThis\.process\b/);
    expect(source, where).not.toMatch(/\b(globalThis|global)\s*\[\s*["']process["']\s*\]/);
    expect(source, where).not.toMatch(/\bBuffer\b/);
    expect(source, where).not.toMatch(/\brequire\(/);
    expect(source, where).not.toMatch(/\bNodeJS\./);
    expect(source, where).not.toMatch(/\bErrnoException\b/);
  }
}

describe("the providers' portable entry stays free of Node APIs", () => {
  it("follows relative value imports into the providers and the core's portable entry, and checks every file", async () => {
    const files = await closureOf(["portable.ts"]);
    const reached = [...files.values()];
    expect(reached.filter((f) => f.pkg === "providers").map((f) => f.name).sort()).toEqual(EXPECTED_PROVIDER_FILES);
    expect(reached.filter((f) => f.pkg === "core").map((f) => f.name).sort()).toEqual(EXPECTED_CORE_FILES);
    expectPortable(files);
  });

  it("imports the core only through its portable entry", async () => {
    const files = await closureOf(["portable.ts"]);
    for (const [key, { pkg, source }] of files) {
      if (pkg !== "providers") continue;
      for (const spec of valueSpecifiers(source)) {
        if (!spec.startsWith(".")) expect(spec, key).toBe(CORE_PORTABLE);
      }
      // Type imports follow the same rule, so the declarations never point at the Node facades either.
      for (const m of source.matchAll(STATEMENT)) if (!m[3]!.startsWith(".")) expect(m[3], key).toBe(CORE_PORTABLE);
    }
  });

  it("leaves out the providers that need Node APIs", async () => {
    const reached = [...(await closureOf(["portable.ts"])).values()].filter((f) => f.pkg === "providers").map((f) => f.name);
    for (const left of ["random.ts", "cloudflare-r2.ts", "sigv4.ts", "supabase.ts", "vapid.ts", "index.ts"]) expect(reached).not.toContain(left);
  });

  it("the package declares the portable subpath", async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.exports["./portable"]).toEqual({ types: "./dist/portable.d.ts", default: "./dist/portable.js" });
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.dependencies).toEqual({ "@secret-desk/core": "workspace:*" });
  });

  it("the entry exports the portable providers and registry", () => {
    expect(portableEntry.portableProviders.length).toBeGreaterThan(0);
    expect(typeof portableEntry.createPortableRegistry).toBe("function");
    for (const name of ["ProviderError", "callJson", "cloudflareProviders", "stripeProviders", "grafanaProviders", "manualProviders", "openaiProviders", "resendProviders", "revenueCatProviders", "cloudflareAccessProviders", "withAnthropicAdmin", "readVariableField"]) {
      expect(portableEntry, name).toHaveProperty(name);
    }
    for (const name of ["createDefaultRegistry", "randomProviders", "supabaseProviders", "vapidProviders", "cloudflareR2Providers", "signRequest"]) expect(portableEntry, name).not.toHaveProperty(name);
  });

  it("the scanner tells value imports from type imports", () => {
    expect(valueSpecifiers(`import { a } from "./a.js";\nimport type { B } from "./b.js";\nexport * from "./c.js";\nexport type { D } from "./d.js";\nimport x from "node:fs";\nimport { y } from "@scope/pkg/sub";`)).toEqual(["./a.js", "./c.js", "node:fs", "@scope/pkg/sub"]);
    expect(packageOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageOf("yaml/util")).toBe("yaml");
    expect(packageOf("node:fs")).toBe("node:fs");
  });
});
