import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver, LoginError, RecipeHostError, RecipeRunError, type LoginHooks, type Recipe, type RunHooks } from "@secret-desk/automation";
import { InventoryError, IssuanceError, SecretValue } from "@secret-desk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import {
  FACADES,
  cancelFacade,
  cancelRecipeSignIn,
  checkFacadeSession,
  checkRecipeSession,
  checkRecipeSessionScheduled,
  credentialsFrom,
  getFacadeState,
  getRecipeSignInState,
  listFacades,
  portalFrom,
  startFacadeConnect,
  startFacadeSignIn,
  startRecipeSignIn,
  submitFacadeAccess,
  submitFacadeCode,
  submitFacadeConfirm,
  submitRecipeCode,
  submitRecipeConfirm,
} from "../src/facade.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

// The browser steps are scripted: the tests call the hooks the way the real runner does.
const mocks = vi.hoisted(() => ({ runRecipe: vi.fn(), signIn: vi.fn(), checkSession: vi.fn(), resolveRecipe: vi.fn() }));
const real = vi.hoisted(() => ({ resolveRecipe: null as unknown as (r: unknown, s?: string) => unknown }));
vi.mock("@secret-desk/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@secret-desk/automation")>();
  real.resolveRecipe = actual.resolveRecipe as never;
  return { ...actual, runRecipe: mocks.runRecipe, signIn: mocks.signIn, checkSession: mocks.checkSession, resolveRecipe: mocks.resolveRecipe };
});

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;
const KEY = "sk_madeup_integration_key_value_1";
const PROJECT = "proj1a2b3c";
const HOME = `https://app.revenuecat.com/projects/${PROJECT}/overview`;
const body = (extra: Record<string, unknown> = {}) => ({ username: "me@example.test", password: "made-up-pw-1", ...extra });

