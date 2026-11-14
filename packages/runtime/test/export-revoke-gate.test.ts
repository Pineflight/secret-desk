import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, type Provider } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { createLocalRuntime } from "../src/runtime.js";
import { translateEn } from "../src/i18n-en.js";

// The environment export asks a provider to delete an issued value only through the gate: never an identifier that is the current one
// of the entry (a provider that rotates in place), and never once the file write started.

const human = { kind: "human", name: "alice" } as const;

const INVENTORY = (externalId: string) => `version: 1
secrets:
  - { id: dev-issued, name: DEV_ISSUED, stage: dev, service: x, provider: made-up-issuer, expiry: none, externalId: ${externalId}, places: [{ repo: acme-issue, scope: repository }] }
envTemplates:
  - id: issue-dev
    repo: acme-issue
    stage: dev
    file: .env.local
    entries:
      - { key: ISSUED, from: { type: issue, secret: dev-issued } }
`;

/** `inPlace`: the new value keeps the identifier of the entry ("same-id"); otherwise the provider names a new object. */
async function setup(inPlace: boolean, over: { revoke?: Provider["revoke"] } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-export-gate-")));
  const projects = join(dir, "projects");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY("same-id"));
  await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: {} }));
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const rt = await createLocalRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, bundledRecipes: null, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
  const revoke = vi.fn(over.revoke ?? (async () => undefined));
  rt.providers.register({
    id: "made-up-issuer",
    label: "Made up issuer",
    kind: "automatic",
    issue: async () => ({ value: SecretValue.from("made_up_issued_value"), externalId: inPlace ? "same-id" : "new-id" }),
    revoke,
  } as Provider);
  return { rt, projects, revoke };
}

describe("exportEnv and the gate", () => {
  it("a file that exists does not delete a token whose identifier is the entry's current one (provider rotates in place)", async () => {
    const { rt, projects, revoke } = await setup(true);
    await writeFile(join(projects, ".env.local"), "EXISTING=1\n");
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local") }).catch((e: Error) => e);
    expect(revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toContain("Datei existiert schon");
    expect((err as Error).message).toContain("Nicht widerrufen, weil die Kennung im Inventar noch die aktuelle ist");
    expect((err as Error).message).toContain("dev-issued (same-id)");
    expect(translateEn((err as Error).message)).toContain("Not revoked because the identifier is still the current one in the inventory");
  });

  it("a path outside the allowed folders still deletes a token with a new identifier", async () => {
    const { rt, revoke, projects } = await setup(false);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sd-export-outside-")));
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(outside, ".env.local") }).catch((e: Error) => e);
    expect((err as Error).message).toContain("ausserhalb der erlaubten Ordner");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]![0]).toMatchObject({ externalId: "new-id" });
    expect((err as Error).message).not.toContain("Nicht widerrufen");
    expect(projects.length).toBeGreaterThan(0);
  });

  it("a failed write after it started (the file path is a folder) deletes nothing and says the token stays valid", async () => {
    const { rt, projects, revoke } = await setup(false);
    await mkdir(join(projects, ".env.local"));
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local"), overwrite: true }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toContain("Nicht widerrufen, weil das Schreiben der Datei begonnen hatte");
    expect((err as Error).message).toContain("dev-issued (new-id)");
    expect(translateEn((err as Error).message)).toContain("writing the file had begun");
  });

  it("a delete the provider refuses is named for removal by hand, and the values of the run are forgotten when nothing was written", async () => {
    const { rt, projects } = await setup(false, { revoke: async () => Promise.reject(new Error("refused")) });
    await writeFile(join(projects, ".env.local"), "EXISTING=1\n");
    const runValues = new Map<string, string>();
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local"), runValues }).catch((e: Error) => e);
    expect((err as Error).message).toContain("Nicht widerrufen (beim Anbieter von Hand entfernen): dev-issued (new-id).");
    expect(translateEn((err as Error).message)).toContain("Not revoked (remove at the provider by hand): dev-issued (new-id).");
    expect(runValues.size).toBe(0);
  });

  it("after the write started the values of the run stay, and an agent's run values are never touched", async () => {
    const { rt, projects } = await setup(false);
    await mkdir(join(projects, ".env.local"));
    const runValues = new Map<string, string>();
    await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local"), overwrite: true, runValues }).catch(() => undefined);
    expect([...runValues.keys()].sort()).toEqual(["issue-dev:", "issue-dev:ISSUED"]);
    const agent = { kind: "agent", name: "claude" } as const;
    const foreign = new Map([["issue-dev:ISSUED", "made-up"]]);
    await exportEnv(rt, agent, { repo: "acme-issue", path: join(projects, ".env.local"), runValues: foreign }).catch(() => undefined);
    expect([...foreign.keys()]).toEqual(["issue-dev:ISSUED"]);
  });
});
