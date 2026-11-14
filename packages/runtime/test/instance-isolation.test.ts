import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver, type BrowserDriver, type LoginCredentials, type LoginHooks, type RunHooks } from "@secret-desk/automation";
import { IssuanceError, SecretValue, type PendingIssuance } from "@secret-desk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceGoneError, confirmIssuance, getIssuance, listIssuances, rejectIssuance } from "../src/agent-api.js";
import { cancelFacade, getFacadeState, startFacadeSignIn, submitFacadeCode, submitFacadeConfirm } from "../src/facade.js";
import { MemoryPendingStore, type PendingStore } from "../src/issuances.js";
import { isLiveCheckRunning } from "../src/live-check.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../src/runtime.js";
import { startTeamToken, submitTeamTokenCode, submitTeamTokenCredentials } from "../src/team-token.js";

// Two runtimes in one process must share nothing: a code typed for one is never taken by the other, and a wait that ran out
// cannot be answered. The browser steps are scripted; the scripts call the hooks the way the real runner does.
const mocks = vi.hoisted(() => ({ runRecipe: vi.fn(), signIn: vi.fn() }));
vi.mock("@secret-desk/automation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@secret-desk/automation")>()), runRecipe: mocks.runRecipe, signIn: mocks.signIn }));

const human = { kind: "human", name: "alice" } as const;
const PROVIDER = "revenuecat";
const FACADE_KEY = `facade:${PROVIDER}`;
const REPO = "acme-org/team-config";
const T0 = Date.parse("2026-11-14T10:00:00.000Z");