async function setup(opts: { vault?: { set: (id: string, value: string, expires?: string | null) => Promise<void> }; fetch?: (url: string) => Response } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-facade-mocked-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\n");
  await writeFile(join(dir, "c.yaml"), "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const fetchMock = (async (url: string | URL | Request) => {
    const u = String(url);
    if (opts.fetch) return opts.fetch(u);
    if (u.includes("/v2/projects/") && u.includes("/apps")) return json({ items: [{ id: "app1", name: "iOS", type: "app_store" }] });
    if (u.includes("/v2/projects")) return json({ items: [{ id: PROJECT, name: "Main" }] });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const kept = new Map<string, string>();
  const vault = opts.vault
    ? {
        set: async (id: string, value: string, expires?: string | null) => {
          await opts.vault!.set(id, value, expires);
          kept.set(id, value);
        },
        get: async (id: string) => (kept.has(id) ? SecretValue.from(kept.get(id)!) : null),
        info: async (id: string) => (kept.has(id) ? { id, savedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp" } : null),
        list: async () => [],
        has: async (id: string) => kept.has(id),
        delete: async () => undefined,
      }
    : null;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: vault as never, env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, fetch: fetchMock, automationDriver: () => new FakeDriver() });
  return rt;
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const stateOf = (rt: Runtime, id = "revenuecat") => getFacadeState(rt, human, id);
const finished = (rt: Runtime, id = "revenuecat") => ["done", "failed", "cancelled"].includes(stateOf(rt, id).status);
const connect = async (rt: Runtime, id = "revenuecat", extra: Record<string, unknown> = {}) => {
  startFacadeConnect(rt, human, id, extra);
  await until(() => finished(rt, id));
  return stateOf(rt, id);
};

beforeEach(() => {
  mocks.runRecipe.mockReset();
  mocks.signIn.mockReset();
  mocks.checkSession.mockReset();
  mocks.resolveRecipe.mockReset();
  mocks.runRecipe.mockImplementation(async () => ({ value: SecretValue.from(KEY) }));
  mocks.signIn.mockImplementation(async () => ({ url: HOME }));
  mocks.checkSession.mockImplementation(async () => ({ signedIn: true, url: HOME }));
  mocks.resolveRecipe.mockImplementation((r: unknown, s?: string) => real.resolveRecipe(r, s));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripe descriptor", () => {
  const stripe = FACADES.find((f) => f.id === "stripe")!;
  const key = (value: string) => SecretValue.from(value);
  const ACCOUNT = "acct_1AbCdEfGhIjKl";
  const rk = (mode: string) => ["rk", mode, "51AbCdEfGhIjKlMnOpQrStUv"].join("_");

  it("names the connection after account and mode, and defaults to a sandbox", () => {
    expect(stripe.connectionFor!({ account: ACCOUNT, mode: "live" })).toBe(`stripe:${ACCOUNT}:live`);
    expect(stripe.connectionFor!({ account: ACCOUNT })).toBe(`stripe:${ACCOUNT}:sandbox`);
    expect(stripe.connectionFor!({ mode: "live" })).toBe("stripe::live");
    expect(stripe.keyName(new Date("2026-11-01T10:05:00Z"), { mode: "live" })).toBe("secret-desk-live-2026-11-01-1005");
    expect(stripe.keyName(new Date("2026-11-01T10:05:00Z"), {})).toBe("secret-desk-test-2026-11-01-1005");
  });

  it("refuses a key of the other mode", async () => {
    const rt = await setup();
    expect(await stripe.verifyKey!(rt, key(rk("live")), { account: ACCOUNT, mode: "sandbox" })).toBe("The key is a live key, but the sandbox mode was chosen.");
    expect(await stripe.verifyKey!(rt, key(rk("test")), { account: ACCOUNT, mode: "live" })).toBe("The key is a sandbox key, but the live mode was chosen.");
  });

  it("asks the account of the key, and falls back to the account id inside the key", async () => {
    const answers: { status?: number; body?: string; throws?: boolean }[] = [];
    const rt = await setup({
      fetch: () => {
        const a = answers.shift()!;
        if (a.throws) throw new Error("network down");
        return new Response(a.body ?? "{}", { status: a.status ?? 200 });
      },
    });
    const inputs = { account: ACCOUNT, mode: "sandbox" };
    answers.push({ body: JSON.stringify({ id: ACCOUNT }) });
    expect(await stripe.verifyKey!(rt, key(rk("test")), inputs)).toBeNull();
    answers.push({ body: JSON.stringify({ id: "acct_1Other" }) });
    expect(await stripe.verifyKey!(rt, key(rk("test")), inputs)).toMatch(/belongs to the account acct_1Other/);
    for (const a of [{ status: 403 }, { body: "not json" }, { body: JSON.stringify({ id: 5 }) }, { throws: true }]) {
      answers.push(a);
      expect(await stripe.verifyKey!(rt, key(rk("test")), inputs), JSON.stringify(a)).toBeNull();
      answers.push(a);
      expect(await stripe.verifyKey!(rt, key("rk_test_made_up_without_account"), inputs), JSON.stringify(a)).toBe("The account of the new key could not be read, so it was not stored.");
    }
    answers.push({ status: 403 });
    expect(await stripe.verifyKey!(rt, key(rk("test")), { mode: "sandbox" })).toBe("The account of the new key could not be read, so it was not stored.");
  });
});

describe("listing", () => {
  it("a recipe that is not loaded makes a provider unavailable, with empty details", async () => {
    const rt = await setup();
    vi.spyOn(rt.automation, "recipe").mockReturnValue(undefined);
    const list = await listFacades(rt, human);
    expect(list[0]).toMatchObject({ available: false, reason: "The recipe with the guided sign-in is not loaded.", host: null, hostBy: null, hosts: [], methods: [], passwordless: false, inputs: [] });
    expect(() => startFacadeSignIn(rt, human, "revenuecat", body())).toThrow(/not loaded/);
  });

  it("describes the inputs of a provider, with fallbacks for what the recipe leaves out", async () => {
    const rt = await setup();
    const original = rt.automation.recipe.bind(rt.automation);
    vi.spyOn(rt.automation, "recipe").mockImplementation((id) => {
      const r = original(id);
      if (!r || id !== "stripe-restricted-key") return r;
      return { ...r, params: r.params.map((p) => ({ ...p, labelEn: undefined, options: undefined, pattern: undefined, help: undefined })) } as Recipe;
    });
    const stripe = (await listFacades(rt, human)).find((f) => f.id === "stripe")!;
    expect(stripe.inputs).toEqual([
      { param: "account", label: "Stripe-Konto", labelEn: "Stripe-Konto", options: null, pattern: null, help: null },
      { param: "mode", label: "Modus", labelEn: "Modus", options: null, pattern: null, help: null },
    ]);
  });

  it("a recipe without status information, a provider without a promise, and several portals are listed", async () => {
    const rt = await setup();
    vi.spyOn(rt.automation, "info").mockReturnValue({ ...rt.automation.info(), recipes: [] });
    const peecho = rt.automation.recipe("peecho-api-keys")!;
    const original = rt.automation.recipe.bind(rt.automation);
    vi.spyOn(rt.automation, "recipe").mockImplementation((id) => (id === "revenuecat-secret-api-key" ? peecho : original(id)));
    const base = FACADES.find((f) => f.id === "openai")!;
    const { promise: _promise, ...withoutPromise } = base;
    (FACADES as unknown as unknown[]).push({ ...withoutPromise, id: "made-up", recipeId: "revenuecat-secret-api-key" });
    try {
      const list = await listFacades(rt, human);
      expect(list.find((f) => f.id === "revenuecat")).toMatchObject({ recipeStatus: null, hostBy: "portal", hosts: [{ value: "live", host: "www.peecho.com" }, { value: "test", host: "test.www.peecho.com" }] });
      expect(list.find((f) => f.id === "made-up")?.promise).toBeNull();
    } finally {
      (FACADES as unknown as unknown[]).pop();
    }
  });

  it("a provider counts as connected through any of its account connections", async () => {
    const rt = await setup();
    rt.connections.session.set("stripe:acct_1Expired:live", "made_up_old_key", "2020-01-01");
    expect((await listFacades(rt, human)).find((f) => f.id === "stripe")?.connected).toBe(false);
    rt.connections.session.set("stripe:acct_1AbCdEfGhIjKl:live", "made_up_stripe_key", null);
    expect((await listFacades(rt, human)).find((f) => f.id === "stripe")?.connected).toBe(true);
  });

  it("every route refuses an unknown provider", async () => {
    const rt = await setup();
    const calls: (() => unknown)[] = [
      () => getFacadeState(rt, human, "nope"),
      () => submitFacadeCode(rt, human, "nope", {}),
      () => submitFacadeAccess(rt, human, "nope", {}),
      () => submitFacadeConfirm(rt, human, "nope", {}),
      () => cancelFacade(rt, human, "nope"),
      () => startFacadeSignIn(rt, human, "nope", body()),
      () => startFacadeConnect(rt, human, "nope", {}),
    ];
    for (const c of calls) expect(c).toThrow(/Unknown provider: nope/);
    await expect(checkFacadeSession(rt, human, "nope")).rejects.toThrow(/Unknown provider/);
    expect(() => getRecipeSignInState(rt, human, "nope")).toThrow(/Unknown recipe: nope/);
  });
});

describe("input", () => {
  it("credentials: length and control characters, with or without a password", () => {
    expect(() => credentialsFrom({ username: "a".repeat(255), password: "x" })).toThrow(/email is not valid/);
    expect(() => credentialsFrom({ username: "a\nb", password: "x" })).toThrow(/email is not valid/);
    expect(() => credentialsFrom({ username: "a@b.test", password: "x".repeat(1025) })).toThrow(/password is not valid/);
    expect(() => credentialsFrom({ username: "a@b.test", password: "x\u0000y" })).toThrow(/password is not valid/);
    expect(credentialsFrom({ username: "a@b.test", password: "ignored" }, false)).toEqual({ username: "a@b.test", password: "" });
  });

  it("the portal is chosen by host or by the host parameter; anything else is a clear request", async () => {
    const rt = await setup();
    const recipe = rt.automation.recipe("peecho-api-keys")!;
    expect(portalFrom(rt.automation.recipe("revenuecat-secret-api-key")!, {}).host).toBe("app.revenuecat.com");
    expect(portalFrom(recipe, { host: "live" }).host).toBe("www.peecho.com");
    expect(portalFrom(recipe, {}, { portal: "test" }).host).toBe("test.www.peecho.com");
    expect(() => portalFrom(recipe, {})).toThrow(/Choose the portal first/);
    mocks.resolveRecipe.mockImplementation(() => {
      throw new TypeError("unexpected");
    });
    expect(() => portalFrom(recipe, { host: "live" })).toThrow(TypeError);
    mocks.resolveRecipe.mockImplementation(() => {
      throw new RecipeHostError("no host chosen");
    });
    expect(() => portalFrom(recipe, { host: "live" })).toThrow(InventoryError);
  });

  it("project and inputs are checked before any browser opens", async () => {
    const rt = await setup();
    expect(() => startFacadeSignIn(rt, human, "openai", body({ projectId: "p1" }))).toThrow(/no project to choose/);
    expect(() => startFacadeSignIn(rt, human, "revenuecat", body({ projectId: "NOT VALID!" }))).toThrow(/expected format/);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { mode: "live" } }))).toThrow(/Stripe account is missing/);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { account: "nope", mode: "live" } }))).toThrow(/does not have the expected format/);
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { account: "acct_1AbCdEfGhIjKl", mode: "staging" } }))).toThrow(/Mode is not allowed/);
    const original = rt.automation.recipe.bind(rt.automation);
    vi.spyOn(rt.automation, "recipe").mockImplementation((id) => {
      const r = original(id);
      return r && id === "stripe-restricted-key" ? ({ ...r, params: r.params.filter((p) => p.key !== "mode") } as Recipe) : r;
    });
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { account: "acct_1AbCdEfGhIjKl" } }))).toThrow(/no parameter mode/);
  });

  it("messages fall back to the German label when the recipe has no English one", async () => {
    const rt = await setup();
    const original = rt.automation.recipe.bind(rt.automation);
    vi.spyOn(rt.automation, "recipe").mockImplementation((id) => {
      const r = original(id);
      return r && id === "stripe-restricted-key" ? ({ ...r, params: r.params.map((p) => ({ ...p, labelEn: undefined })) } as Recipe) : r;
    });
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { mode: "live" } }))).toThrow("Stripe-Konto is missing.");
    expect(() => startFacadeSignIn(rt, human, "stripe", body({ inputs: { account: "nope", mode: "live" } }))).toThrow("Stripe-Konto does not have the expected format.");
  });

  it("an optional input may be left out", async () => {
    const rt = await setup();
    const original = rt.automation.recipe.bind(rt.automation);
    vi.spyOn(rt.automation, "recipe").mockImplementation((id) => {
      const r = original(id);
      return r && id === "stripe-restricted-key" ? ({ ...r, params: r.params.map((p) => (p.key === "mode" ? { ...p, required: false } : p)) } as Recipe) : r;
    });
    startFacadeConnect(rt, human, "stripe", { inputs: { account: "acct_1AbCdEfGhIjKl" } });
    await until(() => finished(rt, "stripe"));
    expect(stateOf(rt, "stripe").status).toBe("failed");
  });

  it("automation off or a recipe without guided sign-in", async () => {
    const rt = await setup();
    vi.spyOn(rt.automation, "recipe").mockReturnValue(undefined);
    expect(() => startFacadeConnect(rt, human, "revenuecat", {})).toThrow(/not loaded/);
    expect(() => startRecipeSignIn(rt, human, "revenuecat-secret-api-key", body())).toThrow(/no guided sign-in/);
    await expect(checkRecipeSession(rt, human, "revenuecat-secret-api-key")).rejects.toThrow(/no guided sign-in/);
    (rt.automation as { enabled: boolean }).enabled = false;
    expect(() => startRecipeSignIn(rt, human, "x", body())).toThrow(/automation is off/);
    await expect(checkRecipeSession(rt, human, "x")).rejects.toThrow(/automation is off/);
  });
});

