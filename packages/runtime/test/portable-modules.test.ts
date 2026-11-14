import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as portableEntry from "../src/portable.js";

// Same mechanism as the guards of `@secret-desk/core/portable` and `@secret-desk/providers/portable`: a tripwire, not a proof. It follows
// every relative value import of `src/portable.ts` (static and `import("./x.js")`), resolves `@secret-desk/core/portable` and
// `@secret-desk/providers/portable` into their sources and follows those too, and checks each file it reaches. Real portability is only
// proven by running the code in a runtime without Node built-ins. Type-only imports are erased at build time and exempt: the runtime
// entry imports types from the automation package and from its own Node modules (`agent-api.ts`, `live-check-store.ts`, ...), and no
// value.
const CORE_PORTABLE = "@secret-desk/core/portable";
const PROVIDERS_PORTABLE = "@secret-desk/providers/portable";
const EXPECTED_RUNTIME_FILES = [
  "agent-api-core.ts", "approvals.ts", "automation-port.ts", "connection-guides.ts", "facade-registry.ts", "github-crypto-core.ts", "host-core.ts", "instance-state.ts", "issuances.ts",
  "known-connections.ts", "live-check-notify.ts", "params.ts", "path-basename.ts", "portable.ts", "runtime-core.ts", "team-token-rights.ts",
];
const EXPECTED_PROVIDER_FILES = [
  "anthropic.ts", "checks.ts", "cloudflare-access.ts", "cloudflare.ts", "discover.ts", "grafana.ts", "http.ts", "manual.ts", "openai.ts", "portable.ts", "resend.ts", "revenuecat.ts", "stripe.ts",
  "variable-sources.ts",
];
const EXPECTED_CORE_FILES = [
  "base64.ts", "config-core.ts", "connections-core.ts", "env-export-errors.ts", "evidence.ts", "git-names.ts", "github-core.ts", "guards.ts", "inventory-backend.ts", "inventory-errors.ts",
  "inventory-store.ts", "issuance.ts", "params.ts", "patch.ts", "place-io.ts", "place-key.ts", "portable.ts", "preflight.ts", "provider.ts", "reserved-names.ts", "rotate.ts", "secret.ts", "sha256.ts",
  "snapshot.ts", "stages.ts", "status.ts", "stripe-accounts.ts", "team.ts", "types.ts", "variable-sources.ts", "variables.ts", "vault-core.ts", "vendors.ts", "verification.ts", "worker-secrets.ts",
];
// Modules that must never be in the closure: the Node host, the browser automation, the local builder and the agent interface.
const NEVER_IN_CLOSURE = ["host.ts", "automation.ts", "runtime.ts", "agent-api.ts", "connection-check.ts", "facade.ts", "team-sync.ts", "repos.ts", "i18n-en.ts", "github-crypto.ts"];
// Pure JavaScript only (no Node built-ins, no native or WASM code): what the core's portable closure may import.
const PURE_PACKAGES = ["yaml", "zod", "@noble/hashes"];
const NODE_BUILTINS = ["assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "net", "os", "path", "stream", "tls", "url", "util", "zlib"];
// Packages that are never allowed anywhere in the closure, by name (a message that says why helps the person who trips on it).
const FORBIDDEN_PACKAGES = ["@secret-desk/core", "@secret-desk/providers", "@secret-desk/automation", "libsodium-wrappers", "playwright-core"];

type Pkg = "runtime" | "providers" | "core";
interface Reached {
  pkg: Pkg;
  name: string;
  source: string;
}
const DIRS: Record<Pkg, URL> = { runtime: new URL("../src/", import.meta.url), providers: new URL("../../providers/src/", import.meta.url), core: new URL("../../core/src/", import.meta.url) };

async function sourceOf(pkg: Pkg, name: string): Promise<string> {
  const text = await readFile(fileURLToPath(new URL(name, DIRS[pkg])), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const STATEMENT = /^\s*(import|export)\s+(type\s+)?(?:[^;]*?\s*from\s+)?["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Specifiers of value imports and re-exports, and of dynamic `import("...")` (type-only ones are erased at build time and exempt). */
export function valueSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(STATEMENT)) if (!m[2]) found.push(m[3]!);
  for (const m of source.matchAll(DYNAMIC)) found.push(m[1]!);
  return found;
}

export const packageOf = (spec: string): string => (spec.startsWith("node:") ? spec : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);

/** Every file reached from `portable.ts` of the runtime, keyed `<package>:<file>`. Core and provider files are reached only through their portable entries. */
async function closureOfRuntimeEntry(): Promise<Map<string, Reached>> {
  const files = new Map<string, Reached>();
  const queue: { pkg: Pkg; name: string }[] = [{ pkg: "runtime", name: "portable.ts" }];
  while (queue.length) {
    const { pkg, name } = queue.pop()!;
    const key = `${pkg}:${name}`;
    if (files.has(key)) continue;
    const source = await sourceOf(pkg, name);
    files.set(key, { pkg, name, source });
    for (const spec of valueSpecifiers(source)) {
      if (spec.startsWith(".")) queue.push({ pkg, name: posix.normalize(posix.join(posix.dirname(name), spec.replace(/\.js$/, ".ts"))) });
      else if (spec === CORE_PORTABLE) queue.push({ pkg: "core", name: "portable.ts" });
      else if (spec === PROVIDERS_PORTABLE) queue.push({ pkg: "providers", name: "portable.ts" });
    }
  }
  return files;
}

/**
 * What is wrong with one file of the closure: a value import it may not have, a Node API, a forbidden name. Empty when clean.
 * Runtime files may import only the portable entries of the core and the providers; provider files only the core's; core files
 * only the pure packages.
 */
export function findingsOf(pkg: Pkg, name: string, source: string): string[] {
  const out: string[] = [];
  const allowedBare: string[] = pkg === "runtime" ? [CORE_PORTABLE, PROVIDERS_PORTABLE] : pkg === "providers" ? [CORE_PORTABLE] : PURE_PACKAGES;
  for (const spec of valueSpecifiers(source)) {
    if (spec.startsWith(".")) continue;
    const bare = pkg === "core" ? packageOf(spec) : spec;
    if (!allowedBare.includes(bare)) out.push(`${name}: value import of ${spec}`);
    if (spec.startsWith("node:")) out.push(`${name}: node: specifier ${spec}`);
    if (FORBIDDEN_PACKAGES.includes(packageOf(spec)) && spec !== CORE_PORTABLE && spec !== PROVIDERS_PORTABLE) out.push(`${name}: forbidden package ${spec}`);
  }
  for (const mod of NODE_BUILTINS) if (new RegExp(`from\\s+["']${mod}(/[^"']*)?["']`).test(source)) out.push(`${name}: bare Node built-in ${mod}`);
  if (/libsodium/.test(source)) out.push(`${name}: libsodium`);
  if (/playwright/.test(source)) out.push(`${name}: playwright`);
  const tokens: [string, RegExp][] = [
    ["process.", /\bprocess\./],
    ["process[", /\bprocess\s*\[/],
    ["globalThis.process", /\bglobalThis\.process\b/],
    ["globalThis['process']", /\b(globalThis|global)\s*\[\s*["']process["']\s*\]/],
    ["Buffer", /\bBuffer\b/],
    ["require(", /\brequire\(/],
    ["NodeJS.", /\bNodeJS\./],
    ["ErrnoException", /\bErrnoException\b/],
  ];
  for (const [label, re] of tokens) if (re.test(source)) out.push(`${name}: ${label}`);
  return out;
}

const names = (files: Map<string, Reached>, pkg: Pkg): string[] => [...files.values()].filter((f) => f.pkg === pkg).map((f) => f.name).sort();

describe("the runtime's portable entry stays free of Node APIs", () => {
  it("follows value imports into the runtime, the providers and the core, and the pinned file lists match", async () => {
    const files = await closureOfRuntimeEntry();
    expect(names(files, "runtime")).toEqual(EXPECTED_RUNTIME_FILES);
    expect(names(files, "providers")).toEqual(EXPECTED_PROVIDER_FILES);
    expect(names(files, "core")).toEqual(EXPECTED_CORE_FILES);
    expect(files.size).toBe(EXPECTED_RUNTIME_FILES.length + EXPECTED_PROVIDER_FILES.length + EXPECTED_CORE_FILES.length);
  });

  it("no file of the closure has a value import of Node, a forbidden package or a Node API token", async () => {
    const found: string[] = [];
    for (const { pkg, name, source } of (await closureOfRuntimeEntry()).values()) found.push(...findingsOf(pkg, `${pkg}/${name}`, source));
    expect(found).toEqual([]);
  });

  it("the Node host, the browser automation, the local builder and the agent interface are not in the closure", async () => {
    const runtimeFiles = names(await closureOfRuntimeEntry(), "runtime");
    for (const never of NEVER_IN_CLOSURE) expect(runtimeFiles, never).not.toContain(never);
  });

  it("the runtime files import the core and the providers only through their portable entries", async () => {
    for (const { pkg, name, source } of (await closureOfRuntimeEntry()).values()) {
      if (pkg !== "runtime") continue;
      for (const spec of valueSpecifiers(source)) if (!spec.startsWith(".")) expect([CORE_PORTABLE, PROVIDERS_PORTABLE], `${name}: ${spec}`).toContain(spec);
      // Types follow the same rule for the core and the providers, so the declarations never point at the Node facades either. Types of
      // the automation package and of the runtime's own modules are allowed (they are erased).
      for (const m of source.matchAll(STATEMENT)) {
        const spec = m[3]!;
        expect(spec, `${name}: ${spec}`).not.toBe("@secret-desk/core");
        expect(spec, `${name}: ${spec}`).not.toBe("@secret-desk/providers");
      }
    }
  });

  it("the entry imports the automation package for types only", async () => {
    for (const { pkg, name, source } of (await closureOfRuntimeEntry()).values()) {
      if (pkg !== "runtime") continue;
      for (const m of source.matchAll(STATEMENT)) if (m[3]!.startsWith("@secret-desk/automation")) expect(m[2], `${name} imports a value from the automation package`).toBeTruthy();
    }
  });

  it("the package declares the portable subpath and the build produces its files", async () => {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    expect(pkg.exports["./portable"]).toEqual({ types: "./dist/portable.d.ts", default: "./dist/portable.js" });
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    // tsc maps src/portable.ts to dist/portable.js and dist/portable.d.ts (rootDir src, outDir dist).
    await expect(readFile(fileURLToPath(new URL("../src/portable.ts", import.meta.url)), "utf8")).resolves.toContain("export *");
  });

  it("the entry exports the builder, the queues, the crypto helpers, the host core and the automation port", () => {
    for (const name of [
      "createPortableRuntime", "issuanceDeps", "assertAuthorizeTimeout", "GITHUB_CONNECTION", "GITHUB_APP_KEY_CONNECTION",
      "InstanceState", "WaiterBook", "WaitExpiredError", "waitDeadline", "IssuanceQueue", "MemoryPendingStore", "ApprovalQueue",
      "createGitHubClient", "createAppTokenProvider", "assertCanSeal", "githubAppKeyStatus", "githubAppUsable",
      "HostCapabilityError", "readHostEnv", "hostHome", "expandHomeFor", "noAutomation", "AutomationUnavailableError", "LIVE_CHECK_NOTIFY_CONNECTION",
    ]) {
      expect(portableEntry, name).toHaveProperty(name);
    }
    // What needs Node stays off the entry.
    for (const name of ["createRuntime", "createLocalRuntime", "nodeRuntimeHost", "nodeHomePaths", "AutomationManager", "NODE_GITHUB_DEFAULTS", "withNodeDefaults"]) expect(portableEntry, name).not.toHaveProperty(name);
    // The internal builder and the base-class variant of the GitHub client are for the Node entry only: not on this entry.
    for (const name of ["buildRuntime", "createGitHubClientOn", "githubDefaults", "githubClientClass", "createConnections"]) expect(portableEntry, name).not.toHaveProperty(name);
    expect(portableEntry.noAutomationFor).toBeTypeOf("function");
  });

  it("the import scanners tell value imports from type imports and see dynamic imports", () => {
    expect(valueSpecifiers(`import { a } from "./a.js";\nimport type { B } from "./b.js";\nexport * from "./c.js";\nexport type { D } from "./d.js";\nimport x from "node:fs";\nimport { y } from "@scope/pkg/sub";\nconst m = await import("./e.js");\nimport "side-effect";`)).toEqual([
      "./a.js", "./c.js", "node:fs", "@scope/pkg/sub", "side-effect", "./e.js",
    ]);
    expect(packageOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageOf("yaml/util")).toBe("yaml");
    expect(packageOf("node:fs")).toBe("node:fs");
  });

  it("the detector flags what it must, and passes clean code", () => {
    const flagged = (pkg: Pkg, source: string): string[] => findingsOf(pkg, "x.ts", source);
    expect(flagged("runtime", `import { a } from "./a.js";\nimport { b } from "@secret-desk/core/portable";\nimport type { T } from "@secret-desk/automation";\nconst id = globalThis.crypto.randomUUID();`)).toEqual([]);
    expect(flagged("runtime", `import { readFile } from "node:fs/promises";`)).toEqual(["x.ts: value import of node:fs/promises", "x.ts: node: specifier node:fs/promises"]);
    expect(flagged("runtime", `import { createSign } from "crypto";`)).toEqual(["x.ts: value import of crypto", "x.ts: bare Node built-in crypto"]);
    expect(flagged("runtime", `import { ConnectionStore } from "@secret-desk/core";`)).toEqual(["x.ts: value import of @secret-desk/core", "x.ts: forbidden package @secret-desk/core"]);
    expect(flagged("runtime", `export * from "@secret-desk/providers";`)).toEqual(["x.ts: value import of @secret-desk/providers", "x.ts: forbidden package @secret-desk/providers"]);
    expect(flagged("runtime", `import { PlaywrightDriver } from "@secret-desk/automation";`)).toEqual(["x.ts: value import of @secret-desk/automation", "x.ts: forbidden package @secret-desk/automation"]);
    expect(flagged("runtime", `import sodium from "libsodium-wrappers";`)).toEqual(["x.ts: value import of libsodium-wrappers", "x.ts: forbidden package libsodium-wrappers", "x.ts: libsodium"]);
    expect(flagged("runtime", `const m = await import("node:os");`)).toEqual(["x.ts: value import of node:os", "x.ts: node: specifier node:os"]);
    expect(flagged("runtime", `import { z } from "zod";`)).toEqual(["x.ts: value import of zod"]);
    expect(flagged("core", `import { z } from "zod";\nimport { sha256 } from "@noble/hashes/sha2";`)).toEqual([]);
    expect(flagged("core", `import { y } from "yaml";\nimport { chromium } from "playwright-core";`)).toEqual(["x.ts: value import of playwright-core", "x.ts: forbidden package playwright-core", "x.ts: playwright"]);
    expect(flagged("providers", `import { a } from "@secret-desk/core/portable";`)).toEqual([]);
    expect(flagged("providers", `import { a } from "yaml";`)).toEqual(["x.ts: value import of yaml"]);
    expect(flagged("runtime", `const v = process.env.X; const w = process["env"]; const g = globalThis.process; const h = globalThis["process"]; const b = Buffer.from("a");`)).toEqual([
      "x.ts: process.", "x.ts: process[", "x.ts: globalThis.process", "x.ts: globalThis['process']", "x.ts: Buffer",
    ]);
    expect(flagged("runtime", `const r = require("fs"); let e: NodeJS.ErrnoException;`)).toEqual(["x.ts: require(", "x.ts: NodeJS.", "x.ts: ErrnoException"]);
    // Type-only imports are exempt.
    expect(flagged("runtime", `import type { Buffer } from "node:buffer";`)).toEqual(["x.ts: Buffer"]);
    expect(flagged("runtime", `import type { RuntimeHost } from "node:fs";\nexport type { A } from "@secret-desk/core";`)).toEqual([]);
  });
});
