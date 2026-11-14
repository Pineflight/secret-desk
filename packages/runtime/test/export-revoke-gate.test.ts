import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, type Provider } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { exportEnv } from "../src/agent-api.js";
import { nodeRuntimeHost } from "../src/host.js";
import { translateEn } from "../src/i18n-en.js";
import { createRuntime } from "../src/runtime.js";

// The environment export asks a provider to delete an issued value only through the gate: never an identifier that is the current one
// of an entry (a provider that rotates in place), and never once the file write started. And it checks everything that needs no value
// before it issues anything: a provider that rotates in place replaces the value when it issues.

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

const INVENTORY = `version: 1
secrets:
  - { id: dev-issued, name: DEV_ISSUED, stage: dev, service: x, provider: made-up-issuer, expiry: none, externalId: same-id, places: [{ repo: acme-issue, scope: repository }] }
envTemplates:
  - id: issue-dev
    repo: acme-issue
    stage: dev
    file: .env.local
    entries:
      - { key: ISSUED, from: { type: issue, secret: dev-issued } }
`;

const IN_PLACE_LOST = "Der Anbieter hat den Wert unter derselben Kennung ersetzt (Rotation an Ort und Stelle): der neue Wert ging mit dem fehlgeschlagenen Export verloren und alle Ziele halten noch den alten Wert, der nicht mehr gilt. Nichts ist zu widerrufen. Das Secret erneut rotieren und seine Ziele schreiben: dev-issued (same-id).";
const IN_PLACE_WRITTEN = "Der Anbieter hat den Wert unter derselben Kennung ersetzt (Rotation an Ort und Stelle): der neue Wert steht hoechstens in der Datei, deren Schreiben begonnen hatte, und alle Ziele halten noch den alten Wert, der nicht mehr gilt. Nichts ist zu widerrufen. Das Secret erneut rotieren und seine Ziele schreiben: dev-issued (same-id).";
const FILE_WRITTEN = "Nicht widerrufen, weil das Schreiben der Datei begonnen hatte und sie den Wert enthalten kann: der Token bleibt beim Anbieter gueltig (von Hand entfernen, wenn die Datei nicht gebraucht wird): dev-issued (new-id).";

/** `inPlace`: the new value keeps the identifier of the entry ("same-id"); otherwise the provider names a new object ("new-id"). */
async function setup(inPlace: boolean, over: { revoke?: Provider["revoke"]; gitCheckIgnored?: () => Promise<boolean | null> } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sd-export-gate-")));
  const projects = join(dir, "projects");
  await mkdir(projects);
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "links.json"), JSON.stringify({ version: 1, links: {} }));
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\nlinksFile: ${JSON.stringify(join(dir, "links.json"))}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(projects)}]\n`);
  const host = { ...nodeRuntimeHost({ env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv }), ...(over.gitCheckIgnored ? { gitCheckIgnored: over.gitCheckIgnored } : {}) };
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, host, bundledRecipes: null, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
  const revoke = vi.fn(over.revoke ?? (async () => undefined));
  const issue = vi.fn(async () => ({ value: SecretValue.from("made_up_issued_value"), externalId: inPlace ? "same-id" : "new-id" }));
  rt.providers.register({ id: "made-up-issuer", label: "Made up issuer", kind: "automatic", issue, revoke } as Provider);
  return { rt, projects, revoke, issue };
}

describe("exportEnv checks the target before it issues anything", () => {
  it("an existing file without overwrite: no issue, no revoke, nothing happens to the in-place token", async () => {
    const { rt, projects, issue, revoke } = await setup(true);
    await writeFile(join(projects, ".env.local"), "EXISTING=1\n");
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local") }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Datei existiert schon: ${join(projects, ".env.local")}`);
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("a path outside the allowed folders: no issue", async () => {
    const { rt, issue, revoke } = await setup(true);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sd-export-outside-")));
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(outside, ".env.local") }).catch((e: Error) => e);
    expect((err as Error).message).toContain("Pfad liegt ausserhalb der erlaubten Ordner");
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("a folder at the target path, also with overwrite: no issue", async () => {
    const { rt, projects, issue, revoke } = await setup(false);
    await mkdir(join(projects, ".env.local"));
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local"), overwrite: true }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Der Pfad ist ein Ordner, keine Datei: ${join(projects, ".env.local")}`);
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("an agent is held to the same checks and its run values are never touched", async () => {
    const { rt, projects, issue } = await setup(false);
    await writeFile(join(projects, ".env.local"), "EXISTING=1\n");
    const foreign = new Map([["issue-dev:ISSUED", "made-up"]]);
    const err = await exportEnv(rt, agent, { repo: "acme-issue", path: join(projects, ".env.local"), runValues: foreign }).catch((e: Error) => e);
    expect((err as Error).message).toContain("Datei existiert schon");
    expect(issue).not.toHaveBeenCalled();
    expect([...foreign.keys()]).toEqual(["issue-dev:ISSUED"]);
  });
});

