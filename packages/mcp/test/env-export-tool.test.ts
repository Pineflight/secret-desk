import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeskClient } from "../src/client.js";
import { envExportTool } from "../src/env-export.js";
import { TOOLS } from "../src/tools.js";

const VALUE = ["made", "up", "value"].join("-");
const response = (over: Record<string, unknown> = {}) => ({
  repo: "acme-app",
  stage: "dev",
  format: "dotenv",
  filename: ".env.local",
  content: `# header\nSITE_URL=${VALUE}\n# NO_VALUE= (missing: no target value set)\n`,
  keys: ["SITE_URL"],
  missing: [{ name: "NO_VALUE", reason: "no target value set" }],
  ...over,
});
const client = (res: unknown, seen: unknown[] = []) => ({ request: async (m: string, p: string, b: unknown) => { seen.push([m, p, b]); return res; } }) as unknown as DeskClient;

describe("desk_env_export", () => {
  it("is registered with the documented parameters", () => {
    const tool = TOOLS.find((t) => t.name === "desk_env_export")!;
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["format", "include", "out", "repo", "stage"]);
  });

  it("without out: asks the portal (stage defaults to dev) and returns names only, never a value", async () => {
    const seen: unknown[] = [];
    const r = await envExportTool(client(response(), seen), { repo: "acme-app" });
    expect(seen).toEqual([["POST", "/env/export", { repo: "acme-app", stage: "dev", format: "dotenv", include: "variables" }]]);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(r).toMatchObject({ status: "preview", keys: ["SITE_URL"], missing: [{ name: "NO_VALUE" }] });
    expect(r).not.toHaveProperty("content");
    expect(JSON.stringify(r)).toContain("`out`");
  });

  it("without out and include=all: dev secret values stay out of the response", async () => {
    const secretValue = ["dev", "secret", "value"].join("-");
    const res = response({ content: `API_KEY=${secretValue}\nSITE_URL=${VALUE}\n`, keys: ["API_KEY", "SITE_URL"], missing: [] });
    const r = await envExportTool(client(res), { repo: "acme-app", include: "all" });
    expect(JSON.stringify(r)).not.toContain(secretValue);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(r).toMatchObject({ keys: ["API_KEY", "SITE_URL"] });
  });

  it("with out: writes mode 600 inside the working dir and returns no content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    const r = await envExportTool(client(response()), { repo: "acme-app", out: "sub/.env.local" }, cwd);
    const file = join(await (await import("node:fs/promises")).realpath(cwd), "sub", ".env.local");
    expect(await readFile(file, "utf8")).toContain(VALUE);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(r).not.toHaveProperty("content");
    expect(r).toMatchObject({ status: "written", keys: ["SITE_URL"], missing: [{ name: "NO_VALUE" }] });
  });

  it("never overwrites", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    await writeFile(join(cwd, ".env"), "KEEP=1\n");
    await expect(envExportTool(client(response()), { repo: "acme-app", out: ".env" }, cwd)).rejects.toThrow(/existiert schon/);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("KEEP=1\n");
  });

  it("refuses paths outside the working dir (dotdot, absolute, symlink) and odd file names", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    const outside = await mkdtemp(join(tmpdir(), "sd-mcp-out-"));
    await symlink(outside, join(cwd, "link"));
    for (const out of ["../.env", join(outside, ".env"), "link/.env"]) {
      await expect(envExportTool(client(response()), { repo: "acme-app", out }, cwd)).rejects.toThrow(/ausserhalb/);
    }
    for (const out of [".envrc", "Makefile", "run.sh", "package.json"]) {
      await expect(envExportTool(client(response()), { repo: "acme-app", out }, cwd)).rejects.toThrow(/Nur Dateien/);
    }
    await expect(envExportTool(client(response({ format: "json" })), { repo: "acme-app", format: "json", out: "package.json" }, cwd)).rejects.toThrow(/Nur Dateien/);
    await expect(readFile(join(outside, ".env"))).rejects.toThrow();
  });

  it("refuses a path that git tracks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    execFileSync("git", ["init", "-q"], { cwd });
    await mkdir(join(cwd, "a"));
    await writeFile(join(cwd, "a", ".env"), "x=1\n");
    execFileSync("git", ["add", "a/.env"], { cwd });
    execFileSync("rm", [join(cwd, "a", ".env")]);
    await expect(envExportTool(client(response()), { repo: "acme-app", out: "a/.env" }, cwd)).rejects.toThrow(/Git verfolgt/);
  });

  it("writes an untracked path inside a git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    execFileSync("git", ["init", "-q"], { cwd });
    await envExportTool(client(response()), { repo: "acme-app", out: ".env" }, cwd);
    expect(await readFile(join(cwd, ".env"), "utf8")).toContain(VALUE);
  });

  it("json export may be written to env.<name>.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    await envExportTool(client(response({ format: "json", content: "{}\n" })), { repo: "acme-app", format: "json", out: "env.dev.json" }, cwd);
    expect(await readFile(join(cwd, "env.dev.json"), "utf8")).toBe("{}\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("passes other write errors through (read-only directory)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sd-mcp-env-"));
    await chmod(cwd, 0o500);
    try {
      await expect(envExportTool(client(response()), { repo: "acme-app", out: ".env" }, cwd)).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(cwd, 0o700);
    }
  });

  it("portal denial (policy) reaches the caller as an error", async () => {
    const denied = { request: async () => { throw new Error("Agenten duerfen fuer staging keine .env exportieren."); } } as unknown as DeskClient;
    await expect(envExportTool(denied, { repo: "acme-app", stage: "staging" })).rejects.toThrow(/staging/);
  });
});
