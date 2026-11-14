import {
  type ActorRef,
  EnvEntrySchema,
  errorMatchesPlace,
  githubPlacesOf,
  isWorkerPlace,
  snapshotPlaces,
  EnvTemplateSchema,
  InventoryError,
  ParamsInvalidError,
  integrationDefaultsOf,
  preflightEntry,
  ttlDaysProblems,
  validateEntryParams,
  type EntryPreflight,
  SecretAgentCreateSchema,
  SecretAgentPatchSchema,
  SecretHumanPatchSchema,
  SecretValue,
  StaleIssuanceError,
  hasWriteStarted,
  writtenPlacesOf,
  type DiscardResult,
  VariableAgentCreateSchema,
  parseInput,
  parseStripeConnectionId,
  VENDORS,
  connectionRole,
  vendorOfConnection,
  vendorOfProvider,
  VENDOR_CATEGORIES,
  type VendorCategory,
  type VendorDef,
  readConnectionLabel,
  secretApprovalSnapshot,
  variableApprovalSnapshot,
  agentStageIds,
  adoptVariable,
  applyVariable,
  assertPublicValue,
  commitIssuance,
  computeStatus,
  discardIssuance,
  exportTeamBundle,
  inspectVariable,
  overallStatus,
  planRotation,
  prepareIssuance,
  renderEvidenceSvg,
  type CommitResult,
  type OverallStatus,
  type PendingIssuance,
  type Place,
  type ProviderDefSchema,
  type SecretEntry,
  type SecretSchema,
  type Stage,
  type StatusLevel,
  type VariableDrift,
  type VariableEntry,
  type VariableSchema,
  type VerificationReport,
} from "@secret-desk/core/portable";
import type { z } from "zod";
import type { Approval } from "./approvals.js";
import type { AutomationInfo, AutomationRunState } from "./automation-port.js";
import { connectionGuide } from "./connection-guides.js";
import { FACADES, facadeConnectionForRecipe } from "./facade-registry.js";
import { githubAppKeyStatus } from "./github-crypto-core.js";
import { paramStatus } from "./params.js";
import { posixBasename } from "./path-basename.js";
import { GITHUB_APP_KEY_CONNECTION, issuanceDeps, type RuntimeCore } from "./runtime-core.js";
import { neededRights } from "./team-token-rights.js";

/**
 * Die Operationen, die Portal, MCP-Server und CLI gemeinsam nutzen. Hier sitzt die Richtlinie:
 * Agenten duerfen Metadaten und Variablen-Sollwerte pflegen und Dev-Dateien erzeugen, aber nichts in staging
 * oder production ausloesen, ohne dass ein Mensch es freigibt. Bestaetigen darf nur ein Mensch.
 * Kein Rueckgabewert enthaelt je einen geheimen Wert.
 *
 * This module is the part of the agent API that needs no Node API: it takes a `RuntimeCore` and reaches the browser automation only
 * through the `AutomationPort`. The local edition's `agent-api.ts` re-exports all of it and adds what needs the file system (the
 * environment file export). The portable entry exports it by name.
 */
export interface Actor {
  /** "human" (Portal/CLI) oder "agent" (MCP). */
  kind: "human" | "agent";
  name: string;
  /**
   * Opaque, stable reference supplied by whatever authenticates the request (when anything does). This repository never
   * interprets it: it is stored next to the name and handed to the authorisation hook. Nothing sets it by default.
   */
  principalId?: string;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * The review is not there any more: it expired, was dealt with, or the process that held its value was restarted. This is a normal
 * outcome, not a fault: the value is gone and the way on is to issue it again. A `PolicyError` for callers that handle that class.
 */
export class IssuanceGoneError extends PolicyError {
  readonly code = "issuance-gone";
  constructor(id: string) {
    super(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
    this.name = "IssuanceGoneError";
  }
}

export const requireHuman = (actor: Actor, what: string): void => {
  if (actor.kind !== "human") throw new PolicyError(`${what} darf nur ein Mensch.`);
};

/** The reference to an actor that is recorded with an issuance or an approval (names and the opaque principal id, never a value). */
export const actorRef = (actor: Actor): ActorRef => ({ name: actor.name, kind: actor.kind, ...(actor.principalId ? { principalId: actor.principalId } : {}) });

/** Sensitive actions the authorisation hook is consulted for. */
export type AuthorizedAction =
  | "issuance.prepare"
  | "issuance.confirm"
  | "issuance.reject"
  | "issuance.manual-value"
  | "approval.resolve"
  | "inventory.edit"
  | "variable.apply"
  | "integration.connect"
  | "integration.disconnect"
  | "evidence.attach"
  | "automation.run"
  | "github.sync"
  | "team.sync.apply"
  | "team.sync.push"
  | "team.sync.configure"
  | "team.import"
  | "settings.edit"
  | "repo.link"
  | "connection.check"
  | "env.export";

/** The fixed names of the routines that run without a human or agent actor and ask the hook before they act. */
export const SYSTEM_ROUTINES = ["team-sync-startup", "sign-in-scheduler", "live-check-scheduler"] as const;
export type SystemRoutine = (typeof SYSTEM_ROUTINES)[number];

/**
 * The actor of a routine the process runs on its own (a timer or the start-up), only ever built inside the runtime by
 * `authorizeSystem`. It is not an `Actor`: nothing that comes from a request (portal, agent API, MCP) can carry it, and no
 * policy function accepts it.
 */
export interface SystemActor {
  kind: "system";
  name: SystemRoutine;
  /** Never set: a routine has no principal. Present in the type only so a hook can read `actor.principalId` without narrowing first. */
  principalId?: undefined;
}

export interface AuthorizationRequest {
  actor: Actor | SystemActor;
  action: AuthorizedAction;
  /** What the action concerns: ids and actor references only, never values. */
  subject?: {
    secretId?: string;
    variableId?: string;
    approvalId?: string;
    /** Id of a connection (for example `github`); an identifier, never a token. */
    connectionId?: string;
    /** Id of a repository (inventory name), for repository links and env export. */
    repo?: string;
    /** Who prepared the issuance this action is about, that is who caused it to run (for `issuance.confirm` and `issuance.reject`). */
    preparedBy?: ActorRef;
    /** Name of whoever asked for the approval this action belongs to (for `approval.resolve` and for what an approval causes). */
    requestedBy?: string;
    /** The same as a reference: kind and, when there is one, the opaque principal id of whoever asked. */
    requestedByRef?: ActorRef;
    stage?: string;
    /** How the action is done when that matters (for example `merge` or `replace` for a team import). */
    mode?: string;
  };
}

/** What the runtime reports when the hook faulted (see `RuntimeOptions.onAuthorizeFault`). Never a message, never a value. */
export interface AuthorizeFault {
  action: AuthorizedAction;
  reason: "threw" | "returned-value" | "timeout" | "not-a-function" | "invalid-actor";
  /** Class name of the foreign error, only for `threw`. */
  errorName?: string;
  /** The fixed routine name, only when the fault came from a routine the process runs on its own (a scheduled refusal), never for a person's request. */
  routine?: SystemRoutine;
}

/**
 * Called before a sensitive action, after the built-in policy checks (`requireHuman`, stage policy) have passed: it can only
 * refuse what the built-in rules allow, never allow what they refuse. Throw (preferably a `PolicyError`) to refuse; returning
 * `undefined` (or a promise of it) means allowed, any other return value is a refusal. May be async; it must settle within
 * `RuntimeOptions.authorizeTimeoutMs`. This repository ships no rules; a hook comes from the process that embeds the runtime.
 */
export type Authorize = (request: AuthorizationRequest) => void | Promise<void>;

/**
 * Consults the configured hook (if any). A refusal that is a `PolicyError` is passed on unchanged; anything else the hook throws
 * becomes a generic refusal so no hook internals reach a response. The hook gets a copy of the request.
 */
export async function authorize(rt: RuntimeCore, request: AuthorizationRequest & { actor: Actor }): Promise<void> {
  // Only a human or an agent can reach the hook through here. Any other kind (above all `system`, which only the runtime's own
  // routines may use, see `authorizeSystem`) is refused without asking the hook, even if a caller forged the object.
  const kind: unknown = request.actor.kind;
  if (rt.authorize !== undefined && kind !== "human" && kind !== "agent") return refuseAction(rt, request.action, "invalid-actor");
  return askHook(rt, request);
}

/** Fails closed: every fault is one generic refusal, reported (class name only) to the optional callback. */
function refuseAction(rt: RuntimeCore, action: AuthorizedAction, reason: AuthorizeFault["reason"], error?: unknown, routine?: SystemRoutine): never {
  try {
    rt.onAuthorizeFault?.({ action, reason, ...(routine ? { routine } : {}), ...(reason === "threw" ? { errorName: error instanceof Error ? error.constructor.name : typeof error } : {}) });
  } catch {
    // A faulty callback must not change the outcome.
  }
  throw new PolicyError("Die Berechtigungspruefung hat die Aktion nicht zugelassen.");
}

/**
 * Asks the hook on behalf of a routine the process runs on its own (a timer or the start-up), with the actor
 * `{ kind: "system", name: <routine> }`. True when the routine may go on. False when the hook refused or faulted (same rules as
 * `authorize`: any non-undefined result, a throw, a timeout or a non-function refuses; a fault is reported to
 * `onAuthorizeFault`): the routine skips that unit of work and tries again at its next turn. Never throws. Without a hook the
 * answer is true and nothing else happens. The subject carries ids only, never a value.
 */
export async function authorizeSystem(rt: RuntimeCore, routine: SystemRoutine, action: AuthorizedAction, subject?: AuthorizationRequest["subject"]): Promise<boolean> {
  try {
    await askHook(rt, { actor: { kind: "system", name: routine }, action, ...(subject ? { subject } : {}) });
    return true;
  } catch {
    return false;
  }
}

async function askHook(rt: RuntimeCore, request: AuthorizationRequest): Promise<void> {
  const hook = rt.authorize;
  if (hook === undefined) return;
  const refuse = (reason: AuthorizeFault["reason"], error?: unknown): never => refuseAction(rt, request.action, reason, error, request.actor.kind === "system" ? request.actor.name : undefined);
  if (typeof hook !== "function") return refuse("not-a-function");
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), rt.authorizeTimeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS);
    // Under Node a timer is an object with `unref`: a hung hook must not keep the process alive. Other runtimes return a number.
    if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  });
  let result: unknown;
  try {
    result = await Promise.race([Promise.resolve().then(() => hook(structuredClone(request))), timeout]);
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    return refuse("threw", err);
  } finally {
    clearTimeout(timer);
  }
  if (result === timedOut) return refuse("timeout");
  if (result !== undefined) return refuse("returned-value");
}