describe("exportEnv and the gate when the file system changes after the checks", () => {
  /** A map that creates the target file the moment the export hands it the first value: a change between the check and the write. */
  const racing = (file: string) =>
    new (class extends Map<string, string> {
      override set(key: string, value: string): this {
        writeFileSync(file, "CREATED_IN_BETWEEN=1\n");
        return super.set(key, value);
      }
    })();

  it("the write fails before it started: a token with a new identifier is deleted, the run values are forgotten", async () => {
    const { rt, projects, revoke } = await setup(false);
    const file = join(projects, ".env.local");
    const runValues = racing(file);
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: file, runValues }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Datei existiert schon: ${file}`);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]![0]).toMatchObject({ externalId: "new-id" });
    expect(runValues.size).toBe(0);
  });

  it("the same, but the provider refuses the delete: named for removal by hand, with the English text", async () => {
    const { rt, projects } = await setup(false, { revoke: async () => Promise.reject(new Error("refused")) });
    const file = join(projects, ".env.local");
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: file, runValues: racing(file) }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`Datei existiert schon: ${file}\nNicht widerrufen (beim Anbieter von Hand entfernen): dev-issued (new-id).`);
    expect(translateEn((err as Error).message)).toBe(`File already exists: ${file}\nNot revoked (remove at the provider by hand): dev-issued (new-id).`);
  });

  it("an in-place token after the same race: not deleted, the exact in-place text, in English too", async () => {
    const { rt, projects, revoke } = await setup(true);
    const file = join(projects, ".env.local");
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: file, runValues: racing(file) }).catch((e: Error) => e);
    expect(revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(`Datei existiert schon: ${file}\n${IN_PLACE_LOST}`);
    expect(translateEn((err as Error).message)).toBe(
      `File already exists: ${file}\nThe provider replaced the value under the same identifier (rotation in place): the new value was lost with the failed export and every target still holds the old value, which no longer works. There is nothing to revoke. Rotate the secret again and write its targets: dev-issued (same-id).`,
    );
  });
});

describe("the notices in English", () => {
  it("translates the lists, also an entry without an identifier, and the new rotation warnings", () => {
    expect(translateEn("Nicht widerrufen (beim Anbieter von Hand entfernen): dev-token (ohne Kennung), gone (ohne Kennung).")).toBe("Not revoked (remove at the provider by hand): dev-token (without identifier), gone (without identifier).");
    expect(translateEn("Der neue Token ist nur in einem Teil der Ziele geschrieben: die anderen Ziele (api/repo) halten noch den alten Wert, der gueltig bleibt. Das Secret erneut rotieren.")).toBe("The new token is written to only some targets: the other targets (api/repo) still hold the old value, which stays valid. Rotate the secret again.");
    expect(translateEn("Rotation fehlgeschlagen: der neue Token (Kennung new-id) ist beim Anbieter noch gueltig")).toBe("Rotation failed: the new token (identifier new-id) is still valid at the provider");
  });
});

describe("exportEnv after the file write started", () => {
  const failingGit = async (): Promise<boolean | null> => Promise.reject(new Error("git check failed"));

  it("a token with a new identifier is not deleted and the notice says the token stays valid; the run values stay", async () => {
    const { rt, projects, revoke } = await setup(false, { gitCheckIgnored: failingGit });
    const runValues = new Map<string, string>();
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local"), runValues }).catch((e: Error) => e);
    expect(revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(`git check failed\n${FILE_WRITTEN}`);
    expect(translateEn((err as Error).message)).toBe("git check failed\nNot revoked because writing the file had begun and it may contain the value: the token stays valid at the provider (remove it by hand if the file is not needed): dev-issued (new-id).");
    expect([...runValues.keys()].sort()).toEqual(["issue-dev:", "issue-dev:ISSUED"]);
  });

  it("an in-place token: nothing to revoke, the new value is at most in the file", async () => {
    const { rt, projects, revoke } = await setup(true, { gitCheckIgnored: failingGit });
    const err = await exportEnv(rt, human, { repo: "acme-issue", path: join(projects, ".env.local") }).catch((e: Error) => e);
    expect(revoke).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(`git check failed\n${IN_PLACE_WRITTEN}`);
  });
});
