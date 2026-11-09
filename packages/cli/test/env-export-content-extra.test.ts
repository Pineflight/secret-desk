import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTrackedByGit } from "../src/env-file.js";
import { main } from "../src/index.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-cli-envx2-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nvariables:\n  - { id: v-site, name: SITE_URL, stage: dev, value: \"http://localhost:3000\", places: [{ repo: acme-app, scope: repository }] }\n");
  const config = join(dir, "secret-desk.config.yaml");
  await writeFile(config, "inventory: ./inventory.yaml\nvault: { enabled: false }\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_ENVX2 } }\n");
  process.env.SD_CLI_ENVX2 = "x";
  const out: string[] = [];
  const err: string[] = [];
  return { dir, config, out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("isTrackedByGit", () => {
  it("is true for a tracked file, false for an untracked one in a repository, null outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cli-git-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(join(dir, "a.env"), "x=1\n");
    await writeFile(join(dir, "b.env"), "x=1\n");
    execFileSync("git", ["add", "a.env"], { cwd: dir });
    expect(await isTrackedByGit(join(dir, "a.env"))).toBe(true);
    expect(await isTrackedByGit(join(dir, "b.env"))).toBe(false);
    const plain = await mkdtemp(join(tmpdir(), "sd-cli-nogit-"));
    expect(await isTrackedByGit(join(plain, "c.env"))).toBeNull();
  });
});

describe("env export (content mode) argument errors", () => {
  it("needs --config and --repo", async () => {
    const t = await setup();
    expect(await main(["env", "export", "--repo", "acme-app"], t.io)).toBe(2);
    expect(await main(["env", "export", "--config", t.config], t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("env export --config <file> --repo <repo>");
  });

  it("rejects an unknown --include", async () => {
    const t = await setup();
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--include", "everything"], t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("--include: variables or all");
  });

  it("writes an untracked file inside a git repository without a warning", async () => {
    const t = await setup();
    execFileSync("git", ["init", "-q"], { cwd: t.dir });
    const file = join(t.dir, ".env.local");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file], t.io)).toBe(0);
    expect(await readFile(file, "utf8")).toContain("SITE_URL=");
    expect(t.err).toEqual([]);
  });

  it("defaults the target to the file name from the export in the working directory", async () => {
    const t = await setup();
    const cwd = process.cwd();
    process.chdir(t.dir);
    try {
      expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app"], t.io)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(t.out.join("\n")).toMatch(/written: .*\.env/);
  });

  it("falls back to the stage id dev when the inventory defines no dev stage", async () => {
    const t = await setup();
    await writeFile(join(t.dir, "inventory.yaml"), "version: 1\nstages:\n  - { id: qa, kind: test }\n  - { id: prod, kind: live }\nvariables:\n  - { id: v-site, name: SITE_URL, stage: qa, value: \"https://qa.example.com\", places: [{ repo: acme-app, scope: repository }] }\n");
    const file = join(t.dir, ".env.local");
    const code = await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file], t.io);
    expect(code).toBe(2);
    expect(t.err.join("\n")).toMatch(/dev/);
  });
});
