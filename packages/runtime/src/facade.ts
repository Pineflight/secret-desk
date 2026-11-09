import {
  LoginError,
  RecipeRunError,
  checkSession,
  loginMethodsOf,
  type LoginMethodInfo,
  type LoginMethodId,
  paramValueProblem,
  RecipeHostError,
  recipeParamVars,
  resolveRecipe,
  runRecipe,
  signIn,
  type LoginCredentials,
  type LoginEvent,
  type Recipe,
  type SudoAnswer,
} from "@secret-desk/automation";
import { ANTHROPIC_API_PREFIXES, isAnthropicApiKey } from "@secret-desk/providers";
import { InventoryError, IssuanceError, redact, STRIPE_ACCOUNT_PATTERN, stripeConnectionId, stripeKeyMode, type SecretValue, type StripeAccountMode } from "@secret-desk/core";
import { requireHuman, type Actor } from "./agent-api.js";
import type { AutomationRunState, FacadeTimelineEntry } from "./automation.js";
import { checkConnection, stripeKeyCarriesAccount, type ConnectionCheckResult } from "./connection-check.js";
import { getConnectionResources } from "./params.js";
import { sudoAnswerFrom } from "./sudo-answer.js";
import type { Runtime } from "./runtime.js";

/**
 * Provider facade: one guided flow per provider that signs in through the remote browser, creates the integration key the
 * portal needs, stores it as the provider's connection and tests it.
 *
 * The human types the provider sign-in (email, password) for this run only. The values live in memory for the run, are typed
 * only into pages on the recipe's hosts and are wiped afterwards: they are not stored, not logged, not part of any state,
 * error, screenshot or response. Agents can never use any of this (human-only routes, no MCP tool).
 */

/**
 * One way to connect a provider whose accounts differ (Anthropic: a Team organization with an Admin key, or a Personal account with
 * a normal API key). The sign-in (the descriptor's recipe) is shared; the variant picks the recipe that creates the key and what
 * goes with it. The human chooses a variant for each run and nothing is preselected on the server: a request without a valid
 * variant is refused.
 */
export interface FacadeVariant {
  /** Stable id sent by the portal (`variant` in the request body). */
  id: string;
  /** Catalog key of the variant's name in the connect dialog. */
  label: string;
  /** Recipe that creates the key of this variant (replaces the descriptor's `recipeId` for the key step only). */
  recipeId: string;
  /** Fixed recipe parameters of the integration key. */
  keyParams: Record<string, string>;
  /** Expiry of the key in days; the value is also the recipe variable `days`. */
  keyExpiryDays?: number;
  /** The key is optional (see the descriptor's `keyOptional`). */
  keyOptional?: boolean;
  /** Catalog key of the sentence that says what this variant can do (shown under its name). */
  promise?: string;
  /** Checks the new key before it is stored (see the descriptor's `verifyKey`). */
  verifyKey?(rt: Runtime, key: SecretValue, inputs: Record<string, string>): Promise<string | null>;
}

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
  /**
   * The integration key is optional: when the recipe ends as "unsupported" (the account has no such feature), the run finishes
   * as done ("ready, keys come from the browser") instead of failing.
   */
  keyOptional?: boolean;
  /**
   * The integration key expires after this many days (the recipe asks the provider for that expiry). The portal stores the
   * expiry day with the connection, so the connection health shows it before the key stops working.
   */
  keyExpiryDays?: number;
  /**
   * Ways to connect, when the key differs by account type. The descriptor's `recipeId` then only signs in (and checks the session);
   * the chosen variant's `recipeId`, `keyParams`, `keyExpiryDays`, `keyOptional` and `promise` replace the descriptor's for the run,
   * so a descriptor with variants sets none of those fields itself (except `recipeId` and `keyParams`, which the sign-in needs).
   */
  variants?: FacadeVariant[];
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

/**
 * A new Anthropic API key (Personal) must be a normal API key and must work: `GET /v1/models?limit=1`. Resolves to a problem text
 * (never the key), or null when the key is fine.
 */