async function setup(options: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const dir = await mkdtemp(join(tmpdir(), "sd-instance-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme-org\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  return createRuntime(join(dir, "c.yaml"), { env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, vault: null, fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch, automationDriver: () => new FakeDriver(), ...options });
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const facade = (rt: Runtime) => getFacadeState(rt, human, PROVIDER);
const finished = (rt: Runtime) => ["done", "failed", "cancelled"].includes(facade(rt).status);
const signInAs = (rt: Runtime, username: string) => startFacadeSignIn(rt, human, PROVIDER, { username, password: "made-up-pw-1" });

/** What each sign-in received, by the user name it signed in with. */
let received: Record<string, string>;

beforeEach(() => {
  received = {};
  mocks.runRecipe.mockReset();
  mocks.signIn.mockReset();
  // The sign-in asks for a code, notes what it got and stops there.
  mocks.signIn.mockImplementation(async (_recipe: unknown, creds: LoginCredentials, _driver: unknown, hooks: LoginHooks) => {
    const who = creds.username;
    hooks.onEvent?.({ type: "needs", need: "mfa-code" });
    received[who] = await hooks.requestCode!();
    throw new Error("stop here");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two runtimes in one process share no waiter", () => {
  it("a code delivered to the other runtime is not consumed and not visible: A waits, B is asked", async () => {
    const a = await setup();
    const b = await setup();
    signInAs(a, "a@example.test");
    await until(() => facade(a).needs === "mfa-code");
    expect(a.instance.codeWaiters.size).toBe(1);
    expect(b.instance.codeWaiters.size).toBe(0);
    expect(b.instance.codeWaiters.get(FACADE_KEY, b.now())).toBeUndefined();
    expect(() => submitFacadeCode(b, human, PROVIDER, { code: "111111" })).toThrow(IssuanceError);
    // A neither saw the code nor lost its wait.
    expect(received).toEqual({});
    expect(facade(a).needs).toBe("mfa-code");
    expect(a.instance.codeWaiters.size).toBe(1);
    submitFacadeCode(a, human, PROVIDER, { code: "222222" });
    await until(() => finished(a));
    expect(received).toEqual({ "a@example.test": "222222" });
  });

  it("and the reverse: B waits, A is asked", async () => {
    const a = await setup();
    const b = await setup();
    signInAs(b, "b@example.test");
    await until(() => facade(b).needs === "mfa-code");
    expect(a.instance.codeWaiters.size).toBe(0);
    expect(() => submitFacadeCode(a, human, PROVIDER, { code: "333333" })).toThrow(IssuanceError);
    expect(received).toEqual({});
    expect(b.instance.codeWaiters.size).toBe(1);
    submitFacadeCode(b, human, PROVIDER, { code: "444444" });
    await until(() => finished(b));
    expect(received).toEqual({ "b@example.test": "444444" });
  });

  it("both wait on the same provider at once: each code reaches its own run only", async () => {
    const a = await setup();
    const b = await setup();
    signInAs(a, "a@example.test");
    signInAs(b, "b@example.test");
    await until(() => facade(a).needs === "mfa-code" && facade(b).needs === "mfa-code");
    submitFacadeCode(b, human, PROVIDER, { code: "555555" });
    await until(() => finished(b));
    expect(received).toEqual({ "b@example.test": "555555" });
    expect(facade(a).needs).toBe("mfa-code");
    expect(a.instance.codeWaiters.size).toBe(1);
    submitFacadeCode(a, human, PROVIDER, { code: "666666" });
    await until(() => finished(a));
    expect(received).toEqual({ "a@example.test": "666666", "b@example.test": "555555" });
  });

  it("the consent question and its cancel are per runtime too", async () => {
    const a = await setup();
    const b = await setup();
    mocks.signIn.mockImplementation(async (_recipe: unknown, _creds: unknown, _driver: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "needs", need: "consent" });
      await hooks.requestConfirm!();
      return { url: "https://app.revenuecat.com/" };
    });
    signInAs(a, "a@example.test");
    signInAs(b, "b@example.test");
    await until(() => facade(a).needs === "consent" && facade(b).needs === "consent");
    cancelFacade(b, human, PROVIDER);
    await until(() => finished(b));
    expect(facade(b).status).toBe("cancelled");
    // A's question is still open and still answerable.
    expect(a.instance.confirmWaiters.size).toBe(1);
    expect(facade(a).needs).toBe("consent");
    expect(() => submitFacadeConfirm(b, human, PROVIDER, { accept: true })).toThrow(IssuanceError);
    cancelFacade(a, human, PROVIDER);
    await until(() => finished(a));
  });

  it("the team token run keeps its questions in the runtime: credentials and code of one are not seen by the other", async () => {
    const a = await setup();
    const b = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, driver: BrowserDriver, hooks: RunHooks) => {
      await hooks.signIn!(driver);
      return { value: SecretValue.from("made_up_team_token_value_1") };
    });
    startTeamToken(a, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => a.automation.state("team-token").ask?.type === "credentials");
    expect(a.instance.teamToken.credentials.size).toBe(1);
    expect(b.instance.teamToken.credentials.size).toBe(0);
    expect(() => submitTeamTokenCredentials(b, human, { method: "email", username: "x@example.test", password: "made-up-pw-1" })).toThrow(IssuanceError);
    expect(a.instance.teamToken.credentials.size).toBe(1);
    submitTeamTokenCredentials(a, human, { method: "email", username: "a@example.test", password: "made-up-pw-1" });
    await until(() => a.automation.state("team-token").needs === "mfa-code");
    expect(a.instance.teamToken.code.size).toBe(1);
    expect(() => submitTeamTokenCode(b, human, { code: "777777" })).toThrow(IssuanceError);
    expect(received).toEqual({});
    submitTeamTokenCode(a, human, { code: "888888" });
    await until(() => ["failed", "done"].includes(a.automation.state("team-token").status));
    expect(received).toEqual({ "a@example.test": "888888" });
  });

  it("the live-check flag belongs to the runtime", async () => {
    const a = await setup();
    const b = await setup();
    a.instance.liveCheckRunning = true;
    expect(isLiveCheckRunning(a)).toBe(true);
    expect(isLiveCheckRunning(b)).toBe(false);
  });

  it("pending reviews are per runtime as well", async () => {
    const a = await setup({ now: () => new Date(T0) });
    const b = await setup({ now: () => new Date(T0) });
    a.issuances.add(review("only-in-a", T0 + 60 * 60_000));
    expect(a.issuances.get("only-in-a")).toBeDefined();
    expect(b.issuances.get("only-in-a")).toBeUndefined();
    expect(b.issuances.list()).toEqual([]);
  });
});

describe("a wait cannot be satisfied after its deadline, whether or not a sweep ran", () => {
  it("an answer typed after the deadline is refused, and the run ends as expired", async () => {
    let t = T0;
    const rt = await setup({ now: () => new Date(t) });
    signInAs(rt, "a@example.test");
    await until(() => facade(rt).needs === "mfa-code");
    const timeoutAt = Date.parse(facade(rt).timeoutAt!);
    expect(timeoutAt).toBeGreaterThan(T0);
    t = timeoutAt - 1;
    expect(rt.instance.codeWaiters.get(FACADE_KEY, rt.now())).toBeDefined();
    t = timeoutAt;
    expect(() => submitFacadeCode(rt, human, PROVIDER, { code: "123456" })).toThrow(IssuanceError);
    expect(received).toEqual({});
    expect(rt.instance.codeWaiters.size).toBe(0);
    await until(() => finished(rt));
    expect(facade(rt)).toMatchObject({ status: "failed", failure: { message: "The time for the answer ran out." } });
  });

  it("the sweep hook removes the expired wait and reports the earliest deadline that remains", async () => {
    let t = T0;
    const rt = await setup({ now: () => new Date(t) });
    signInAs(rt, "a@example.test");
    await until(() => facade(rt).needs === "mfa-code");
    const timeoutAt = Date.parse(facade(rt).timeoutAt!);
    expect(await rt.sweep()).toEqual(new Date(timeoutAt));
    expect(rt.instance.codeWaiters.size).toBe(1);
    // With reviews too, the earliest of everything that waits is reported.
    rt.issuances.add(review("early", timeoutAt - 60_000));
    rt.issuances.add(review("late", timeoutAt + 60_000));
    expect(await rt.sweep()).toEqual(new Date(timeoutAt - 60_000));
    t = timeoutAt - 30_000;
    expect(await rt.sweep()).toEqual(new Date(timeoutAt));
    t = timeoutAt + 1;
    expect(await rt.sweep()).toEqual(new Date(timeoutAt + 60_000));
    t = timeoutAt + 60_000;
    expect(await rt.sweep()).toBeNull();
    expect(rt.instance.codeWaiters.size).toBe(0);
    await until(() => finished(rt));
    expect(facade(rt).status).toBe("failed");
  });

  it("the team token questions expire with the run", async () => {
    let t = T0;
    const rt = await setup({ now: () => new Date(t) });
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, driver: BrowserDriver, hooks: RunHooks) => {
      await hooks.signIn!(driver);
      return { value: SecretValue.from("made_up_team_token_value_1") };
    });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "credentials");
    const timeoutAt = Date.parse(rt.automation.state("team-token").timeoutAt!);
    t = timeoutAt + 1;
    expect(() => submitTeamTokenCredentials(rt, human, { method: "email", username: "a@example.test", password: "made-up-pw-1" })).toThrow(IssuanceError);
    expect(rt.instance.teamToken.credentials.size).toBe(0);
    await until(() => ["failed", "done"].includes(rt.automation.state("team-token").status));
  });
});