describe("failures of a run", () => {
  const failing = async (err: unknown) => {
    const rt = await setup();
    vi.spyOn(rt.automation, "newDriver").mockRejectedValue(err);
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    return stateOf(rt);
  };

  it("maps errors of the sign-in to codes with fixed texts", async () => {
    expect((await failing(new LoginError("abort", "aborted"))).failure).toMatchObject({ code: "cancelled" });
    expect((await failing(new LoginError("timeout", "slow", "too slow"))).failure).toMatchObject({ code: "timeout", message: "slow", messageEn: "too slow" });
    expect((await failing(new LoginError("rejected", "refused"))).failure).toMatchObject({ code: "rejected", messageEn: "refused" });
  });

  it("maps recipe errors; a possibly created key is named", async () => {
    const make = async (err: RecipeRunError) => {
      const rt = await setup();
      mocks.runRecipe.mockRejectedValue(err);
      return connect(rt);
    };
    expect((await make(new RecipeRunError("abort", "stop"))).failure?.code).toBe("cancelled");
    expect((await make(new RecipeRunError("timeout", "slow"))).failure?.code).toBe("timeout");
    expect((await make(new RecipeRunError("host", "wrong"))).failure?.code).toBe("host");
    const capture = await make(new RecipeRunError("capture", "no key", "secret-desk-integration-x"));
    expect(capture.failure?.code).toBe("key");
    expect(capture.createdName).toBe("secret-desk-integration-x");
  });

  it("other errors: first line only, or a generic text, or cancelled", async () => {
    expect((await failing(new Error("boom\nsecond"))).failure).toMatchObject({ code: "browser", message: "boom" });
    expect((await failing(new Error(""))).failure).toMatchObject({ code: "browser", message: "The browser could not be used." });
    expect((await failing("text"))["failure"]).toMatchObject({ code: "browser" });
    const rt = await setup();
    vi.spyOn(rt.automation, "newDriver").mockImplementation(async () => {
      rt.automation.cancel("facade:revenuecat");
      throw new Error("whatever");
    });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    expect(stateOf(rt)).toMatchObject({ status: "cancelled", failure: { code: "cancelled", message: "Cancelled." } });
  });

  it("a connect run that cannot even get a browser fails cleanly", async () => {
    const rt = await setup();
    vi.spyOn(rt.automation, "newDriver").mockRejectedValue(new Error("no browser"));
    const s = await connect(rt, "openai");
    expect(s).toMatchObject({ status: "failed", failure: { code: "browser", message: "no browser" } });
  });
});

