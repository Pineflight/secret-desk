import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalSession, loadOrCreateLaunchSecret } from "../src/server/security.js";

const dirOf = () => mkdtemp(join(tmpdir(), "sd-launch-"));

describe("launch secret file", () => {
  it("creates a 256-bit secret with mode 600 and reuses it", async () => {
    const file = join(await dirOf(), "nested", "launch-secret");
    const first = await loadOrCreateLaunchSecret(file);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateLaunchSecret(file)).toBe(first);
    expect((await readFile(file, "utf8")).trim()).toBe(first);
  });

  it("uses the content of an existing file", async () => {
    const file = join(await dirOf(), "launch-secret");
    await writeFile(file, `${"c".repeat(43)}\n`, { mode: 0o600 });
    expect(await loadOrCreateLaunchSecret(file)).toBe("c".repeat(43));
  });

  it("sets a too open file to 600 and warns without the secret", async () => {
    const file = join(await dirOf(), "launch-secret");
    await writeFile(file, `${"d".repeat(43)}\n`);
    await chmod(file, 0o644);
    const warnings: string[] = [];
    expect(await loadOrCreateLaunchSecret(file, "linux", (m) => warnings.push(m))).toBe("d".repeat(43));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("d".repeat(43));
  });

  it("replaces a too short file", async () => {
    const file = join(await dirOf(), "launch-secret");
    await writeFile(file, "short\n", { mode: 0o600 });
    const secret = await loadOrCreateLaunchSecret(file);
    expect(secret).not.toBe("short");
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("without the file option every session has a new secret (default unchanged)", () => {
    expect(new PortalSession({ env: {} }).launchSecret).not.toBe(new PortalSession({ env: {} }).launchSecret);
  });

  it("a session built from the file secret accepts exactly that secret", async () => {
    const file = join(await dirOf(), "launch-secret");
    const secret = await loadOrCreateLaunchSecret(file);
    const s = new PortalSession({ launchSecret: secret, env: {} });
    expect(s.launchUrl(4747)).toBe(`http://127.0.0.1:4747/?launch=${secret}`);
    expect(s.mayIssue(new Request("http://127.0.0.1:4747/api/session", { headers: { "x-secret-desk-launch": secret } }))).toBe(true);
    expect(s.mayIssue(new Request("http://127.0.0.1:4747/api/session", { headers: { "x-secret-desk-launch": "wrong" } }))).toBe(false);
  });
});

describe("startup (instrumentation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete (globalThis as { __secretDesk?: unknown }).__secretDesk;
  });

  it("prints exactly one launch line at startup and none in API responses", async () => {
    const dir = await dirOf();
    await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
    await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(dir)}]\n`);
    const secretFile = join(dir, "launch-secret");
    vi.stubEnv("SECRET_DESK_CONFIG", join(dir, "secret-desk.config.yaml"));
    vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", secretFile);
    vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "");
    vi.stubEnv("SECRET_DESK_DEMO", "");
    vi.stubEnv("HOME", dir);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { register } = await import("../src/instrumentation.js");
    const { getDesk } = await import("../src/server/desk.js");
    await register();
    await register();
    await getDesk();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("?launch="));
    expect(lines).toHaveLength(1);
    const secret = (await readFile(secretFile, "utf8")).trim();
    expect(lines[0]).toContain(secret);
    const desk = await getDesk();
    expect(desk.session.launchSecret).toBe(secret);
  });

  it("does nothing outside the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await import("../src/instrumentation.js");
    await register();
    expect((globalThis as { __secretDesk?: unknown }).__secretDesk).toBeUndefined();
  });
});
