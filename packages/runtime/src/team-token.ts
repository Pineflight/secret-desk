import {
  LoginError,
  RecipeRunError,
  SudoError,
  loginMethodsOf,
  recipeParamVars,
  revokeRecipe,
  runRecipe,
  signIn,
  tokenName,
  type BrowserDriver,
  type LoginCredentials,
  type LoginEvent,
  type LoginMethodId,
  type Recipe,
  type RunHooks,
  type SudoAnswer,
  type SudoEvent,
} from "@secret-desk/automation";
import { GitHubClient, GitHubError, GitHubInputError, InventoryError, IssuanceError, TEAM_SYNC_CONNECTION, patProvider, redact, type SecretValue } from "@secret-desk/core";
import { requireHuman, type Actor } from "./agent-api.js";
import type { AutomationRunState, FacadeTimelineEntry, RunAsk } from "./automation.js";
import { credentialsFrom, methodFrom } from "./facade.js";
import { WaitExpiredError, waitDeadline, type TeamTokenAnswers, type Waiter, type WaiterBook } from "./instance-state.js";
import { sudoAnswerFrom } from "./sudo-answer.js";
import type { Runtime } from "./runtime.js";
import {
  readTeamTokenRecord,
  writeTeamTokenRecord,
  type PendingRevocation,
  type TeamTokenMeta,
} from "./team-token-meta.js";
import { teamRights, teamRightsLabels, teamRightsList, teamRightsQuery, type TeamMode, type TeamPushStrategy } from "./team-token-rights.js";

/**
 * A separate GitHub token for team sync, created through the browser recipe `github-fine-grained-token`: limited to the one
 * team repository and to exactly the rights of the chosen mode. The general GitHub integration token is never widened.
 *
 * The human never leaves the portal. When GitHub is signed out the portal asks for the sign-in method, email and password for this
 * run (kept in memory only, typed only on GitHub's hosts, wiped afterwards), then for the codes and approvals GitHub asks for;
 * when GitHub asks "Confirm access" the portal asks how to confirm (GitHub Mobile with the number to tap, authenticator code or
 * password). The token is read from the page, tested with the new token itself and only then stored as the connection
 * `team-sync`, which team sync prefers over the integration. The token it replaces is deleted at GitHub by the same recipe
 * (`revoke`) once the new one works; only when that run fails the old one is listed for deletion by hand, with the reason.
 * Agents never reach any of this (human routes only).
 */

export const TEAM_TOKEN_RECIPE = "github-fine-grained-token";
/** Lifetime of a new team token. */
export const TEAM_TOKEN_DAYS = 90;
/** Where the human finds and deletes the token at GitHub. */
export const GITHUB_TOKENS_URL = "https://github.com/settings/personal-access-tokens";
const RUN_KEY = "team-token";
const CHECK_KEY = "team-token-check";
const MAX_TEXT = 400;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const DOTS = /^\.{1,2}$/;

/** Phases of a team token run in the order the portal shows them. `signin`, `confirm` and `revoking` appear only when they happen. */
export const TEAM_TOKEN_PHASES = ["opening", "signin", "confirm", "creating", "testing", "revoking", "ready"] as const;

export type TeamTokenFailureCode = "timeout" | "cancelled" | "host" | "step" | "browser" | "key" | "test" | "store" | "rejected" | "code" | "captcha" | "unsupported" | "page";

export interface TeamTokenInfo {
  /** false: automation is off or the recipe is missing; `reason` says why. */
  available: boolean;
  reason: "automation-off" | "recipe-missing" | null;
  /** Where a human sees the remote browser (sign-in, "Confirm access"), if configured. */
  viewerUrl: string | null;
  timeoutMinutes: number;
  /** The team token this portal created (null when none, or a typed-in token is in use). */
  active: (TeamTokenMeta & { valid: boolean }) | null;
  /** An earlier token that is replaced and that the portal could not delete at GitHub: `reason` says why. Never claimed to be revoked. */
  pendingRevocation: (PendingRevocation & { url: string }) | null;
  tokensUrl: string;
  days: number;
  /** The rights of both modes, for the "what will be created" line. */
  rights: Record<TeamMode, string[]>;
  run: AutomationRunState;
}

