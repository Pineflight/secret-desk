import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The path check only objects on Windows; here the core check is replaced so the refusal is exercised on every platform.
vi.mock("@secret-desk/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@secret-desk/core")>()),
  localPathProblem: () => "Der Pfad enthaelt Zeichen, die Windows nicht erlaubt (< > : \" | ? *).",
}));

import { main } from "../src/index.js";

describe("env export (content mode) path check", () => {
  it("refuses a target the platform does not allow, with an English message, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cli-envpath-"));
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nvariables:\n  - { id: v, name: SITE_URL, stage: dev, value: \"http://localhost\", places: [{ repo: acme-app, scope: repository }] }\n");
    const config = join(dir, "secret-desk.config.yaml");
    await writeFile(config, "inventory: ./inventory.yaml\nvault: { enabled: false }\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_ENVPATH } }\n");
    process.env.SD_CLI_ENVPATH = "x";
    const err: string[] = [];
    const code = await main(["env", "export", "--config", config, "--repo", "acme-app", "--out", join(dir, ".env.local")], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/^Fehler: .+/);
    expect((await readdir(dir)).sort()).toEqual(["inventory.yaml", "secret-desk.config.yaml"]);
  });
});