/** How long a hook may take before the action is refused. */
export const DEFAULT_AUTHORIZE_TIMEOUT_MS = 10_000;

/** Reads `id` and `stage` of a not yet validated entry for the hook subject. Only strings are taken, nothing else. */
const entrySubject = (entry: unknown, idKey: "secretId" | "variableId"): NonNullable<AuthorizationRequest["subject"]> => {
  const e = (typeof entry === "object" && entry !== null ? entry : {}) as { id?: unknown; stage?: unknown };
  return { ...(typeof e.id === "string" ? { [idKey]: e.id } : {}), ...(typeof e.stage === "string" ? { stage: e.stage } : {}) };
};

const agentMayRunNow = (rt: RuntimeCore, actor: Actor, stage: Stage, hasPlaces: boolean): boolean =>
  actor.kind === "human" || (agentStageIds(rt.config, rt.inventory.stages).includes(stage) && hasPlaces);

// ---------------------------------------------------------------------------------------------- Secrets

export interface SecretView {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  owner: string | null;
  link: string | null;
  tags: string[];
  product: string | null;
  stage: Stage;
  service: string;
  provider: string;
  automatic: boolean;
  /** Der Wert entsteht ueber ein Browserfenster (Rezept), nicht ueber eine API. */
  browser: boolean;
  /** The provider only reads a value the service already shows: "read again" instead of "generate", no expiry through the provider. */
  readOnly: boolean;
  expiry: SecretEntry["expiry"];
  expires: string | null;
  daysLeft: number | null;
  status: StatusLevel;
  rotatedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  ttlDays: number | null;
  places: Place[];
  guide: { url: string; steps: string[]; openUrl: string } | null;
  connection: string | null;
  /** Vendor (provider card) the entry counts for: its provider definition or browser recipe belongs to it. Null for generators and unknown providers. */
  vendor: string | null;
  /** A browser recipe with several portals: the host this entry's parameters pick (for the sign-in check of the right portal). Null otherwise. */
  browserHost: string | null;
  notes: string | null;
  /** Stand der Anbieter-Parameter: ok, missing (Pflichtparameter fehlen), invalid, none (der Anbieter braucht keine). Nur Schluessel, nie Werte. */
  params: { status: "ok" | "missing" | "invalid" | "none"; missing: string[] };
  /** Nur beim Live-Abgleich: Ziele, die GitHub nicht lesen liess (403/429/5xx). Fuer sie ist "fehlt" unbekannt. */
  liveErrors?: string[];
}

type LiveCheck = Awaited<ReturnType<typeof snapshotPlaces>>;

