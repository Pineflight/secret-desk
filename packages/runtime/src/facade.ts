import {
  LoginError,
  RecipeRunError,
  checkSession,
  loginMethodsOf,
  type LoginMethodInfo,
  type LoginMethodId,
  paramValueProblem,
  recipeParamVars,
  runRecipe,
  signIn,
  type LoginCredentials,
  type LoginEvent,
  type Recipe,
} from "@secret-desk/automation";
import { InventoryError, IssuanceError, redact, STRIPE_ACCOUNT_PATTERN, stripeConnectionId, stripeKeyMode, type SecretValue, type StripeAccountMode } from "@secret-desk/core";
import { requireHuman, type Actor } from "./agent-api.js";
import type { AutomationRunState, FacadeTimelineEntry } from "./automation.js";
import { checkConnection, stripeKeyCarriesAccount, type ConnectionCheckResult } from "./connection-check.js";
import { getConnectionResources } from "./params.js";
import type { Runtime } from "./runtime.js";

/**
 * Provider facade: one guided flow per provider that signs in through the remote browser, creates the integration key the
 * portal needs, stores it as the provider's connection and tests it.
 *
 * The human types the provider sign-in (email, password) for this run only. The values live in memory for the run, are typed
 * only into pages on the recipe's hosts and are wiped afterwards: they are not stored, not logged, not part of any state,
 * error, screenshot or response. Agents can never use any of this (human-only routes, no MCP tool).
 */

