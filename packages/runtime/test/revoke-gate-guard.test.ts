import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A tripwire for the rule "ONE gate decides whether a newly issued value is revoked": `revokeNewValue` in the core is the only
// code that asks a provider to revoke or delete the new value of a review. Every other site (commit's stale checks, discard, the
// sweep and its retries, a person's reject, an explicit orphan revoke) goes through it. This test fails when a provider's `revoke`
// is called anywhere else in `packages/core/src` or `packages/runtime/src`, except at the listed places, each with its reason.
const RUNTIME_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CORE_SRC = fileURLToPath(new URL("../../core/src/", import.meta.url));

/** Calls of a provider's `revoke` that are outside the gate on purpose: file name and how many, with the reason. */
const OUTSIDE_THE_GATE: Readonly<Record<string, { calls: number; why: string }>> = Object.freeze({
  "issuance.ts": { calls: 3, why: "the gate itself (1), the old-value revoke after a confirmed commit (1) and the undo inside prepareIssuance before any item exists (1)" },
  "rotate.ts": { calls: 2, why: "the separate rotate flow (not the review flow): its own undo and old-value revoke; not covered by the gate, listed as not covered" },
  "env-export.ts": { calls: 1, why: "the separate template-command flow, not the review flow; not covered by the gate, listed as not covered" },
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// A call is `.revoke(` or `.revoke?.(` on something; the declaration `revoke?(ctx)` of the provider interface is not one.
const CALL = /\.revoke\??\.?\(/g;
export const revokeCalls = (code: string): number => (stripComments(code).match(CALL) ?? []).length;

describe("one gate for revoking a newly issued value", () => {
  it("a provider's revoke is called only at the listed places in the core and the runtime", async () => {
    const found: Record<string, number> = {};
    for (const file of [...(await sourceFiles(CORE_SRC)), ...(await sourceFiles(RUNTIME_SRC))]) {
      const calls = revokeCalls(await readFile(file, "utf8"));
      if (calls > 0) found[file.slice(file.lastIndexOf("/") + 1)] = calls;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(OUTSIDE_THE_GATE).map(([name, o]) => [name, o.calls])));
    for (const o of Object.values(OUTSIDE_THE_GATE)) expect(o.why.length).toBeGreaterThan(20);
  });

  it("inside issuance.ts exactly one call sits in the gate, and none in discard, the sweep or the queue", async () => {
    const core = stripComments(await readFile(join(CORE_SRC, "issuance.ts"), "utf8"));
    const gate = core.slice(core.indexOf("export async function revokeNewValue"), core.indexOf("export interface DiscardResult"));
    expect(gate.length).toBeGreaterThan(200);
    expect((gate.match(CALL) ?? []).length).toBe(1);
    const discard = core.slice(core.indexOf("export async function discardIssuance"));
    expect((discard.match(CALL) ?? []).length).toBe(0);
    for (const file of ["issuances.ts", "agent-api.ts"]) expect(revokeCalls(await readFile(join(RUNTIME_SRC, file), "utf8")), file).toBe(0);
  });

  it("the scanner counts calls, not mentions", () => {
    expect(revokeCalls("await provider.revoke({ a: 1 });")).toBe(1);
    expect(revokeCalls("await provider.revoke?.({ a: 1 });")).toBe(1);
    expect(revokeCalls("// provider.revoke( in a comment\nconst revokes = provider?.revoke;")).toBe(0);
    expect(revokeCalls("if (!provider?.revoke) return;")).toBe(0);
  });
});