describe("the sign-in dialogue", () => {
  it("shows every event, asks for a code and a consent and goes on", async () => {
    const rt = await setup();
    const trail: string[] = [];
    mocks.signIn.mockImplementation(async (_r: unknown, _c: unknown, _d: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "opening" });
      hooks.onEvent?.({ type: "opening" });
      hooks.onEvent?.({ type: "entered", field: "username" });
      hooks.onEvent?.({ type: "entered", field: "password" });
      hooks.onEvent?.({ type: "submitted" });
      hooks.onEvent?.({ type: "needs", need: "mfa-code" });
      trail.push(`code ${stateOf(rt).text}`);
      trail.push(`typed ${await hooks.requestCode!()}`);
      hooks.onEvent?.({ type: "needs", need: "approval", messageEn: "Approve it", detail: "42" });
      trail.push(`approval ${stateOf(rt).text}`);
      hooks.onEvent?.({ type: "needs", need: "approval" });
      trail.push(`approval-default ${stateOf(rt).text}`);
      hooks.onEvent?.({ type: "resumed", need: "approval" });
      hooks.onEvent?.({ type: "needs", need: "consent" });
      trail.push(`consent ${stateOf(rt).text}`);
      trail.push(`accepted ${await hooks.requestConfirm!()}`);
      hooks.onEvent?.({ type: "signed-in", url: HOME });
      return { url: HOME };
    });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => stateOf(rt).needs === "mfa-code");
    expect(() => submitFacadeCode(rt, human, "revenuecat", {})).toThrow(InventoryError);
    submitFacadeCode(rt, human, "revenuecat", { code: "123 456" });
    await until(() => stateOf(rt).needs === "consent");
    expect(() => submitFacadeConfirm(rt, human, "revenuecat", { accept: "yes" })).toThrow(/Say whether/);
    submitFacadeConfirm(rt, human, "revenuecat", { accept: false });
    await until(() => finished(rt));
    expect(trail).toEqual([
      "code Waiting for the one-time code.",
      "typed 123456",
      "approval Approve it",
      "approval-default Approve the sign-in on your device ...",
      "consent Waiting for your confirmation of the authorization.",
      "accepted false",
    ]);
    expect(stateOf(rt).status).toBe("done");
  });

  it("a run whose state has no deadline gets the default one", async () => {
    const rt = await setup();
    const state = rt.automation.state.bind(rt.automation);
    vi.spyOn(rt.automation, "state").mockImplementation((key) => ({ ...state(key), timeoutAt: null }));
    mocks.signIn.mockImplementation(async (_r: unknown, _c: unknown, _d: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "opening" });
      return { url: HOME };
    });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    expect(stateOf(rt).status).toBe("done");
  });

  it("cancelling while the authorization question is open ends the run", async () => {
    const rt = await setup();
    mocks.signIn.mockImplementation(async (_r: unknown, _c: unknown, _d: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "needs", need: "consent" });
      await hooks.requestConfirm!();
      return { url: HOME };
    });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => stateOf(rt).needs === "consent");
    cancelFacade(rt, human, "revenuecat");
    await until(() => finished(rt));
    expect(stateOf(rt).status).toBe("cancelled");
  });

  it("answers are refused when nothing waits for them", async () => {
    const rt = await setup();
    expect(() => submitFacadeCode(rt, human, "revenuecat", { code: "123456" })).toThrow(IssuanceError);
    expect(() => submitFacadeConfirm(rt, human, "revenuecat", { accept: true })).toThrow(IssuanceError);
    expect(() => submitFacadeAccess(rt, human, "revenuecat", { method: "mobile" })).toThrow(IssuanceError);
    expect(() => submitRecipeCode(rt, human, "revenuecat-secret-api-key", { code: "123456" })).toThrow(IssuanceError);
    expect(() => submitRecipeConfirm(rt, human, "revenuecat-secret-api-key", { accept: true })).toThrow(IssuanceError);
    expect(() => cancelFacade(rt, human, "revenuecat")).toThrow(/No sign-in is running/);
    expect(() => cancelRecipeSignIn(rt, human, "revenuecat-secret-api-key")).toThrow(/No sign-in is running/);
  });

  it("the plain recipe sign-in: signs in, remembers the host, and can be cancelled while it waits", async () => {
    const rt = await setup();
    startRecipeSignIn(rt, human, "revenuecat-secret-api-key", body());
    await until(() => getRecipeSignInState(rt, human, "revenuecat-secret-api-key").status === "done");
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "app.revenuecat.com", signedIn: true, source: "connect" }]);
    mocks.signIn.mockImplementation(async (_r: unknown, _c: unknown, _d: unknown, hooks: LoginHooks) => {
      hooks.onEvent?.({ type: "needs", need: "mfa-code" });
      await hooks.requestCode!();
      return { url: HOME };
    });
    startRecipeSignIn(rt, human, "revenuecat-secret-api-key", body());
    await until(() => getRecipeSignInState(rt, human, "revenuecat-secret-api-key").needs === "mfa-code");
    expect(cancelRecipeSignIn(rt, human, "revenuecat-secret-api-key").status).toBe("waiting-human");
    await until(() => getRecipeSignInState(rt, human, "revenuecat-secret-api-key").status === "cancelled");
  });

  it("a recipe sign-in that fails reports it, a second one while busy is refused", async () => {
    const rt = await setup();
    mocks.signIn.mockRejectedValue(new LoginError("rejected", "refused"));
    startRecipeSignIn(rt, human, "revenuecat-secret-api-key", body());
    await until(() => getRecipeSignInState(rt, human, "revenuecat-secret-api-key").status === "failed");
    rt.automation.begin("busy-run", "p", { text: "x" });
    expect(() => startRecipeSignIn(rt, human, "revenuecat-secret-api-key", { username: "me@example.test", password: "made-up-pw-1" })).toThrow(IssuanceError);
  });
});