export async function getTeamTokenInfo(rt: Runtime, actor: Actor): Promise<TeamTokenInfo> {
  requireHuman(actor, "Open the team token");
  const recipe = rt.automation.recipe(TEAM_TOKEN_RECIPE);
  const reason = !rt.automation.enabled ? "automation-off" : !recipe ? "recipe-missing" : null;
  const rec = await readTeamTokenRecord(rt);
  // A token that has expired or was removed is not "valid" any more, the meta still says what it was.
  const valid = rec.active ? (await rt.connections.status(TEAM_SYNC_CONNECTION)).connected : false;
  return {
    available: reason === null,
    reason,
    viewerUrl: rt.automation.viewerUrl,
    timeoutMinutes: rt.automation.loginTimeoutMinutes,
    active: rec.active ? { ...rec.active, valid } : null,
    pendingRevocation: rec.pendingRevocation ? { ...rec.pendingRevocation, url: GITHUB_TOKENS_URL } : null,
    tokensUrl: GITHUB_TOKENS_URL,
    days: TEAM_TOKEN_DAYS,
    rights: { pull: teamRightsLabels(teamRights("pull", "pull-request")), "pull-push": teamRightsLabels(teamRights("pull-push", "pull-request")) },
    run: rt.automation.state(RUN_KEY),
  };
}

// ------------------------------------------------------------------------------------------ input

export interface TeamTokenRequest {
  repo: string;
  owner: string;
  name: string;
  branch: string | undefined;
  mode: TeamMode;
  strategy: TeamPushStrategy;
}

function requestFrom(body: Record<string, unknown>): TeamTokenRequest {
  const repo = typeof body["repo"] === "string" ? body["repo"].trim() : "";
  const [owner, name] = repo.split("/") as [string, string];
  if (!REPO.test(repo) || DOTS.test(owner) || DOTS.test(name)) throw new InventoryError('Field repo: format "owner/name".');
  const mode = body["mode"];
  if (mode !== "pull" && mode !== "pull-push") throw new InventoryError("Field mode: pull or pull-push.");
  const strategy = body["strategy"] ?? "pull-request";
  if (strategy !== "pull-request" && strategy !== "direct") throw new InventoryError("Field strategy: pull-request or direct.");
  const rawBranch = body["branch"];
  let branch: string | undefined;
  if (rawBranch !== undefined && rawBranch !== null && rawBranch !== "") {
    if (typeof rawBranch !== "string" || rawBranch.length > 255 || /[\u0000-\u001f\u007f\s]/.test(rawBranch)) throw new InventoryError("Field branch is not valid.");
    branch = rawBranch;
  }
  return { repo, owner, name, branch, mode, strategy };
}

/** Variables of the recipe run. The parameters the recipe declares (none today) keep their defaults. */
export function teamTokenVars(recipe: Pick<Recipe, "params">, req: Pick<TeamTokenRequest, "owner" | "name" | "mode" | "strategy">, now: Date): Record<string, string> {
  const rights = teamRights(req.mode, req.strategy);
  return {
    name: tokenName(`secret-desk-team-${req.name}`, now),
    owner: req.owner,
    days: String(TEAM_TOKEN_DAYS),
    date: now.toISOString().slice(0, 10),
    description: `secret-desk team sync (${req.mode === "pull" ? "read" : "read and push"})`,
    repos: req.name,
    permissions: teamRightsList(rights),
    permissionsQuery: teamRightsQuery(rights),
    stage: "",
    secretId: "",
    ...recipeParamVars(recipe, {}),
  };
}

// ------------------------------------------------------------------------------------------ run

class Tracker {
  readonly #timeline: FacadeTimelineEntry[] = [];
  constructor(
    private readonly rt: Runtime,
    readonly key: string,
  ) {}

