import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitCheckIgnored, runEnvCommand, writeEnvFile } from "../src/env-export.js";

describe("writeEnvFile with an injected Git check", () => {
  it("asks the given function, with the resolved path, instead of starting git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-host-"));
    const checkIgnored = vi.fn(async () => true as boolean | null);
    const result = await writeEnvFile(join(dir, ".env"), "A=1\n", { checkIgnored });
    expect(result).toEqual({ path: join(dir, ".env"), gitIgnored: true });
    expect(checkIgnored).toHaveBeenCalledExactlyOnceWith(join(dir, ".env"));
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("A=1\n");
  });

  it("a function that answers null leaves the result unchecked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-host-"));
    expect((await writeEnvFile(join(dir, ".env"), "A=1\n", { checkIgnored: async () => null })).gitIgnored).toBeNull();
  });

  it("the default check is exported and answers null outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-host-plain-"));
    expect([null, false]).toContain(await gitCheckIgnored(join(dir, ".env")));
  });
});

describe("runEnvCommand allow-list", () => {
  it.each(["rm", "toString", "constructor", "__proto__", "hasOwnProperty", "supabase-status ", ""])("refuses %j before a process is started", async (name) => {
    await expect(runEnvCommand(name as never, tmpdir())).rejects.toThrow("Unknown template command.");
  });
});