/** What a provider needs to join the facade. The recipe carries the sign-in (login.form) and the key creation. */
export interface FacadeDescriptor {
  /** Provider id shown in the portal. */
  id: string;
  label: string;
  /** Recipe with `login.form` and the steps that create the integration key. */
  recipeId: string;
  /** Connection that receives the key (see connection-guides.ts). For a provider with `inputs` this is the general connection that opens the flow. */
  connectionId: string;
  /** Name of the key at the provider. `inputs` are the values the human chose for this run. */
  keyName(now: Date, inputs: Record<string, string>): string;
  /**
   * Recipe parameters the human chooses for each run (for example the Stripe account and mode). Each is validated against the
   * recipe's parameter specification and passed to the recipe.
   */
  inputs: string[];
  /** The connection that receives the key of this run, when it depends on `inputs` (one per Stripe account and mode). */
  connectionFor?(inputs: Record<string, string>): string;
  /** Connections starting with this prefix also count as connected (the per-account connections of Stripe). */
  connectionPrefix?: string;
  /**
   * Checks the new key before it is stored (for example that it belongs to the chosen account). Resolves to a problem text, or
   * null when the key is fine.
   */
  verifyKey?(rt: Runtime, key: SecretValue, inputs: Record<string, string>): Promise<string | null>;
  /** Fixed recipe parameters of the integration key (for example the read-only permission). */
  keyParams: Record<string, string>;
  /** The recipe parameter that names the provider project, and how to read it from a dashboard address. */
  project: { param: string; fromUrl: RegExp } | null;
  /** Catalog key of the sentence that says what kind of key this is (shown in the connect dialog). Without it nothing is shown. */
  promise?: string;
  /** Discovery kinds whose option counts are reported after the connection test ("1 project, 3 apps"). */
  summary: { key: string; kind: string }[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The account a Stripe key belongs to (`GET /v1/account`). Null when the key is refused or the answer has no id. */
async function stripeKeyAccount(rt: Runtime, key: SecretValue): Promise<string | null> {
  try {
    const res = await rt.fetch("https://api.stripe.com/v1/account", { method: "GET", headers: { Authorization: `Bearer ${key.reveal()}`, Accept: "application/json", "User-Agent": "secret-desk" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}

export const FACADES: readonly FacadeDescriptor[] = [
  {
    id: "revenuecat",
    label: "RevenueCat",
    recipeId: "revenuecat-secret-api-key",
    connectionId: "revenuecat",
    // Date and time (UTC): a second key on the same day must not share a name, the key list is found by that name.
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    // v2 secret key, Project configuration: Read only, every other section stays "No access" (the recipe default).
    keyParams: { projectConfiguration: "Read only" },
    promise: "facade.promise.revenuecat",
    project: { param: "projectId", fromUrl: /^https:\/\/app\.revenuecat\.com\/projects\/([a-z0-9]+)(?:\/|$)/ },
    inputs: [],
    summary: [
      { key: "projects", kind: "revenuecat.project" },
      { key: "apps", kind: "revenuecat.app" },
    ],
  },
  {
    // The Admin API key is created once through the signed-in browser; project keys are issued with it from then on.
    id: "openai",
    label: "OpenAI",
    recipeId: "openai-admin-key",
    connectionId: "openai",
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: {},
    promise: "facade.promise.openai",
    project: null,
    inputs: [],
    summary: [{ key: "projects", kind: "openai.project" }],
  },
  {
    // The Admin API cannot create API keys: the admin key lets the portal list workspaces and check and deactivate keys, while
    // the keys themselves come from the browser recipe `anthropic-api-key`. The Console signs in by email code (no password).
    id: "anthropic",
    label: "Anthropic",
    recipeId: "anthropic-admin-key",
    connectionId: "anthropic",
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: {},
    promise: "facade.promise.anthropic",
    project: null,
    inputs: [],
    summary: [{ key: "workspaces", kind: "anthropic.workspace" }],
  },
  {
    // One Stripe organization holds several accounts, each with a sandbox and a live mode. The human names the account and the
    // mode; the key is created in that account and stored as the connection of exactly that (account, mode).
    id: "stripe",
    label: "Stripe",
    recipeId: "stripe-restricted-key",
    connectionId: "stripe",
    keyName: (now, inputs) => `secret-desk-${inputs["mode"] === "live" ? "live" : "test"}-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    // Only webhook endpoints: that is all the portal needs from Stripe.
    keyParams: { preset: "webhooks" },
    promise: "facade.promise.stripe",
    inputs: ["account", "mode"],
    connectionFor: (inputs) => stripeConnectionId(inputs["account"] ?? "", inputs["mode"] === "live" ? "live" : "sandbox"),
    connectionPrefix: "stripe:",
    async verifyKey(rt, key, inputs) {
      const mode: StripeAccountMode | undefined = stripeKeyMode(key.reveal());
      const want: StripeAccountMode = inputs["mode"] === "live" ? "live" : "sandbox";
      if (mode && mode !== want) return `The key is a ${mode === "live" ? "live" : "sandbox"} key, but the ${want} mode was chosen.`;
      const have = await stripeKeyAccount(rt, key);
      if (have === null) {
        // Restricted keys usually may not read /v1/account; the key itself names its account.
        if (stripeKeyCarriesAccount(key.reveal(), inputs["account"] ?? "")) return null;
        return "The account of the new key could not be read, so it was not stored.";
      }
      if (have !== inputs["account"]) return `The new key belongs to the account ${have}, not to ${inputs["account"]}, so it was not stored.`;
      return null;
    },
    project: null,
    summary: [],
  },
];

export const facadeById = (id: string): FacadeDescriptor | undefined => FACADES.find((f) => f.id === id);

/** Integration a browser recipe belongs to (its facade's connection), so its secrets count for that integration. */
export const facadeConnectionForRecipe = (recipeId: string | undefined): string | null =>
  (recipeId ? FACADES.find((f) => f.recipeId === recipeId)?.connectionId : undefined) ?? null;

/** Phases of a facade run in the order the portal shows them. `code`, `approval` and `consent` appear only when the provider asks. */
export const FACADE_PHASES = ["opening", "username", "password", "code", "approval", "consent", "signed-in", "key", "stored", "testing", "connected"] as const;
export type FacadePhase = (typeof FACADE_PHASES)[number];

export type FacadeFailureCode = "rejected" | "timeout" | "cancelled" | "host" | "step" | "page" | "busy" | "code" | "unsupported" | "browser" | "project-unknown" | "session-lost" | "key" | "store" | "test" | "captcha";

export interface FacadeResult {
  /** The key was created, stored and the connection test did not fail. */
  connected: boolean;
  /** The connection that received the key (differs from the facade's general connection for a Stripe account). */
  connectionId: string;
  storedIn: "vault" | "session";
  keyName: string;
  projectId: string | null;
  check: ConnectionCheckResult | null;
  /** Counts reported by the provider after the connection test, keyed by the descriptor's summary keys. */
  counts: Record<string, number>;
}

export interface FacadeInput {
  param: string;
  label: string;
  labelEn: string;
  /** Fixed choices, if the recipe declares any. */
  options: string[] | null;
  /** Regular expression the value must match, if the recipe declares one. */
  pattern: string | null;
  help: string | null;
}

export interface FacadeInfo {
  id: string;
  label: string;
  recipeId: string;
  connectionId: string;
  /** false: automation is off or the recipe is missing; `reason` says why. */
  available: boolean;
  reason: string | null;
  /** The recipe's STATUS comment: what is verified and what is not. */
  recipeStatus: string | null;
  host: string | null;
  connected: boolean;
  /** The provider names a project the key belongs to; the portal may ask for it as a fallback. */
  needsProject: boolean;
  /** Recipe parameters the human chooses for each run, with their specification (account, mode ...). */
  inputs: FacadeInput[];
  timeoutMinutes: number;
  /** The ways to sign in: the provider's own form (email) and the identity providers the recipe offers. */
  methods: LoginMethodInfo[];
  /** Catalog key of the sentence about the key this flow creates, or null. */
  promise: string | null;
  /** The email sign-in has no password (the provider sends a one-time code); the portal then asks only for the email. */
  passwordless: boolean;
}

const stateKey = (id: string): string => `facade:${id}`;
const checkKey = (id: string): string => `facade-check:${id}`;

/** One pending one-time code request per facade run. */
const codeWaiters = new Map<string, { resolve: (code: string) => void; reject: (err: Error) => void }>();

/** One pending authorization (OAuth consent) question per facade run. */
const confirmWaiters = new Map<string, { resolve: (accepted: boolean) => void; reject: (err: Error) => void }>();

const MAX_TEXT = 400;

function descriptorOf(rt: Runtime, id: string): { d: FacadeDescriptor; recipe: Recipe } {
  const d = facadeById(id);
  if (!d) throw new InventoryError(`Unknown provider: ${id}`);
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(d.recipeId);
  if (!recipe?.login?.form) throw new InventoryError(`The recipe ${d.recipeId} with the guided sign-in is not loaded.`);
  return { d, recipe };
}

export async function listFacades(rt: Runtime, actor: Actor): Promise<FacadeInfo[]> {
  requireHuman(actor, "Open the provider sign-in");
  const info = rt.automation.info();
  const out: FacadeInfo[] = [];
  for (const d of FACADES) {
    const recipe = rt.automation.recipe(d.recipeId);
    const meta = info.recipes.find((r) => r.id === d.recipeId);
    const reason = !rt.automation.enabled ? "Browser automation is off." : !recipe?.login?.form ? "The recipe with the guided sign-in is not loaded." : null;
    out.push({
      id: d.id,
      label: d.label,
      recipeId: d.recipeId,
      connectionId: d.connectionId,
      available: reason === null,
      reason,
      recipeStatus: meta?.status ?? null,
      host: recipe?.host ?? null,
      connected: await facadeConnected(rt, d),
      needsProject: d.project !== null,
      inputs: d.inputs.flatMap((param) => {
        const spec = recipe?.params.find((p) => p.key === param);
        return spec ? [{ param, label: spec.label, labelEn: spec.labelEn ?? spec.label, options: spec.options ?? null, pattern: spec.pattern ?? null, help: spec.help ?? null }] : [];
      }),
      timeoutMinutes: rt.automation.loginTimeoutMinutes,
      methods: recipe ? loginMethodsOf(recipe) : [],
      promise: d.promise ?? null,
      passwordless: recipe?.login?.form?.passwordless === true,
    });
  }
  return out;
}

async function facadeConnected(rt: Runtime, d: FacadeDescriptor): Promise<boolean> {
  if ((await rt.connections.status(d.connectionId)).connected) return true;
  if (!d.connectionPrefix) return false;
  for (const id of await rt.connections.ids(d.connectionPrefix)) if ((await rt.connections.status(id)).connected) return true;
  return false;
}

export function getFacadeState(rt: Runtime, actor: Actor, id: string): AutomationRunState {
  requireHuman(actor, "Open the provider sign-in");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  return rt.automation.state(stateKey(id));
}

// ------------------------------------------------------------------------------------------ input

const CONTROL = /[\u0000-\u001f\u007f]/;

export function credentialsFrom(body: Record<string, unknown>, needsPassword = true): LoginCredentials {
  const username = typeof body["username"] === "string" ? body["username"].trim() : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  // The password leaves the request body right away: nothing but the run's own object holds it.
  if (typeof body["password"] === "string") body["password"] = "";
  if (!username) throw new InventoryError("The email is missing.");
  if (username.length > 254 || CONTROL.test(username)) throw new InventoryError("The email is not valid.");
  // A passwordless email sign-in (the provider sends a code) takes no password; whatever was sent is dropped.
  if (!needsPassword) return { username, password: "" };
  if (!password) throw new InventoryError("The password is missing.");
  if (password.length > 1024 || CONTROL.test(password)) throw new InventoryError("The password is not valid.");
  return { username, password };
}

/** The chosen sign-in method (default: email). It must be one the recipe offers. */
export function methodFrom(recipe: Recipe, body: Record<string, unknown>): LoginMethodId {
  const raw = typeof body["method"] === "string" && body["method"] ? body["method"] : "email";
  const offered = loginMethodsOf(recipe).find((m) => m.id === raw);
  if (!offered) throw new InventoryError(`This provider does not offer the sign-in method ${String(raw)}.`);
  return offered.id;
}

function projectFrom(d: FacadeDescriptor, recipe: Recipe, body: Record<string, unknown>): string | undefined {
  const raw = typeof body["projectId"] === "string" ? body["projectId"].trim() : "";
  if (!raw) return undefined;
  const spec = d.project ? recipe.params.find((p) => p.key === d.project!.param) : undefined;
  if (!spec) throw new InventoryError("This provider has no project to choose.");
  if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) throw new InventoryError("The project id does not have the expected format.");
  return raw;
}

/** The values the human chose for the recipe parameters named in `inputs`. Each must fit the parameter's pattern and options. */
function inputsFrom(d: FacadeDescriptor, recipe: Recipe, body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const nested = typeof body["inputs"] === "object" && body["inputs"] !== null && !Array.isArray(body["inputs"]) ? (body["inputs"] as Record<string, unknown>) : {};
  for (const param of d.inputs) {
    const spec = recipe.params.find((p) => p.key === param);
    if (!spec) throw new InventoryError(`The recipe has no parameter ${param}.`);
    const raw = typeof nested[param] === "string" ? (nested[param] as string).trim() : "";
    if (!raw) {
      if (spec.required && spec.default === undefined) throw new InventoryError(`${spec.labelEn ?? spec.label} is missing.`);
      continue;
    }
    const problem = paramValueProblem(spec, raw);
    if (problem) throw new InventoryError(`${spec.labelEn ?? spec.label} ${problem === "hat nicht das erwartete Format" ? "does not have the expected format" : "is not allowed"}.`);
    out[param] = raw;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ state

class Tracker {
  readonly #timeline: FacadeTimelineEntry[] = [];
  constructor(
    private readonly rt: Runtime,
    readonly key: string,
  ) {}

  #now(): string {
    return new Date().toISOString();
  }

  /** Enters a phase: the previous one is done. */
  phase(phase: string, patch: Partial<AutomationRunState> = {}): void {
    const last = this.#timeline.at(-1);
    if (last?.phase === phase && last.state === "active") return this.rt.automation.update(this.key, { ...patch, timeline: [...this.#timeline] });
    if (last?.state === "active") last.state = "done";
    this.#timeline.push({ phase, state: "active", at: this.#now() });
    this.rt.automation.update(this.key, { phase, timeline: [...this.#timeline], ...patch });
  }

  /** Marks the active phase as failed. */
  fail(): FacadeTimelineEntry[] {
    const last = this.#timeline.at(-1);
    if (last?.state === "active") last.state = "failed";
    return [...this.#timeline];
  }

  done(): FacadeTimelineEntry[] {
    const last = this.#timeline.at(-1);
    if (last?.state === "active") last.state = "done";
    return [...this.#timeline];
  }
}

interface Failure {
  code: FacadeFailureCode;
  message: string;
  messageEn: string;
  createdName?: string;
}

/** Turns anything a run can throw into a failure with fixed texts. Values never reach the texts. */
function failureOf(err: unknown, known: string[], cancelled: boolean): Failure {
  const clean = (t: string): string => redact(t, known).slice(0, MAX_TEXT);
  if (err instanceof LoginError) {
    const code: FacadeFailureCode = err.kind === "abort" ? "cancelled" : err.kind;
    const message = clean(err.message);
    return { code, message, messageEn: clean(err.messageEn ?? err.message) };
  }
  if (err instanceof RecipeRunError) {
    const code: FacadeFailureCode = err.kind === "abort" ? "cancelled" : err.kind === "timeout" ? "timeout" : err.kind === "host" ? "host" : "key";
    return { code, message: clean(err.message), messageEn: clean(err.message), ...(err.createdName ? { createdName: err.createdName } : {}) };
  }
  if (cancelled) return { code: "cancelled", message: "Cancelled.", messageEn: "Cancelled." };
  const text = err instanceof Error && err.message ? clean(err.message.split("\n")[0] ?? "") : "";
  return { code: "browser", message: text || "The browser could not be used.", messageEn: text || "The browser could not be used." };
}

function mapSignInEvent(t: Tracker, rt: Runtime, e: LoginEvent, timeoutAt: string): void {
  switch (e.type) {
    case "opening":
      return t.phase("opening", { text: "Opening the sign-in page.", status: "running", needs: null, timeoutAt });
    case "entered":
      return t.phase(e.field === "username" ? "username" : "password", { text: e.field === "username" ? "Email entered." : "Password entered.", status: "running" });
    case "submitted":
      return rt.automation.update(t.key, { text: "Sign-in submitted. Waiting for the provider." });
    case "needs": {
      const phase = e.need === "mfa-code" ? "code" : e.need;
      const text = e.need === "mfa-code" ? "Waiting for the one-time code." : e.need === "approval" ? (e.messageEn ?? "Approve the sign-in on your device ...") : "Waiting for your confirmation of the authorization.";
      return t.phase(phase, { status: "waiting-human", needs: e.need, text: text.slice(0, MAX_TEXT), detail: (e.detail ?? "").slice(0, MAX_TEXT) });
    }
    case "resumed":
      return rt.automation.update(t.key, { status: "running", needs: null, detail: "", text: "Continuing." });
    case "signed-in":
      return t.phase("signed-in", { status: "running", needs: null, text: "Signed in." });
  }
}

// ------------------------------------------------------------------------------------------ flows

/**
 * Starts the sign-in. The credentials come from the request body, are held only by this run and wiped when it ends.
 * Returns the initial state at once; the run goes on in the background and the portal polls getFacadeState.
 * After a successful sign-in the key is created, stored and tested (see connect).
 */
export function startFacadeSignIn(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Sign in at the provider");
  const { d, recipe } = descriptorOf(rt, id);
  const projectId = projectFrom(d, recipe, body);
  const inputs = inputsFrom(d, recipe, body);
  const method = methodFrom(recipe, body);
  const creds = credentialsFrom(body, !(method === "email" && recipe.login?.form?.passwordless === true));
  const key = stateKey(id);
  rt.automation.forget(key);
  const minutes = rt.automation.loginTimeoutMinutes;
  let signal: AbortSignal;
  try {
    signal = rt.automation.begin(key, id, { text: "Opening the sign-in page.", kind: "signin", needs: null, phase: "opening", timeline: [], timeoutAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  } catch (err) {
    creds.username = "";
    creds.password = "";
    throw err;
  }
  const state = rt.automation.state(key);
  void runSignIn(rt, actor, d, recipe, creds, projectId, inputs, key, signal, minutes, method);
  return state;
}

async function runSignIn(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, creds: LoginCredentials, projectId: string | undefined, inputs: Record<string, string>, key: string, signal: AbortSignal, minutes: number, method: LoginMethodId): Promise<void> {
  const known = [creds.username, creds.password].filter((x) => x !== "");
  const t = new Tracker(rt, key);
  const timeoutAt = rt.automation.state(key).timeoutAt ?? new Date(Date.now() + minutes * 60_000).toISOString();
  try {
    const driver = await rt.automation.newDriver();
    const result = await signIn(
      recipe,
      creds,
      driver,
      {
        onEvent: (e) => mapSignInEvent(t, rt, e, timeoutAt),
        requestCode: () =>
          new Promise<string>((resolve, reject) => {
            codeWaiters.set(key, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
        requestConfirm: () =>
          new Promise<boolean>((resolve, reject) => {
            confirmWaiters.set(key, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      },
      { timeoutMinutes: minutes, signal, method },
    );
    // The credentials are not needed any more.
    creds.username = "";
    creds.password = "";
    rt.automation.noteSignIn(recipe.host, true, "connect");
    await runConnect(rt, actor, d, recipe, key, signal, t, projectId, inputs, result.url);
  } catch (err) {
    finishFailed(rt, key, t, failureOf(err, known, signal.aborted));
  } finally {
    creds.username = "";
    creds.password = "";
    codeWaiters.delete(key);
    confirmWaiters.delete(key);
  }
}

/** Uses the browser session that is already signed in: creates the key, stores and tests it. Needs no credentials. */
export function startFacadeConnect(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Connect the provider");
  const { d, recipe } = descriptorOf(rt, id);
  const projectId = projectFrom(d, recipe, body);
  const inputs = inputsFrom(d, recipe, body);
  const key = stateKey(id);
  rt.automation.forget(key);
  const signal = rt.automation.begin(key, id, { text: "Using the signed-in browser.", kind: "connect", needs: null, phase: "signed-in", timeline: [], timeoutAt: null });
  const state = rt.automation.state(key);
  const t = new Tracker(rt, key);
  t.phase("signed-in", { status: "running", text: "Using the signed-in browser." });
  void (async () => {
    try {
      await runConnect(rt, actor, d, recipe, key, signal, t, projectId, inputs, undefined);
    } catch (err) {
      finishFailed(rt, key, t, failureOf(err, [], signal.aborted));
    }
  })();
  return state;
}

function finishFailed(rt: Runtime, key: string, t: Tracker, f: Failure): void {
  const cancelled = f.code === "cancelled";
  rt.automation.end(key, {
    status: cancelled ? "cancelled" : "failed",
    text: f.messageEn,
    needs: null,
    timeline: t.fail(),
    failure: { code: f.code, message: f.message, messageEn: f.messageEn },
    ...(f.createdName ? { createdName: f.createdName } : {}),
  });
}

/** Reads the project id from the dashboard address, or loads the provider's home page to find it. */
async function detectProject(rt: Runtime, d: FacadeDescriptor, recipe: Recipe, signal: AbortSignal, url: string | undefined): Promise<string | undefined> {
  if (!d.project) return undefined;
  const pattern = recipe.params.find((p) => p.key === d.project!.param)?.pattern;
  const read = (u: string | undefined): string | undefined => {
    const m = u ? d.project!.fromUrl.exec(u) : null;
    const v = m?.[1];
    return v && (pattern === undefined || new RegExp(pattern).test(v)) ? v : undefined;
  };
  const direct = read(url);
  if (direct) return direct;
  const session = await checkSession(recipe, await rt.automation.newDriver(), { signal, timeoutSeconds: 15 });
  return session.signedIn ? read(session.url) : undefined;
}

async function runConnect(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, key: string, signal: AbortSignal, t: Tracker, projectGiven: string | undefined, inputs: Record<string, string>, signedInUrl: string | undefined): Promise<void> {
  const projectId = projectGiven ?? (await detectProject(rt, d, recipe, signal, signedInUrl));
  if (d.project && !projectId) {
    return finishFailed(rt, key, t, { code: "project-unknown", message: "Signed in, but the project could not be determined. Enter the project id.", messageEn: "Signed in, but the project could not be determined. Enter the project id." });
  }

  // Create the key.
  const now = new Date();
  const keyName = d.keyName(now, inputs);
  const connectionId = d.connectionFor ? d.connectionFor(inputs) : d.connectionId;
  t.phase("key", { status: "running", text: `Creating the integration key ${keyName}.`, needs: null });
  const vars = {
    name: keyName,
    owner: "",
    days: "0",
    date: now.toISOString().slice(0, 10),
    description: "",
    repos: "",
    permissions: "",
    permissionsQuery: "",
    stage: "",
    secretId: "",
    ...recipeParamVars(recipe, { ...d.keyParams, ...inputs, ...(d.project && projectId ? { [d.project.param]: projectId } : {}) }),
  };
  // A recipe that wants the human to sign in again means the browser did not keep the session: stop instead of waiting.
  let sessionLost = false;
  let challenged = false;
  const inner = new AbortController();
  const driver = await rt.automation.newDriver();
  let value: SecretValue;
  try {
    const result = await runRecipe(
      recipe,
      vars,
      driver,
      {
        onWaitingForHuman: (w) => {
          if (w.kind === "pause") {
            // The recipe asks for the human in the browser (for example a password confirmation): the portal does not send the
            // human to the browser, so the run ends with a message and the human tries again.
            challenged = true;
            inner.abort();
            return;
          }
          sessionLost = true;
          inner.abort();
        },
        onResumed: () => {
          if (!sessionLost) rt.automation.update(key, { status: "running", needs: null, text: "Continuing." });
        },
      },
      { loginTimeoutMinutes: rt.automation.loginTimeoutMinutes, signal: AbortSignal.any([signal, inner.signal]) },
    );
    value = result.value;
    // The recipe ran inside the signed-in browser: remember the sign-in at this host.
    rt.automation.noteSignIn(recipe.host, true, "run");
  } catch (err) {
    if (challenged) {
      const createdName = err instanceof RecipeRunError ? err.createdName : undefined;
      return finishFailed(rt, key, t, { code: "captcha", message: "Der Anbieter verlangt eine Pruefung, die das Skript nicht loesen kann.", messageEn: "The provider asks for a check the script cannot do.", ...(createdName ? { createdName } : {}) });
    }
    if (sessionLost) {
      const createdName = err instanceof RecipeRunError ? err.createdName : undefined;
      return finishFailed(rt, key, t, { code: "session-lost", message: "The browser is not signed in (the session was not kept). Sign in again.", messageEn: "The browser is not signed in (the session was not kept). Sign in again.", ...(createdName ? { createdName } : {}) });
    }
    return finishFailed(rt, key, t, failureOf(err, [], signal.aborted));
  }

  // A key of the wrong account or mode is never stored: the human expires it at the provider.
  const problem = d.verifyKey ? await d.verifyKey(rt, value, inputs) : null;
  if (problem) {
    return finishFailed(rt, key, t, { code: "key", message: `${problem} Expire the key ${keyName} at the provider.`, messageEn: `${problem} Expire the key ${keyName} at the provider.`, createdName: keyName });
  }

  // Store it as the provider's connection. A human started this flow, so this counts as a human action.
  t.phase("stored", { text: "Storing the key.", status: "running" });
  let storedIn: "vault" | "session";
  try {
    if (rt.connections.vault) {
      await rt.connections.vault.set(connectionId, value.reveal(), null);
      rt.connections.session.delete(connectionId);
      storedIn = "vault";
    } else {
      rt.connections.session.set(connectionId, value, null);
      storedIn = "session";
    }
  } catch {
    return finishFailed(rt, key, t, {
      code: "store",
      message: `The key ${keyName} was created at the provider but could not be stored. Delete it there and run this again.`,
      messageEn: `The key ${keyName} was created at the provider but could not be stored. Delete it there and run this again.`,
      createdName: keyName,
    });
  }

  // Test the connection and count what it can see.
  t.phase("testing", { text: "Testing the connection.", status: "running" });
  let check: ConnectionCheckResult | null = null;
  const counts: Record<string, number> = {};
  try {
    check = await checkConnection(rt, connectionId, {});
    if (check.ok && d.summary.length > 0) {
      const resources = await getConnectionResources(rt, actor, connectionId, { ...(projectId && d.project ? { params: { [d.project.param]: projectId } } : {}) });
      for (const s of d.summary) {
        const r = resources.resources[s.kind];
        if (r && r.status === "ok") counts[s.key] = r.options.length;
      }
    }
  } catch {
    check = null;
  }
  const connected = check?.ok === true;
  const result: FacadeResult = { connected, connectionId, storedIn, keyName, projectId: projectId ?? null, check, counts };
  if (!connected) {
    return finishFailed(rt, key, t, { code: "test", message: "The key was stored, but the connection test failed. Use Test connection for details.", messageEn: "The key was stored, but the connection test failed. Use Test connection for details." });
  }
  t.phase("connected", { text: "Connected." });
  rt.automation.end(key, { status: "done", text: "Connected.", needs: null, timeline: t.done(), result });
}

// ------------------------------------------------------------------------------------------ side routes

/** The one-time code the human typed. It goes to the waiting run once and is not kept. */
export function submitFacadeCode(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Enter a one-time code");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  const key = stateKey(id);
  const waiter = codeWaiters.get(key);
  const state = rt.automation.state(key);
  if (!waiter || state.needs !== "mfa-code") throw new IssuanceError("The provider is not waiting for a one-time code.");
  const code = typeof body["code"] === "string" ? body["code"].replace(/\s+/g, "") : "";
  if (typeof body["code"] === "string") body["code"] = "";
  if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) throw new InventoryError("The code is not valid (4 to 16 letters, digits or dashes).");
  codeWaiters.delete(key);
  waiter.resolve(code);
  return rt.automation.state(key);
}

/** The human confirmed or declined the authorization the identity provider asks for (the scopes were shown in the portal). */
export function submitFacadeConfirm(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Confirm the authorization");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  const key = stateKey(id);
  const waiter = confirmWaiters.get(key);
  if (!waiter || rt.automation.state(key).needs !== "consent") throw new IssuanceError("The provider is not waiting for an authorization.");
  if (typeof body["accept"] !== "boolean") throw new InventoryError("Say whether the authorization is accepted.");
  confirmWaiters.delete(key);
  waiter.resolve(body["accept"]);
  return rt.automation.state(key);
}

export function cancelFacade(rt: Runtime, actor: Actor, id: string): AutomationRunState {
  requireHuman(actor, "Cancel the provider sign-in");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  const key = stateKey(id);
  const cur = rt.automation.state(key);
  if (cur.status !== "running" && cur.status !== "waiting-human") throw new IssuanceError("No sign-in is running.");
  codeWaiters.get(key)?.reject(new Error("cancelled"));
  codeWaiters.delete(key);
  confirmWaiters.get(key)?.reject(new Error("cancelled"));
  confirmWaiters.delete(key);
  return rt.automation.cancel(key);
}

export interface FacadeSessionCheck {
  signedIn: boolean;
  checkedAt: string;
  /** Why the check could not be made (page not opened, browser busy or unreachable). The texts carry no value and no address. */
  failure?: { code: FacadeFailureCode; message: string; messageEn: string };
}

/**
 * Is the browser still signed in at the provider? Needs no credentials and types nothing. A check that cannot be made (the
 * browser is busy with another run, the page does not open, the browser is unreachable) answers with `failure` and a stable code
 * the portal translates, instead of an error text in one language.
 */
export async function checkFacadeSession(rt: Runtime, actor: Actor, id: string, options: { timeoutSeconds?: number } = {}): Promise<FacadeSessionCheck> {
  requireHuman(actor, "Check the provider sign-in");
  const { recipe } = descriptorOf(rt, id);
  return checkRecipeHost(rt, checkKey(id), id, recipe, options);
}

/**
 * Same check for a browser-only vendor: any loaded recipe with a guided sign-in (`login.form`) can be checked by its recipe id.
 * The answer is remembered per recipe host, so the vendor card can show "Ready (browser)" for a while.
 */
export async function checkRecipeSession(rt: Runtime, actor: Actor, recipeId: string, options: { timeoutSeconds?: number } = {}): Promise<FacadeSessionCheck> {
  requireHuman(actor, "Check the provider sign-in");
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(recipeId);
  if (!recipe?.login?.form) throw new InventoryError(`The recipe ${recipeId} has no guided sign-in, so its browser session cannot be checked.`);
  return checkRecipeHost(rt, `recipe-check:${recipeId}`, recipeId, recipe, options);
}

/** The check the background scheduler makes: same as a human's, without an actor (nothing is typed, no value is read). */
export function checkRecipeSessionScheduled(rt: Runtime, recipe: Recipe, options: { timeoutSeconds?: number } = {}): Promise<FacadeSessionCheck> {
  return checkRecipeHost(rt, `recipe-check:${recipe.id}`, recipe.id, recipe, options);
}

async function checkRecipeHost(rt: Runtime, key: string, id: string, recipe: Recipe, options: { timeoutSeconds?: number }): Promise<FacadeSessionCheck> {
  const checkedAt = (): string => new Date().toISOString();
  if (rt.automation.isBusy()) {
    const text = "A browser run is already in progress. Wait for it or cancel it first.";
    return { signedIn: false, checkedAt: checkedAt(), failure: { code: "busy", message: text, messageEn: text } };
  }
  const signal = rt.automation.begin(key, id, { text: "Checking the browser session.", needs: null });
  try {
    const driver = await rt.automation.newDriver();
    const r = await checkSession(recipe, driver, { signal, timeoutSeconds: options.timeoutSeconds ?? 15 });
    rt.automation.end(key, { status: "done", text: r.signedIn ? "Signed in." : "Not signed in." });
    rt.automation.noteSignIn(recipe.host, r.signedIn);
    return { signedIn: r.signedIn, checkedAt: checkedAt() };
  } catch (err) {
    const f = failureOf(err, [], signal.aborted);
    rt.automation.end(key, { status: "failed", text: f.messageEn });
    return { signedIn: false, checkedAt: checkedAt(), failure: { code: f.code, message: f.message, messageEn: f.messageEn } };
  }
}
