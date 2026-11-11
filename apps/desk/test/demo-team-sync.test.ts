import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTeamBundle, parseTeamBundle, readTeamSyncState } from "@secret-desk/core";
import { createRuntime } from "@secret-desk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_LAST_SYNCED_SHA, createDemoFetch, deriveDemoTeamFile, seedDemoTeamSync } from "../src/server/demo.js";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";
import type { PushPlan, SyncCheck, SyncStatus } from "../src/lib/team-sync.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/demo", import.meta.url));
const HOST = "127.0.0.1:4747";
const BASE = `http://${HOST}`;
const DEMO_TOKEN = "demo";

/** The demo as `pnpm demo --team` starts it: a copy of the example folder, the simulated GitHub, the same wiring as desk.ts. */
async function startDemo(configName: string, options: { seed?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-demo-team-"));
  await cp(EXAMPLES, dir, { recursive: true });
  const holder: { rt?: Awaited<ReturnType<typeof createRuntime>> } = {};
  const fetch = await createDemoFetch({ teamFile: () => deriveDemoTeamFile(exportTeamBundle(holder.rt!.inventory.data)) });
  const rt = await createRuntime(join(dir, configName), { vault: null, env: { GITHUB_DEMO_TOKEN: DEMO_TOKEN } as unknown as NodeJS.ProcessEnv, fetch, bundledRecipes: null });
  holder.rt = rt;
  vi.stubEnv("SECRET_DESK_DEMO_SEED", "1");
  if (options.seed !== false) await seedDemoTeamSync(rt);
  const deps: RouterDeps = { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await route(new Request(`${BASE}/api/ui/${path}`, { method, headers: { host: HOST, origin: BASE, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), deps);
    const text = await res.text();
    seen.push(text);
    return { status: res.status, json: JSON.parse(text) as Record<string, any> };
  };
  const seen: string[] = [];
  return { dir, rt, deps, call, seen };
}

const noTokenOrValue = (texts: string[]) => {
  const all = texts.join("\n");
  expect(all).not.toContain(`"${DEMO_TOKEN}"`);
  expect(all).not.toMatch(/Bearer|ghp_|github_pat_|-----BEGIN/);
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as { __secretDesk?: unknown }).__secretDesk;
});

describe("demo team file", () => {
  it("differs from the local file by one changed description and one added secret, and stays a valid team file", async () => {
    const { rt } = await startDemo("secret-desk.config.yaml");
    const local = exportTeamBundle(rt.inventory.data);
    const remote = deriveDemoTeamFile(local);
    const parsed = parseTeamBundle(remote);
    expect(parsed.secrets).toHaveLength(rt.inventory.data.secrets.length + 1);
    expect(parsed.secrets[0]!.description).toContain("Reviewed by the platform team.");
    expect(parsed.secrets.at(-1)).toMatchObject({ id: "mailer-key-acme-web-staging" });
    expect(remote).not.toMatch(/ghp_|github_pat_|sk_live|-----BEGIN/);
    // Deriving twice does not add the secret twice, and an empty team file only gains the added secret.
    expect(parseTeamBundle(deriveDemoTeamFile(remote)).secrets.filter((s) => s.id === "mailer-key-acme-web-staging")).toHaveLength(1);
    expect(parseTeamBundle(deriveDemoTeamFile("version: 1\nsecrets: []\nvariables: []\n")).secrets.map((s) => s.id)).toEqual(["mailer-key-acme-web-staging"]);
    // A first entry without a description falls back to its name.
    const bare = exportTeamBundle({ ...rt.inventory.data, secrets: rt.inventory.data.secrets.map(({ description: _d, ...s }) => s) as never });
    expect(parseTeamBundle(deriveDemoTeamFile(bare)).secrets[0]!.description).toMatch(/^[A-Z_]+ Reviewed/);
  });
});

describe("demo with team sync configured: check, apply, push plan, push", () => {
  it("shows the setting, checks to a non-empty difference and applies it", async () => {
    const { rt, call, seen, dir } = await startDemo("secret-desk.team.config.yaml");
    const status = (await call("GET", "team-sync/status")).json as unknown as SyncStatus;
    expect(status).toMatchObject({ configured: true, connected: true, tokenSource: "github-pat", repo: "acme/team-config", branch: "main", path: "secret-desk.team.yaml", mode: "pull-push", pushStrategy: "pull-request", pushBranch: "secret-desk/team-sync", setupNeeded: false });
    expect(status.lastSyncAt).not.toBeNull();

    const check = (await call("POST", "team-sync/check", {})).json as unknown as SyncCheck;
    expect(check.state).toBe("remote-changed");
    expect(check.remoteSha).toMatch(/^[0-9a-f]{40}$/);
    expect(check.remoteSha).not.toBe(DEMO_LAST_SYNCED_SHA);
    expect(check.diff!.empty).toBe(false);
    expect(check.diff!.sections.secrets.added).toEqual(["mailer-key-acme-web-staging"]);
    expect(check.diff!.sections.secrets.changed).toHaveLength(1);

    const before = rt.inventory.data.secrets.length;
    const applied = await call("POST", "team-sync/apply", { expectSha: check.remoteSha, resolution: "merge" });
    expect(applied.status).toBe(200);
    expect(applied.json["added"]).toEqual(["mailer-key-acme-web-staging"]);
    expect(rt.inventory.data.secrets).toHaveLength(before + 1);
    // The state file sits next to the (copied) configuration, never in the repository's example folder.
    expect((await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"))).remoteSha).toBe(check.remoteSha);
    noTokenOrValue(seen);
  });

  it("loads a push plan and creates a pull request with a made-up URL, then updates the same one", async () => {
    const { call, seen, rt, dir } = await startDemo("secret-desk.team.config.yaml");
    const check = (await call("POST", "team-sync/check", {})).json as unknown as SyncCheck;
    await call("POST", "team-sync/apply", { expectSha: check.remoteSha, resolution: "merge" });
    const plan = (await call("POST", "team-sync/push-plan", {})).json as unknown as PushPlan;
    expect(plan).toMatchObject({ strategy: "pull-request", targetBranch: "secret-desk/team-sync" });
    expect(plan.diff.empty).toBe(false);
    expect(plan.diff.sections.secrets.changed).toHaveLength(1);
    expect(plan.remoteSha).toBe(check.remoteSha);
    expect(plan.localHash).toMatch(/^[0-9a-f]{64}$/);

    const pushed = await call("POST", "team-sync/push", { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha });
    expect(pushed.status).toBe(200);
    expect(pushed.json).toMatchObject({ pushed: true, strategy: "pull-request", pullRequest: { number: 12, url: "https://github.com/acme/team-config/pull/12" } });
    const status = (await call("GET", "team-sync/status")).json as unknown as SyncStatus;
    expect(status.pendingPullUrl).toBe("https://github.com/acme/team-config/pull/12");
    expect(status.lastPushAt).not.toBeNull();

    // The branch exists now in the simulated repository, and a second push (after the debounce) updates the same pull request.
    const branches = (await call("GET", "team-sync/discovery/branches?repo=acme/team-config")).json as unknown as { branches: string[] };
    expect(branches.branches).toEqual(["main", "secret-desk/team-sync"]);
    const state = await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"));
    await writeFile(join(dir, ".secret-desk-team-sync.json"), JSON.stringify({ ...state, lastPushAt: new Date(Date.now() - 60_000).toISOString() }));
    rt.inventory.data.secrets[1]!.description = "Changed again in the demo.";
    const plan2 = (await call("POST", "team-sync/push-plan", {})).json as unknown as PushPlan;
    const again = await call("POST", "team-sync/push", { confirm: true, expectLocalHash: plan2.localHash, expectRemoteSha: plan2.remoteSha });
    expect(again.json["pullRequest"]).toMatchObject({ url: "https://github.com/acme/team-config/pull/12" });
    noTokenOrValue(seen);
  });

  it("does not push without confirmation", async () => {
    const { call, seen } = await startDemo("secret-desk.team.config.yaml");
    const res = await call("POST", "team-sync/push", { confirm: false, expectLocalHash: "x", expectRemoteSha: null });
    expect(res.status).toBeGreaterThanOrEqual(400);
    noTokenOrValue(seen);
  });

  it("writes no sync state file without the throw-away copy marker, and does with it", async () => {
    const { rt, dir } = await startDemo("secret-desk.team.config.yaml", { seed: false });
    const file = join(dir, ".secret-desk-team-sync.json");
    vi.stubEnv("SECRET_DESK_DEMO_SEED", "");
    await seedDemoTeamSync(rt);
    await expect(readFile(file, "utf8")).rejects.toThrow();
    vi.stubEnv("SECRET_DESK_DEMO_SEED", "1");
    await seedDemoTeamSync(rt);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ remoteSha: DEMO_LAST_SYNCED_SHA });
  });

  it("starts with a conflict when the demo state was not seeded, and keeps an existing state when seeding", async () => {
    const { call, rt, dir } = await startDemo("secret-desk.team.config.yaml", { seed: false });
    expect(((await call("POST", "team-sync/check", {})).json as unknown as SyncCheck).state).toBe("conflict");
    const file = join(dir, ".secret-desk-team-sync.json");
    await seedDemoTeamSync(rt);
    const written = await readFile(file, "utf8");
    expect(JSON.parse(written)).toMatchObject({ remoteSha: DEMO_LAST_SYNCED_SHA, setupDismissed: true });
    await seedDemoTeamSync(rt, new Date(0));
    expect(await readFile(file, "utf8")).toBe(written);
  });
});

describe("demo setup: choose the simulated repository from the lists", () => {
  it("lists repositories, branches, files and the modes of acme/team-config without any token field", async () => {
    const { call, seen } = await startDemo("secret-desk.config.yaml");
    const repos = (await call("GET", "team-sync/discovery/repos")).json as { problem: unknown; preselected: string; repos: { fullName: string; selectable: boolean; reason: string | null }[] };
    expect(repos.problem).toBeNull();
    expect(repos.preselected).toBe("acme/team-config");
    expect(repos.repos.find((r) => r.fullName === "acme/open-samples")).toMatchObject({ selectable: false, reason: "public" });
    const branches = (await call("GET", "team-sync/discovery/branches?repo=acme/team-config")).json;
    expect(branches).toMatchObject({ problem: null, branches: ["main"], defaultBranch: "main" });
    const files = (await call("GET", "team-sync/discovery/files?repo=acme/team-config&branch=main")).json;
    expect(files).toMatchObject({ problem: null, files: ["secret-desk.team.yaml"], preselected: "secret-desk.team.yaml", canCreate: false });
    const other = (await call("GET", "team-sync/discovery/files?repo=acme/acme-app&branch=main")).json;
    expect(other).toMatchObject({ problem: null, files: [], canCreate: true });
    for (const [mode, strategy] of [["pull", "pull-request"], ["pull-push", "pull-request"], ["pull-push", "direct"]]) {
      const access = (await call("GET", `team-sync/discovery/access?repo=acme/team-config&branch=main&path=secret-desk.team.yaml&mode=${mode}&strategy=${strategy}`)).json as { ok: boolean; checks: { id: string; status: string }[] };
      expect(access.ok, `${mode} ${strategy}`).toBe(true);
      expect(access.checks.find((c) => c.id === "push")?.status ?? "pass").toBe("pass");
    }
    noTokenOrValue(seen);
  });

  it("saves the chosen setting and previews it", async () => {
    const { call, seen, dir } = await startDemo("secret-desk.config.yaml");
    const saved = await call("PUT", "team-sync/config", { teamSync: { repo: "acme/team-config", branch: "main", path: "secret-desk.team.yaml", mode: "pull" } });
    expect(saved.status).toBe(200);
    expect(saved.json["status"]).toMatchObject({ configured: true, tokenSource: "github-pat" });
    expect(await readFile(join(dir, "secret-desk.config.yaml"), "utf8")).toContain("acme/team-config");
    const check = (await call("POST", "team-sync/check", {})).json as unknown as SyncCheck;
    expect(check.state).toBe("conflict");
    expect(check.diff!.empty).toBe(false);
    // The example folder in the repository is never written (the copy is).
    expect((await readdir(EXAMPLES)).sort()).toEqual(["inventory.yaml", "secret-desk.config.yaml", "secret-desk.team.config.yaml"]);
    noTokenOrValue(seen);
  });
});

describe("demo code is reachable only with SECRET_DESK_DEMO=1", () => {
  const prepare = async (demo: string) => {
    const dir = await mkdtemp(join(tmpdir(), "sd-demo-gate-"));
    await cp(EXAMPLES, dir, { recursive: true });
    vi.stubEnv("SECRET_DESK_CONFIG", join(dir, "secret-desk.team.config.yaml"));
    vi.stubEnv("SECRET_DESK_DEMO", demo);
    vi.stubEnv("SECRET_DESK_LAUNCH_SECRET_FILE", "");
    vi.stubEnv("SECRET_DESK_NO_LAUNCH_SECRET", "1");
    vi.stubEnv("GITHUB_DEMO_TOKEN", "");
    vi.stubEnv("HOME", dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    return dir;
  };

  it("seeds the demo team sync state and serves the simulated team repository when the demo is on", async () => {
    const dir = await prepare("1");
    vi.stubEnv("SECRET_DESK_DEMO_SEED", "1");
    const { getDesk } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.demo).toBe(true);
    expect((await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"))).remoteSha).not.toBeNull();
    const res = await desk.rt.fetch("https://api.github.com/repos/acme/team-config/contents/secret-desk.team.yaml?ref=main");
    expect(res.status).toBe(200);
  });

  it("does not seed a state next to a user-supplied configuration (no throw-away marker), though the demo is on", async () => {
    const dir = await prepare("1");
    vi.stubEnv("SECRET_DESK_DEMO_SEED", "");
    const { getDesk } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.demo).toBe(true);
    expect((await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"))).remoteSha).toBeNull();
  });

  it("never seeds a state and never answers from the simulation when the demo is off", async () => {
    const dir = await prepare("");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("no network in tests"));
    const { getDesk } = await import("../src/server/desk.js");
    const desk = await getDesk();
    expect(desk.demo).toBe(false);
    expect(await readdir(dir)).not.toContain(".secret-desk-team-sync.json");
    expect(desk.rt.fetch).not.toBe((await import("../src/server/demo.js")).createDemoFetch);
    await expect(desk.rt.fetch("https://api.github.com/repos/acme/team-config")).rejects.toThrow("no network in tests");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