function review(id: string, expiresAtMs: number): PendingIssuance {
  return {
    id,
    secretId: "s",
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    value: new SecretValue("made-up-issued-value-1"),
    companions: [],
    report: { id, secretName: "SOME_NAME", stage: "shared", provider: "manual", kind: "manual", checks: [], checklist: [], externalId: undefined },
    issuedSecret: { id: "s" },
  } as unknown as PendingIssuance;
}

describe("a pending review expires by its deadline on every access path", () => {
  const DEADLINE = T0 + 15 * 60_000;

  it("one second before the deadline the review is there; list, get, confirm and reject each treat it as gone at the deadline, with no sweep and no timer", async () => {
    let t = T0;
    const rtBefore = await setup({ now: () => new Date(t) });
    rtBefore.issuances.add(review("r1", DEADLINE));
    t = DEADLINE - 1000;
    expect((await listIssuances(rtBefore)).map((v) => v.id)).toEqual(["r1"]);
    expect((await getIssuance(rtBefore, "r1")).id).toBe("r1");
    t = T0;

    const at = async (path: (rt: Runtime) => Promise<unknown>): Promise<{ rt: Runtime; held: PendingIssuance }> => {
      let t = T0;
      const rt = await setup({ now: () => new Date(t) });
      const held = review("r1", DEADLINE);
      rt.issuances.add(held);
      t = DEADLINE;
      await path(rt);
      return { rt, held };
    };
    const listed = await at(async (rt) => expect(await listIssuances(rt)).toEqual([]));
    const got = await at((rt) => expect(getIssuance(rt, "r1")).rejects.toBeInstanceOf(IssuanceGoneError));
    const confirmed = await at((rt) => expect(confirmIssuance(rt, human, "r1", { ticks: [] })).rejects.toBeInstanceOf(IssuanceGoneError));
    const rejected = await at((rt) => expect(rejectIssuance(rt, human, "r1")).rejects.toBeInstanceOf(IssuanceGoneError));
    for (const { rt, held } of [listed, got, confirmed, rejected]) {
      // Removed on that access, and the value is dropped from memory, without anybody having swept.
      expect(rt.issuances.list()).toEqual([]);
      expect(held.value.reveal()).toBe("");
    }
  });

  it("the sweep hook removes what expired, settles the provider-side delete and reports what remains", async () => {
    let t = T0;
    const rt = await setup({ now: () => new Date(t) });
    rt.issuances.add(review("soon", DEADLINE));
    rt.issuances.add(review("later", DEADLINE + 60_000));
    expect(await rt.sweep()).toEqual(new Date(DEADLINE));
    t = DEADLINE + 1;
    expect(await rt.sweep()).toEqual(new Date(DEADLINE + 60_000));
    expect(rt.issuances.get("soon")).toBeUndefined();
    expect(await rt.sweep(new Date(DEADLINE + 60_000))).toBeNull();
    expect(await rt.sweep()).toBeNull();
  });

  it("the sweep hook is not asked of the authorisation hook: a refusing hook cannot extend a life", async () => {
    let t = T0;
    const authorize = vi.fn(() => {
      throw new Error("refuse everything");
    });
    const rt = await setup({ now: () => new Date(t), authorize });
    const held = review("r1", DEADLINE);
    rt.issuances.add(held);
    t = DEADLINE;
    await rt.sweep();
    expect(authorize).not.toHaveBeenCalled();
    expect(rt.issuances.list()).toEqual([]);
    expect(held.value.reveal()).toBe("");
  });
});

