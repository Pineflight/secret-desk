import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The runtime is the real one; only the home folder its host reports is switched, so the wiring in desk.ts is what is tested.
const home = vi.hoisted(() => ({ missing: false }));
vi.mock("@secret-desk/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@secret-desk/runtime")>();
  return {
    ...actual,
    createLocalRuntime: async (...args: Parameters<typeof actual.createLocalRuntime>) => {
      const rt = await actual.createLocalRuntime(...args);
      if (home.missing) rt.host = { ...rt.host!, homeDir: () => undefined };
      return rt;
    },
  };
});

const dirOf = () => mkdtemp(join(tmpdir(), "sd-agent-home-"));

async function configIn(dir: string): Promise<string> {
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  const file = join(dir, "secret-desk.config.yaml");
  await writeFile(file, `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(dir)}]\n`);
  return file;
}

afterEach(() => {
  home.missing = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as { __secretDesk?: unknown }).__secretDesk;
});

async function prepare() {
  const dir = await dirOf();
  const work = await dirOf();
  vi.stubEnv("SECRET_DESK_CONFIG", await configIn(dir));
  vi.stubEnv("SECRET_DESK_DEMO", "");
  vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", "");
  vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "1");
  vi.stubEnv("HOME", dir);
  vi.spyOn(process, "cwd").mockReturnValue(work);
  return { dir, work };
}

describe("agent token location in getDesk", () => {
  it("with the home folder of the host the token file is ~/.secret-desk/agent-token, as before", async () => {
    const { dir } = await prepare();
    const { getDesk } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.agentToken).toBe((await readFile(join(dir, ".secret-desk", "agent-token"), "utf8")).trim());
  });

  it("with a host that reports no home folder, start-up fails closed and no token file is written anywhere", async () => {
    home.missing = true;
    const { dir, work } = await prepare();
    const { getDesk } = await import("../src/server/desk.js");
    await expect(getDesk()).rejects.toThrow(/home folder/);
    expect(await readdir(work)).toEqual([]);
    expect(await readdir(dir)).not.toContain(".secret-desk");
    expect(await readdir(dir)).not.toContain("agent-token");
  });
});
