import {
  LoginError,
  RecipeRunError,
  checkSession,
  recipeParamVars,
  runRecipe,
  signIn,
  type LoginCredentials,
  type LoginEvent,
  type Recipe,
} from "@secret-desk/automation";
import { InventoryError, IssuanceError, redact, type SecretValue } from "@secret-desk/core";
import { requireHuman, type Actor } from "./agent-api.js";
import type { AutomationRunState, FacadeTimelineEntry } from "./automation.js";
import { checkConnection, type ConnectionCheckResult } from "./connection-check.js";
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
  /** Connection that receives the key (see connection-guides.ts). */
  connectionId: string;
  /** Name of the key at the provider. */
  keyName(now: Date): string;
  /** Fixed recipe parameters of the integration key (for example the read-only permission). */
  keyParams: Record<string, string>;
  /** The recipe parameter that names the provider project, and how to read it from a dashboard address. */
  project: { param: string; fromUrl: RegExp } | null;
  /** Discovery kinds whose option counts are reported after the connection test ("1 project, 3 apps"). */
  summary: { key: string; kind: string }[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

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
    project: { param: "projectId", fromUrl: /^https:\/\/app\.revenuecat\.com\/projects\/([a-z0-9]+)(?:\/|$)/ },
    summary: [
      { key: "projects", kind: "revenuecat.project" },
      { key: "apps", kind: "revenuecat.app" },
    ],
  },
];

export const facadeById = (id: string): FacadeDescriptor | undefined => FACADES.find((f) => f.id === id);

/** Integration a browser recipe belongs to (its facade's connection), so its secrets count for that integration. */
export const facadeConnectionForRecipe = (recipeId: string | undefined): string | null =>
  (recipeId ? FACADES.find((f) => f.recipeId === recipeId)?.connectionId : undefined) ?? null;

/** Phases of a facade run in the order the portal shows them. `code`, `approval` and `captcha` appear only when the provider asks. */
export const FACADE_PHASES = ["opening", "username", "password", "code", "approval", "captcha", "signed-in", "key", "stored", "testing", "connected"] as const;
export type FacadePhase = (typeof FACADE_PHASES)[number];

export type FacadeFailureCode = "rejected" | "timeout" | "cancelled" | "host" | "step" | "code" | "unsupported" | "browser" | "project-unknown" | "session-lost" | "key" | "store" | "test";

export interface FacadeResult {
  /** The key was created, stored and the connection test did not fail. */
  connected: boolean;
  storedIn: "vault" | "session";
  keyName: string;
  projectId: string | null;
  check: ConnectionCheckResult | null;
  /** Counts reported by the provider after the connection test, keyed by the descriptor's summary keys. */
  counts: Record<string, number>;
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
  timeoutMinutes: number;
  /** Where a human sees the remote browser (CAPTCHA, approvals), if configured. */
  viewerUrl: string | null;
}

const stateKey = (id: string): string => `facade:${id}`;
const checkKey = (id: string): string => `facade-check:${id}`;

/** One pending one-time code request per facade run. */
const codeWaiters = new Map<string, { resolve: (code: string) => void; reject: (err: Error) => void }>();

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
      connected: (await rt.connections.status(d.connectionId)).connected,
      needsProject: d.project !== null,
      timeoutMinutes: rt.automation.loginTimeoutMinutes,
      viewerUrl: rt.automation.viewerUrl,
    });
  }
  return out;
}

export function getFacadeState(rt: Runtime, actor: Actor, id: string): AutomationRunState {
  requireHuman(actor, "Open the provider sign-in");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  return rt.automation.state(stateKey(id));
}

// ------------------------------------------------------------------------------------------ input

const CONTROL = /[\u0000-\u001f\u007f]/;

function credentialsFrom(body: Record<string, unknown>): LoginCredentials {
  const username = typeof body["username"] === "string" ? body["username"].trim() : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";
  // The password leaves the request body right away: nothing but the run's own object holds it.
  if (typeof body["password"] === "string") body["password"] = "";
  if (!username) throw new InventoryError("The email is missing.");
  if (username.length > 254 || CONTROL.test(username)) throw new InventoryError("The email is not valid.");
  if (!password) throw new InventoryError("The password is missing.");
  if (password.length > 1024 || CONTROL.test(password)) throw new InventoryError("The password is not valid.");
  return { username, password };
}

function projectFrom(d: FacadeDescriptor, recipe: Recipe, body: Record<string, unknown>): string | undefined {
  const raw = typeof body["projectId"] === "string" ? body["projectId"].trim() : "";
  if (!raw) return undefined;
  const spec = d.project ? recipe.params.find((p) => p.key === d.project!.param) : undefined;
  if (!spec) throw new InventoryError("This provider has no project to choose.");
  if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) throw new InventoryError("The project id does not have the expected format.");
  return raw;
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
      const text = e.need === "mfa-code" ? "Waiting for the one-time code." : e.need === "approval" ? (e.messageEn ?? "Waiting for an approval in the app or by email.") : (e.messageEn ?? "A security check needs the browser window.");
      return t.phase(phase, { status: "waiting-human", needs: e.need, text: text.slice(0, MAX_TEXT) });
    }
    case "resumed":
      return rt.automation.update(t.key, { status: "running", needs: null, text: "Continuing." });
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
  const creds = credentialsFrom(body);
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
  void runSignIn(rt, actor, d, recipe, creds, projectId, key, signal, minutes);
  return state;
}

async function runSignIn(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, creds: LoginCredentials, projectId: string | undefined, key: string, signal: AbortSignal, minutes: number): Promise<void> {
  const known = [creds.username, creds.password];
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
      },
      { timeoutMinutes: minutes, signal },
    );
    // The credentials are not needed any more.
    creds.username = "";
    creds.password = "";
    await runConnect(rt, actor, d, recipe, key, signal, t, projectId, result.url);
  } catch (err) {
    finishFailed(rt, key, t, failureOf(err, known, signal.aborted));
  } finally {
    creds.username = "";
    creds.password = "";
    codeWaiters.delete(key);
  }
}