function view(rt: RuntimeCore, s: SecretEntry, today: Date, check?: LiveCheck): SecretView {
  const provider = rt.providers.get(s.provider);
  const errors = check?.errors ?? [];
  const failed = (p: Place): boolean => errors.some((e) => errorMatchesPlace(e, p));
  const liveErrors = check ? s.places.filter(failed).map((p) => errors.find((e) => errorMatchesPlace(e, p))!.message) : [];
  const r = computeStatus(s, today, { thresholds: rt.inventory.data.thresholds, ...(check ? { live: check.snapshot, owner: rt.owner, unreadable: failed } : {}) });
  return {
    id: s.id,
    name: s.name,
    title: s.title ?? null,
    description: s.description ?? null,
    owner: s.owner ?? null,
    link: s.link ?? null,
    tags: s.tags,
    product: s.product ?? null,
    stage: s.stage,
    service: s.service,
    provider: s.provider,
    automatic: provider?.kind === "automatic" && typeof provider.issue === "function",
    browser: rt.automation.isBrowserProvider(provider),
    readOnly: provider?.readOnly === true,
    expiry: s.expiry,
    expires: s.expires,
    daysLeft: r.daysLeft,
    status: r.status,
    rotatedAt: s.rotatedAt ?? null,
    verifiedAt: s.verifiedAt ?? null,
    verifiedBy: s.verifiedBy ?? null,
    ttlDays: s.ttlDays ?? null,
    places: s.places,
    guide: provider?.guide ? { url: provider.guide.url, steps: provider.guide.steps, openUrl: provider.guide.openUrl?.(s, { owner: rt.owner, now: today }) ?? provider.guide.url } : null,
    // Browser recipes need no connection token, but a recipe behind a facade belongs to that integration (overview counts).
    connection: provider?.connection ?? facadeConnectionForRecipe((provider as { automation?: { recipeId?: string } } | undefined)?.automation?.recipeId),
    vendor: vendorOfProvider(s.provider)?.id ?? null,
    // The portal host a multi-host browser recipe uses for this entry (its `hostBy` parameter), else null: the port answers it.
    browserHost: rt.automation.browserHostOf(provider, s.params),
    notes: s.notes ?? null,
    params: paramStatus(rt, s),
    ...(liveErrors.length > 0 ? { liveErrors: [...new Set(liveErrors)] } : {}),
  };
}

export interface ListFilter {
  stage?: Stage;
  repo?: string;
  product?: string;
  status?: StatusLevel;
  provider?: string;
  /** Freitext: Name, id, Beschreibung, Schlagworte, Verantwortlicher, Ziele. */
  q?: string;
  tag?: string;
  /** Live-Abgleich mit GitHub (Netzwerk). */
  live?: boolean;
}

export async function listSecrets(rt: RuntimeCore, filter: ListFilter = {}, today = new Date()): Promise<SecretView[]> {
  let secrets = rt.inventory.data.secrets;
  if (filter.stage) secrets = secrets.filter((s) => s.stage === filter.stage);
  if (filter.repo) secrets = secrets.filter((s) => githubPlacesOf(s.places).some((p) => p.repo === filter.repo));
  if (filter.product) secrets = secrets.filter((s) => s.product === filter.product);
  if (filter.provider) secrets = secrets.filter((s) => s.provider === filter.provider);
  if (filter.tag) secrets = secrets.filter((s) => s.tags.includes(filter.tag!));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    secrets = secrets.filter((s) => [s.id, s.name, s.title, s.description, s.owner, s.product, s.service, ...s.tags, ...s.places.map((p) => (isWorkerPlace(p) ? p.script : p.repo))].some((x) => x?.toLowerCase().includes(q)));
  }
  const live = filter.live ? await snapshotPlaces({ github: rt.github, workers: rt.workers, owner: rt.owner }, secrets.flatMap((s) => s.places)) : undefined;
  const views = secrets.map((s) => view(rt, s, today, live));
  const out = filter.status ? views.filter((v) => v.status === filter.status) : views;
  return out.sort((a, b) => (b.daysLeft === null ? -1 : a.daysLeft === null ? 1 : a.daysLeft - b.daysLeft));
}

export function getSecret(rt: RuntimeCore, id: string, today = new Date()): SecretView {
  const s = rt.inventory.getSecret(id);
  if (!s) throw new InventoryError(`Secret nicht gefunden: ${id}`);
  return view(rt, s, today);
}

export interface Overview {
  total: number;
  byStage: Record<Stage, number>;
  byStatus: Record<StatusLevel, number>;
  attention: SecretView[];
  variables: number;
  pendingReviews: number;
  pendingApprovals: number;
}

export async function overview(rt: RuntimeCore, today = new Date()): Promise<Overview> {
  const all = await listSecrets(rt, {}, today);
  const byStage: Record<Stage, number> = Object.fromEntries(rt.inventory.stages.map((d) => [d.id, 0]));
  const byStatus: Record<StatusLevel, number> = { ok: 0, unknown: 0, soon: 0, "no-date": 0, due: 0, missing: 0, expired: 0 };
  for (const v of all) {
    byStage[v.stage] = byStage[v.stage]! + 1;
    byStatus[v.status] += 1;
  }
  return {
    total: all.length,
    byStage,
    byStatus,
    attention: all.filter((v) => ["expired", "due", "missing", "no-date", "soon"].includes(v.status)).slice(0, 25),
    variables: rt.inventory.data.variables.length,
    pendingReviews: rt.issuances.list().length,
    pendingApprovals: rt.approvals.list("pending").length,
  };
}

/** The vendors (one card each on the Integrations page) with the ids that belong to them. No values, no state. */
export function listVendors(): { categories: VendorCategory[]; vendors: (VendorDef & { facade: boolean })[] } {
  // `facade`: the vendor has a guided sign-in (same id), so its card always offers "Connect".
  return { categories: [...VENDOR_CATEGORIES], vendors: VENDORS.map((v) => ({ ...v, facade: FACADES.some((f) => f.id === v.id) })) };
}

export function listProviders(rt: RuntimeCore) {
  return rt.providers.list().map((p) => ({ id: p.id, label: p.label, kind: p.kind, browser: rt.automation.isBrowserProvider(p), readOnly: p.readOnly === true, connection: p.connection ?? null, vendor: vendorOfProvider(p.id)?.id ?? null, guide: p.guide ? { url: p.guide.url, steps: p.guide.steps } : null }));
}

/** Stack-Adresse fuer den Direktlink: Standardwert der Integration, sonst die erste baseUrl eines Grafana-Eintrags. */
function grafanaBase(rt: RuntimeCore): string | undefined {
  const d = rt.inventory.data.integrationDefaults?.["grafana"]?.["baseUrl"];
  if (typeof d === "string") return d;
  const e = rt.inventory.data.secrets.find((x) => x.provider === "grafana-service-account-token" && typeof x.params["baseUrl"] === "string");
  return e ? String(e.params["baseUrl"]) : undefined;
}

/** "Name (Sandbox)" for a Stripe connection of an account whose name is known; undefined otherwise. */
function stripeLabel(id: string, name: string | undefined): string | undefined {
  const p = parseStripeConnectionId(id);
  return p && name ? `Stripe ${name} (${p.mode === "live" ? "Live" : "Sandbox"})` : undefined;
}

