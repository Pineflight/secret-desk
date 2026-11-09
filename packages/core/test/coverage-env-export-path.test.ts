import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The local path check only objects on Windows; here it is replaced so the refusal is exercised on every platform.
vi.mock("../src/platform.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform.js")>()),
  localPathProblem: () => "Der Pfad enthaelt Zeichen, die Windows nicht erlaubt (< > : \" | ? *).",
}));

import { EnvExportError, writeEnvFile } from "../src/env-export.js";

describe("writeEnvFile path check", () => {
  it("refuses a path the platform does not allow and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cov-envpath-"));
    await expect(writeEnvFile(join(dir, ".env"), "A=1\n")).rejects.toBeInstanceOf(EnvExportError);
    expect(await readdir(dir)).toEqual([]);
  });
});
