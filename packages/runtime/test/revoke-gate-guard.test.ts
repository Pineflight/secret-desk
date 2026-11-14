import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire for the rule "ONE gate decides whether a newly issued value is revoked": `revokeNewValue` in the core is the only
// code that asks a provider to revoke or delete a NEW value (a review's, an environment export's, a rotation's). This test fails
// when a provider's `revoke` is called, or taken as a value to call later, anywhere else in the core and the runtime except at the
// listed places, and when another provider's `revoke` is called in the providers and the automation package except at the listed
// places. It is a text check, not a proof: it cannot see a call through a name it does not know (an `eval`, a computed key that is
// not a plain string, a function passed in from outside).
const RUNTIME_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE_SRC = fileURLToPath(new URL("../../core/src/", import.meta.url));
const PROVIDERS_SRC = fileURLToPath(new URL("../../providers/src/", import.meta.url));
const AUTOMATION_SRC = fileURLToPath(new URL("../../automation/src/", import.meta.url));
const CLI_SRC = fileURLToPath(new URL("../../cli/src/", import.meta.url));
const MCP_SRC = fileURLToPath(new URL("../../mcp/src/", import.meta.url));

/** Uses of a provider's `revoke` that are outside the gate on purpose: file name and how many, with the reason. */
const OUTSIDE_THE_GATE: Readonly<Record<string, { uses: number; why: string }>> = Object.freeze({
  "issuance.ts": { uses: 3, why: "the gate itself (1), the old-value revoke after a confirmed commit (1) and the undo inside prepareIssuance before any item exists (1)" },
  "rotate.ts": { uses: 1, why: "the old-value revoke after every place was written (guarded: not the new identifier, not another entry's); the new value goes through the gate" },
});

/** Uses of another provider's `revoke` in the providers and the automation package: file name and how many, with the reason. */
const PROVIDER_PACKAGE_CALLERS: Readonly<Record<string, { uses: number; why: string }>> = Object.freeze({
  "anthropic.ts": { uses: 1, why: "withAnthropicAdmin wraps the provider it is given and passes revoke on to it when no admin connection exists (a provider implementation, not a flow)" },
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|cts|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A call: `.revoke(`, `.revoke?.(`, `.revoke!(`, `.revoke.call(` (also apply, bind), `["revoke"](`, `["revoke"]?.(`, `["revoke"].call(`. */
const SUFFIX = String.raw`(?:!|\??\.\s*(?:call|apply|bind)\s*(?:\?\.)?|\?\.)?`;
// A bracket access follows an expression (`p["revoke"]`, `p?.["revoke"]`), unlike the array literal `add(["revoke"], ...)`.
const MEMBER = String.raw`(?<=[\w$)\]?.]\s*)\[\s*["'\`]revoke["'\`]\s*\]`;
const CALL = new RegExp(String.raw`\.revoke\s*${SUFFIX}\s*\(|${MEMBER}\s*${SUFFIX}\s*\(`, "g");
/** Taking the function as a value: `const f = p.revoke;`, `f(p.revoke)`, `{ revoke } = p`, `{ revoke: f } = p`, `p["revoke"]` without a call. */
const ALIAS = new RegExp(
  String.raw`(?<!\b(?:if|while)\s*)[=,(]\s*[\w$][\w$.?!]*?\??\.revoke\s*(?=[;,)]|$)|\{[^{}]*\brevoke\b[^{}]*\}\s*=(?![=>])|${MEMBER}(?!\s*${SUFFIX}\s*\()`,
  "gm",
);

/** How many calls and aliases of a provider's `revoke` the code has. A declaration (`async revoke(ctx)`, `revoke?(ctx)`) is neither. */
export const revokeUses = (code: string): number => {
  const text = stripComments(code);
  return (text.match(CALL) ?? []).length + (text.match(ALIAS) ?? []).length;
};

async function usesByFile(dirs: string[]): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const dir of dirs) {
    for (const file of await sourceFiles(dir)) {
      const uses = revokeUses(await readFile(file, "utf8"));
      if (uses > 0) found[file.slice(file.lastIndexOf("/") + 1)] = uses;
    }
  }
  return found;
}

