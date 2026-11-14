import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { ensureConfigFile } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PolicyError,
  SYSTEM_ROUTINES,
  authorize,
  authorizeSystem,
  confirmIssuance,
  requestIssuance,
  submitManualValue,
  type Actor,
  type AuthorizationRequest,
  type Authorize,
  type AuthorizeFault,
  type SystemRoutine,
} from "../src/agent-api.js";
import { LiveCheckScheduler, runLiveCheck } from "../src/live-check.js";
import { createLocalRuntime, issuanceDeps, type Runtime } from "../src/runtime.js";
import { envHost } from "./helpers/env-host.js";
import { SignInScheduler } from "../src/sign-in-schedule.js";
import { startupTeamSync } from "../src/team-sync.js";
import { newWorld, setup as liveCheckSetup } from "./helpers/live-check-world.js";

const DETAIL = "hook-internal-detail-for-test";
const GENERIC = "Die Berechtigungspruefung hat die Aktion nicht zugelassen.";
const human: Actor = { kind: "human", name: "alice" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every way a hook can refuse. `fault` is what the fault callback is told (nothing for a deliberate PolicyError). */
interface Refusal {
  name: string;
  fault: AuthorizeFault["reason"] | null;
  install: (rt: Runtime) => void;
}
const REFUSALS: Refusal[] = [
  { name: "a throw", fault: "threw", install: (rt) => void (rt.authorize = () => { throw new Error(DETAIL); }) },
  { name: "a return value", fault: "returned-value", install: (rt) => void (rt.authorize = (() => false) as unknown as Authorize) },
  {
    name: "a timeout",
    fault: "timeout",
    install: (rt) => {
      rt.authorize = () => new Promise<void>(() => undefined);
      rt.authorizeTimeoutMs = 20;
    },
  },
  { name: "a hook that is not a function", fault: "not-a-function", install: (rt) => void (rt.authorize = "nope" as unknown as Authorize) },
  { name: "a deliberate PolicyError", fault: null, install: (rt) => void (rt.authorize = () => { throw new PolicyError(DETAIL); }) },
];
const FUNCTION_REFUSALS = REFUSALS.filter((r) => r.fault !== "not-a-function");

/** Installs a fault callback and returns what it collects. */
function collectFaults(rt: Runtime): AuthorizeFault[] {
  const faults: AuthorizeFault[] = [];
  rt.onAuthorizeFault = (f) => void faults.push(f);
  return faults;
}

/** The faults a refusal must have produced, and nothing of the hook internals in them. */
function expectFaults(faults: AuthorizeFault[], refusal: Refusal, action: string, count: number, routine: SystemRoutine): void {
  expect(faults).toEqual(Array.from({ length: refusal.fault === null ? 0 : count }, () => ({ action, reason: refusal.fault, routine, ...(refusal.fault === "threw" ? { errorName: "Error" } : {}) })));
  expect(JSON.stringify(faults)).not.toContain(DETAIL);
}

/** A hook that records and allows. */
function allowing(rt: Runtime): AuthorizationRequest[] {
  const seen: AuthorizationRequest[] = [];
  rt.authorize = (request) => void seen.push(request);
  return seen;
}

describe("the system actor", () => {
  it("has a closed list of fixed routine names", () => {
    expect([...SYSTEM_ROUTINES]).toEqual(["team-sync-startup", "sign-in-scheduler", "live-check-scheduler"]);
  });

  it("authorizeSystem needs no hook, and the hook sees the system actor with a copy of the request", async () => {
    const { rt } = await liveCheckSetup();
    expect(await authorizeSystem(rt, "live-check-scheduler", "automation.run")).toBe(true);
    const seen = allowing(rt);
    rt.authorize = (request) => {
      seen.push(request);
      request.actor.name = "mallory" as never;
    };
    expect(await authorizeSystem(rt, "sign-in-scheduler", "automation.run", { connectionId: "vendor-b" })).toBe(true);
    expect(await authorizeSystem(rt, "sign-in-scheduler", "automation.run", { connectionId: "vendor-b" })).toBe(true);
    expect(seen).toEqual([
      { actor: { kind: "system", name: "mallory" }, action: "automation.run", subject: { connectionId: "vendor-b" } },
      { actor: { kind: "system", name: "mallory" }, action: "automation.run", subject: { connectionId: "vendor-b" } },
    ]);
  });

  it("authorizeSystem answers false for every refusal and never throws", async () => {
    for (const refusal of REFUSALS) {
      const { rt } = await liveCheckSetup();
      refusal.install(rt);
      const faults = collectFaults(rt);
      expect(await authorizeSystem(rt, "live-check-scheduler", "automation.run")).toBe(false);
      expectFaults(faults, refusal, "automation.run", 1, "live-check-scheduler");
    }
  });
});

describe("a forged actor never reaches the hook through the actor path", () => {
  it("authorize refuses an actor of any other kind, system included, without asking the hook", async () => {
    const { rt } = await liveCheckSetup();
    const seen = allowing(rt);
    const faults = collectFaults(rt);
    for (const actor of [{ kind: "system", name: "live-check-scheduler" }, { kind: "root", name: "x" }, { name: "no-kind" }]) {
      const error = await authorize(rt, { actor: actor as unknown as Actor, action: "inventory.edit" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).message).toBe(GENERIC);
    }
    expect(seen).toEqual([]);
    expect(faults).toEqual(Array.from({ length: 3 }, () => ({ action: "inventory.edit", reason: "invalid-actor" })));
    // A human and an agent still pass.
    await authorize(rt, { actor: human, action: "inventory.edit" });
    await authorize(rt, { actor: { kind: "agent", name: "claude" }, action: "inventory.edit" });
    expect(seen.map((r) => r.actor.kind)).toEqual(["human", "agent"]);
  });

  it("without a hook the helper still returns at once, as before", async () => {
    const { rt } = await liveCheckSetup();
    await expect(authorize(rt, { actor: { kind: "system", name: "live-check-scheduler" } as unknown as Actor, action: "inventory.edit" })).resolves.toBeUndefined();
  });

  it("the policy functions do not take a forged system actor for a human", async () => {
    const world = await sweepWorld();
    const forged = { kind: "system", name: "live-check-scheduler" } as unknown as Actor;
    const seen = allowing(world.rt);
    await expect(confirmIssuance(world.rt, forged, "x", { ticks: [] })).rejects.toThrow(/darf nur ein Mensch/);
    await expect(submitManualValue(world.rt, forged, "hmac-acme-app", "made-up-value")).rejects.toThrow(/darf nur ein Mensch/);
    await expect(requestIssuance(world.rt, forged, "hmac-acme-app")).rejects.toThrow(GENERIC);
    expect(seen).toEqual([]);
    expect(world.rt.issuances.list()).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ expiry sweep

const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    product: acme-app
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
`;

async function sweepWorld() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const calls: string[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace("https://api.github.com", "");
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if ((init?.method ?? "GET") === "GET" && u.includes("/secrets")) return new Response(JSON.stringify({ secrets: [{ name: "ARTIFACT_HMAC_SECRET", created_at: "c", updated_at: new Date().toISOString() }] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-unattended-sweep-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_x" }, fetch: fetchMock, bundledRecipes: null });
  return { rt, calls };
}

/** One review that has expired already. */
async function expiredReview(rt: Runtime): Promise<string> {
  const r = await requestIssuance(rt, human, "hmac-acme-app");
  if (r.status !== "awaiting-review") throw new Error("expected a review");
  (rt.issuances.get(r.issuance.id) as { expiresAt: string }).expiresAt = new Date(Date.now() - 1000).toISOString();
  return r.issuance.id;
}

describe("the expiry sweep is clean-up and no hook can refuse it", () => {
  /** An expired review whose new value exists at the provider, with a provider whose revoke is counted. */
  async function expiredWithRevoke(rt: Runtime) {
    const id = await expiredReview(rt);
    const pending = rt.issuances.get(id)!;
    pending.report.externalId = "external-new-1";
    const revoke = vi.fn(async () => undefined);
    (rt.providers.get("random-hex") as { revoke?: unknown }).revoke = revoke;
    return { id, pending, revoke };
  }

  const never = (): Promise<void> => new Promise<void>(() => undefined);
  const hooks: [string, Authorize][] = [
    ["a hook that refuses everything", () => { throw new PolicyError(DETAIL); }],
    ["a hook that returns a value", (() => false) as unknown as Authorize],
    ["a hook that never settles", never],
  ];

  for (const [name, hook] of hooks) {
    it(`${name}: an expired review is still discarded, revoked at the provider, and the hook is not asked`, async () => {
      const { rt } = await sweepWorld();
      const { id, pending, revoke } = await expiredWithRevoke(rt);
      const asked = vi.fn(hook);
      rt.authorize = asked;
      const faults = collectFaults(rt);
      expect(await rt.issuances.sweep(issuanceDeps(rt))).toEqual([id]);
      expect(rt.issuances.get(id)).toBeUndefined();
      expect(rt.issuances.list()).toEqual([]);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(pending.report.confirmation?.note).toContain("Zeit abgelaufen");
      expect(asked).not.toHaveBeenCalled();
      expect(faults).toEqual([]);
    });
  }

  it("the sweep that a new issuance and a confirm start first discards the expired review whatever the hook says, without asking for it", async () => {
    const { rt } = await sweepWorld();
    const { id, revoke } = await expiredWithRevoke(rt);
    const seen: AuthorizationRequest[] = [];
    rt.authorize = (request) => void seen.push(request);
    const fresh = await requestIssuance(rt, human, "hmac-acme-app");
    expect(fresh.status).toBe("awaiting-review");
    expect(rt.issuances.get(id)).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
    const second = await expiredWithRevoke(rt);
    await expect(confirmIssuance(rt, human, "unknown-review", { ticks: [] })).rejects.toThrow(/nicht gefunden/);
    expect(rt.issuances.get(second.id)).toBeUndefined();
    expect(second.revoke).toHaveBeenCalledTimes(1);
    expect(seen.map((r) => [r.actor.kind, r.action])).toEqual([["human", "issuance.prepare"], ["human", "issuance.prepare"]]);
  });
});

// ------------------------------------------------------------------------------------------------ start-up team sync

const TOKEN = "made-up-team-token";
const REMOTE = `version: 1
secrets:
  - id: hmac-app
    name: APP_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: app, scope: repository }
  - id: api-key
    name: API_KEY
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: app, scope: repository }
variables: []
`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

async function startupWorld(options: { pullOnStart?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-unattended-start-"));
  const path = join(dir, "c.yaml");
  await ensureConfigFile(path);
  if (options.pullOnStart) await writeFile(path, `${await readFile(path, "utf8")}\nteamSync:\n  repo: acme/team-config\n  path: team/desk.yaml\n  branch: main\n  pullOnStart: true\n`);
  const calls: string[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/repos/acme/team-config") return json({ private: true, permissions: { push: true } });
    if (url.pathname === "/repos/acme/team-config/contents/team/desk.yaml") return json({ type: "file", sha: "sha1", content: Buffer.from(REMOTE).toString("base64"), encoding: "base64" });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  const env = { SECRET_DESK_TEAM_REPO: "acme/team-config", SECRET_DESK_TEAM_PATH: "team/desk.yaml", SECRET_DESK_TEAM_BRANCH: "main", SECRET_DESK_TEAM_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv;
  const rt = await createLocalRuntime(path, { vault: null, env, fetch: fetchMock, bundledRecipes: null });
  const files = async () => ({ config: await readFile(path, "utf8"), inventory: JSON.stringify(rt.inventory.data) });
  return { rt, env, calls, files };
}

const SYSTEM = { kind: "system", name: "team-sync-startup" };

describe("start-up team sync (team-sync-startup)", () => {
  it("runs without a hook, as before", async () => {
    const { rt, env } = await startupWorld();
    expect("authorize" in rt).toBe(false);
    await startupTeamSync(rt, envHost(env));
    expect(rt.config.teamSync).toMatchObject({ repo: "acme/team-config" });
    expect(rt.inventory.data.secrets).toHaveLength(2);
  });

  it("asks before it writes the configuration and before it applies the new entries, as the system actor", async () => {
    const { rt, env } = await startupWorld();
    const seen = allowing(rt);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await startupTeamSync(rt, envHost(env));
    expect(seen).toEqual([
      { actor: SYSTEM, action: "team.sync.configure" },
      { actor: SYSTEM, action: "team.sync.apply", subject: { mode: "merge" } },
    ]);
    expect(rt.inventory.data.secrets).toHaveLength(2);
  });

  for (const refusal of REFUSALS) {
    it(`${refusal.name} at the configuration step: nothing is written, nothing is fetched, and a later start-up asks again`, async () => {
      const { rt, env, calls, files } = await startupWorld();
      const before = await files();
      refusal.install(rt);
      const faults = collectFaults(rt);
      await startupTeamSync(rt, envHost(env));
      expect(await files()).toEqual(before);
      expect(rt.config.teamSync).toBeUndefined();
      expect(calls).toEqual([]);
      expectFaults(faults, refusal, "team.sync.configure", 1, "team-sync-startup");
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      allowing(rt);
      await startupTeamSync(rt, envHost(env));
      expect(rt.inventory.data.secrets).toHaveLength(2);
    });
  }

  for (const refusal of FUNCTION_REFUSALS) {
    it(`${refusal.name} at the apply step: the configuration IS written, inventory and team state stay as they were, and a second start asks and applies nothing`, async () => {
      const { rt, env, files } = await startupWorld();
      refusal.install(rt);
      const refusing = rt.authorize as Authorize;
      const seen: AuthorizationRequest[] = [];
      rt.authorize = (request) => {
        seen.push(request);
        return request.action === "team.sync.apply" ? refusing(request) : undefined;
      };
      const faults = collectFaults(rt);
      const before = await files();
      await startupTeamSync(rt, envHost(env));
      expect(seen.map((r) => r.action)).toEqual(["team.sync.configure", "team.sync.apply"]);
      expect(rt.inventory.data.secrets).toHaveLength(0);
      expect((await files()).inventory).toBe(before.inventory);
      expect(rt.teamSyncMemo.lastError).toBeNull();
      expectFaults(faults, refusal, "team.sync.apply", 1, "team-sync-startup");
      // The allowed first step wrote the configuration.
      expect(rt.config.teamSync).toMatchObject({ repo: "acme/team-config" });
      const after = await files();
      expect(after.config).not.toBe(before.config);
      expect(after.config).toContain("acme/team-config");
      // A second start does not enter the set-up branch again: nothing is asked and nothing is applied.
      const inventoryBefore = after.inventory;
      seen.length = 0;
      await startupTeamSync(rt, envHost(env));
      expect(seen).toEqual([]);
      expect(rt.inventory.data.secrets).toHaveLength(0);
      expect((await files()).inventory).toBe(inventoryBefore);
    });
  }

  it("the read-only check of the repository (pullOnStart) is not asked", async () => {
    const { rt, env, calls } = await startupWorld({ pullOnStart: true });
    const seen = allowing(rt);
    await startupTeamSync(rt, envHost(env));
    expect(seen).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(rt.inventory.data.secrets).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ scheduled sign-in checks

interface World {
  opened: string[];
}

async function signInWorld() {
  const w: World = { opened: [] };
  const dir = await mkdtemp(join(tmpdir(), "sd-unattended-signin-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nautomation:\n  signInCheckHours: 6\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: "ghp_x" } as unknown as NodeJS.ProcessEnv,
    automationDriver: () =>
      new FakeDriver({
        pollMs: 2,
        on: (e, drv) => {
          if (e.action !== "goto") return;
          const host = new URL(e.key).hostname;
          w.opened.push(host);
          drv.url = `https://${host}/login`;
        },
      }),
    persistSignIn: false,
  });
  const lines: string[] = [];
  const scheduler = new SignInScheduler(rt, { log: (l) => void lines.push(l), timeoutSeconds: 0.05, retryMinutes: 0 });
  return { rt, w, scheduler, lines };
}