async function anthropicApiKeyProblem(rt: Runtime, key: SecretValue): Promise<string | null> {
  const value = key.reveal();
  if (!isAnthropicApiKey(value)) return `The new key does not start with ${ANTHROPIC_API_PREFIXES.join(" or ")}, so it is not a normal API key and was not stored.`;
  let status: number;
  try {
    const res = await rt.fetch("https://api.anthropic.com/v1/models?limit=1", { method: "GET", headers: { "x-api-key": value, "anthropic-version": "2023-06-01", Accept: "application/json", "User-Agent": "secret-desk" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    status = res.status;
  } catch {
    return "The new key could not be checked at Anthropic, so it was not stored.";
  }
  return status === 200 ? null : `Anthropic did not accept the new key (HTTP ${status}), so it was not stored.`;
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
    // Two ways to connect, one Console sign-in (the recipe `anthropic-admin-key` carries it). Team: the organization Admin key
    // lets the portal list workspaces and check and deactivate keys. Personal: a normal API key, created by the browser recipe
    // `anthropic-api-key` (the Admin API cannot create keys), which the portal can only check. Both are the `anthropic` connection.
    id: "anthropic",
    label: "Anthropic",
    recipeId: "anthropic-admin-key",
    connectionId: "anthropic",
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: {},
    project: null,
    inputs: [],
    summary: [{ key: "workspaces", kind: "anthropic.workspace" }],
    variants: [
      { id: "team", label: "facade.variant.anthropic.team", recipeId: "anthropic-admin-key", keyParams: {}, keyOptional: true, promise: "facade.promise.anthropic.team" },
      // 30 days is the default of the Console dialog (it has no 90 days); `days` carries it to the recipe and the expiry day to the connection.
      { id: "personal", label: "facade.variant.anthropic.personal", recipeId: "anthropic-api-key", keyParams: {}, keyExpiryDays: 30, promise: "facade.promise.anthropic.personal", verifyKey: (rt, key) => anthropicApiKeyProblem(rt, key) },
    ],
  },
  {
    // The Cloud access policy token is created once through the signed-in browser (grafana.com, portal sign-in only); after that
    // the portal creates stack service accounts and tokens through the Cloud API. The facade belongs to the vendor `grafana`,
    // whose card also holds the stack connection (`grafana`), which stays a pasted token.
    id: "grafana",
    label: "Grafana Cloud",
    recipeId: "grafana-cloud-access-policy",
    connectionId: "grafana-cloud",
    keyName: (now) => `secret-desk-integration-${now.toISOString().slice(0, 10)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`,
    keyParams: { expiry: "90 days" },
    keyExpiryDays: 90,
    promise: "facade.promise.grafana",
    project: null,
    inputs: [],
    summary: [],
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
  /**
   * The sign-in worked, but the provider cannot create the integration key for this account (Anthropic: admin keys need an
   * organization). Nothing is stored; keys are created in the browser. `connected` is false.
   */
  browserOnly?: boolean;
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
  /** A recipe with several portals: the parameter that picks one and the host of each value (empty for one portal). */
  hostBy: string | null;
  hosts: { value: string; host: string }[];
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
  /** The ways to connect (empty = one way). The portal asks which one; the choice goes with the request as `variant`. */
  variants: { id: string; label: string; promise: string | null }[];
  /** The email sign-in has no password (the provider sends a one-time code); the portal then asks only for the email. */
  passwordless: boolean;
}

const stateKey = (id: string): string => `facade:${id}`;
const checkKey = (id: string): string => `facade-check:${id}`;

/** One pending one-time code request per facade run. */
const codeWaiters = new Map<string, { resolve: (code: string) => void; reject: (err: Error) => void }>();

/** One pending authorization (OAuth consent) question per facade run. */
const confirmWaiters = new Map<string, { resolve: (accepted: boolean) => void; reject: (err: Error) => void }>();

/** One pending identity-verification question ("Verification required", "Confirm access") per facade run. */
const accessWaiters = new Map<string, { run: AbortSignal; resolve: (answer: SudoAnswer) => void; reject: (err: Error) => void }>();

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
      hostBy: recipe?.hostBy ?? null,
      hosts: Object.entries(recipe?.hosts ?? {}).map(([value, host]) => ({ value, host })),
      connected: await facadeConnected(rt, d),
      needsProject: d.project !== null,
      inputs: d.inputs.flatMap((param) => {
        const spec = recipe?.params.find((p) => p.key === param);
        return spec ? [{ param, label: spec.label, labelEn: spec.labelEn ?? spec.label, options: spec.options ?? null, pattern: spec.pattern ?? null, help: spec.help ?? null }] : [];
      }),
      timeoutMinutes: rt.automation.loginTimeoutMinutes,
      methods: recipe ? loginMethodsOf(recipe) : [],
      promise: d.promise ?? null,
      variants: (d.variants ?? []).map((v) => ({ id: v.id, label: v.label, promise: v.promise ?? null })),
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

/**
 * The recipe for the portal the human chose. A recipe with several hosts needs the choice: the body's `host` (a host or a value
 * of the recipe's host parameter), else the input of that parameter. Everything after this sees one host only.
 */
export function portalFrom(recipe: Recipe, body: Record<string, unknown>, inputs: Record<string, string> = {}): Recipe {
  if (!recipe.hosts) return recipe;
  const given = typeof body["host"] === "string" ? body["host"].trim() : "";
  return resolvePortal(recipe, given !== "" ? given : (inputs[recipe.hostBy!] ?? ""));
}

function resolvePortal(recipe: Recipe, choice: string): Recipe {
  try {
    return resolveRecipe(recipe, choice);
  } catch (err) {
    if (err instanceof RecipeHostError) throw new InventoryError("Choose the portal first: this provider has more than one, each with its own account.");
    throw err;
  }
}

/** The chosen sign-in method (default: email). It must be one the recipe offers. */
export function methodFrom(recipe: Recipe, body: Record<string, unknown>): LoginMethodId {
  const raw = typeof body["method"] === "string" && body["method"] ? body["method"] : "email";
  const offered = loginMethodsOf(recipe).find((m) => m.id === raw);
  if (!offered) throw new InventoryError(`This provider does not offer the sign-in method ${String(raw)}.`);
  return offered.id;
}

/**
 * The way the human chose for a provider with variants (`variant` in the body). Missing or unknown is refused; a provider
 * without variants takes none (and ignores the field). Returns the descriptor as this run sees it and the recipe that creates the key.
 */
function variantFrom(rt: Runtime, d: FacadeDescriptor, whole: Recipe, body: Record<string, unknown>, inputs: Record<string, string>): { run: FacadeDescriptor; keyRecipe: Recipe } {
  if (!d.variants) return { run: d, keyRecipe: portalFrom(whole, body, inputs) };
  const raw = typeof body["variant"] === "string" ? body["variant"].trim() : "";
  if (!raw) throw new InventoryError(`Choose how to connect ${d.label}: ${d.variants.map((v) => v.id).join(" or ")}.`);
  const v = d.variants.find((x) => x.id === raw);
  if (!v) throw new InventoryError(`Unknown way to connect ${d.label}: ${raw.slice(0, 40)}. Use ${d.variants.map((x) => x.id).join(" or ")}.`);
  const recipe = rt.automation.recipe(v.recipeId);
  if (!recipe) throw new InventoryError(`The recipe ${v.recipeId} is not loaded.`);
  // The variant's own settings replace the descriptor's; identity (id, label) stays the provider's.
  return { run: { ...d, ...v, id: d.id, label: d.label }, keyRecipe: portalFrom(recipe, body, inputs) };
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
    return this.#close("failed");
  }

  done(): FacadeTimelineEntry[] {
    return this.#close("done");
  }

  /** Only the newest entry can still be active (phase() closes the one before it). */
  #close(state: "done" | "failed"): FacadeTimelineEntry[] {
    for (const entry of this.#timeline) if (entry.state === "active") entry.state = state;
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
  const text = err instanceof Error && err.message ? clean(err.message.split("\n")[0]!) : "";
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
  const { d: base, recipe: whole } = descriptorOf(rt, id);
  const projectId = projectFrom(base, whole, body);
  const inputs = inputsFrom(base, whole, body);
  const { run: d, keyRecipe } = variantFrom(rt, base, whole, body, inputs);
  const recipe = portalFrom(whole, body, inputs);
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
  void runSignIn(rt, actor, d, recipe, keyRecipe, creds, projectId, inputs, key, signal, minutes, method);
  return state;
}

async function runSignIn(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, keyRecipe: Recipe, creds: LoginCredentials, projectId: string | undefined, inputs: Record<string, string>, key: string, signal: AbortSignal, minutes: number, method: LoginMethodId): Promise<void> {
  const known = [creds.username, creds.password].filter((x) => x !== "");
  const t = new Tracker(rt, key);
  try {
    const url = await driveSignIn(rt, recipe, creds, key, signal, minutes, method, t);
    await runConnect(rt, actor, d, keyRecipe, key, signal, t, projectId, inputs, url);
  } catch (err) {
    finishFailed(rt, key, t, failureOf(err, known, signal.aborted));
  } finally {
    creds.username = "";
    creds.password = "";
    codeWaiters.delete(key);
    confirmWaiters.delete(key);
  }
}

/**
 * The sign-in engine both runs share (the facade's and the plain recipe sign-in): drives the recipe's sign-in form, asks the human
 * for a code, an approval or a consent through the run's waiters, wipes the credentials and remembers the sign-in at the host.
 * Returns the address the sign-in landed on.
 */
async function driveSignIn(rt: Runtime, recipe: Recipe, creds: LoginCredentials, key: string, signal: AbortSignal, minutes: number, method: LoginMethodId, t: Tracker): Promise<string | undefined> {
  const timeoutAt = rt.automation.state(key).timeoutAt ?? new Date(Date.now() + minutes * 60_000).toISOString();
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
  return result.url;
}

// ------------------------------------------------------------------------------------------ recipe sign-in

const recipeSignInKey = (recipeId: string): string => `recipe-signin:${recipeId}`;

/** A loaded recipe with a guided sign-in, for the plain sign-in of a browser-only vendor. */
function signInRecipeOf(rt: Runtime, recipeId: string): Recipe {
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(recipeId);
  if (!recipe?.login?.form) throw new InventoryError(`The recipe ${recipeId} has no guided sign-in.`);
  return recipe;
}

/** The recipe must exist (state, code, confirm and cancel need no guided sign-in check beyond the run key). */
function knownRecipe(rt: Runtime, recipeId: string): void {
  if (!rt.automation.recipe(recipeId)) throw new InventoryError(`Unknown recipe: ${recipeId}`);
}

export function getRecipeSignInState(rt: Runtime, actor: Actor, recipeId: string): AutomationRunState {
  requireHuman(actor, "Open the provider sign-in");
  knownRecipe(rt, recipeId);
  return rt.automation.state(recipeSignInKey(recipeId));
}

/**
 * Signs in at a browser-only vendor and nothing else: no key is created, nothing is stored. Same engine, prompts and memory rules
 * as the facade sign-in: the credentials come from the request body, live in this run only and are wiped when it ends. A recipe
 * with several hosts needs `host` (a host or a value of the recipe's host parameter). On success the sign-in is remembered at the
 * host (source `connect`). One browser run at a time: a busy browser is a conflict.
 */
export function startRecipeSignIn(rt: Runtime, actor: Actor, recipeId: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Sign in at the provider");
  const whole = signInRecipeOf(rt, recipeId);
  const recipe = portalFrom(whole, body);
  const method = methodFrom(recipe, body);
  const creds = credentialsFrom(body, !(method === "email" && recipe.login?.form?.passwordless === true));
  const key = recipeSignInKey(recipeId);
  rt.automation.forget(key);
  const minutes = rt.automation.loginTimeoutMinutes;
  let signal: AbortSignal;
  try {
    signal = rt.automation.begin(key, recipeId, { text: "Opening the sign-in page.", kind: "signin", needs: null, phase: "opening", timeline: [], timeoutAt: new Date(Date.now() + minutes * 60_000).toISOString() });
  } catch (err) {
    creds.username = "";
    creds.password = "";
    throw err;
  }
  const state = rt.automation.state(key);
  void runRecipeSignIn(rt, recipe, creds, key, signal, minutes, method);
  return state;
}

async function runRecipeSignIn(rt: Runtime, recipe: Recipe, creds: LoginCredentials, key: string, signal: AbortSignal, minutes: number, method: LoginMethodId): Promise<void> {
  const known = [creds.username, creds.password].filter((x) => x !== "");
  const t = new Tracker(rt, key);
  try {
    await driveSignIn(rt, recipe, creds, key, signal, minutes, method, t);
    rt.automation.end(key, { status: "done", text: "Signed in.", needs: null, timeline: t.done() });
  } catch (err) {
    finishFailed(rt, key, t, failureOf(err, known, signal.aborted));
  } finally {
    creds.username = "";
    creds.password = "";
    codeWaiters.delete(key);
    confirmWaiters.delete(key);
  }
}

export function submitRecipeCode(rt: Runtime, actor: Actor, recipeId: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Enter a one-time code");
  knownRecipe(rt, recipeId);
  return submitCodeAt(rt, recipeSignInKey(recipeId), body);
}

export function submitRecipeConfirm(rt: Runtime, actor: Actor, recipeId: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Confirm the authorization");
  knownRecipe(rt, recipeId);
  return submitConfirmAt(rt, recipeSignInKey(recipeId), body);
}

export function cancelRecipeSignIn(rt: Runtime, actor: Actor, recipeId: string): AutomationRunState {
  requireHuman(actor, "Cancel the provider sign-in");
  knownRecipe(rt, recipeId);
  return cancelAt(rt, recipeSignInKey(recipeId));
}

/** Uses the browser session that is already signed in: creates the key, stores and tests it. Needs no credentials. */
export function startFacadeConnect(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Connect the provider");
  const { d: base, recipe: whole } = descriptorOf(rt, id);
  const projectId = projectFrom(base, whole, body);
  const inputs = inputsFrom(base, whole, body);
  const { run: d, keyRecipe: recipe } = variantFrom(rt, base, whole, body, inputs);
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
  accessWaiters.delete(key);
  rt.automation.end(key, {
    status: cancelled ? "cancelled" : "failed",
    text: f.messageEn,
    needs: null,
    ask: null,
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
  try {
    await runConnectSteps(rt, actor, d, recipe, key, signal, t, projectGiven, inputs, signedInUrl);
  } finally {
    // Success, failure or cancel: no question of this run stays answerable.
    if (accessWaiters.get(key)?.run === signal) accessWaiters.delete(key);
  }
}

async function runConnectSteps(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, key: string, signal: AbortSignal, t: Tracker, projectGiven: string | undefined, inputs: Record<string, string>, signedInUrl: string | undefined): Promise<void> {
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
    // The expiry the recipe asks the provider for. `days` is a base variable, not a recipe parameter, so it is set here.
    days: String(d.keyExpiryDays ?? 0),
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
        // The provider may ask to verify the identity in the middle of the run (a password, a code from an email or an app): the
        // portal asks the human and the answer is typed once, never in the browser window.
        access: {
          request: (ask) => {
            rt.automation.update(key, {
              status: "waiting-human",
              needs: null,
              text: `Verify your identity at ${d.label}.`,
              ask: { type: "access", stage: "choose", methods: [...ask.methods], attempt: ask.attempt, maxAttempts: ask.maxAttempts, ...(ask.problem ? { problem: ask.problem } : {}) },
            });
            return new Promise<SudoAnswer>((resolve, reject) => {
              const onAbort = (): void => {
                accessWaiters.delete(key);
                reject(new Error("cancelled"));
              };
              if (signal.aborted) return onAbort();
              signal.addEventListener("abort", onAbort, { once: true });
              // The waiter belongs to this run (its signal); answered, it drops the listener so questions do not pile them up.
              accessWaiters.set(key, {
                run: signal,
                resolve: (answer) => {
                  signal.removeEventListener("abort", onAbort);
                  resolve(answer);
                },
                reject: (err) => {
                  signal.removeEventListener("abort", onAbort);
                  reject(err);
                },
              });
            });
          },
          onEvent: (e) => {
            if (e.type === "checking") rt.automation.update(key, { status: "running", ask: { type: "access", stage: "checking", method: e.method }, text: `${d.label} is checking the verification.` });
            if (e.type === "confirmed") rt.automation.update(key, { status: "running", ask: null, text: "Verification done." });
          },
        },
        onWaitingForHuman: (w) => {
          // A hand-over to the human ends the portal's question (no stale question stays in the state).
          rt.automation.update(key, { ask: null });
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
      { loginTimeoutMinutes: rt.automation.loginTimeoutMinutes, signal: AbortSignal.any([signal, inner.signal]), access: rt.automation.accessTiming },
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
    if (d.keyOptional && err instanceof RecipeRunError && err.kind === "unsupported") {
      // The recipe ran in the signed-in browser up to the page that lacks the feature: the browser is ready.
      rt.automation.noteSignIn(recipe.host, true, "run");
      const text = "Signed in. This account has no admin keys (they need an organization); API keys are created in the browser. Choose Personal to connect with a normal API key.";
      const result: FacadeResult = { connected: false, browserOnly: true, connectionId: d.connectionId, storedIn: rt.connections.vault ? "vault" : "session", keyName: "", projectId: null, check: null, counts: {} };
      t.phase("connected", { text });
      return rt.automation.end(key, { status: "done", text, needs: null, ask: null, timeline: t.done(), result });
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
  const expires = d.keyExpiryDays ? new Date(now.getTime() + d.keyExpiryDays * 86_400_000).toISOString().slice(0, 10) : null;
  try {
    if (rt.connections.vault) {
      await rt.connections.vault.set(connectionId, value.reveal(), expires);
      rt.connections.session.delete(connectionId);
      storedIn = "vault";
    } else {
      rt.connections.session.set(connectionId, value, expires);
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
  rt.automation.end(key, { status: "done", text: "Connected.", needs: null, ask: null, timeline: t.done(), result });
}

// ------------------------------------------------------------------------------------------ side routes

/** The one-time code the human typed. It goes to the waiting run once and is not kept. */
export function submitFacadeCode(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Enter a one-time code");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  return submitCodeAt(rt, stateKey(id), body);
}

function submitCodeAt(rt: Runtime, key: string, body: Record<string, unknown>): AutomationRunState {
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

/** The identity verification the human typed (a code or a password). It goes to the waiting run once and is not kept. */
export function submitFacadeAccess(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Verify your identity");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  const key = stateKey(id);
  const waiter = accessWaiters.get(key);
  const ask = rt.automation.state(key).ask;
  const current = rt.automation.runSignal(key);
  // Only the run that asked can be answered: a waiter of an ended or replaced run is refused.
  if (!waiter || waiter.run !== current || current?.aborted || ask?.type !== "access" || ask.stage !== "choose") throw new IssuanceError("The provider is not waiting for a verification.");
  const answer = sudoAnswerFrom(body, ask.methods);
  accessWaiters.delete(key);
  waiter.resolve(answer);
  return rt.automation.state(key);
}

/** The human confirmed or declined the authorization the identity provider asks for (the scopes were shown in the portal). */
export function submitFacadeConfirm(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Confirm the authorization");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  return submitConfirmAt(rt, stateKey(id), body);
}

function submitConfirmAt(rt: Runtime, key: string, body: Record<string, unknown>): AutomationRunState {
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
  return cancelAt(rt, stateKey(id));
}

function cancelAt(rt: Runtime, key: string): AutomationRunState {
  const cur = rt.automation.state(key);
  if (cur.status !== "running" && cur.status !== "waiting-human") throw new IssuanceError("No sign-in is running.");
  codeWaiters.get(key)?.reject(new Error("cancelled"));
  codeWaiters.delete(key);
  accessWaiters.get(key)?.reject(new Error("cancelled"));
  accessWaiters.delete(key);
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
export async function checkFacadeSession(rt: Runtime, actor: Actor, id: string, options: { timeoutSeconds?: number; host?: string } = {}): Promise<FacadeSessionCheck> {
  requireHuman(actor, "Check the provider sign-in");
  const { recipe } = descriptorOf(rt, id);
  const portal = resolvePortal(recipe, options.host ?? "");
  return checkRecipeHost(rt, recipe.hosts ? `${checkKey(id)}:${portal.host}` : checkKey(id), id, portal, options);
}

/**
 * Same check for a browser-only vendor: any loaded recipe with a guided sign-in (`login.form`) can be checked by its recipe id.
 * The answer is remembered per recipe host, so the vendor card can show "Ready (browser)" for a while.
 */
export async function checkRecipeSession(rt: Runtime, actor: Actor, recipeId: string, options: { timeoutSeconds?: number; host?: string } = {}): Promise<FacadeSessionCheck> {
  requireHuman(actor, "Check the provider sign-in");
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(recipeId);
  if (!recipe?.login?.form) throw new InventoryError(`The recipe ${recipeId} has no guided sign-in, so its browser session cannot be checked.`);
  const portal = resolvePortal(recipe, options.host ?? "");
  return checkRecipeHost(rt, recipe.hosts ? `recipe-check:${recipeId}:${portal.host}` : `recipe-check:${recipeId}`, recipeId, portal, options);
}

/**
 * The check the background scheduler makes: same as a human's, without an actor (nothing is typed, no value is read). A recipe
 * with several hosts is checked once per host: `host` picks the portal.
 */
export function checkRecipeSessionScheduled(rt: Runtime, recipe: Recipe, options: { timeoutSeconds?: number; host?: string } = {}): Promise<FacadeSessionCheck> {
  const portal = resolvePortal(recipe, options.host ?? "");
  return checkRecipeHost(rt, recipe.hosts ? `recipe-check:${recipe.id}:${portal.host}` : `recipe-check:${recipe.id}`, recipe.id, portal, options);
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
