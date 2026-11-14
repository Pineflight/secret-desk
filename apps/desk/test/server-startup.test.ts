import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveCheckScheduler, SignInScheduler } from "@secret-desk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirOf = () => mkdtemp(join(tmpdir(), "sd-startup-"));

async function configIn(dir: string): Promise<string> {
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  const file = join(dir, "secret-desk.config.yaml");
  await writeFile(file, `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(dir)}]\n`);
  return file;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as { __secretDesk?: unknown }).__secretDesk;
});

describe("getDesk", () => {
  it("finds the configuration two folders above the working directory and starts without a launch secret when switched off", async () => {
    const dir = await dirOf();
    await configIn(dir);
    vi.spyOn(process, "cwd").mockReturnValue(join(dir, "apps", "desk"));
    vi.stubEnv("SECRET_DESK_CONFIG", undefined);
    vi.stubEnv("SECRET_DESK_DEMO", "");
    vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", "");
    vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "1");
    vi.stubEnv("HOME", dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { getDesk } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.demo).toBe(false);
    expect(desk.session.launchSecret).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(desk.hosts.has("127.0.0.1:4747")).toBe(true);
    expect(await getDesk()).toBe(desk);
  });

  it("ignores a launch secret file while the launch secret is switched off", async () => {
    const dir = await dirOf();
    vi.stubEnv("SECRET_DESK_CONFIG", await configIn(dir));
    vi.stubEnv("SECRET_DESK_DEMO", "");
    vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", join(dir, "launch-secret"));
    vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "1");
    vi.stubEnv("HOME", dir);
    const { getDesk } = await import("../src/server/desk.js");
    expect((await getDesk()).session.launchSecret).toBeNull();
  });

  it("runs the demo with a simulated GitHub, its own agent token and a periodic sweep that survives errors", async () => {
    const dir = await dirOf();
    vi.stubEnv("SECRET_DESK_CONFIG", await configIn(dir));
    vi.stubEnv("SECRET_DESK_DEMO", "1");
    vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", "");
    vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "");
    vi.stubEnv("HOME", dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { getDesk, demoRuntimeOptions } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.demo).toBe(true);
    // The demo never opens the real vault file or the key store of the machine, although the configuration has the vault on (the default).
    expect(desk.rt.connections.vault).toBeUndefined();
    expect(desk.rt.config.vault.enabled).toBe(true);
    expect(demoRuntimeOptions(fetch)).toMatchObject({ vault: null, watchInventory: true });
    expect(desk.rt.config.policy.envRoots).toEqual([join(tmpdir(), "secret-desk-demo")]);
    expect((await readFile(join(tmpdir(), "secret-desk-demo", "agent-token"), "utf8")).trim()).toBe(desk.agentToken);
    const sweep = vi.spyOn(desk.rt.issuances, "sweep").mockRejectedValue(new Error("sweep failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("starts the sign-in checks and the weekly live check in the background, and neither in the demo", async () => {
    const signIn = vi.spyOn(SignInScheduler.prototype, "start");
    const liveCheck = vi.spyOn(LiveCheckScheduler.prototype, "start");
    const stubs = async (demo: string) => {
      const dir = await dirOf();
      vi.stubEnv("SECRET_DESK_CONFIG", await configIn(dir));
      vi.stubEnv("SECRET_DESK_DEMO", demo);
      vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", "");
      vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "1");
      vi.stubEnv("HOME", dir);
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await stubs("");
    const { getDesk } = await import("../src/server/desk.js");
    await getDesk();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(liveCheck).toHaveBeenCalledTimes(1);
    delete (globalThis as { __secretDesk?: unknown }).__secretDesk;
    await stubs("1");
    await getDesk();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(liveCheck).toHaveBeenCalledTimes(1);
  });
});