describe("one gate for revoking a newly issued value", () => {
  it("a provider's revoke is used only at the listed places in the core and the runtime", async () => {
    expect(await usesByFile([CORE_SRC, RUNTIME_SRC])).toEqual(Object.fromEntries(Object.entries(OUTSIDE_THE_GATE).map(([name, o]) => [name, o.uses])));
    for (const o of Object.values(OUTSIDE_THE_GATE)) expect(o.why.length).toBeGreaterThan(20);
  });

  it("another provider's revoke is used only at the listed places in the providers and the automation package, and nowhere in the CLI and MCP server", async () => {
    expect(await usesByFile([PROVIDERS_SRC, AUTOMATION_SRC])).toEqual(Object.fromEntries(Object.entries(PROVIDER_PACKAGE_CALLERS).map(([name, o]) => [name, o.uses])));
    for (const o of Object.values(PROVIDER_PACKAGE_CALLERS)) expect(o.why.length).toBeGreaterThan(20);
    expect(await usesByFile([CLI_SRC, MCP_SRC])).toEqual({});
  });

  it("inside issuance.ts exactly one call sits in the gate, and none in discard, the sweep or the queue", async () => {
    const core = stripComments(await readFile(join(CORE_SRC, "issuance.ts"), "utf8"));
    const gate = core.slice(core.indexOf("export async function revokeNewValue"), core.indexOf("export interface DiscardResult"));
    expect(gate.length).toBeGreaterThan(200);
    expect((gate.match(CALL) ?? []).length).toBe(1);
    const discard = core.slice(core.indexOf("export async function discardIssuance"));
    expect(revokeUses(discard)).toBe(0);
    for (const file of ["issuances.ts", "agent-api.ts"]) expect(revokeUses(await readFile(join(RUNTIME_SRC, file), "utf8")), file).toBe(0);
  });

  it("the environment export and the rotate flow call the gate for a new value", async () => {
    expect(await readFile(join(CORE_SRC, "env-export.ts"), "utf8")).toContain("revokeNewValue(");
    expect(await readFile(join(CORE_SRC, "rotate.ts"), "utf8")).toContain("revokeNewValue(");
  });

  it("the scanner counts calls and aliases, not mentions", () => {
    for (const code of [
      "await provider.revoke({ a: 1 });",
      "await provider.revoke?.({ a: 1 });",
      "await provider.revoke!({ a: 1 });",
      "await provider?.revoke!(ctx);",
      'await provider["revoke"]({ a: 1 });',
      'await provider["revoke"]!(ctx);',
      "await provider.revoke.call(provider, ctx);",
      "await provider.revoke?.apply(provider, [ctx]);",
      'await provider["revoke"].call(provider, ctx);',
      "const revoke = provider.revoke;",
      "const revoke = provider?.revoke;",
      "run(provider.revoke);",
      "const { revoke } = provider;",
      "const { issue, revoke: drop } = provider;",
      'const drop = provider["revoke"];',
    ]) expect(revokeUses(code), code).toBe(1);
    for (const code of [
      "// provider.revoke( in a comment, and const f = provider.revoke;\nconst revokes = 1;",
      "if (!provider?.revoke) return;",
      "if (r.revoke) assigns(r.revoke.steps);",
      "const steps = recipe.revoke?.steps ?? [];",
      "async revoke(ctx: RevokeContext) { return 1; }",
      "revoke?(ctx: RevokeContext): Promise<void>;",
      "const { issue } = provider;",
      'add(["revoke"], "a literal, not a member access");',
      "await revokeRecipe(recipe);",
    ]) expect(revokeUses(code), code).toBe(0);
  });
});
