import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver, LoginError, RecipeRunError, SudoError, type BrowserDriver, type LoginHooks, type RunHooks } from "@secret-desk/automation";
import { InventoryError, IssuanceError, SecretValue } from "@secret-desk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { readTeamTokenRecord, writeTeamTokenRecord } from "../src/team-token-meta.js";
import { checkTeamTokenSession, getTeamTokenInfo, startTeamToken, submitTeamTokenAccess, submitTeamTokenCode, submitTeamTokenConfirm, submitTeamTokenCredentials, verifyTeamToken } from "../src/team-token.js";

// The browser recipes are replaced by scripts: they call the hooks of the portal the way the real runner does.
const mocks = vi.hoisted(() => ({ runRecipe: vi.fn(), revokeRecipe: vi.fn(), signIn: vi.fn() }));
vi.mock("@secret-desk/automation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@secret-desk/automation")>()), runRecipe: mocks.runRecipe, revokeRecipe: mocks.revokeRecipe, signIn: mocks.signIn }));

const human = { kind: "human", name: "alice" } as const;
const REPO = "acme-org/team-config";
const NEW_TOKEN = "made_up_new_team_token_value_1";
const RUN = "team-token";

interface Api {
  repo: Record<string, unknown>;
  status: number;
  tree: boolean;
  branch: boolean;
}