describe("the store of pending values is the embedder's to choose", () => {
  it("a runtime uses the store it is given, and a value the store no longer has is a normal outcome", async () => {
    const inner = new MemoryPendingStore();
    const puts: string[] = [];
    const store: PendingStore = { put: (p) => (puts.push(p.id), inner.put(p)), get: (id) => inner.get(id), list: () => inner.list(), delete: (id) => inner.delete(id) };
    const rt = await setup({ pendingStore: store, now: () => new Date(T0) });
    rt.issuances.add(review("kept", T0 + 60_000));
    expect(puts).toEqual(["kept"]);
    expect((await getIssuance(rt, "kept")).id).toBe("kept");
    // The process was evicted and restarted: the embedder's store has the identifier at most, not the value.
    inner.delete("kept");
    const gone = await getIssuance(rt, "kept").catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(IssuanceGoneError);
    expect(gone).toMatchObject({ code: "issuance-gone", message: "Pruefung nicht gefunden oder abgelaufen: kept" });
    expect(await listIssuances(rt)).toEqual([]);
  });

  it("the clock is the one given, and without one the system clock", async () => {
    const fixed = await setup({ now: () => new Date(T0) });
    expect(fixed.now().getTime()).toBe(T0);
    const system = await setup();
    expect(Math.abs(system.now().getTime() - Date.now())).toBeLessThan(5000);
  });
});
