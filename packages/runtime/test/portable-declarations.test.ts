import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The declarations of `@secret-desk/runtime/portable` must resolve in a project that does not have `@secret-desk/automation` installed
// (the portable entry never loads it). A `.d.ts` keeps every import of its source, type-only ones included, so this follows EVERY
// relative import of `src/portable.ts` (`import`, `import type`, `export ... from`, `import("...")`) and looks at what each file names.
// Real proof is a compile in a project without the package; this is the tripwire that keeps it so. (Value imports that a declaration
// drops, such as `node:fs` in a store that is only reached through a type, are not the concern here.)
// Packages the portable entry's consumer may not have installed: the automation package (an optional peer) and what only it or the Node
// facades load.
const NEVER_NAMED = ["@secret-desk/automation", "playwright-core", "libsodium-wrappers"];
const RELATIVE_NODE_MODULES = ["host.ts", "automation.ts", "runtime.ts", "agent-api.ts", "connection-check.ts", "facade.ts", "team-sync.ts", "repos.ts", "i18n-en.ts", "github-crypto.ts", "index.ts"];

const SRC = new URL("../src/", import.meta.url);
const STATEMENT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s*from\s+)?["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

async function declarationClosure(): Promise<Map<string, string[]>> {
  const specifiersOf = new Map<string, string[]>();
  const queue = ["portable.ts"];
  while (queue.length) {
    const name = queue.pop()!;
    if (specifiersOf.has(name)) continue;
    const text = (await readFile(fileURLToPath(new URL(name, SRC)), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const specs = [...[...text.matchAll(STATEMENT)].map((m) => m[1]!), ...[...text.matchAll(DYNAMIC)].map((m) => m[1]!)];
    specifiersOf.set(name, specs);
    for (const spec of specs) if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(name), spec.replace(/\.js$/, ".ts"))));
  }
  return specifiersOf;
}

describe("the declarations of the portable entry", () => {
  it("name no automation package and no Node module of the runtime", async () => {
    const closure = await declarationClosure();
    expect([...closure.keys()]).toContain("automation-types.ts");
    for (const [name, specs] of closure) {
      expect(RELATIVE_NODE_MODULES, name).not.toContain(name);
      for (const spec of specs) {
        if (spec.startsWith(".")) continue;
        expect(NEVER_NAMED, `${name}: ${spec}`).not.toContain(spec);
      }
    }
  });

  it("the shapes that stand in for the automation package's types import nothing from it", async () => {
    const closure = await declarationClosure();
    expect(closure.get("automation-types.ts")).toEqual(["@secret-desk/core/portable"]);
  });
});

describe("who installs the automation package", () => {
  const manifestOf = async (path: string): Promise<Record<string, Record<string, unknown>>> =>
    JSON.parse(await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as Record<string, Record<string, unknown>>;

  it("the runtime package asks for it as an optional peer (and has it for its own build and tests), not as a hard dependency", async () => {
    const runtime = await manifestOf("../package.json");
    expect(runtime["dependencies"]).not.toHaveProperty("@secret-desk/automation");
    expect(runtime["peerDependencies"]).toEqual({ "@secret-desk/automation": "workspace:*" });
    expect(runtime["peerDependenciesMeta"]).toEqual({ "@secret-desk/automation": { optional: true } });
    expect(runtime["devDependencies"]).toHaveProperty("@secret-desk/automation", "workspace:*");
  });

  it("every package that uses the runtime root entry names the automation package itself", async () => {
    for (const path of ["../../cli/package.json", "../../../apps/desk/package.json"]) {
      const manifest = await manifestOf(path);
      expect(manifest["dependencies"], path).toHaveProperty("@secret-desk/runtime");
      expect(manifest["dependencies"], path).toHaveProperty("@secret-desk/automation", "workspace:*");
    }
  });
});
