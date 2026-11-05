import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";

const INVENTORY = `version: 1
secrets:
  - { id: api-key-dev, name: API_KEY, stage: dev, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }] }
  - { id: token-staging, name: TOKEN, stage: staging, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: environment, environment: staging }] }
variables:
  - { id: v-site, name: SITE_URL, stage: dev, value: "http://localhost:3000", places: [{ repo: acme-app, scope: repository }] }
  - { id: v-staging, name: STAGING_URL, stage: staging, value: "https://staging.example.com", places: [{ repo: acme-app, scope: environment, environment: staging }] }
envTemplates:
  - { id: t, repo: acme-app, stage: dev, entries: [{ key: API_KEY, from: { type: generate, kind: hex, bytes: 16 } }] }
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-cli-envx-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  const config = join(dir, "secret-desk.config.yaml");
  await writeFile(config, "inventory: ./inventory.yaml\nvault: { enabled: false }\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_ENVX } }\n");
  process.env.SD_CLI_ENVX = "x";
  const out: string[] = [];
  const err: string[] = [];
  return { dir, config, out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("secret-desk env export (content mode)", () => {
  it("writes the file with mode 600, dev secrets with a value, missing ones reported", async () => {
    const t = await setup();
    const file = join(t.dir, "out", ".env.local");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "all"], t.io)).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("SITE_URL=http://localhost:3000");
    expect(text).toMatch(/\nAPI_KEY=[0-9a-f]{32}\n/);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    // the value never goes to the terminal
    expect(t.out.join("\n")).not.toContain("localhost:3000");
    expect(t.out.join("\n")).toContain("mode 600");
  });

  it("any stage for variables, staging secret omitted", async () => {
    const t = await setup();
    const file = join(t.dir, ".env.staging");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--stage", "staging", "--out", file, "--include", "all"], t.io)).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("STAGING_URL=https://staging.example.com");
    expect(text).toContain("# TOKEN= (missing: secret values of stage staging are never exported)");
    expect(t.err.join("\n")).toContain("missing: TOKEN");
  });

  it("json format", async () => {
    const t = await setup();
    const file = join(t.dir, "env.dev.json");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--format", "json"], t.io)).toBe(0);
    expect((JSON.parse(await readFile(file, "utf8")) as { values: Record<string, string> }).values.SITE_URL).toBe("http://localhost:3000");
  });

  it("refuses to overwrite without --force", async () => {
    const t = await setup();
    const file = join(t.dir, ".env.local");
    await writeFile(file, "KEEP=1\n");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "variables"], t.io)).toBe(1);
    expect(await readFile(file, "utf8")).toBe("KEEP=1\n");
    expect(t.err.join("\n")).toContain("--force");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "variables", "--force"], t.io)).toBe(0);
    expect(await readFile(file, "utf8")).toContain("SITE_URL=");
  });

  it("refuses a path that git tracks unless --force", async () => {
    const t = await setup();
    execFileSync("git", ["init", "-q"], { cwd: t.dir });
    const file = join(t.dir, "tracked.env");
    await writeFile(file, "OLD=1\n");
    execFileSync("git", ["add", "tracked.env"], { cwd: t.dir });
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "variables"], t.io)).toBe(1);
    t.err.length = 0;
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "variables", "--force"], t.io)).toBe(0);
    expect(t.err.join("\n")).toContain("Git tracks");
  });

  it("tracked guard also fires when the file does not exist on disk", async () => {
    const t = await setup();
    execFileSync("git", ["init", "-q"], { cwd: t.dir });
    const file = join(t.dir, "gone.env");
    await writeFile(file, "x=1\n");
    execFileSync("git", ["add", "gone.env"], { cwd: t.dir });
    execFileSync("rm", [file]);
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "variables"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("Git tracks");
  });

  it("rejects an unknown format", async () => {
    const t = await setup();
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--format", "yaml"], t.io)).toBe(2);
    expect(t.err.join("\n")).toMatch(/format/);
  });

  it("is the default: no format/include/force flag still runs the content export (the item's documented command)", async () => {
    const t = await setup();
    const file = join(t.dir, ".env.local");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--stage", "dev", "--out", file], t.io)).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("SITE_URL=http://localhost:3000");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(t.out.join("\n")).not.toContain("localhost:3000");
  });

  it("never prints values to stdout, not even when stdout is not a terminal", async () => {
    const t = await setup();
    const file = join(t.dir, ".env.local");
    await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--include", "all"], t.io);
    const written = await readFile(file, "utf8");
    const secret = /\nAPI_KEY=([0-9a-f]{32})\n/.exec(written)![1]!;
    expect([...t.out, ...t.err].join("\n")).not.toContain(secret);
  });

  it("--force narrows an existing broad-mode file to 600", async () => {
    if (process.platform === "win32") return;
    const t = await setup();
    const file = join(t.dir, ".env.local");
    await writeFile(file, "OLD=1\n");
    await chmod(file, 0o644);
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--out", file, "--force"], t.io)).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("--template still selects the template mode", async () => {
    const t = await setup();
    const file = join(t.dir, "tpl.env");
    expect(await main(["env", "export", "--config", t.config, "--repo", "acme-app", "--template", "t", "--out", file], t.io)).toBe(0);
    expect(await readFile(file, "utf8")).toMatch(/API_KEY=/);
  });
});
