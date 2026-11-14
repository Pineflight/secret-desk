import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { gitCheckIgnored } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { gitEnv } from "../src/host.js";

describe("gitEnv per platform", () => {
  const source = { PATH: "/bin", Path: "C:\\Windows", SystemRoot: "C:\\Windows", GH_TEST: "poison_made_up" };

  it("on Windows names the null device NUL, because Git refuses the device path that os.devNull gives there", () => {
    const env = gitEnv(source, "win32");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("NUL");
    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(Object.keys(env)).toContain("Path");
    expect(Object.keys(env)).not.toContain("GH_TEST");
  });

  it("elsewhere keeps os.devNull and matches names exactly, as before", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const env = gitEnv(source, platform);
      expect(env["GIT_CONFIG_GLOBAL"]).toBe(devNull);
      expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "PATH", "SystemRoot"]);
    }
  });
});

describe("gitCheckIgnored with the host's Git environment and a real git, on every system", () => {
  it("answers true, false and null for an ignored file, a visible file and a folder that is no repository", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sd-git-env-")));
    const env = gitEnv(process.env);
    const repo = join(root, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, env });
    await writeFile(join(repo, ".gitignore"), ".env.ignored\n");
    expect(await gitCheckIgnored(join(repo, ".env.ignored"), env)).toBe(true);
    expect(await gitCheckIgnored(join(repo, ".env.visible"), env)).toBe(false);
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await gitCheckIgnored(join(plain, ".env"), env)).toBeNull();
  });
});