/** Uses the browser session that is already signed in: creates the key, stores and tests it. Needs no credentials. */
export function startFacadeConnect(rt: Runtime, actor: Actor, id: string, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Connect the provider");
  const { d, recipe } = descriptorOf(rt, id);
  const projectId = projectFrom(d, recipe, body);
  const key = stateKey(id);
  rt.automation.forget(key);
  const signal = rt.automation.begin(key, id, { text: "Using the signed-in browser.", kind: "connect", needs: null, phase: "signed-in", timeline: [], timeoutAt: null });
  const state = rt.automation.state(key);
  const t = new Tracker(rt, key);
  t.phase("signed-in", { status: "running", text: "Using the signed-in browser." });
  void (async () => {
    try {
      await runConnect(rt, actor, d, recipe, key, signal, t, projectId, undefined);
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

async function runConnect(rt: Runtime, actor: Actor, d: FacadeDescriptor, recipe: Recipe, key: string, signal: AbortSignal, t: Tracker, projectGiven: string | undefined, signedInUrl: string | undefined): Promise<void> {
  const projectId = projectGiven ?? (await detectProject(rt, d, recipe, signal, signedInUrl));
  if (d.project && !projectId) {
    return finishFailed(rt, key, t, { code: "project-unknown", message: "Signed in, but the project could not be determined. Enter the project id.", messageEn: "Signed in, but the project could not be determined. Enter the project id." });
  }

  // Create the key.
  const now = new Date();
  const keyName = d.keyName(now);
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
    ...recipeParamVars(recipe, { ...d.keyParams, ...(d.project && projectId ? { [d.project.param]: projectId } : {}) }),
  };
  // A recipe that wants the human to sign in again means the browser did not keep the session: stop instead of waiting.
  let sessionLost = false;
  const inner = new AbortController();
  const driver = await rt.automation.newDriver();
  let value: SecretValue;
  try {
    const result = await runRecipe(
      recipe,
      vars,
      driver,
      {
        onWaitingForHuman: () => {
          sessionLost = true;
          inner.abort();
        },
      },
      { loginTimeoutMinutes: rt.automation.loginTimeoutMinutes, signal: AbortSignal.any([signal, inner.signal]) },
    );
    value = result.value;
  } catch (err) {
    if (sessionLost) {
      const createdName = err instanceof RecipeRunError ? err.createdName : undefined;
      return finishFailed(rt, key, t, { code: "session-lost", message: "The browser is not signed in (the session was not kept). Sign in again.", messageEn: "The browser is not signed in (the session was not kept). Sign in again.", ...(createdName ? { createdName } : {}) });
    }
    return finishFailed(rt, key, t, failureOf(err, [], signal.aborted));
  }

  // Store it as the provider's connection. A human started this flow, so this counts as a human action.
  t.phase("stored", { text: "Storing the key.", status: "running" });
  let storedIn: "vault" | "session";
  try {
    if (rt.connections.vault) {
      await rt.connections.vault.set(d.connectionId, value.reveal(), null);
      rt.connections.session.delete(d.connectionId);
      storedIn = "vault";
    } else {
      rt.connections.session.set(d.connectionId, value, null);
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
    check = await checkConnection(rt, d.connectionId, {});
    if (check.ok) {
      const resources = await getConnectionResources(rt, actor, d.connectionId, { ...(projectId && d.project ? { params: { [d.project.param]: projectId } } : {}) });
      for (const s of d.summary) {
        const r = resources.resources[s.kind];
        if (r && r.status === "ok") counts[s.key] = r.options.length;
      }
    }
  } catch {
    check = null;
  }
  const connected = check?.ok === true;
  const result: FacadeResult = { connected, storedIn, keyName, projectId: projectId ?? null, check, counts };
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

export function cancelFacade(rt: Runtime, actor: Actor, id: string): AutomationRunState {
  requireHuman(actor, "Cancel the provider sign-in");
  if (!facadeById(id)) throw new InventoryError(`Unknown provider: ${id}`);
  const key = stateKey(id);
  const cur = rt.automation.state(key);
  if (cur.status !== "running" && cur.status !== "waiting-human") throw new IssuanceError("No sign-in is running.");
  codeWaiters.get(key)?.reject(new Error("cancelled"));
  codeWaiters.delete(key);
  return rt.automation.cancel(key);
}

export interface FacadeSessionCheck {
  signedIn: boolean;
  checkedAt: string;
}

/** Is the browser still signed in at the provider? Needs no credentials and types nothing. */
export async function checkFacadeSession(rt: Runtime, actor: Actor, id: string, options: { timeoutSeconds?: number } = {}): Promise<FacadeSessionCheck> {
  requireHuman(actor, "Check the provider sign-in");
  const { recipe } = descriptorOf(rt, id);
  const key = checkKey(id);
  const signal = rt.automation.begin(key, id, { text: "Checking the browser session.", needs: null });
  try {
    const driver = await rt.automation.newDriver();
    const r = await checkSession(recipe, driver, { signal, timeoutSeconds: options.timeoutSeconds ?? 15 });
    rt.automation.end(key, { status: "done", text: r.signedIn ? "Signed in." : "Not signed in." });
    return { signedIn: r.signedIn, checkedAt: new Date().toISOString() };
  } catch (err) {
    const f = failureOf(err, [], signal.aborted);
    rt.automation.end(key, { status: "failed", text: f.messageEn });
    throw new IssuanceError(f.messageEn);
  }
}