describe("connecting with the signed-in browser", () => {
  it("detects the project from the page when the sign-in address does not name it", async () => {
    const rt = await setup();
    mocks.signIn.mockResolvedValue({ url: undefined });
    mocks.checkSession.mockResolvedValue({ signedIn: true, url: HOME });
    startFacadeSignIn(rt, human, "revenuecat", body());
    await until(() => finished(rt));
    expect(stateOf(rt)).toMatchObject({ status: "done", result: { projectId: PROJECT, connected: true, counts: { apps: 1 } } });
  });

  it("without a project from the address or the page, it asks for the project", async () => {
    const rt = await setup();
    mocks.checkSession.mockResolvedValue({ signedIn: false, url: "" });
    const s = await connect(rt);
    expect(s.failure?.code).toBe("project-unknown");
    mocks.checkSession.mockResolvedValue({ signedIn: true, url: "https://app.revenuecat.com/somewhere" });
    expect((await connect(rt)).failure?.code).toBe("project-unknown");
  });

  it("counts only what the provider could list, and survives a failing connection test", async () => {
    const calls: string[] = [];
    const rt = await setup({
      fetch: (u) => {
        calls.push(u);
        if (u.includes("/apps")) return new Response("{}", { status: 500 });
        if (u.includes("/v2/projects")) return new Response(JSON.stringify({ items: [{ id: PROJECT, name: "Main" }] }), { status: 200 });
        return new Response(null, { status: 404 });
      },
    });
    startFacadeConnect(rt, human, "revenuecat", { projectId: PROJECT });
    await until(() => finished(rt));
    expect(stateOf(rt).result).toMatchObject({ connected: true, counts: { projects: 1 } });
    expect(stateOf(rt).result?.counts).not.toHaveProperty("apps");
  });

  it("a connection test that cannot run leaves the key stored and reports the failed test", async () => {
    const rt = await setup();
    const status = rt.connections.status.bind(rt.connections);
    vi.spyOn(rt.connections, "status").mockImplementation(async (id) => {
      if (rt.automation.state("facade:revenuecat").phase === "testing") throw new Error("store unreadable");
      return status(id);
    });
    const s = await connect(rt, "revenuecat", { projectId: PROJECT });
    expect(s.failure?.code).toBe("test");
    expect(rt.connections.session.has("revenuecat")).toBe(true);
  });

  it("stores in the vault when there is one, and reports a vault that cannot store", async () => {
    const stored: string[] = [];
    const ok = await setup({ vault: { set: async (id) => void stored.push(id) } });
    expect((await connect(ok, "revenuecat", { projectId: PROJECT })).status).toBe("done");
    expect(stored).toEqual(["revenuecat"]);
    const bad = await setup({ vault: { set: async () => Promise.reject(new Error("disk full")) } });
    const s = await connect(bad, "revenuecat", { projectId: PROJECT });
    expect(s.failure?.code).toBe("store");
    expect(s.createdName).toMatch(/^secret-desk-integration-/);
  });

  it("a key of the wrong account is never stored", async () => {
    const rt = await setup({ fetch: () => new Response(JSON.stringify({ id: "acct_1Other" }), { status: 200 }) });
    const rk = ["rk", "test", "51AbCdEfGhIjKlMnOpQrStUv"].join("_");
    mocks.runRecipe.mockResolvedValue({ value: SecretValue.from(rk) });
    const s = await connect(rt, "stripe", { inputs: { account: "acct_1AbCdEfGhIjKl", mode: "sandbox" } });
    expect(s.failure?.code).toBe("key");
    expect(rt.connections.session.has("stripe:acct_1AbCdEfGhIjKl:sandbox")).toBe(false);
  });

  it("an optional admin key: an unsupported account is a ready browser, with the vault noted", async () => {
    const rt = await setup();
    mocks.runRecipe.mockRejectedValue(new RecipeRunError("unsupported", "no admin keys here"));
    const s = await connect(rt, "anthropic");
    expect(s).toMatchObject({ status: "done", result: { browserOnly: true, connected: false, storedIn: "session" } });
    const stored = await setup({ vault: { set: async () => undefined } });
    mocks.runRecipe.mockRejectedValue(new RecipeRunError("unsupported", "no admin keys here"));
    expect((await connect(stored, "anthropic")).result?.storedIn).toBe("vault");
    const required = await setup();
    mocks.runRecipe.mockRejectedValue(new RecipeRunError("unsupported", "no"));
    expect((await connect(required, "openai")).failure?.code).toBe("key");
  });

  it("a grafana key carries its expiry day", async () => {
    const rt = await setup();
    mocks.runRecipe.mockResolvedValue({ value: SecretValue.from("glc_made_up_key") });
    await connect(rt, "grafana");
    expect((await rt.connections.status("grafana-cloud")).expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("questions in the middle of a key run", () => {
  const askOnce = { methods: ["mobile", "code"], attempt: 1, maxAttempts: 3 } as never;

  it("the recipe's identity question is answered in the portal and its events are shown", async () => {
    const rt = await setup();
    const trail: string[] = [];
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      const answer = hooks.access!.request({ ...(askOnce as object), problem: "wrong-code" } as never);
      trail.push(`ask ${JSON.stringify(stateOf(rt).ask)}`);
      submitFacadeAccess(rt, human, "revenuecat", { method: "mobile" });
      trail.push(`answer ${JSON.stringify(await answer)}`);
      hooks.access!.onEvent?.({ type: "checking", method: "code" });
      trail.push(`checking ${stateOf(rt).text}`);
      hooks.access!.onEvent?.({ type: "confirmed" });
      trail.push(`confirmed ${stateOf(rt).text}`);
      hooks.access!.onEvent?.({ type: "mobile", number: "17" });
      hooks.onResumed?.();
      return { value: SecretValue.from(KEY) };
    });
    startFacadeConnect(rt, human, "revenuecat", { projectId: PROJECT });
    await until(() => finished(rt));
    expect(trail[0]).toContain('"problem":"wrong-code"');
    expect(trail.slice(1)).toEqual(['answer {"method":"mobile"}', "checking RevenueCat is checking the verification.", "confirmed Verification done."]);
    expect(stateOf(rt).status).toBe("done");
  });

  it("an answer for a question that ended is refused", async () => {
    const rt = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      void hooks.access!.request(askOnce).catch(() => undefined);
      rt.automation.update("facade:revenuecat", { ask: { type: "access", stage: "mobile", number: "1" } });
      expect(() => submitFacadeAccess(rt, human, "revenuecat", { method: "mobile" })).toThrow(/not waiting for a verification/);
      return { value: SecretValue.from(KEY) };
    });
    expect((await connect(rt, "revenuecat", { projectId: PROJECT })).status).toBe("done");
    expect(() => submitFacadeAccess(rt, human, "revenuecat", { method: "mobile" })).toThrow(IssuanceError);
  });

  it("cancelling while the question is open rejects it", async () => {
    const rt = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      await hooks.access!.request(askOnce);
      return { value: SecretValue.from(KEY) };
    });
    startFacadeConnect(rt, human, "revenuecat", { projectId: PROJECT });
    await until(() => stateOf(rt).ask?.type === "access");
    cancelFacade(rt, human, "revenuecat");
    await until(() => finished(rt));
    expect(stateOf(rt).status).toBe("cancelled");
  });

  it("a question that arrives after the cancel is rejected at once", async () => {
    const rt = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      rt.automation.cancel("facade:revenuecat");
      await hooks.access!.request(askOnce);
      return { value: SecretValue.from(KEY) };
    });
    expect((await connect(rt, "revenuecat", { projectId: PROJECT })).status).toBe("cancelled");
  });

  it("a pause with an unrelated error is still a check the script cannot do", async () => {
    const rt = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "pause", reason: "check", url: "https://app.revenuecat.com/x" });
      throw new Error("stopped");
    });
    const s = await connect(rt, "revenuecat", { projectId: PROJECT });
    expect(s.failure?.code).toBe("captcha");
    expect(s.createdName).toBeUndefined();
  });

  it("a hand-over to the human in the browser ends the run: a pause is a check, a login means the session was lost", async () => {
    const rt = await setup();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "pause", reason: "check", url: "https://app.revenuecat.com/x" });
      throw new RecipeRunError("abort", "stopped", "secret-desk-integration-y");
    });
    const pause = await connect(rt, "revenuecat", { projectId: PROJECT });
    expect(pause.failure?.code).toBe("captcha");
    expect(pause.createdName).toBe("secret-desk-integration-y");
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "login", reason: "sign in", url: "https://app.revenuecat.com/login" });
      hooks.onResumed?.();
      throw new Error("stopped");
    });
    const login = await connect(rt, "revenuecat", { projectId: PROJECT });
    expect(login.failure?.code).toBe("session-lost");
    expect(login.createdName).toBeUndefined();
    mocks.runRecipe.mockImplementation(async (_r: unknown, _v: unknown, _d: unknown, hooks: RunHooks) => {
      hooks.onWaitingForHuman?.({ kind: "login", reason: "sign in", url: "https://app.revenuecat.com/login" });
      throw new RecipeRunError("abort", "stopped", "secret-desk-integration-z");
    });
    expect((await connect(rt, "revenuecat", { projectId: PROJECT })).createdName).toBe("secret-desk-integration-z");
  });
});