describe("scheduled sign-in checks (sign-in-scheduler)", () => {
  it("run without a hook, as before", async () => {
    const { rt, w, scheduler } = await signInWorld();
    expect("authorize" in rt).toBe(false);
    const tick = await scheduler.tick();
    expect(tick.checked.length).toBeGreaterThan(0);
    expect(w.opened.length).toBeGreaterThan(0);
  });

  it("ask once per host, as automation.run for the system actor with the recipe id, and then run the check", async () => {
    const { rt, w, scheduler } = await signInWorld();
    const seen = allowing(rt);
    const tick = await scheduler.tick();
    expect(seen.length).toBe(tick.checked.length);
    expect(seen.every((r) => r.actor.kind === "system" && r.actor.name === "sign-in-scheduler" && r.action === "automation.run" && typeof r.subject?.connectionId === "string" && Object.keys(r.subject).length === 1)).toBe(true);
    expect(w.opened.length).toBe(tick.checked.length);
  });

  for (const refusal of REFUSALS) {
    it(`${refusal.name}: no browser is opened, nothing is remembered, the refusal is logged, and the next tick asks again`, async () => {
      const { rt, w, scheduler, lines } = await signInWorld();
      refusal.install(rt);
      const faults = collectFaults(rt);
      const tick = await scheduler.tick();
      expect(tick).toEqual({ skipped: null, checked: [] });
      expect(w.opened).toEqual([]);
      expect(rt.automation.signInChecks()).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.endsWith("not allowed by the authorisation hook"))).toBe(true);
      expect(lines.join("\n")).not.toContain(DETAIL);
      if (refusal.fault !== null) expect(faults.length).toBe(lines.length);
      expect(faults.every((f) => f.action === "automation.run" && f.reason === refusal.fault && f.routine === "sign-in-scheduler")).toBe(true);
      expect(JSON.stringify(faults)).not.toContain(DETAIL);
      allowing(rt);
      expect((await scheduler.tick()).checked.length).toBeGreaterThan(0);
    });
  }

  it("a refused host is not asked again before the retry time and is asked again after it", async () => {
    const { rt, w, lines } = await signInWorld();
    const seen: AuthorizationRequest[] = [];
    rt.authorize = (request) => {
      seen.push(request);
      throw new PolicyError(DETAIL);
    };
    const scheduler = new SignInScheduler(rt, { log: (l) => void lines.push(l), timeoutSeconds: 0.05, retryMinutes: 30 });
    await scheduler.tick();
    const firstRound = seen.length;
    expect(firstRound).toBeGreaterThan(0);
    // The attempt time is remembered: five minutes later nothing is asked.
    const start = Date.now();
    const clock = vi.spyOn(rt.automation, "now").mockImplementation(() => new Date(start + 5 * 60_000));
    await scheduler.tick();
    expect(seen).toHaveLength(firstRound);
    // After the retry time every refused host is asked again.
    clock.mockImplementation(() => new Date(start + 31 * 60_000));
    await scheduler.tick();
    expect(seen).toHaveLength(2 * firstRound);
    expect(w.opened).toEqual([]);
    expect(rt.automation.signInChecks()).toEqual([]);
  });

  it("the timer goes on after a refusal and checks as soon as the hook allows", async () => {
    const { rt, w, lines } = await signInWorld();
    let asked = 0;
    rt.authorize = () => {
      if (++asked <= 3) throw new Error(DETAIL);
    };
    const scheduler = new SignInScheduler(rt, { log: (l) => void lines.push(l), timeoutSeconds: 0.05, retryMinutes: 0, intervalMs: 10 });
    scheduler.start();
    try {
      await vi.waitFor(() => expect(w.opened.length).toBeGreaterThan(0), { timeout: 4000 });
    } finally {
      scheduler.stop();
    }
    expect(lines.some((l) => l.endsWith("not allowed by the authorisation hook"))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ scheduled live check

describe("scheduled live check (live-check-scheduler)", () => {
  it("runs without a hook, as before", async () => {
    const { rt, log } = await liveCheckSetup({ world: newWorld() });
    expect("authorize" in rt).toBe(false);
    const tick = await new LiveCheckScheduler(rt, { log }).tick();
    expect(tick.skipped).toBeNull();
    expect(rt.automation.liveCheckReports()).toHaveLength(1);
  });

  it("asks once as automation.run for the system actor, without a subject, and then runs", async () => {
    const { rt, log } = await liveCheckSetup({ world: newWorld() });
    const seen = allowing(rt);
    const tick = await new LiveCheckScheduler(rt, { log }).tick();
    expect(seen).toEqual([{ actor: { kind: "system", name: "live-check-scheduler" }, action: "automation.run" }]);
    expect(tick.report).toMatchObject({ trigger: "schedule" });
    expect(rt.automation.liveCheckReports()).toHaveLength(1);
  });

  for (const refusal of REFUSALS) {
    it(`${refusal.name}: nothing runs, nothing is stored or sent, and the next tick asks again`, async () => {
      const world = newWorld();
      const { rt, log, lines, fetchCalls } = await liveCheckSetup({ world, recipes: ["ok-create"] });
      refusal.install(rt);
      const faults = collectFaults(rt);
      const scheduler = new LiveCheckScheduler(rt, { log });
      expect(await scheduler.tick()).toEqual({ skipped: "refused", report: null });
      expect(rt.automation.liveCheckReports()).toEqual([]);
      expect(world.drivers).toHaveLength(0);
      expect(fetchCalls).toEqual([]);
      expect(lines).toEqual(["secret-desk: scheduled live check: not allowed by the authorisation hook"]);
      // Still refused at the next tick: asked again, but the log line only comes when it turns from allowed to refused.
      expect(await scheduler.tick()).toEqual({ skipped: "refused", report: null });
      expect(lines).toHaveLength(1);
      expectFaults(faults, refusal, "automation.run", 2, "live-check-scheduler");
      allowing(rt);
      const retry = await scheduler.tick();
      expect(retry.skipped).toBeNull();
      expect(rt.automation.liveCheckReports()).toHaveLength(1);
    });
  }

  it("logs the refusal to the console when no log function is given", async () => {
    const { rt } = await liveCheckSetup();
    rt.authorize = () => {
      throw new PolicyError(DETAIL);
    };
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await new LiveCheckScheduler(rt).tick()).skipped).toBe("refused");
    expect(out).toHaveBeenCalledWith("secret-desk: scheduled live check: not allowed by the authorisation hook");
  });

  it("a tick that comes in while the hook is asked neither asks nor runs a second time", async () => {
    const { rt, log } = await liveCheckSetup({ world: newWorld() });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const seen: AuthorizationRequest[] = [];
    rt.authorize = async (request) => {
      seen.push(request);
      await gate;
    };
    const scheduler = new LiveCheckScheduler(rt, { log });
    const first = scheduler.tick();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(await scheduler.tick()).toEqual({ skipped: "running", report: null });
    release();
    expect((await first).skipped).toBeNull();
    expect(seen).toHaveLength(1);
    expect(rt.automation.liveCheckReports()).toHaveLength(1);
  });

  it("a manual run that starts while the hook is asked wins: the tick does not start a second run", async () => {
    const { rt, log } = await liveCheckSetup({ world: newWorld() });
    let manual: Promise<unknown> = Promise.resolve();
    rt.authorize = () => {
      manual = runLiveCheck(rt, { trigger: "manual", log });
    };
    const scheduler = new LiveCheckScheduler(rt, { log });
    expect(await scheduler.tick()).toEqual({ skipped: "running", report: null });
    await manual;
    expect(rt.automation.liveCheckReports()).toHaveLength(1);
    expect(rt.automation.liveCheckReports()[0]).toMatchObject({ trigger: "manual" });
  });

  it("the timer goes on after a refusal and runs as soon as the hook allows", async () => {
    const { rt, log } = await liveCheckSetup({ world: newWorld() });
    let asked = 0;
    rt.authorize = () => {
      if (++asked <= 2) throw new Error(DETAIL);
    };
    const scheduler = new LiveCheckScheduler(rt, { log, intervalMs: 10 });
    scheduler.start();
    try {
      await vi.waitFor(() => expect(rt.automation.liveCheckReports()).toHaveLength(1), { timeout: 4000 });
    } finally {
      scheduler.stop();
    }
    expect(asked).toBeGreaterThanOrEqual(3);
  });
});