  phase(phase: string, patch: Partial<AutomationRunState> = {}): void {
    const last = this.#timeline.at(-1);
    if (last?.phase === phase && last.state === "active") return this.rt.automation.update(this.key, { ...patch, timeline: [...this.#timeline] });
    if (last?.state === "active") last.state = "done";
    this.#timeline.push({ phase, state: "active", at: this.rt.now().toISOString() });
    this.rt.automation.update(this.key, { phase, timeline: [...this.#timeline], ...patch });
  }

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
  code: TeamTokenFailureCode;
  message: string;
  createdName?: string;
}

function failureOf(err: unknown, known: string[], cancelled: boolean): Failure {
  const clean = (t: string): string => redact(t, known).slice(0, MAX_TEXT);
  if (err instanceof LoginError) {
    const code: TeamTokenFailureCode = err.kind === "abort" ? "cancelled" : err.kind;
    return { code, message: clean(err.messageEn ?? err.message) };
  }
  if (err instanceof RecipeRunError) {
    const code: TeamTokenFailureCode = err.kind === "abort" ? "cancelled" : err.kind === "timeout" ? "timeout" : err.kind === "host" ? "host" : err.kind === "step" ? "step" : "key";
    return { code, message: clean(err.message), ...(err.createdName ? { createdName: err.createdName } : {}) };
  }
  // A question nobody answered in time ends the run like any other time-out.
  if (err instanceof WaitExpiredError) return { code: "timeout", message: err.message };
  if (cancelled) return { code: "cancelled", message: "Cancelled." };
  const text = err instanceof Error && err.message ? clean(err.message.split("\n")[0]!) : "";
  return { code: "browser", message: text || "The browser could not be used." };
}

function finishFailed(rt: Runtime, t: Tracker, f: Failure): void {
  const cancelled = f.code === "cancelled";
  rt.automation.end(t.key, {
    status: cancelled ? "cancelled" : "failed",
    text: f.message,
    needs: null,
    timeline: t.fail(),
    failure: { code: f.code, message: f.message, messageEn: f.message },
    ...(f.createdName ? { createdName: f.createdName } : {}),
  });
}

/** What the new token has to prove before it is stored: it reads the repository, and for a push mode may push. Texts carry no value. */
export async function verifyTeamToken(rt: Runtime, value: SecretValue, req: Pick<TeamTokenRequest, "owner" | "name" | "branch" | "mode" | "strategy">): Promise<string | null> {
  const gh = new GitHubClient({ auth: patProvider(value), fetch: rt.fetch });
  const where = `${req.owner}/${req.name}`;
  try {
    const info = await gh.getRepo(req.owner, req.name);
    if (info.private !== true) return `${where} is not a private repository, so it is not used for team sync.`;
    const branch = req.branch ?? info.defaultBranch ?? undefined;
    if (!branch) return `The branch of ${where} could not be determined.`;
    const tree = await gh.listFilePaths(req.owner, req.name, branch);
    if (tree === null) return `The branch ${branch} of ${where} could not be read with the new token.`;
    if (req.mode === "pull-push") {
      if (info.permissions?.push !== true) return `The new token cannot push to ${where}. Check its repository access and the Contents right.`;
      if (req.strategy === "pull-request") await gh.findOpenPull(req.owner, req.name, "secret-desk/permission-check", branch);
    }
    return null;
  } catch (err) {
    if (err instanceof GitHubInputError) return "The repository or branch name is not valid.";
    if (err instanceof GitHubError) return redact(`GitHub refused the new token (${err.status}): ${err.message.split("\n")[0]!}`, [value]).slice(0, MAX_TEXT);
    return "The new token could not be tested.";
  }
}

/**
 * Starts the creation of a team token through the browser. Returns the initial state at once; the run goes on in the background
 * and the portal polls getTeamTokenInfo. Only one browser run at a time.
 */
export function startTeamToken(rt: Runtime, actor: Actor, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Create the team token");
  const req = requestFrom(body);
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(TEAM_TOKEN_RECIPE);
  if (!recipe) throw new InventoryError(`The recipe ${TEAM_TOKEN_RECIPE} is not loaded.`);
  const now = rt.now();
  const vars = teamTokenVars(recipe, req, now);
  rt.automation.forget(RUN_KEY);
  const minutes = rt.automation.loginTimeoutMinutes;
  const signal = rt.automation.begin(RUN_KEY, TEAM_TOKEN_RECIPE, {
    text: "Opening GitHub in the browser.",
    kind: "connect",
    needs: null,
    phase: "opening",
    timeline: [],
    timeoutAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
  });
  const state = rt.automation.state(RUN_KEY);
  const t = new Tracker(rt, RUN_KEY);
  t.phase("opening", { status: "running", text: "Opening GitHub in the browser." });
  void runTeamToken(rt, recipe, req, vars, signal, t, now);
  return state;
}

// ------------------------------------------------------------------------------------------ the human's answers

/**
 * Waits for the human's answer to one question. Only one team token run exists at a time per runtime, so one slot per question in
 * the runtime's own state (`rt.instance.teamToken`) is enough. A cancelled run rejects it, and so does the deadline of the run: an
 * expired question can no longer be answered.
 */
function waitFor<K extends keyof TeamTokenAnswers>(rt: Runtime, slot: K, signal: AbortSignal): Promise<TeamTokenAnswers[K]> {
  const book = rt.instance.teamToken[slot] as WaiterBook<TeamTokenAnswers[K]>;
  return new Promise<TeamTokenAnswers[K]>((resolve, reject) => {
    const onAbort = (): void => {
      book.delete(RUN_KEY, signal);
      reject(new Error("cancelled"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    book.set(RUN_KEY, {
      run: signal,
      deadline: waitDeadline(rt.now(), slot),
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
}

/** The question of this kind that can still be answered, or undefined (nothing asked, or its deadline passed). */
const open = <K extends keyof TeamTokenAnswers>(rt: Runtime, slot: K): Waiter<TeamTokenAnswers[K]> | undefined => (rt.instance.teamToken[slot] as WaiterBook<TeamTokenAnswers[K]>).answerable(RUN_KEY, rt.now(), rt.automation.runSignal(RUN_KEY));

/** Delivers the answer to the waiting run, once. */
function deliver<K extends keyof TeamTokenAnswers>(rt: Runtime, slot: K, value: TeamTokenAnswers[K]): void {
  (rt.instance.teamToken[slot] as WaiterBook<TeamTokenAnswers[K]>).take(RUN_KEY, rt.now())?.resolve(value);
}

/** The question the run asks right now, or null. */
const asked = (rt: Runtime): AutomationRunState["ask"] | undefined => {
  const s = rt.automation.state(RUN_KEY);
  return s.status === "waiting-human" ? s.ask : undefined;
};

/**
 * The hooks that let the portal sign in and confirm access: the sign-in on the run's own open browser (asking for the method and
 * the credentials first) and the "Confirm access" questions. `phased`: the confirmation belongs to its own timeline phase
 * (creating the token); during the delete run it stays inside the "revoking" phase.
 */
function portalHooks(rt: Runtime, recipe: Recipe, t: Tracker, signal: AbortSignal, known: string[], phased: boolean): Pick<RunHooks, "access" | "signIn"> {
  const update = (patch: Partial<AutomationRunState>): void => rt.automation.update(RUN_KEY, patch);
  const onLogin = (e: LoginEvent): void => {
    if (e.type === "needs") {
      const text = e.need === "mfa-code" ? "Waiting for the one-time code." : e.need === "approval" ? (e.messageEn ?? "Approve the sign-in on your device ...") : "Waiting for your confirmation of the authorization.";
      return t.phase("signin", { status: "waiting-human", needs: e.need, ask: null, detail: (e.detail ?? "").slice(0, MAX_TEXT), text: text.slice(0, MAX_TEXT) });
    }
    if (e.type === "resumed") return update({ status: "running", needs: null, detail: "", text: "Continuing." });
    if (e.type === "signed-in") return update({ status: "running", needs: null, ask: null, text: "Signed in to GitHub." });
  };
  const onAccess = (e: SudoEvent): void => {
    if (e.type === "mobile") return update({ status: "waiting-human", ask: { type: "access", stage: "mobile", number: e.number }, text: "Waiting for GitHub Mobile." });
    if (e.type === "checking") return update({ status: "running", ask: { type: "access", stage: "checking", method: e.method }, text: "GitHub is checking the confirmation." });
    if (e.type === "confirmed") return update({ status: "running", ask: null, text: "Access confirmed." });
  };
  return {
    signIn: async (driver: BrowserDriver): Promise<void> => {
      t.phase("signin", { status: "waiting-human", needs: null, detail: "", ask: { type: "credentials", methods: loginMethodsOf(recipe) }, text: "Sign in to GitHub: choose the way and enter your details." });
      const { creds, method } = await waitFor(rt, "credentials", signal);
      known.push(creds.username, creds.password);
      update({ ask: null, status: "running", text: "Signing in to GitHub." });
      await signIn(
        recipe,
        creds,
        driver,
        {
          onEvent: onLogin,
          requestCode: () => waitFor(rt, "code", signal),
          requestConfirm: () => waitFor(rt, "confirm", signal),
        },
        { timeoutMinutes: rt.automation.loginTimeoutMinutes, signal, method, keepOpen: true },
      );
    },
    access: {
      request: (ask) => {
        const patch: Partial<AutomationRunState> = {
          status: "waiting-human",
          needs: null,
          text: "Confirm access at GitHub.",
          ask: { type: "access", stage: "choose", methods: [...ask.methods], attempt: ask.attempt, maxAttempts: ask.maxAttempts, ...(ask.problem ? { problem: ask.problem } : {}) },
        };
        if (phased) t.phase("confirm", patch);
        else update(patch);
        return waitFor(rt, "access", signal);
      },
      onEvent: onAccess,
    },
  };
}

/** The confirmation the human typed in the portal for "Confirm access". It goes to the waiting run once and is not kept. */
export function submitTeamTokenAccess(rt: Runtime, actor: Actor, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Confirm access at GitHub");
  const ask = asked(rt);
  if (!open(rt, "access") || ask?.type !== "access" || ask.stage !== "choose") throw new IssuanceError("GitHub is not waiting for a confirmation.");
  deliver(rt, "access", sudoAnswerFrom(body, ask.methods));
  return rt.automation.state(RUN_KEY);
}

/** The sign-in method and credentials the human typed in the portal. They go to the waiting run once and are wiped when it ends. */
export function submitTeamTokenCredentials(rt: Runtime, actor: Actor, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Sign in at GitHub");
  const recipe = rt.automation.recipe(TEAM_TOKEN_RECIPE);
  if (!recipe || !open(rt, "credentials") || asked(rt)?.type !== "credentials") throw new IssuanceError("GitHub is not waiting for a sign-in.");
  const method = methodFrom(recipe, body);
  const creds = credentialsFrom(body);
  deliver(rt, "credentials", { creds, method });
  return rt.automation.state(RUN_KEY);
}

/** The one-time code of the GitHub sign-in. */
export function submitTeamTokenCode(rt: Runtime, actor: Actor, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Enter a one-time code");
  if (!open(rt, "code") || rt.automation.state(RUN_KEY).needs !== "mfa-code") throw new IssuanceError("GitHub is not waiting for a one-time code.");
  const code = typeof body["code"] === "string" ? body["code"].replace(/\s+/g, "") : "";
  if (typeof body["code"] === "string") body["code"] = "";
  if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) throw new InventoryError("The code is not valid (4 to 16 letters, digits or dashes).");
  deliver(rt, "code", code);
  return rt.automation.state(RUN_KEY);
}

/** The human confirmed or declined the authorization the identity provider asks for. */
export function submitTeamTokenConfirm(rt: Runtime, actor: Actor, body: Record<string, unknown>): AutomationRunState {
  requireHuman(actor, "Confirm the authorization");
  if (!open(rt, "confirm") || rt.automation.state(RUN_KEY).needs !== "consent") throw new IssuanceError("The provider is not waiting for an authorization.");
  if (typeof body["accept"] !== "boolean") throw new InventoryError("Say whether the authorization is accepted.");
  deliver(rt, "confirm", body["accept"]);
  return rt.automation.state(RUN_KEY);
}

// ------------------------------------------------------------------------------------------ the run

/** The delete run for the replaced token. Never throws: the result says whether the token is gone and, if not, why. */
async function revokeReplaced(rt: Runtime, recipe: Recipe, vars: Record<string, string>, oldName: string, t: Tracker, signal: AbortSignal, known: string[]): Promise<{ done: true } | { done: false; reason: string }> {
  try {
    const driver = await rt.automation.newDriver();
    await revokeRecipe(
      recipe,
      { ...vars, externalId: oldName },
      driver,
      {
        ...portalHooks(rt, recipe, t, signal, known, false),
        onWaitingForHuman: () => rt.automation.update(RUN_KEY, { status: "waiting-human", text: "Waiting at GitHub." }),
        onResumed: () => rt.automation.update(RUN_KEY, { status: "running", needs: null, text: "Continuing." }),
      },
      { loginTimeoutMinutes: rt.automation.loginTimeoutMinutes, signal, access: rt.automation.accessTiming },
    );
    return { done: true };
  } catch (err) {
    if (signal.aborted && !(err instanceof RecipeRunError && err.kind !== "abort")) return { done: false, reason: "The delete run was cancelled." };
    const reason = err instanceof SudoError || err instanceof RecipeRunError || err instanceof LoginError ? err.message : "The browser could not be used.";
    return { done: false, reason: redact(reason, known).replace(/\s+/g, " ").slice(0, MAX_TEXT) };
  }
}

async function runTeamToken(rt: Runtime, recipe: Recipe, req: TeamTokenRequest, vars: Record<string, string>, signal: AbortSignal, t: Tracker, now: Date): Promise<void> {
  const name = vars["name"]!;
  const known: string[] = [];
  let value: SecretValue;
  let expires: string | null;
  try {
    const driver = await rt.automation.newDriver();
    const result = await runRecipe(
      recipe,
      vars,
      driver,
      {
        ...portalHooks(rt, recipe, t, signal, known, true),
        onWaitingForHuman: (w) => {
          // Only when the portal cannot answer (no guided sign-in in the recipe, or it left the browser elsewhere): the browser window.
          const signIn = w.kind === "login";
          t.phase(signIn ? "signin" : "confirm", {
            status: "waiting-human",
            needs: null,
            ask: null,
            text: signIn ? "Sign in to GitHub in the browser window." : "Confirm access at GitHub in the browser window.",
          });
        },
        onResumed: () => rt.automation.update(RUN_KEY, { status: "running", needs: null, text: "Continuing." }),
        onProgress: (p) => {
          // Opening the form (goto, confirmation) still belongs to "opening", "signin" and "confirm": creating starts with the first fill or click.
          const form = p.label.startsWith("fill") || p.label.startsWith("click") || p.label.startsWith("select");
          if (form && rt.automation.state(RUN_KEY).status === "running") t.phase("creating", { text: "Creating the team token at GitHub.", step: { index: p.index, total: p.total } });
          else rt.automation.update(RUN_KEY, { step: { index: p.index, total: p.total } });
        },
      },
      { loginTimeoutMinutes: rt.automation.loginTimeoutMinutes, signal, access: rt.automation.accessTiming },
    );
    value = result.value;
    expires = result.expiresAt ?? new Date(now.getTime() + TEAM_TOKEN_DAYS * 86_400_000).toISOString().slice(0, 10);
  } catch (err) {
    return finishFailed(rt, t, failureOf(err, known, signal.aborted));
  }

  // Test with the new token itself before it becomes the active one. A failure keeps the previous state untouched.
  t.phase("testing", { status: "running", needs: null, ask: null, text: "Testing the new token." });
  const problem = await verifyTeamToken(rt, value, req);
  if (problem) {
    return finishFailed(rt, t, { code: "test", message: `${problem} The token ${name} was created at GitHub but not stored: delete it at ${GITHUB_TOKENS_URL}.`, createdName: name });
  }

  let before: Awaited<ReturnType<typeof readTeamTokenRecord>>;
  let meta: TeamTokenMeta;
  try {
    before = await readTeamTokenRecord(rt);
    meta = { repo: req.repo, mode: req.mode, strategy: req.strategy, tokenName: name, createdAt: now.toISOString(), expires };
    // The new value goes in first; the replaced token is noted for deletion at once, so a crash during the delete run loses nothing.
    if (rt.connections.vault) {
      await rt.connections.vault.set(TEAM_SYNC_CONNECTION, value.reveal(), expires);
      rt.connections.session.delete(TEAM_SYNC_CONNECTION);
    } else {
      rt.connections.session.set(TEAM_SYNC_CONNECTION, value, expires);
    }
    const pendingRevocation = before.active ? { tokenName: before.active.tokenName, repo: before.active.repo, since: now.toISOString() } : before.pendingRevocation;
    await writeTeamTokenRecord(rt, { active: meta, pendingRevocation });
  } catch {
    return finishFailed(rt, t, { code: "store", message: `The token ${name} was created at GitHub but could not be stored. Delete it at ${GITHUB_TOKENS_URL} and run this again.`, createdName: name });
  }

  // Delete the replaced token at GitHub with the recipe. A failure does not undo the new token: the old one stays listed, with the reason.
  let revoked: boolean | null = null;
  let revokeFailure: string | undefined;
  if (before.active) {
    t.phase("revoking", { status: "running", needs: null, ask: null, text: "Deleting the replaced token at GitHub." });
    const outcome = await revokeReplaced(rt, recipe, vars, before.active.tokenName, t, signal, known);
    revoked = outcome.done;
    try {
      if (outcome.done) await writeTeamTokenRecord(rt, { active: meta, pendingRevocation: before.pendingRevocation });
      else {
        revokeFailure = outcome.reason;
        await writeTeamTokenRecord(rt, { active: meta, pendingRevocation: { tokenName: before.active.tokenName, repo: before.active.repo, since: now.toISOString(), reason: outcome.reason } });
      }
    } catch {
      /* the note written before stays */
    }
  }
  t.phase("ready", { status: "running", needs: null, ask: null, text: "The team token is ready." });
  rt.automation.end(RUN_KEY, {
    status: "done",
    text: "The team token is ready.",
    needs: null,
    ask: null,
    timeline: t.done(),
    result: { tokenName: name, expires, repo: req.repo, mode: req.mode, revoked, ...(revokeFailure ? { revokeFailure } : {}) },
  });
}

export function cancelTeamToken(rt: Runtime, actor: Actor): AutomationRunState {
  requireHuman(actor, "Cancel the team token");
  return rt.automation.cancel(RUN_KEY);
}

/** The human deleted the old token at GitHub: stop reminding. */
export async function dismissTeamTokenRevocation(rt: Runtime, actor: Actor): Promise<TeamTokenInfo> {
  requireHuman(actor, "Confirm the deletion of the old team token");
  const rec = await readTeamTokenRecord(rt);
  await writeTeamTokenRecord(rt, { active: rec.active, pendingRevocation: null });
  return getTeamTokenInfo(rt, actor);
}

export interface TeamTokenSessionCheck {
  signedIn: boolean;
  checkedAt: string;
  failure?: { code: "busy" | "browser"; message: string };
}

/** Is the browser signed in at GitHub? Types nothing; opens the settings page and looks where GitHub sends the browser. */
export async function checkTeamTokenSession(rt: Runtime, actor: Actor): Promise<TeamTokenSessionCheck> {
  requireHuman(actor, "Check the GitHub sign-in");
  if (!rt.automation.enabled) throw new InventoryError("Browser automation is off (automation.enabled in the configuration).");
  const recipe = rt.automation.recipe(TEAM_TOKEN_RECIPE);
  if (!recipe) throw new InventoryError(`The recipe ${TEAM_TOKEN_RECIPE} is not loaded.`);
  const checkedAt = (): string => rt.now().toISOString();
  if (rt.automation.isBusy()) return { signedIn: false, checkedAt: checkedAt(), failure: { code: "busy", message: "A browser run is already in progress. Wait for it or cancel it first." } };
  const expect = recipe.login?.expect.url ? new RegExp(recipe.login.expect.url) : null;
  rt.automation.begin(CHECK_KEY, TEAM_TOKEN_RECIPE, { text: "Checking the browser session.", needs: null });
  const driver = await rt.automation.newDriver();
  try {
    await driver.open();
    await driver.goto("https://github.com/settings/profile");
    let url = await driver.currentUrl().catch(() => "");
    for (let i = 0; i < 8 && expect && !expect.test(url); i++) {
      await new Promise((r) => setTimeout(r, 250));
      url = await driver.currentUrl().catch(() => "");
    }
    const signedIn = expect !== null && expect.test(url);
    rt.automation.end(CHECK_KEY, { status: "done", text: signedIn ? "Signed in." : "Not signed in." });
    return { signedIn, checkedAt: checkedAt() };
  } catch {
    rt.automation.end(CHECK_KEY, { status: "failed", text: "The browser could not be used." });
    return { signedIn: false, checkedAt: checkedAt(), failure: { code: "browser", message: "The browser could not be used." } };
  } finally {
    await driver.close().catch(() => undefined);
  }
}