export async function listConnections(rt: RuntimeCore) {
  // Stripe connections per account and mode (`stripe:<acct_id>:<mode>`) exist only once a key was stored for them.
  const stripeAccounts = (await rt.connections.ids("stripe:")).filter((id) => parseStripeConnectionId(id) !== null);
  const ids = [...new Set(["github", "github-app-key", ...(rt.config.teamSync ? ["team-sync"] : []), "stripe-test", "stripe-live", ...stripeAccounts, ...rt.providers.list().flatMap((p) => (p.connection ? [p.connection] : []))])];
  const statuses = await rt.connections.statuses(ids);
  // With an injected signer the GitHub App is usable without a stored key (the shared answer of `githubAppKeyStatus`).
  const appIndex = statuses.findIndex((x) => x.id === GITHUB_APP_KEY_CONNECTION);
  if (appIndex >= 0 && !statuses[appIndex]!.connected) statuses[appIndex] = await githubAppKeyStatus(rt);
  // Team-Sync ohne eigenes Token nutzt die GitHub-Integration: so anzeigen, nicht als "nicht verbunden".
  const gh = [statuses.find((x) => x.id === "github"), statuses.find((x) => x.id === "github-app-key")].find((x) => x?.connected);
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i]!;
    if (s.id === "team-sync" && !s.connected && gh?.connected) statuses[i] = { ...s, connected: true, source: "github" as const, ...(gh.expires !== undefined ? { expires: gh.expires } : {}) };
  }
  const saved = new Map<string, string>();
  for (const s of statuses) {
    const info = s.source === "vault" ? await rt.connections.vault?.info(s.id).catch(() => null) : null;
    if (info) saved.set(s.id, info.savedAt);
  }
  const stripeNames = new Map<string, string>();
  for (const id of stripeAccounts) {
    const name = await readConnectionLabel(rt.connections, id);
    if (name) stripeNames.set(id, name);
  }
  return statuses.map((s) => {
    const g = connectionGuide(s.id, rt.owner, s.id === "grafana" ? { grafanaBaseUrl: grafanaBase(rt) } : s.id === "team-sync" && rt.config.teamSync ? { teamRepo: rt.config.teamSync.repo, teamRights: neededRights(rt.config.teamSync) } : {});
    const days = s.expires ? Math.ceil((Date.parse(`${s.expires}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
    const v = vendorOfConnection(s.id);
    return { ...s, vendor: v?.id ?? null, role: v ? connectionRole(v, s.id) : "primary", canRemember: Boolean(rt.connections.vault), daysLeft: days, savedAt: saved.get(s.id) ?? null, label: stripeLabel(s.id, stripeNames.get(s.id)) ?? g?.label ?? s.id, description: g?.description ?? null, url: g?.url ?? null, openUrl: g ? g.openUrl ?? g.url : null, steps: g?.steps ?? [], permissions: g?.permissions ?? [] };
  });
}

/** Dateinamen, die Agenten als .env-Ziel nutzen duerfen: .env, .env.local, .env.development ... (nicht .envrc, .npmrc, Makefile, *.sh). */
export const AGENT_ENV_FILENAME = /^\.env(?:\.(?!(?:sh|bash|zsh|fish|ksh|csh|command|ps1|bat|cmd|py|js|mjs|cjs|rb|pl|php)$)[A-Za-z0-9_-]+)*$/i;
/** Whether an agent may name this path as the target of an environment file: only the file name counts (see `AGENT_ENV_FILENAME`). */
export const agentMayWriteEnvFile = (path: string): boolean => AGENT_ENV_FILENAME.test(posixBasename(path.replace(/\\/g, "/")));

/** Parameter-Namen, ueber die ein Anbieter ein Netzwerkziel bekommen koennte. Agenten setzen sie nie; ein Mensch im Portal. */
const NETWORK_PARAM_KEYS: ReadonlySet<string> = new Set(["baseurl", "url", "endpoint", "host", "hostname", "origin", "webhookurl", "server"]);

const agentStages = (rt: RuntimeCore): string[] => agentStageIds(rt.config, rt.inventory.stages);

/**
 * Neue Eintraege. Menschen: alles, was das Schema erlaubt. Agenten: nur Stages der Art dev, nur bekannte Anbieter,
 * keine Netzwerkziele in params, keine Pruefstempel und keine Anbieter-Kennung. Ausgeloest wird dadurch nichts.
 */
export async function addSecret(rt: RuntimeCore, actor: Actor, entry: unknown): Promise<SecretView> {
  if (actor.kind === "agent") {
    const e = parseInput(SecretAgentCreateSchema, entry);
    if (!agentStages(rt).includes(e.stage)) throw new PolicyError(`Agenten legen Eintraege nur in Stages der Art dev an (Stage ${e.stage}). Stage angeben.`);
    if (e.provider !== "manual" && !rt.providers.get(e.provider)) throw new InventoryError(`Unbekannter Anbieter: ${e.provider}`);
    const bad = Object.keys(e.params).filter((k) => NETWORK_PARAM_KEYS.has(k.toLowerCase()));
    if (bad.length > 0) throw new PolicyError(`Agenten setzen keine Adressen in params (${bad.join(", ")}). Das macht ein Mensch im Portal.`);
  }
  // Parameter schon beim Anlegen gegen die Spezifikation pruefen (mit Standardwerten der Integration als Fallback).
  const wanted = entry as { provider?: unknown; params?: unknown };
  const provider = typeof wanted.provider === "string" ? rt.providers.get(wanted.provider) : undefined;
  if (provider?.params?.length) {
    const problems = validateEntryParams(provider, { params: typeof wanted.params === "object" && wanted.params !== null && !Array.isArray(wanted.params) ? (wanted.params as Record<string, unknown>) : {} }, integrationDefaultsOf(rt.inventory, provider));
    if (problems.length > 0) throw new ParamsInvalidError(problems);
  }
  await authorize(rt, { actor, action: "inventory.edit", subject: entrySubject(entry, "secretId") });
  const created = rt.inventory.addSecret(entry as z.input<typeof SecretSchema>);
  await rt.inventory.save();
  return view(rt, created, new Date());
}

/** Lesender Vorabcheck eines (neuen) Eintrags. Fuer die Antwort beim Anlegen und fuer den Plan. */
export function preflightSecret(rt: RuntimeCore, id: string) {
  const secret = rt.inventory.getSecret(id);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${id}`);
  return preflightEntry(secret, issuanceDeps(rt));
}

/**
 * Aenderung an einem bestehenden Eintrag. Mensch: ausdruecklich benannte, bearbeitbare Felder.
 * Agent: nur title, description, owner, link, tags, notes, product. Alles andere ist ein Fehler (nicht ignoriert).
 */
export async function updateSecretMeta(rt: RuntimeCore, actor: Actor, id: string, patch: unknown): Promise<SecretView> {
  const parsed = actor.kind === "agent" ? parseInput(SecretAgentPatchSchema, patch) : parseInput(SecretHumanPatchSchema, patch);
  await authorize(rt, { actor, action: "inventory.edit", subject: { secretId: id } });
  const updated = rt.inventory.patchSecret(id, parsed as Parameters<RuntimeCore["inventory"]["patchSecret"]>[1]);
  await rt.inventory.save();
  return view(rt, updated, new Date());
}

export async function addManualProvider(rt: RuntimeCore, actor: Actor, def: z.input<typeof ProviderDefSchema>) {
  // Ein neuer Anbieter darf keinen bestehenden ersetzen (auch keinen eingebauten): sonst waere ein automatischer ploetzlich ein manueller.
  const wanted = (def as { id?: unknown }).id;
  if (typeof wanted === "string" && rt.providers.get(wanted)) throw new InventoryError(`Anbieter existiert schon: ${wanted}`);
  await authorize(rt, { actor, action: "inventory.edit" });
  const created = rt.inventory.addProvider(def);
  await rt.inventory.save();
  rt.providers.register({ id: created.id, label: created.label, kind: "manual", guide: { url: created.url, steps: created.steps } });
  return created;
}

/** Agenten: nur Dev-Stages, nur .env-Dateinamen, `issue`-Quellen nur aus Dev-Stages. */
function assertAgentTemplate(rt: RuntimeCore, stage: string, file: string | undefined, entries: z.output<typeof EnvEntrySchema>[]): void {
  if (!agentStages(rt).includes(stage)) throw new PolicyError(`Agenten legen Vorlagen nur fuer Stages der Art dev an (Stage ${stage}).`);
  if (file !== undefined && !agentMayWriteEnvFile(file)) throw new PolicyError("Agenten duerfen nur Dateien namens .env oder .env.* als Ziel einer Vorlage setzen.");
  for (const e of entries) {
    if (e.from.type !== "issue") continue;
    const s = rt.inventory.getSecret(e.from.secret);
    if (s && !agentStages(rt).includes(s.stage)) throw new PolicyError(`Agenten duerfen kein Secret aus Stage ${s.stage} in eine Vorlage aufnehmen.`);
  }
}

export async function addEnvTemplate(rt: RuntimeCore, actor: Actor, template: z.input<typeof EnvTemplateSchema>) {
  if (actor.kind === "agent") {
    const t = parseInput(EnvTemplateSchema, template);
    assertAgentTemplate(rt, t.stage, t.file, t.entries);
  }
  await authorize(rt, { actor, action: "inventory.edit" });
  const created = rt.inventory.addEnvTemplate(template);
  await rt.inventory.save();
  return created;
}

export async function addEnvEntry(rt: RuntimeCore, actor: Actor, templateId: string, entry: z.input<typeof EnvEntrySchema>) {
  if (actor.kind === "agent") {
    const t = rt.inventory.data.envTemplates.find((x) => x.id === templateId);
    if (!t) throw new InventoryError(`Vorlage nicht gefunden: ${templateId}`);
    assertAgentTemplate(rt, t.stage, t.file, [parseInput(EnvEntrySchema, entry)]);
  }
  await authorize(rt, { actor, action: "inventory.edit" });
  const updated = rt.inventory.addEnvEntry(templateId, entry);
  await rt.inventory.save();
  return updated;
}

export function teamExport(rt: RuntimeCore): string {
  return exportTeamBundle(rt.inventory.data);
}

// ------------------------------------------------------------------------- Ausstellen und Bestaetigen

export interface IssuanceView {
  id: string;
  secretId: string;
  secretName: string;
  stage: Stage;
  provider: string;
  kind: VerificationReport["kind"];
  createdAt: string;
  expiresAt: string;
  overall: OverallStatus;
  /** Who prepared it: name, kind and an opaque principal id when there is one. Never a value. */
  preparedBy?: ActorRef;
  /** Who asked for it, when that is someone else than the preparer (for example the agent whose request a human approved). */
  requestedBy?: ActorRef;
  /** The approval request it was prepared for, when there was one. */
  approvalId?: string;
  report: VerificationReport;
}

function issuanceView(p: { id: string; secretId: string; createdAt: string; expiresAt: string; preparedBy?: ActorRef; requestedBy?: ActorRef; approvalId?: string; report: VerificationReport }): IssuanceView {
  return {
    id: p.id,
    secretId: p.secretId,
    secretName: p.report.secretName,
    stage: p.report.stage,
    provider: p.report.provider,
    kind: p.report.kind,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    overall: overallStatus(p.report.checks),
    ...(p.preparedBy ? { preparedBy: { ...p.preparedBy } } : {}),
    ...(p.requestedBy ? { requestedBy: { ...p.requestedBy } } : {}),
    ...(p.approvalId ? { approvalId: p.approvalId } : {}),
    report: p.report,
  };
}

/** The hook subject of an action on a pending review: who prepared it, who asked and which approval it belongs to. Ids and references only. */
const issuanceSubject = (p: PendingIssuance): NonNullable<AuthorizationRequest["subject"]> => ({
  secretId: p.secretId,
  stage: p.report.stage,
  ...(p.preparedBy ? { preparedBy: p.preparedBy } : {}),
  ...(p.requestedBy ? { requestedBy: p.requestedBy.name, requestedByRef: p.requestedBy } : {}),
  ...(p.approvalId ? { approvalId: p.approvalId } : {}),
});

/**
 * Puts a prepared review into the queue. When the queue cannot keep it (`add` throws: the store refused the record) and the value was
 * issued at a provider, that value is now known to nobody: it takes the path of an expired review (`discardIssuance`, through the
 * revoke gate, which decides; a refusal or a failed delete is reported and retried as in the sweep), then the original error is
 * rethrown. A manual value was never issued anywhere: it is only dropped.
 */
async function keepOrDiscard(rt: RuntimeCore, pending: PendingIssuance): Promise<void> {
  try {
    rt.issuances.add(pending);
  } catch (err) {
    if (pending.report.kind === "issued") await rt.issuances.discardUnkept(pending, issuanceDeps(rt));
    else {
      pending.value = new SecretValue("");
      for (const c of pending.companions) c.value = new SecretValue("");
    }
    throw err;
  }
}

/**
 * prepareIssuance; bei einem Browser-Anbieter als verfolgter Lauf (Zustand, Abbruch, nur einer gleichzeitig)
 * und mit den Belegen des Browsers als Anlagen am Bericht.
 */
async function prepareTracked(rt: RuntimeCore, actor: Actor, secretId: string, via?: { requestedBy: ActorRef; approvalId: string }): Promise<PendingIssuance> {
  const secret = rt.inventory.getSecret(secretId);
  /* v8 ignore start -- every caller names an entry that exists; prepareIssuance reports a missing one */
  const provider = secret ? rt.providers.get(secret.provider) : undefined;
  /* v8 ignore stop */
  const options = { preparedBy: actorRef(actor), ...(via ?? {}) };
  if (!rt.automation.isBrowserProvider(provider)) return prepareIssuance(secretId, issuanceDeps(rt), options);
  return rt.automation.run(
    secretId,
    provider,
    async () => {
      const pending = await prepareIssuance(secretId, issuanceDeps(rt), options);
      await rt.automation.attach(provider, secretId, pending.report.id);
      return pending;
    },
    (p) => p.id,
  );
}

// ------------------------------------------------------------------------------ Browser-Automatisierung

export async function getAutomation(rt: RuntimeCore, actor: Actor): Promise<AutomationInfo> {
  requireHuman(actor, "Die Browser-Automatisierung ansehen");
  return rt.automation.status();
}

export function getAutomationRun(rt: RuntimeCore, actor: Actor, secretId: string): AutomationRunState {
  requireHuman(actor, "Browser-Laeufe ansehen");
  return rt.automation.state(secretId);
}

export function cancelAutomationRun(rt: RuntimeCore, actor: Actor, secretId: string): AutomationRunState {
  requireHuman(actor, "Browser-Laeufe abbrechen");
  return rt.automation.cancel(secretId);
}

export type IssuanceRequestResult =
  | { status: "awaiting-review"; issuance: IssuanceView; message: string }
  | { status: "pending-approval"; approvalId: string; secretId: string; message: string }
  | { status: "dry-run"; plan: ReturnType<typeof planRotation>; /** Nur fuer Menschen: lesender Vorabcheck beim Anbieter. */ preflight?: EntryPreflight };

/**
 * Bittet um einen neuen Wert. Menschen stossen sofort die Pruefung an. Agenten nur in freigegebenen Stages,
 * sonst entsteht eine Anfrage, die ein Mensch im Portal freigibt. In keinem Fall wird in GitHub geschrieben,
 * bevor ein Mensch den Pruefbericht bestaetigt hat.
 */
export async function requestIssuance(rt: RuntimeCore, actor: Actor, secretId: string, options: { reason?: string; dryRun?: boolean } = {}): Promise<IssuanceRequestResult> {

  const secret = rt.inventory.getSecret(secretId);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${secretId}`);
  // Reject a value the provider cannot honour before any plan, approval, run state or provider call.
  const ttlProblems = ttlDaysProblems(rt.providers.get(secret.provider), secret);
  if (ttlProblems.length > 0) throw new ParamsInvalidError(ttlProblems);
  if (options.dryRun) {
    const plan = planRotation(secretId, rt);
    // Agenten bekommen nur den Parameterstand; Namen von Konten, Projekten usw. liest nur ein Mensch.
    return actor.kind === "human" ? { status: "dry-run", plan, preflight: await preflightEntry(secret, issuanceDeps(rt)) } : { status: "dry-run", plan };
  }
  await authorize(rt, { actor, action: "issuance.prepare", subject: { secretId, stage: secret.stage } });
  // Ein Browser-Lauf oeffnet ein Fenster am Rechner des Menschen: Agenten brauchen dafuer in jeder Stage eine Freigabe.
  const isBrowser = rt.automation.isBrowserProvider(rt.providers.get(secret.provider));
  const browser = actor.kind === "agent" && isBrowser;
  if (actor.kind === "human" && isBrowser) await authorize(rt, { actor, action: "automation.run", subject: { secretId, stage: secret.stage } });
  if (browser || !agentMayRunNow(rt, actor, secret.stage, secret.places.length > 0)) {
    const approval = rt.approvals.create({ action: "issue", targetId: secretId, requestedBy: actor.name, requestedByRef: actorRef(actor), reason: options.reason ?? null, snapshot: secretApprovalSnapshot(secret) });
    return {
      status: "pending-approval",
      approvalId: approval.id,
      secretId,
      message: browser ? "Dieser Anbieter oeffnet ein Browserfenster. Das braucht immer eine Freigabe im Portal (Reiter Freigaben)." : `Stage ${secret.stage} braucht eine Freigabe im Portal (Reiter Freigaben).`,
    };
  }
  // Aufraeumen abgelaufener Pruefungen passiert beim Start einer neuen Ausstellung (und im Takt des Portals), nie beim Lesen.
  await rt.issuances.sweep(issuanceDeps(rt));
  const pending = await prepareTracked(rt, actor, secretId);
  await keepOrDiscard(rt, pending);
  return { status: "awaiting-review", issuance: issuanceView(pending), message: "Wert erzeugt und geprueft. Ein Mensch bestaetigt ihn im Portal (Reiter Pruefen), erst dann wird geschrieben." };
}

/** Der Mensch gibt den Wert selbst ein (zum Beispiel ein Stripe-Key). Er wird geprueft und wartet auf Bestaetigung. */
export async function submitManualValue(rt: RuntimeCore, actor: Actor, secretId: string, value: string): Promise<IssuanceView> {
  requireHuman(actor, "Werte eingeben");
  const stage = rt.inventory.getSecret(secretId)?.stage;
  await authorize(rt, { actor, action: "issuance.manual-value", subject: { secretId, ...(stage ? { stage } : {}) } });
  const pending = await prepareIssuance(secretId, issuanceDeps(rt), { manualValue: new SecretValue(value.trim()), preparedBy: actorRef(actor) });
  await keepOrDiscard(rt, pending);
  return issuanceView(pending);
}

/**
 * Reading checks the deadline itself (the queue treats an expired review as absent and drops its value right there), whether or not
 * a sweep ran. The call that deletes the new value at the provider is not made while reading: the next sweep does it.
 */
export async function listIssuances(rt: RuntimeCore): Promise<IssuanceView[]> {
  return rt.issuances.list().map(issuanceView);
}

export async function getIssuance(rt: RuntimeCore, id: string): Promise<IssuanceView> {
  const p = rt.issuances.get(id);
  if (!p) throw new IssuanceGoneError(id);
  return issuanceView(p);
}

/*
 * Only a review that exists is authorised: for an id nobody knows the answer is "gone", with no hook call (a call per guessed id
 * would write one audit entry per guess and could consume a per-action approval). Review ids are random, so they cannot be
 * guessed; an authenticated person can tell "gone" from "not allowed", which is acceptable for the person who may confirm.
 */
export async function confirmIssuance(rt: RuntimeCore, actor: Actor, id: string, input: { ticks: string[]; note?: string; force?: boolean }): Promise<CommitResult> {
  requireHuman(actor, "Bestaetigen");
  const pending = rt.issuances.get(id);
  if (!pending) throw new IssuanceGoneError(id);
  // Claimed before the first await: while the hook (or the commit) is pending, no second confirm or reject can start on this review.
  if (!rt.issuances.claim(id)) throw new PolicyError("Die Pruefung wird gerade bearbeitet oder ist schon erledigt.");
  try {
    await authorize(rt, { actor, action: "issuance.confirm", subject: issuanceSubject(pending) });
    // Clean-up of other expired reviews runs after the person was authorised, never before.
    await rt.issuances.sweep(issuanceDeps(rt));
    // The hook may have taken a while: only go on with the very same item.
    if (rt.issuances.get(id) !== pending) throw new IssuanceGoneError(id);
    const result = await commitIssuance(pending, issuanceDeps(rt), { by: actor.name, ...(actor.principalId ? { principalId: actor.principalId } : {}), ticks: input.ticks, ...(input.note ? { note: input.note } : {}) }, { force: Boolean(input.force), signal: rt.issuances.signal(id)!, hardBound: rt.issuances.hardBound(id)!, beforeWrite: () => rt.issuances.markWriteStarted(id) });
    if (result.ok) rt.issuances.delete(id);
    return result;
  } catch (err) {
    // The review is stale and cannot be saved. The commit asked the gate to revoke the new value: when the gate refused because a
    // write was started earlier (a partial attempt), the record stays for a person; otherwise the review goes, and a delete the
    // provider did not confirm is owed.
    if (err instanceof StaleIssuanceError) {
      if (err.revokeRefused === "write-started") await rt.issuances.keepForDecision(pending, issuanceDeps(rt));
      else {
        rt.issuances.delete(id);
        rt.issuances.oweIfNeeded(pending, { revokedNew: err.revokedNew, ...(err.revokeRefused ? { refused: err.revokeRefused } : {}) });
      }
    }
    throw err;
  } finally {
    rt.issuances.release(id);
  }
}

/**
 * Rejecting a review a write was started for would revoke a value that may be in use at the places named here. It is refused
 * unless the call carries the acknowledgement (`acknowledgeWritten`): only a person who has seen the places can supply it.
 */
export class IssuanceWrittenError extends PolicyError {
  readonly code = "write-started";
  readonly places: readonly string[];
  constructor(places: readonly string[]) {
    super(`Ein Schreibvorgang wurde begonnen: der neue Wert ist an diesen Orten oder koennte dort sein: ${places.join(", ")}. Ablehnen widerruft ihn beim Anbieter und kann Dienste abschalten, die ihn nutzen.`);
    this.name = "IssuanceWrittenError";
    this.places = [...places];
  }
}

export async function rejectIssuance(rt: RuntimeCore, actor: Actor, id: string, note?: string, options: { acknowledgeWritten?: boolean } = {}): Promise<DiscardResult> {
  requireHuman(actor, "Ablehnen");
  const pending = rt.issuances.get(id);
  if (!pending) throw new IssuanceGoneError(id);
  if (!rt.issuances.claim(id)) throw new PolicyError("Die Pruefung wird gerade bearbeitet oder ist schon erledigt.");
  try {
    await authorize(rt, { actor, action: "issuance.reject", subject: issuanceSubject(pending) });
    if (rt.issuances.get(id) !== pending) throw new IssuanceGoneError(id);
    if (hasWriteStarted(pending) && options.acknowledgeWritten !== true) throw new IssuanceWrittenError(writtenPlacesOf(pending));
    // The queue entry goes only after the discard settled; a delete the provider did not confirm (or an error out of the discard)
    // is owed, and tried again by the sweep like the delete of an expired review.
    let result: DiscardResult = { revokedNew: false };
    try {
      result = await discardIssuance(pending, issuanceDeps(rt), { by: actor.name, ...(actor.principalId ? { principalId: actor.principalId } : {}), why: "rejected", ...(note ? { note } : {}), ...(options.acknowledgeWritten === true ? { acknowledgeWritten: true } : {}) });
    } finally {
      rt.issuances.delete(id);
      rt.issuances.oweIfNeeded(pending, result, { acknowledgeWritten: options.acknowledgeWritten === true });
    }
    return result;
  } finally {
    rt.issuances.release(id);
  }
}

// ------------------------------------------------------------------------------------- Belege, Anlagen

export async function listEvidence(rt: RuntimeCore, secretId: string): Promise<VerificationReport[]> {
  return rt.evidence.list(secretId);
}

export async function getEvidence(rt: RuntimeCore, secretId: string, reportId: string): Promise<VerificationReport> {
  const r = await rt.evidence.get(secretId, reportId);
  if (!r) throw new PolicyError("Bericht nicht gefunden");
  return r;
}

/**
 * The evidence sheet as an image. `lang: "en"` renders the sheet in English; the stored check texts are translated only when the
 * caller passes `translate` (the local edition's `evidenceSvg` binds the English catalogue, which needs every provider and so
 * stays on the Node side). Without it the check texts appear as stored. Default "de" is unchanged.
 */
export async function evidenceSvg(rt: RuntimeCore, secretId: string, reportId: string, lang: "de" | "en" = "de", translate?: (text: string) => string): Promise<string> {
  const report = await getEvidence(rt, secretId, reportId);
  // Only the human text fields are translated: expected/actual are data values and must stay as stored.
  const checks = lang === "en" && translate ? report.checks.map((c) => ({ ...c, label: translate(c.label), ...(c.detail !== undefined ? { detail: translate(c.detail) } : {}) })) : report.checks;
  return renderEvidenceSvg({ ...report, checks }, lang);
}

export async function attachEvidence(rt: RuntimeCore, actor: Actor, secretId: string, reportId: string, bytes: Uint8Array, mime: string, note?: string) {
  requireHuman(actor, "Anlagen hinzufuegen");
  await authorize(rt, { actor, action: "evidence.attach", subject: { secretId } });
  return rt.evidence.attach(secretId, reportId, bytes, mime, note);
}

export async function readAttachment(rt: RuntimeCore, secretId: string, reportId: string, file: string) {
  return rt.evidence.readAttachment(secretId, reportId, file);
}

// -------------------------------------------------------------------------------------------- Variablen

export interface VariableView {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  link: string | null;
  tags: string[];
  product: string | null;
  stage: Stage;
  value: string | null;
  /** Quelle des Sollwerts in einer Integration, falls gesetzt. */
  from: { connection: string; kind: string; resource: string; field: string } | null;
  places: Place[];
}

const variableView = (v: VariableEntry): VariableView => ({
  id: v.id,
  name: v.name,
  description: v.description ?? null,
  owner: v.owner ?? null,
  link: v.link ?? null,
  tags: v.tags,
  product: v.product ?? null,
  stage: v.stage,
  value: v.value,
  from: v.from ?? null,
  places: v.places,
});

export function listVariables(rt: RuntimeCore, filter: { stage?: Stage; repo?: string; product?: string; q?: string; tag?: string } = {}): VariableView[] {
  let list = rt.inventory.data.variables;
  if (filter.tag) list = list.filter((v) => v.tags.includes(filter.tag!));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    list = list.filter((v) => [v.id, v.name, v.description, v.owner, v.product, v.value, ...v.tags, ...v.places.map((p) => p.repo)].some((x) => x?.toLowerCase().includes(q)));
  }
  if (filter.stage) list = list.filter((v) => v.stage === filter.stage);
  if (filter.repo) list = list.filter((v) => v.places.some((p) => p.repo === filter.repo));
  if (filter.product) list = list.filter((v) => v.product === filter.product);
  return list.map(variableView);
}

export function getVariable(rt: RuntimeCore, id: string): VariableView {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  return variableView(v);
}

/** Soll gegen Ist, live aus GitHub. */
export async function inspectVariableLive(rt: RuntimeCore, id: string): Promise<{ variable: VariableView; drift: VariableDrift[] }> {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  return { variable: variableView(v), drift: await inspectVariable(rt.github, rt.owner, v) };
}

export async function addVariable(rt: RuntimeCore, actor: Actor, entry: z.input<typeof VariableSchema>, options: { acknowledgedPublic?: boolean } = {}): Promise<VariableView> {
  if (actor.kind === "agent") parseInput(VariableAgentCreateSchema, entry);
  if (entry.value !== null && entry.value !== undefined) assertPublicValue(entry.name, entry.value, actor.kind === "human" && Boolean(options.acknowledgedPublic));
  await authorize(rt, { actor, action: "inventory.edit", subject: entrySubject(entry, "variableId") });
  const created = rt.inventory.addVariable(entry);
  await rt.inventory.save();
  return variableView(created);
}

export async function updateVariable(rt: RuntimeCore, actor: Actor, id: string, patch: { value?: string | null; description?: string | null; owner?: string | null; link?: string | null; tags?: string[] | null }, options: { acknowledgedPublic?: boolean } = {}): Promise<VariableView> {
  const current = rt.inventory.getVariable(id);
  if (!current) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  if (typeof patch.value === "string") assertPublicValue(current.name, patch.value, actor.kind === "human" && Boolean(options.acknowledgedPublic));
  await authorize(rt, { actor, action: "inventory.edit", subject: { variableId: id, stage: current.stage } });
  const updated = rt.inventory.patchVariable(id, patch);
  await rt.inventory.save();
  return variableView(updated);
}

export async function removeVariable(rt: RuntimeCore, actor: Actor, id: string): Promise<void> {
  requireHuman(actor, "Variablen entfernen");
  await authorize(rt, { actor, action: "inventory.edit", subject: { variableId: id } });
  rt.inventory.removeVariable(id);
  await rt.inventory.save();
}

export type VariableApplyResult =
  | { status: "applied"; outcomes: { place: string; outcome: string; error?: string }[] }
  | { status: "pending-approval"; approvalId: string; message: string };

/** Setzt den Sollwert in GitHub. Agenten nur in freigegebenen Stages, sonst Freigabe. */
export async function requestApplyVariable(rt: RuntimeCore, actor: Actor, id: string, options: { reason?: string; acknowledgedPublic?: boolean } = {}): Promise<VariableApplyResult> {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  await authorize(rt, { actor, action: "variable.apply", subject: { variableId: id, stage: v.stage } });
  if (!agentMayRunNow(rt, actor, v.stage, v.places.length > 0)) {
    const approval = rt.approvals.create({ action: "apply-variable", targetId: id, requestedBy: actor.name, requestedByRef: actorRef(actor), reason: options.reason ?? null, snapshot: variableApprovalSnapshot(v) });
    return { status: "pending-approval", approvalId: approval.id, message: `Stage ${v.stage} braucht eine Freigabe im Portal (Reiter Freigaben).` };
  }
  const outcomes = await applyVariable(rt.github, rt.owner, v, { acknowledgedPublic: actor.kind === "human" && Boolean(options.acknowledgedPublic) });
  return { status: "applied", outcomes };
}

export async function adoptVariableFromGitHub(rt: RuntimeCore, actor: Actor, id: string): Promise<VariableView> {
  requireHuman(actor, "Werte uebernehmen");
  await authorize(rt, { actor, action: "inventory.edit", subject: { variableId: id } });
  const v = await adoptVariable(rt.github, rt.owner, rt.inventory, id);
  await rt.inventory.save();
  return variableView(v);
}

// -------------------------------------------------------------------------------------------- Freigaben

export function listApprovals(rt: RuntimeCore) {
  return rt.approvals.list();
}

export function getApproval(rt: RuntimeCore, id: string): Approval {
  const a = rt.approvals.get(id);
  if (!a) throw new PolicyError(`Anfrage nicht gefunden: ${id}`);
  return a;
}

/** Freigabe oder Ablehnung durch einen Menschen. Eine Freigabe startet die Pruefung bzw. setzt die Variable. */
export async function resolveApproval(rt: RuntimeCore, actor: Actor, id: string, decision: "approve" | "deny"): Promise<Approval> {
  requireHuman(actor, "Freigaben erteilen");
  const approval = rt.approvals.get(id);
  if (!approval) throw new PolicyError(`Anfrage nicht gefunden: ${id}`);
  if (approval.state !== "pending") throw new PolicyError(`Anfrage ist schon erledigt: ${approval.state}`);
  const target0 = approval.action === "issue" ? { secretId: approval.targetId } : { variableId: approval.targetId };
  const origin = { approvalId: id, requestedBy: approval.requestedBy, requestedByRef: approval.requestedByRef };
  await authorize(rt, { actor, action: "approval.resolve", subject: { ...target0, ...origin } });
  // An approval carries out what was asked for, on behalf of the approving actor: the hook is asked for that too, before anything
  // starts. A refusal leaves the request open, nothing is consumed.
  if (decision === "approve") {
    if (approval.action === "issue") {
      const secret = rt.inventory.getSecret(approval.targetId);
      if (secret) {
        await authorize(rt, { actor, action: "issuance.prepare", subject: { ...target0, stage: secret.stage, ...origin } });
        if (rt.automation.isBrowserProvider(rt.providers.get(secret.provider))) await authorize(rt, { actor, action: "automation.run", subject: { ...target0, stage: secret.stage, ...origin } });
      }
    } else {
      const variable = rt.inventory.getVariable(approval.targetId);
      if (variable) await authorize(rt, { actor, action: "variable.apply", subject: { ...target0, stage: variable.stage, ...origin } });
    }
  }
  // Atomar von "offen" auf "in Bearbeitung": ein zweites (auch paralleles) approve/deny wirft sofort, ohne Arbeit.
  if (!rt.approvals.begin(id)) throw new PolicyError("Anfrage wird gerade bearbeitet oder ist schon erledigt.");
  const decidedBy = actorRef(actor);
  if (decision === "deny") return rt.approvals.resolve(id, "denied", undefined, decidedBy);
  try {
    // Die Freigabe gilt fuer den Inhalt von damals. Hat sich der Eintrag (Ziele, Sollwert, Stage, Anbieter, Parameter) geaendert, verfaellt sie.
    const target = approval.action === "issue" ? rt.inventory.getSecret(approval.targetId) : rt.inventory.getVariable(approval.targetId);
    const nowHash = !target ? null : approval.action === "issue" ? secretApprovalSnapshot(target as SecretEntry).hash : variableApprovalSnapshot(target as VariableEntry).hash;
    if (nowHash !== approval.snapshotHash) return rt.approvals.resolve(id, "stale", "Der Eintrag hat sich seit der Anfrage geaendert, Freigabe verworfen.", decidedBy);
    if (approval.action === "issue") {
      const pending = await prepareTracked(rt, actor, approval.targetId, { requestedBy: approval.requestedByRef, approvalId: id });
      await keepOrDiscard(rt, pending);
      return rt.approvals.resolve(id, "approved", `Pruefung ${pending.id} wartet auf Bestaetigung`, decidedBy);
    }
    // The hash above matched, so the target exists (and is the variable this approval was made for).
    const outcomes = await applyVariable(rt.github, rt.owner, target as VariableEntry, { acknowledgedPublic: false });
    const failed = outcomes.some((o) => o.outcome === "failed");
    return rt.approvals.resolve(id, failed ? "failed" : "approved", failed ? "Ziele fehlgeschlagen" : "gesetzt", decidedBy);
  } catch (err) {
    const message = (err as Error).message ?? "Fehler";
    // Der Zustand ist nur noch "in Bearbeitung": resolve kann nicht an einem fremden Zustand scheitern.
    return rt.approvals.resolve(id, "failed", message.slice(0, 200), decidedBy);
  }
}
