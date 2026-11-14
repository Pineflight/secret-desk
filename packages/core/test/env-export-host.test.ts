import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commandEnv, gitCheckIgnored, runEnvCommand, writeEnvFile } from "../src/env-export.js";

describe("commandEnv", () => {
  it("keeps system basics and Docker, and drops everything else, from the object it is given", () => {
    expect(commandEnv({ PATH: "/bin", HOME: "/h", DOCKER_HOST: "tcp://x", GH_TEST: "poison_made_up", SECRET_DESK_TEAM_TOKEN: "poison_made_up", UNSET: undefined })).toEqual({ PATH: "/bin", HOME: "/h", DOCKER_HOST: "tcp://x" });
  });
});

describe("gitCheckIgnored with an environment", () => {
  it("passes exactly the given environment to git", async () => {
    const bin = await realpath(await mkdtemp(join(tmpdir(), "sd-env-git-")));
    const dump = join(bin, "env.txt");
    await writeFile(join(bin, "git"), `#!/bin/sh\nenv > "${dump}"\nexit 1\n`, { mode: 0o755 });
    expect(await gitCheckIgnored(join(bin, ".env"), { PATH: `${bin}:/usr/bin:/bin`, ONLY_THIS: "yes_made_up" })).toBe(false);
    const seen = await readFile(dump, "utf8");
    expect(seen).toContain("ONLY_THIS=yes_made_up");
    expect(seen).not.toContain("HOME=");
  });
});

describe("runEnvCommand and a node_modules link that leads out of the folder", () => {
  it("falls back to PATH, so a planted link is never started", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sd-env-link-")));
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repo);
    await mkdir(join(outside, ".bin"), { recursive: true });
    await writeFile(join(outside, ".bin", "supabase"), `#!/bin/sh\necho planted > "${join(root, "planted.txt")}"\necho ANON_KEY=x\n`, { mode: 0o755 });
    await symlink(outside, join(repo, "node_modules"));
    const saved = process.env["PATH"];
    process.env["PATH"] = join(root, "empty");
    try {
      await expect(runEnvCommand("supabase-status", repo)).rejects.toThrow('Programm "supabase" nicht gefunden');
    } finally {
      process.env["PATH"] = saved;
    }
    expect(await readFile(join(root, "planted.txt"), "utf8").catch(() => null)).toBeNull();
  });
});

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