describe("checking the session", () => {
  it("one check per portal for a recipe with several hosts; the answer is remembered", async () => {
    const rt = await setup();
    mocks.checkSession.mockResolvedValue({ signedIn: false, url: "" });
    const r = await checkRecipeSession(rt, human, "peecho-api-keys", { host: "live" });
    expect(r.signedIn).toBe(false);
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "www.peecho.com", signedIn: false }]);
    await expect(checkRecipeSession(rt, human, "peecho-api-keys")).rejects.toThrow(/Choose the portal first/);
  });

  it("a facade whose recipe has several hosts is checked per host", async () => {
    const rt = await setup();
    const peecho = rt.automation.recipe("peecho-api-keys")!;
    vi.spyOn(rt.automation, "recipe").mockReturnValue(peecho);
    expect((await checkFacadeSession(rt, human, "revenuecat", { host: "test" })).signedIn).toBe(true);
    expect(rt.automation.signInChecks()).toMatchObject([{ host: "test.www.peecho.com" }]);
  });

  it("the scheduled check works without options, and a busy browser is reported", async () => {
    const rt = await setup();
    const recipe = rt.automation.recipe("revenuecat-secret-api-key")!;
    expect((await checkRecipeSessionScheduled(rt, recipe)).signedIn).toBe(true);
    expect(mocks.checkSession.mock.calls.at(-1)?.[2]).toMatchObject({ timeoutSeconds: 15 });
    rt.automation.begin("other", "p", { text: "x" });
    expect((await checkRecipeSessionScheduled(rt, recipe)).failure?.code).toBe("busy");
  });

  it("agents may not use any of this", async () => {
    const rt = await setup();
    await expect(checkFacadeSession(rt, agent, "revenuecat")).rejects.toThrow(PolicyError);
    expect(() => startFacadeConnect(rt, agent, "revenuecat", {})).toThrow(PolicyError);
  });
});
