import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as portable from "../src/portable.js";

describe("what the portable entry leaves out of the agent interface", () => {
  it("does not export exportEnv (the environment file export needs the file system and the host), the root does", () => {
    expect("exportEnv" in portable).toBe(false);
    expect(Object.keys(portable)).not.toContain("exportEnv");
    expect(root.exportEnv).toBeTypeOf("function");
  });
});

describe("the type check of the agent interface exports", () => {
  it("is part of what `pnpm run typecheck` compiles", async () => {
    // Test files of this package are not compiled by tsconfig.json (it includes `src` only); this config adds the one check file.
    const read = async (name: string): Promise<string> => readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
    const manifest = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    expect(manifest.scripts["typecheck"]).toBe("tsc -p tsconfig.typecheck.json");
    const config = JSON.parse(await read("tsconfig.typecheck.json")) as { extends: string; include: string[] };
    expect(config.extends).toBe("./tsconfig.json");
    expect(config.include).toContain("test/agent-api-types.check.ts");
    expect(config.include).toContain("src");
    // The check lists the 15 types the module exported before the split.
    const check = await read("test/agent-api-types.check.ts");
    expect(check.match(/Expect<Same</g)).toHaveLength(15);
    // The build config stays src-only: the check is neither emitted nor shipped.
    expect((JSON.parse(await read("tsconfig.json")) as { include: string[] }).include).toEqual(["src"]);
  });
});