async function setup(opts: { recipes?: boolean; automation?: boolean; vault?: { set: (id: string, value: string, expires?: string | null) => Promise<void> } } = {}) {
  const api: Api = { repo: { private: true, default_branch: "main", permissions: { push: true } }, status: 200, tree: true, branch: true };
  const fetchMock = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (api.status !== 200) return j({ message: "denied\nsecond line" }, api.status);
    if (u.pathname === "/repos/acme-org/team-config") return j(api.repo);
    if (u.pathname.includes("/git/ref/heads/")) return api.branch ? j({ object: { sha: "head1" } }) : j({ message: "Not Found" }, 404);
    if (u.pathname.includes("/git/trees/")) return api.tree ? j({ tree: [{ type: "blob", path: "team.yaml" }] }) : j({ message: "Not Found" }, 404);
    if (u.pathname.endsWith("/pulls")) return j([]);
    return j({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-team-token-mocked-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme-org\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nautomation:\n  enabled: ${opts.automation ?? true}\n`);
  const vault = opts.vault ? ({ ...opts.vault, get: async () => null, info: async () => null, list: async () => [], has: async () => false }) : null;
  const rt = await createRuntime(join(dir, "c.yaml"), {
    vault: vault as never,
    env: { GH_TEST: "gh_main_made_up_integration" } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    ...(opts.recipes === false ? { bundledRecipes: null } : {}),
    automationDriver: () => new FakeDriver(),
  });
  return { rt, api };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const state = (rt: Runtime) => rt.automation.state(RUN);
const finished = (rt: Runtime) => ["done", "failed", "cancelled"].includes(state(rt).status);
const run = async (rt: Runtime) => {
  startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
  await until(() => finished(rt));
  return state(rt);
};
const okRun = (over: { expiresAt?: string } = {}) => async () => ({ value: SecretValue.from(NEW_TOKEN), ...over });

beforeEach(() => {
  mocks.runRecipe.mockReset();
  mocks.revokeRecipe.mockReset();
  mocks.signIn.mockReset();
  mocks.runRecipe.mockImplementation(okRun());
  mocks.revokeRecipe.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("availability", () => {
  it("reports a missing recipe and refuses to start or check without one", async () => {
    const { rt } = await setup({ recipes: false });
    expect(await getTeamTokenInfo(rt, human)).toMatchObject({ available: false, reason: "recipe-missing" });
    expect(() => startTeamToken(rt, human, { repo: REPO, mode: "pull" })).toThrow(/is not loaded/);
    await expect(checkTeamTokenSession(rt, human)).rejects.toThrow(/is not loaded/);
  });

  it("automation off: start and check are refused", async () => {
    const { rt } = await setup({ automation: false });
    expect(await getTeamTokenInfo(rt, human)).toMatchObject({ available: false, reason: "automation-off" });
    expect(() => startTeamToken(rt, human, { repo: REPO, mode: "pull" })).toThrow(/automation is off/);
    await expect(checkTeamTokenSession(rt, human)).rejects.toThrow(/automation is off/);
  });
});

describe("how a failed run is explained", () => {
  const failing = async (err: unknown) => {
    const { rt } = await setup();
    vi.spyOn(rt.automation, "newDriver").mockRejectedValue(err);
    return run(rt);
  };

  it("sign-in errors keep their kind; the English text wins when there is one", async () => {
    expect((await failing(new LoginError("abort", "aborted"))).failure).toMatchObject({ code: "cancelled", message: "aborted" });
    expect((await failing(new LoginError("timeout", "zu lange", "took too long"))).failure).toMatchObject({ code: "timeout", message: "took too long" });
    expect((await failing(new LoginError("rejected", "abgelehnt"))).failure).toMatchObject({ code: "rejected", message: "abgelehnt" });
  });

  it("recipe errors map to cancelled, timeout, host, step, or key, and name a token that may exist", async () => {
    expect((await failing(new RecipeRunError("abort", "stop"))).failure?.code).toBe("cancelled");
    expect((await failing(new RecipeRunError("timeout", "slow"))).failure?.code).toBe("timeout");
    expect((await failing(new RecipeRunError("host", "wrong host"))).failure?.code).toBe("host");
    expect((await failing(new RecipeRunError("step", "no button"))).failure?.code).toBe("step");
    const capture = await failing(new RecipeRunError("capture", "no token", "secret-desk-team-x"));
    expect(capture.failure?.code).toBe("key");
    expect(capture.createdName).toBe("secret-desk-team-x");
  });

  it("other errors are a browser problem with the first line only, or a generic text", async () => {
    expect((await failing(new Error("boom\nsecond line"))).failure).toMatchObject({ code: "browser", message: "boom" });
    expect((await failing(new Error(""))).failure).toMatchObject({ code: "browser", message: "The browser could not be used." });
    expect((await failing("a string"))["failure"]).toMatchObject({ code: "browser", message: "The browser could not be used." });
  });

  it("a cancelled run says so even for an unrelated error", async () => {
    const { rt } = await setup();
    vi.spyOn(rt.automation, "newDriver").mockImplementation(async () => {
      rt.automation.cancel(RUN);
      throw new Error("whatever");
    });
    const s = await run(rt);
    expect(s.status).toBe("cancelled");
    expect(s.failure).toMatchObject({ code: "cancelled", message: "Cancelled." });
  });
});

describe("the run asks the portal", () => {
  it("shows what the browser waits for and how far the form is", async () => {
    const { rt } = await setup();
    const seen: unknown[] = [];
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "login", reason: "sign in", url: "https://github.com/login" });
      seen.push({ ...state(rt) });
      hooks.onWaitingForHuman?.({ kind: "pause", reason: "confirm", url: "https://github.com/sudo" });
      seen.push({ ...state(rt) });
      hooks.onResumed?.();
      hooks.onProgress?.({ index: 1, total: 4, label: "goto https://github.com/x" });
      seen.push({ ...state(rt) });
      hooks.onProgress?.({ index: 2, total: 4, label: "fill Name" });
      seen.push({ ...state(rt) });
      hooks.onProgress?.({ index: 3, total: 4, label: "click Generate" });
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    const final = await run(rt);
    expect(final.status).toBe("done");
    const [login, pause, goto, fill] = seen as { phase?: string; text: string; step: { index: number } | null }[];
    expect(login).toMatchObject({ phase: "signin", text: "Sign in to GitHub in the browser window." });
    expect(pause).toMatchObject({ phase: "confirm", text: "Confirm access at GitHub in the browser window." });
    expect(goto).toMatchObject({ step: { index: 1 } });
    expect(goto?.phase).toBe("confirm");
    expect(fill).toMatchObject({ phase: "creating", step: { index: 2 } });
  });

  it("a form step while the run is not 'running' only moves the progress", async () => {
    const { rt } = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "pause", reason: "confirm", url: "https://github.com/sudo" });
      hooks.onProgress?.({ index: 5, total: 9, label: "fill Name" });
      expect(state(rt)).toMatchObject({ phase: "confirm", status: "waiting-human", step: { index: 5 } });
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    expect((await run(rt)).status).toBe("done");
  });

  it("asks for the sign-in, the code and the authorization, and shows the events of the sign-in", async () => {
    const { rt } = await setup();
    const trail: string[] = [];
    mocks.signIn.mockImplementation(async (_r: unknown, creds: { username: string }, _d: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "opening" });
      hooks.onEvent?.({ type: "needs", need: "mfa-code", detail: "x".repeat(600) });
      trail.push(`mfa ${state(rt).needs} ${state(rt).detail?.length}`);
      const code = await hooks.requestCode!();
      trail.push(`code ${code}`);
      hooks.onEvent?.({ type: "needs", need: "approval", messageEn: "Approve on your phone", detail: "42" });
      trail.push(`approval ${state(rt).text}`);
      hooks.onEvent?.({ type: "needs", need: "approval" });
      trail.push(`approval-default ${state(rt).text}`);
      hooks.onEvent?.({ type: "resumed", need: "approval" });
      trail.push(`resumed ${state(rt).text}`);
      hooks.onEvent?.({ type: "needs", need: "consent" });
      trail.push(`consent ${state(rt).text}`);
      const accepted = await hooks.requestConfirm!();
      trail.push(`accepted ${accepted} ${creds.username}`);
      hooks.onEvent?.({ type: "signed-in", url: "https://github.com/" });
      trail.push(`signed-in ${state(rt).text}`);
      hooks.onEvent?.({ type: "submitted" });
    });
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, driver: BrowserDriver, hooks: RunHooks) => {
      await hooks.signIn!(driver);
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    startTeamToken(rt, human, { repo: REPO, mode: "pull" });
    await until(() => state(rt).ask?.type === "credentials");
    submitTeamTokenCredentials(rt, human, { method: "email", username: "me@example.test", password: "made-up-pw-1" });
    await until(() => state(rt).needs === "mfa-code");
    expect(() => submitTeamTokenCode(rt, human, {})).toThrow(InventoryError);
    submitTeamTokenCode(rt, human, { code: "123456" });
    await until(() => state(rt).needs === "consent");
    expect(() => submitTeamTokenConfirm(rt, human, { accept: "yes" })).toThrow(/Say whether/);
    expect(() => submitTeamTokenConfirm(rt, human, {})).toThrow(InventoryError);
    submitTeamTokenConfirm(rt, human, { accept: true });
    await until(() => finished(rt));
    expect(state(rt).status).toBe("done");
    expect(trail).toEqual([
      "mfa mfa-code 400",
      "code 123456",
      "approval Approve on your phone",
      "approval-default Approve the sign-in on your device ...",
      "resumed Continuing.",
      "consent Waiting for your confirmation of the authorization.",
      "accepted true me@example.test",
      "signed-in Signed in to GitHub.",
    ]);
  });

  it("answers are refused when nothing waits for them", async () => {
    const { rt } = await setup();
    expect(() => submitTeamTokenCode(rt, human, { code: "123456" })).toThrow(IssuanceError);
    expect(() => submitTeamTokenConfirm(rt, human, { accept: true })).toThrow(IssuanceError);
    expect(() => submitTeamTokenAccess(rt, human, { method: "mobile" })).toThrow(IssuanceError);
    expect(() => submitTeamTokenCredentials(rt, human, { method: "email", username: "a", password: "b" })).toThrow(IssuanceError);
  });

  it("a sign-in question that is no longer the visible question is refused", async () => {
    const { rt } = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, driver: BrowserDriver, hooks: RunHooks) => {
      await hooks.signIn!(driver);
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    mocks.signIn.mockResolvedValue(undefined);
    startTeamToken(rt, human, { repo: REPO, mode: "pull" });
    await until(() => state(rt).ask?.type === "credentials");
    rt.automation.update(RUN, { status: "running" });
    expect(() => submitTeamTokenCredentials(rt, human, { method: "email", username: "a", password: "b" })).toThrow(/not waiting for a sign-in/);
    rt.automation.cancel(RUN);
    await until(() => finished(rt));
  });

  it("a run cancelled before the question is asked ends cancelled", async () => {
    const { rt } = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, driver: BrowserDriver, hooks: RunHooks) => {
      rt.automation.cancel(RUN);
      await hooks.signIn!(driver);
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    const s = await run(rt);
    expect(s.status).toBe("cancelled");
  });

  it("Confirm access: the question, its events and the answer", async () => {
    const { rt } = await setup();
    const stages: string[] = [];
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      const answer = hooks.access!.request({ methods: ["mobile", "code"], attempt: 1, maxAttempts: 3, problem: "wrong-code" } as never);
      stages.push(`${asked(rt)?.stage}`);
      hooks.access!.onEvent?.({ type: "choose", ask: { methods: ["mobile"], attempt: 1, maxAttempts: 1 } });
      expect(() => submitTeamTokenAccess(rt, human, { method: "mobile" })).not.toThrow();
      expect(await answer).toEqual({ method: "mobile" });
      hooks.access!.onEvent?.({ type: "mobile", number: "17" });
      stages.push(`mobile ${asked(rt)?.stage} ${state(rt).text}`);
      hooks.access!.onEvent?.({ type: "checking", method: "code" });
      stages.push(`checking ${state(rt).text}`);
      hooks.access!.onEvent?.({ type: "confirmed" });
      stages.push(`confirmed ${state(rt).text}`);
      return { value: SecretValue.from(NEW_TOKEN) };
    });
    startTeamToken(rt, human, { repo: REPO, mode: "pull" });
    await until(() => finished(rt));
    expect(state(rt).status).toBe("done");
    expect(stages).toEqual(["choose", "mobile mobile Waiting for GitHub Mobile.", "checking GitHub is checking the confirmation.", "confirmed Access confirmed."]);
  });

  it("Confirm access answers are refused once the question moved on", async () => {
    const { rt } = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      const answer = hooks.access!.request({ methods: ["mobile"], attempt: 1, maxAttempts: 3 } as never);
      hooks.access!.onEvent?.({ type: "mobile", number: "17" });
      state(rt).status;
      rt.automation.update(RUN, { status: "waiting-human", ask: { type: "access", stage: "mobile", number: "17" } });
      expect(() => submitTeamTokenAccess(rt, human, { method: "mobile" })).toThrow(/not waiting for a confirmation/);
      rt.automation.cancel(RUN);
      await answer.catch(() => undefined);
      throw new RecipeRunError("abort", "stopped");
    });
    expect((await run(rt)).status).toBe("cancelled");
  });
});

function asked(rt: Runtime) {
  const s = state(rt);
  return s.status === "waiting-human" && s.ask?.type === "access" ? s.ask : undefined;
}

describe("testing and storing the new token", () => {
  it("a token without a given expiry gets 90 days; the given expiry is kept", async () => {
    const a = await setup();
    expect((await run(a.rt)).status).toBe("done");
    expect((await a.rt.connections.status("team-sync")).expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const b = await setup();
    mocks.runRecipe.mockImplementation(okRun({ expiresAt: "2030-01-02" }));
    expect((await run(b.rt)).result).toMatchObject({ expires: "2030-01-02" });
  });

  it("stores the token in the vault when there is one", async () => {
    const stored: Record<string, { value: string; expires: string | null | undefined }> = {};
    const { rt } = await setup({ vault: { set: async (id, value, expires) => void (stored[id] = { value, expires }) } });
    rt.connections.session.set("team-sync", "old-session-value", null);
    expect((await run(rt)).status).toBe("done");
    expect(stored["team-sync"]?.value).toBe(NEW_TOKEN);
    expect(rt.connections.session.has("team-sync")).toBe(false);
  });

  it("a vault that cannot store ends the run with the name of the token to delete", async () => {
    const { rt } = await setup({ vault: { set: async () => Promise.reject(new Error("disk full")) } });
    const s = await run(rt);
    expect(s.status).toBe("failed");
    expect(s.failure?.code).toBe("store");
    expect(s.createdName).toMatch(/^secret-desk-t~team-config-/);
  });

  it("verifyTeamToken problems end the run with code test", async () => {
    const { rt, api } = await setup();
    api.repo = { private: false, default_branch: "main" };
    const s = await run(rt);
    expect(s.failure?.code).toBe("test");
    expect(s.failure?.message).toMatch(/not a private repository/);
  });
});

describe("verifyTeamToken", () => {
  const value = SecretValue.from(NEW_TOKEN);
  const req = (over: Record<string, unknown> = {}) => ({ owner: "acme-org", name: "team-config", branch: undefined, mode: "pull" as const, strategy: "pull-request" as const, ...over });

  it("passes for a private repository the token can read", async () => {
    const { rt } = await setup();
    expect(await verifyTeamToken(rt, value, req())).toBeNull();
    expect(await verifyTeamToken(rt, value, req({ branch: "dev" }))).toBeNull();
  });

  it("needs a branch: the given one, the default one, or the answer says it could not be found", async () => {
    const { rt, api } = await setup();
    api.repo = { private: true, permissions: { push: true } };
    expect(await verifyTeamToken(rt, value, req())).toMatch(/branch of acme-org\/team-config could not be determined/);
    expect(await verifyTeamToken(rt, value, req({ branch: "main" }))).toBeNull();
  });

  it("the branch must be readable with the new token", async () => {
    const { rt, api } = await setup();
    api.branch = false;
    expect(await verifyTeamToken(rt, value, req())).toBe("The branch main of acme-org/team-config could not be read with the new token.");
  });

  it("push modes need the push right; pull-request mode also reads the pull requests, a direct push does not", async () => {
    const { rt, api } = await setup();
    expect(await verifyTeamToken(rt, value, req({ mode: "pull-push" }))).toBeNull();
    expect(await verifyTeamToken(rt, value, req({ mode: "pull-push", strategy: "direct" }))).toBeNull();
    api.repo = { private: true, default_branch: "main", permissions: { push: false } };
    expect(await verifyTeamToken(rt, value, req({ mode: "pull-push" }))).toMatch(/cannot push/);
    api.repo = { private: true, default_branch: "main" };
    expect(await verifyTeamToken(rt, value, req({ mode: "pull-push" }))).toMatch(/cannot push/);
  });

  it("GitHub refusals, invalid names and network problems become short texts", async () => {
    const { rt, api } = await setup();
    api.status = 403;
    expect(await verifyTeamToken(rt, value, req())).toMatch(/^GitHub refused the new token \(403\): .*denied$/);
    expect(await verifyTeamToken(rt, value, req({ name: "bad name" }))).toBe("The repository or branch name is not valid.");
    api.status = 200;
    vi.spyOn(rt, "fetch", "get").mockReturnValue((async () => Promise.reject(new TypeError("socket closed"))) as never);
    expect(await verifyTeamToken(rt, value, req())).toBe("The new token could not be tested.");
  });
});

describe("replacing an earlier token", () => {
  const earlier = { repo: REPO, mode: "pull" as const, strategy: "pull-request" as const, tokenName: "secret-desk-t~old-0", createdAt: "2026-01-01T00:00:00.000Z", expires: "2026-04-01" };

  async function replacing() {
    const s = await setup();
    await writeTeamTokenRecord(s.rt, { active: earlier, pendingRevocation: null });
    return s;
  }

  it("deletes the old token after the new one works, and says so", async () => {
    const { rt } = await replacing();
    mocks.revokeRecipe.mockImplementation(async (_r: unknown, vars: { externalId: string }, _d: unknown, hooks: RunHooks) => {
      expect(vars.externalId).toBe("secret-desk-t~old-0");
      hooks.onWaitingForHuman?.({ kind: "pause", reason: "confirm", url: "https://github.com/sudo" });
      expect(state(rt).text).toBe("Waiting at GitHub.");
      hooks.onResumed?.();
      expect(state(rt).text).toBe("Continuing.");
    });
    const s = await run(rt);
    expect(s.result).toMatchObject({ revoked: true });
    expect((await readTeamTokenRecord(rt)).pendingRevocation).toBeNull();
  });

  it("a failing delete run keeps the reason, with nothing secret in it", async () => {
    const reasons: [unknown, RegExp][] = [
      [new SudoError("failed", "confirmation\nrefused"), /^confirmation refused$/],
      [new RecipeRunError("step", "button missing"), /^button missing$/],
      [new LoginError("rejected", "sign-in refused"), /^sign-in refused$/],
      [new Error("internal detail"), /^The browser could not be used\.$/],
    ];
    for (const [err, expected] of reasons) {
      const { rt } = await replacing();
      mocks.revokeRecipe.mockRejectedValue(err);
      const s = await run(rt);
      expect(s.result).toMatchObject({ revoked: false });
      expect(s.result?.revokeFailure).toMatch(expected);
      expect((await readTeamTokenRecord(rt)).pendingRevocation).toMatchObject({ tokenName: "secret-desk-t~old-0", reason: expect.stringMatching(expected) });
    }
  });

  it("a delete run that was cancelled is reported as cancelled; a real failure during cancel is not hidden", async () => {
    const a = await replacing();
    mocks.revokeRecipe.mockImplementation(async () => {
      a.rt.automation.cancel(RUN);
      throw new Error("stopped");
    });
    expect((await run(a.rt)).result?.revokeFailure).toBe("The delete run was cancelled.");
    const b = await replacing();
    mocks.revokeRecipe.mockImplementation(async () => {
      b.rt.automation.cancel(RUN);
      throw new RecipeRunError("step", "button missing");
    });
    expect((await run(b.rt)).result?.revokeFailure).toBe("button missing");
    const c = await replacing();
    mocks.revokeRecipe.mockImplementation(async () => {
      c.rt.automation.cancel(RUN);
      throw new RecipeRunError("abort", "stopped");
    });
    expect((await run(c.rt)).result?.revokeFailure).toBe("The delete run was cancelled.");
  });

  it("the delete run gets the portal's hooks for confirmations without a timeline phase of their own", async () => {
    const { rt } = await replacing();
    mocks.revokeRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      const answer = hooks.access!.request({ methods: ["mobile"], attempt: 1, maxAttempts: 3 } as never);
      expect(state(rt).phase).toBe("revoking");
      submitTeamTokenAccess(rt, human, { method: "mobile" });
      await answer;
    });
    expect((await run(rt)).result).toMatchObject({ revoked: true });
  });
});

describe("checking the browser session", () => {
  class Scripted extends FakeDriver {
    constructor(private readonly script: { open?: boolean; url?: () => Promise<string>; close?: boolean }) {
      super();
    }
    override async open(): Promise<void> {
      if (this.script.open) throw new Error("no browser");
    }
    override async currentUrl(): Promise<string> {
      return this.script.url ? this.script.url() : "https://github.com/settings/profile";
    }
    override async close(): Promise<void> {
      if (this.script.close) throw new Error("close failed");
    }
  }

  async function withDriver(script: ConstructorParameters<typeof Scripted>[0]) {
    const s = await setup();
    vi.spyOn(s.rt.automation, "newDriver").mockResolvedValue(new Scripted(script));
    return s;
  }

  it("signed in when GitHub keeps the browser on the settings page; a failing close is ignored", async () => {
    const { rt } = await withDriver({ close: true });
    expect(await checkTeamTokenSession(rt, human)).toMatchObject({ signedIn: true });
  });

  it("a browser that cannot open is a browser failure", async () => {
    const { rt } = await withDriver({ open: true });
    expect(await checkTeamTokenSession(rt, human)).toMatchObject({ signedIn: false, failure: { code: "browser" } });
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("refuses while another browser run is active", async () => {
    const { rt } = await setup();
    rt.automation.begin("other-run", "p", { text: "busy" });
    expect(await checkTeamTokenSession(rt, human)).toMatchObject({ signedIn: false, failure: { code: "busy" } });
  });

  it("not signed in when the page never reaches the settings; an unreadable address counts as empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { rt } = await withDriver({ url: async () => Promise.reject(new Error("no page")) });
    const pending = checkTeamTokenSession(rt, human);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ signedIn: false });
  });

  it("a recipe without a sign-in check never reports signed in", async () => {
    const { rt } = await withDriver({});
    const recipe = rt.automation.recipe("github-fine-grained-token")!;
    vi.spyOn(rt.automation, "recipe").mockReturnValue({ ...recipe, login: undefined });
    expect(await checkTeamTokenSession(rt, human)).toMatchObject({ signedIn: false });
  });
});
