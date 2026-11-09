import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A connect that never answers: the probe's own timeout has to end it, and a port that does not answer counts as free.
vi.mock("node:net", () => ({
  connect: () => ({
    setTimeout: (_ms: number, onTimeout: () => void) => queueMicrotask(onTimeout),
    once: () => undefined,
    destroy: () => undefined,
  }),
}));

const { main } = await import("../src/index.js");

describe("live-check --run port probe", () => {
  it("treats a port that does not answer in time as not in use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-cli-live-check-timeout-"));
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
    const config = join(dir, "secret-desk.config.yaml");
    await writeFile(config, `inventory: ./inventory.yaml\nvault: { enabled: false }\nlinksFile: ${join(dir, "data", "repo-links.json")}\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: SD_CLI_LC_PORT_GITHUB } }\nautomation:\n  enabled: false\n`);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["live-check", "--config", config, "--run"], { out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(err).toEqual([]);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^Live-Check in Ordnung/);
  });
});
