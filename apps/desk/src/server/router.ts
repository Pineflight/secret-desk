import { resolve } from "node:path";
import { userInfo } from "node:os";
import {
  EnvExportError,
  EvidenceError,
  GitHubError,
  InventoryConflictError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  ParamsInvalidError,
  PreflightError,
  RotationError,
  SyncError,
  StageError,
  TEAM_SYNC_CONNECTION,
  VaultUnavailableError,
  TeamBundleError,
  TeamSyncError,
  VariableError,
  VariablePatchSchema,
  deleteConnectionLabel,
  mergeTeamBundle,
  parseInput,
  parseTeamBundle,
  type Stage,
  type StatusLevel,
} from "@secret-desk/core";
import {
  AutomationError,
  authorize,
  LiveCheckBusyError,
  PolicyError,
  checkConnection,
  getConnectionResources,
  getProviderParams,
  getProviderResources,
  getSecretParams,
  listVariableSources,
  loadVariableFromSource,
  preflightSecret,
  previewVariableSource,
  putConnectionDefaults,
  getResourceMap,
  putResourceMap,
  deleteResourceMap,
  putSecretParams,
  suggestAllParams,
  suggestAllVariables,
  listWriteTargets,
  tokenPrefixProblem,
  cancelAutomationRun,
  cancelFacade,
  cancelTeamToken,
  checkFacadeSession,
  checkTeamTokenSession,
  dismissTeamTokenRevocation,
  getTeamTokenInfo,
  retireTeamToken,
  startTeamToken,
  submitTeamTokenAccess,
  submitTeamTokenCode,
  submitTeamTokenConfirm,
  submitTeamTokenCredentials,
  cancelRecipeSignIn,
  checkRecipeSession,
  getRecipeSignInState,
  getFacadeState,
  listFacades,
  startFacadeConnect,
  startFacadeSignIn,
  startRecipeSignIn,
  submitFacadeAccess,
  submitFacadeCode,
  submitFacadeConfirm,
  submitRecipeCode,
  submitRecipeConfirm,
  getAutomation,
  getAutomationRun,
  getLiveCheck,
  startLiveCheck,
  translateDeep,
  addEnvEntry,
  addEnvTemplate,
  addManualProvider,
  addSecret,
  addVariable,
  adoptVariableFromGitHub,
  applyNormalizationChanges,
  getNormalizationPlan,
  attachEvidence,
  compareStages,
  confirmIssuance,
  evidenceSvg,
  exportEnv,
  exportEnvContent,
  getApproval,
  getEvidence,
  getIssuance,
  getSecret,
  getVariable,
  inspectVariableLive,
  listApprovals,
  listConnections,
  listEvidence,
  listIssuances,
  listProviders,
  listVendors,
  listRepos,
  getSettings,
  listStages,
  listSecrets,
  listVariables,
  overview,
  planGitHubSync,
  runGitHubSync,
  readAttachment,
  rejectIssuance,
  removeLink,
  renameInventoryRepo,
  removeVariable,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  scanLocal,
  setLink,
  setStages,
  submitManualValue,
  teamExport,
  readAbout,
  applyTeamSync,
  checkTeamSync,
  dismissTeamSetup,
  planTeamPush,
  previewTeamText,
  pushTeamSync,
  setupTeamSync,
  teamSyncStatus,
  listTeamRepos,
  listTeamBranches,
  listTeamFiles,
  checkTeamModeAccess,
  updateSecretMeta,
  updateVariable,
  type Actor,
  type AuthorizationRequest,
  type AuthorizedAction,
  type Runtime,
} from "@secret-desk/runtime";
import { bearerMatches, checkHost, checkOrigin, type PortalSession } from "./security";

/** Standardbenutzer: SECRET_DESK_USER, sonst der Betriebssystem-Benutzer, sonst "local". */
export function defaultUser(): string {
  if (process.env.SECRET_DESK_USER) return process.env.SECRET_DESK_USER;
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}

export interface RouterDeps {
  rt: Runtime;
  session: PortalSession;
  agentToken: string;
  hosts: Set<string>;
}

type Body = Record<string, unknown>;
type JsonFn = (data: unknown, status?: number) => Response;
type ErrFn = (status: number, message: string) => Response;
type Ctx = { rt: Runtime; actor: Actor; req: Request; params: string[]; query: URLSearchParams; body: Body; json: JsonFn; err: ErrFn };
type Handler = (c: Ctx) => Promise<unknown> | unknown;
type Raw = (c: Ctx) => Promise<Response>;

type Subject = NonNullable<AuthorizationRequest["subject"]>;
/**
 * Asks the authorisation hook (when the runtime has one) before the handler runs. For routes whose runtime function has no
 * actor, or is synchronous. Humans only routes: the route table already refused agents, so the hook comes after that rule.
 */
const gated = (action: AuthorizedAction, subject: ((c: Ctx) => Subject) | undefined, fn: Handler): Handler => async (c) => {
  await authorize(c.rt, { actor: c.actor, action, ...(subject ? { subject: subject(c) } : {}) });
  return fn(c);
};
const idParam = (c: Ctx): string => decodeURIComponent(c.params[0]!);

const baseJson = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const stage = (q: URLSearchParams): Stage | undefined => (q.get("stage") ? (q.get("stage") as Stage) : undefined);
const str = (b: Body, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || v === "") throw new InventoryError(`Feld fehlt: ${k}`);
  return v;
};
/** Gueltigkeit des Zugangs-Tokens: ein Datum in der Zukunft oder ausdruecklich "laeuft nie ab". */
function tokenExpiry(b: Body): string | null {
  if (b["neverExpires"] === true) return null;
  const d = optStr(b, "expires");
  if (!d) throw new InventoryError("Bis wann der Token gueltig ist, muss angegeben werden (Datum oder laeuft nie ab).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new InventoryError("Das Datum ist ungueltig (JJJJ-MM-TT).");
  if (d < new Date().toISOString().slice(0, 10)) throw new InventoryError("Das Datum liegt in der Vergangenheit: Der Token waere schon abgelaufen.");
  return d;
}
/** Bereits gewaehlte Parameter fuer abhaengige Entdeckungen: Query `param.<schluessel>=<wert>` (zum Beispiel param.accountId). */
function paramsFromQuery(q: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of q) if (k.startsWith("param.") && k.length > 6) out[k.slice(6)] = v;
  return out;
}
const optQ = (q: URLSearchParams, k: string): string | undefined => q.get(k) || undefined;
const queryText = (q: URLSearchParams, k: string): string => {
  const v = q.get(k);
  if (!v) throw new InventoryError(`Feld fehlt: ${k}`);
  return v;
};
/** Kommagetrennte Liste aus dem Query, ohne Leereintraege. */
const csv = (q: URLSearchParams, k: string): string[] => (q.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
/** Art-Liste des Stage-Vergleichs: secret(s) und variable(s), alles andere wird ignoriert. */
function compareKinds(q: URLSearchParams): ("secret" | "variable")[] {
  const out = new Set<"secret" | "variable">();
  for (const k of csv(q, "kinds")) {
    if (k === "secret" || k === "secrets") out.add("secret");
    else if (k === "variable" || k === "variables") out.add("variable");
  }
  return [...out];
}
const optStr = (b: Body, k: string): string | undefined => (typeof b[k] === "string" ? (b[k] as string) : undefined);

/** Der Name kommt vom Agenten selbst (Kopf x-agent-name) und ist nicht verifiziert: gekuerzt und auf harmlose Zeichen beschraenkt. */
export function sanitizeAgentName(raw: string | null): string {
  const clean = (raw ?? "").replace(/[^A-Za-z0-9 ._:@/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return clean || "agent";
}

/** Gemeinsame Operationen. Alle Antworten sind JSON und enthalten nie einen geheimen Wert. */
const common: [string, RegExp, Handler][] = [
  ["GET", /^overview$/, ({ rt }) => overview(rt)],
  // Cheap freshness probe for the UI: the version counts every change of the inventory content (own and external).
  ["GET", /^inventory\/version$/, ({ rt }) => ({ version: rt.inventory.version, problem: rt.inventory.problem?.persistent ? rt.inventory.problem : null })],
  ["GET", /^stages$/, ({ rt }) => listStages(rt)],
  // Vereinheitlichung: der Plan zeigt nur Namen, Stages, Anbieter und Parameter-Schluessel, nie Werte. Anwenden nur im Portal.
  ["GET", /^normalization$/, ({ rt }) => getNormalizationPlan(rt)],
  // Ueber secret-desk: Version, Lizenz, Drittlizenzen. Nur lokale Dateien, keine Werte.
  ["GET", /^about$/, () => readAbout({ rootDir: resolve(process.cwd(), "../.."), thirdPartyFile: resolve(process.cwd(), "third-party.json"), env: process.env })],
  ["GET", /^team-sync\/status$/, ({ rt }) => teamSyncStatus(rt)],
  ["GET", /^secrets$/, ({ rt, query }) => listSecrets(rt, { ...(stage(query) ? { stage: stage(query)! } : {}), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), ...(query.get("product") ? { product: query.get("product")! } : {}), ...(query.get("status") ? { status: query.get("status") as StatusLevel } : {}), ...(query.get("provider") ? { provider: query.get("provider")! } : {}), ...(query.get("q") ? { q: query.get("q")! } : {}), ...(query.get("tag") ? { tag: query.get("tag")! } : {}), live: query.get("live") === "1" })],
  // Stage-Vergleich: rein lesend (auch live), nur Namen und Zustaende, Variablen-Sollwerte nur im Vergleich.
  ["GET", /^compare$/, ({ rt, query }) => compareStages(rt, { live: query.get("live") === "1", allRepos: query.get("all") === "1", workflows: query.get("workflows") === "1", compare: csv(query, "compare"), kinds: compareKinds(query), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), normalizeNames: query.get("normalize") === "1" })],
  // Inventory -> GitHub: the plan only reads (names, places, reasons, never a value). Agents may read it; running it is humans only.
  ["POST", /^compare\/sync-plan$/, ({ rt, actor, body }) => planGitHubSync(rt, actor, { ...(optStr(body, "repo") ? { repo: optStr(body, "repo")! } : {}) })],
  // ?preflight=1 (nur Mensch): zusaetzlich der lesende Vorabcheck beim Anbieter in der Antwort. Angelegt wird auch bei Warnungen und Fehlbefunden.
  ["POST", /^secrets$/, async ({ rt, actor, body, query }) => {
    const created = await addSecret(rt, actor, body);
    return query.get("preflight") === "1" && actor.kind === "human" ? { ...created, preflight: await preflightSecret(rt, created.id) } : created;
  }],
  ["GET", /^secrets\/([^/]+)$/, ({ rt, params }) => getSecret(rt, params[0]!)],
  // Der Akteur bestimmt die erlaubten Felder (strikt, unbekannte Felder -> 400): Agenten nur Metadaten, Menschen alle bearbeitbaren.
  ["PATCH", /^secrets\/([^/]+)$/, ({ rt, actor, params, body }) => updateSecretMeta(rt, actor, params[0]!, body)],
  ["GET", /^dev-templates$/, ({ rt }) => rt.inventory.data.envTemplates.map((t) => ({ id: t.id, repo: t.repo, stage: t.stage, file: t.file, entries: t.entries.map((e) => ({ key: e.key, source: e.from.type, description: e.description ?? null, ...(e.from.type === "variable" ? { variable: e.from.variable } : {}), ...(e.from.type === "issue" ? { secret: e.from.secret } : {}), ...(e.from.type === "default" ? { value: e.from.value } : {}), ...(e.from.type === "prompt" ? { optional: e.from.optional } : {}), ...(e.from.type === "ref" ? { refTemplate: e.from.template, refKey: e.from.key } : {}), ...(e.from.type === "command" ? { command: e.from.command, commandKey: e.from.key, optional: e.from.optional } : {}) })) }))],
  ["GET", /^providers$/, ({ rt }) => listProviders(rt)],
  ["GET", /^vendors$/, () => listVendors()],
  ["POST", /^providers$/, ({ rt, actor, body }) => addManualProvider(rt, actor, body as never)],
  ["GET", /^connections$/, ({ rt }) => listConnections(rt)],
  ["POST", /^env-templates$/, ({ rt, actor, body }) => addEnvTemplate(rt, actor, body as never)],
  ["POST", /^env-templates\/([^/]+)\/entries$/, ({ rt, actor, params, body }) => addEnvEntry(rt, actor, params[0]!, body as never)],
  ["POST", /^renewal-requests$/, ({ rt, actor, body }) => requestIssuance(rt, actor, str(body, "secretId"), { ...(optStr(body, "reason") ? { reason: optStr(body, "reason")! } : {}), dryRun: body.dryRun === true })],
  ["GET", /^reviews$/, ({ rt }) => listIssuances(rt)],
  ["GET", /^reviews\/([^/]+)$/, ({ rt, params }) => getIssuance(rt, params[0]!)],
  ["GET", /^evidence\/([^/]+)$/, ({ rt, params }) => listEvidence(rt, params[0]!)],
  ["GET", /^evidence\/([^/]+)\/([^/]+)$/, ({ rt, params }) => getEvidence(rt, params[0]!, params[1]!)],
  ["GET", /^variables$/, ({ rt, query }) => listVariables(rt, { ...(stage(query) ? { stage: stage(query)! } : {}), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), ...(query.get("product") ? { product: query.get("product")! } : {}), ...(query.get("q") ? { q: query.get("q")! } : {}), ...(query.get("tag") ? { tag: query.get("tag")! } : {}) })],
  ["POST", /^variables$/, ({ rt, actor, body }) => {
    const { acknowledgedPublic, ...entry } = body;
    return addVariable(rt, actor, entry as never, { acknowledgedPublic: acknowledgedPublic === true });
  }],
  ["GET", /^variables\/([^/]+)$/, ({ rt, params }) => getVariable(rt, params[0]!)],
  ["GET", /^variables\/([^/]+)\/status$/, ({ rt, params }) => inspectVariableLive(rt, params[0]!)],
  // Strikt: nur Sollwert und Beschreibung. stage, places, id, name sind keine Felder dieser Route (400 statt stillem Ignorieren).
  ["PATCH", /^variables\/([^/]+)$/, ({ rt, actor, params, body }) => {
    const { acknowledgedPublic, ...patch } = parseInput(VariablePatchSchema, body);
    return updateVariable(rt, actor, params[0]!, patch as never, { acknowledgedPublic: acknowledgedPublic === true });
  }],
  ["POST", /^variables\/([^/]+)\/apply$/, ({ rt, actor, params, body }) => requestApplyVariable(rt, actor, params[0]!, { ...(optStr(body, "reason") ? { reason: optStr(body, "reason")! } : {}), acknowledgedPublic: body.acknowledgedPublic === true })],
  ["GET", /^approvals$/, ({ rt }) => listApprovals(rt)],
  ["GET", /^approvals\/([^/]+)$/, ({ rt, params }) => getApproval(rt, params[0]!)],
  // Agenten sehen die Liste, aber keine lokalen Pfade.
  ["GET", /^repos$/, ({ rt, actor, query }) => listRepos(rt, { live: query.get("live") === "1", includePaths: actor.kind === "human" })],
  // Content export (no file written): the caller gets the text, the portal turns it into a download.
  ["POST", /^env\/export$/, ({ rt, actor, body }) => {
    const format = optStr(body, "format") ?? "dotenv";
    const include = optStr(body, "include") ?? "variables";
    if (format !== "dotenv" && format !== "json") throw new InventoryError("format: dotenv oder json");
    if (include !== "variables" && include !== "all") throw new InventoryError("include: variables oder all");
    return exportEnvContent(rt, actor, { repo: str(body, "repo"), stage: str(body, "stage"), format, include });
  }],
  ["POST", /^env-export$/, ({ rt, actor, body }) => exportEnv(rt, actor, { repo: str(body, "repo"), ...(optStr(body, "path") ? { path: optStr(body, "path")! } : {}), ...(optStr(body, "template") ? { template: optStr(body, "template")! } : {}), ...(optStr(body, "stage") ? { stage: optStr(body, "stage") as Stage } : {}), overwrite: body.overwrite === true, ...(body.prompts && typeof body.prompts === "object" ? { prompts: body.prompts as Record<string, string> } : {}) })],
];

/** Nur im Portal (Mensch): Bestaetigen, Eingeben, Freigeben, Verbindungen, Anlagen, Browser-Laeufe ansehen und abbrechen. */
const humanOnly: [string, RegExp, Handler][] = [
  // Team-Sync: Status liest auch der Agent (common). Abfragen, Uebernehmen und Schieben macht nur ein Mensch.
  ["POST", /^team-sync\/check$/, ({ rt }) => checkTeamSync(rt)],
  ["POST", /^team-sync\/preview-text$/, ({ rt, body }) => previewTeamText(rt, str(body, "text"))],
  ["POST", /^team-sync\/apply$/, async ({ rt, actor, body }) => {
    const resolution = optStr(body, "resolution");
    if (resolution !== "merge" && resolution !== "replace" && resolution !== "keep-local") throw new InventoryError("Feld resolution: merge, replace oder keep-local.");
    await authorize(rt, { actor, action: "team.sync.apply", subject: { mode: resolution } });
    return applyTeamSync(rt, { expectSha: str(body, "expectSha"), resolution, confirmReplace: body.confirmReplace === true });
  }],
  // Discovery for the setup pickers: repositories, branches and team files the GitHub integration can see, and what a mode needs.
  // Read only, no token in any answer. Agents get 404: listing the repositories of the integration is a human decision.
  ["GET", /^team-sync\/discovery\/repos$/, ({ rt }) => listTeamRepos(rt)],
  ["GET", /^team-sync\/discovery\/branches$/, ({ rt, query }) => listTeamBranches(rt, queryText(query, "repo"))],
  ["GET", /^team-sync\/discovery\/files$/, ({ rt, query }) => listTeamFiles(rt, queryText(query, "repo"), queryText(query, "branch"))],
  ["GET", /^team-sync\/discovery\/access$/, ({ rt, query }) => checkTeamModeAccess(rt, { repo: queryText(query, "repo"), branch: queryText(query, "branch"), path: queryText(query, "path"), mode: queryText(query, "mode"), ...(optQ(query, "strategy") ? { strategy: optQ(query, "strategy")! } : {}) })],
  // Team token: a separate GitHub token for team sync, created through the browser (see docs/TEAM.md). Human routes only: agents
  // get 404, and no response carries the token or the sign-in.
  // Starting the run opens a browser; the steps that take a credential or a one-time code are integration.connect; cancel only
  // closes the run and the check only reads the session, so cancel stays unhooked and the check is a browser run.
  ["GET", /^team-sync\/token$/, ({ rt, actor }) => getTeamTokenInfo(rt, actor)],
  ["POST", /^team-sync\/token$/, gated("automation.run", undefined, ({ rt, actor, body }) => startTeamToken(rt, actor, body))],
  ["POST", /^team-sync\/token\/credentials$/, gated("integration.connect", () => ({ connectionId: TEAM_SYNC_CONNECTION }), ({ rt, actor, body }) => submitTeamTokenCredentials(rt, actor, body))],
  ["POST", /^team-sync\/token\/code$/, gated("integration.connect", () => ({ connectionId: TEAM_SYNC_CONNECTION }), ({ rt, actor, body }) => submitTeamTokenCode(rt, actor, body))],
  ["POST", /^team-sync\/token\/confirm$/, gated("integration.connect", () => ({ connectionId: TEAM_SYNC_CONNECTION }), ({ rt, actor, body }) => submitTeamTokenConfirm(rt, actor, body))],
  ["POST", /^team-sync\/token\/access$/, gated("integration.connect", () => ({ connectionId: TEAM_SYNC_CONNECTION }), ({ rt, actor, body }) => submitTeamTokenAccess(rt, actor, body))],
  ["POST", /^team-sync\/token\/cancel$/, ({ rt, actor }) => cancelTeamToken(rt, actor)],
  ["POST", /^team-sync\/token\/check$/, gated("automation.run", undefined, ({ rt, actor }) => checkTeamTokenSession(rt, actor))],
  ["POST", /^team-sync\/token\/revocation-done$/, gated("team.sync.configure", undefined, ({ rt, actor }) => dismissTeamTokenRevocation(rt, actor))],
  ["POST", /^team-sync\/push-plan$/, ({ rt }) => planTeamPush(rt)],
  ["POST", /^team-sync\/push$/, gated("team.sync.push", undefined, ({ rt, req, body }) => pushTeamSync(rt, { confirm: body.confirm === true, expectLocalHash: str(body, "expectLocalHash"), expectRemoteSha: typeof body["expectRemoteSha"] === "string" ? (body["expectRemoteSha"] as string) : null, lang: req.headers.get("x-secret-desk-lang") === "en" ? "en" : "de" }))],
  ["PUT", /^team-sync\/config$/, gated("team.sync.configure", undefined, async ({ rt, body }) => ({ config: await setupTeamSync(rt, body.teamSync), status: await teamSyncStatus(rt) }))],
  ["POST", /^team-sync\/dismiss-setup$/, gated("team.sync.configure", undefined, async ({ rt }) => { await dismissTeamSetup(rt); return teamSyncStatus(rt); })],
  // Wendet gewaehlte Aenderungen des Plans auf das Inventar an (nie nach GitHub). Agenten bekommen 404.
  ["POST", /^normalization\/apply$/, ({ rt, actor, body }) => applyNormalizationChanges(rt, actor, body)],
  // Stage-Definitionen aendert nur ein Mensch im Portal (Einstellungen); Agenten lesen sie.
  ["PUT", /^stages$/, gated("settings.edit", undefined, ({ rt, body }) => setStages(rt, Array.isArray(body.stages) ? (body.stages as never[]) : (() => { throw new InventoryError("Feld fehlt: stages"); })()))],
  // Gestartet wird ein Browser-Lauf ueber renewal-requests (oder die Freigabe); hier nur Zustand und Abbruch. Agenten sehen nichts davon.
  // Reine Metadaten der Konfiguration (Pfade, Schalter, aufgeloeste Richtlinie), nie Werte. Agenten bekommen 404.
  ["GET", /^settings$/, ({ rt }) => getSettings(rt)],
  ["GET", /^automation$/, ({ rt, actor }) => getAutomation(rt, actor)],
  ["GET", /^automation\/runs\/([^/]+)$/, ({ rt, actor, params }) => getAutomationRun(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^automation\/runs\/([^/]+)\/cancel$/, ({ rt, actor, params }) => cancelAutomationRun(rt, actor, decodeURIComponent(params[0]!))],
  // Live check (read-only test of every integration and a dry run of every recipe, see docs/TROUBLESHOOTING.md): the stored reports and
  // whether a run is active; POST starts a manual run in the background (409 while one runs or the browser is busy). Ids and results
  // only, never a value. Agents get 404.
  ["GET", /^live-check$/, ({ rt }) => getLiveCheck(rt)],
  // The manual run starts browser dry runs of the recipes: automation.run.
  ["POST", /^live-check$/, gated("automation.run", undefined, ({ rt }) => {
    startLiveCheck(rt);
    return getLiveCheck(rt);
  })],
  // Provider facade (guided sign-in, key creation, connection). The sign-in goes into the body of one POST, is used for that run
  // only and never comes back in any response. Agents get 404 here, the MCP server has no tool for it.
  ["GET", /^facades$/, ({ rt, actor }) => listFacades(rt, actor)],
  ["GET", /^facades\/([^/]+)\/state$/, ({ rt, actor, params }) => getFacadeState(rt, actor, decodeURIComponent(params[0]!))],
  // Steps that take a sign-in, a one-time code, a confirmation or that create and store the key are integration.connect (subject: the
  // facade or recipe id). Cancel only closes the browser run and stays unhooked; the session checks are browser runs (automation.run).
  ["POST", /^facades\/([^/]+)\/sign-in$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => startFacadeSignIn(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^facades\/([^/]+)\/code$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => submitFacadeCode(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^facades\/([^/]+)\/access$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => submitFacadeAccess(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^facades\/([^/]+)\/confirm$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => submitFacadeConfirm(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^facades\/([^/]+)\/connect$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => startFacadeConnect(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^facades\/([^/]+)\/cancel$/, ({ rt, actor, params }) => cancelFacade(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^recipes\/([^/]+)\/check$/, gated("automation.run", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => checkRecipeSession(rt, actor, decodeURIComponent(params[0]!), optStr(body, "host") ? { host: optStr(body, "host")! } : {}))],
  // Plain sign-in at a browser-only vendor (a recipe with a guided sign-in, no key is created). Same rules as the facade routes:
  // the sign-in goes into the body of one POST and never comes back; agents get 404.
  ["GET", /^recipes\/([^/]+)\/sign-in\/state$/, ({ rt, actor, params }) => getRecipeSignInState(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^recipes\/([^/]+)\/sign-in$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => startRecipeSignIn(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^recipes\/([^/]+)\/sign-in\/code$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => submitRecipeCode(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^recipes\/([^/]+)\/sign-in\/confirm$/, gated("integration.connect", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => submitRecipeConfirm(rt, actor, decodeURIComponent(params[0]!), body))],
  ["POST", /^recipes\/([^/]+)\/sign-in\/cancel$/, ({ rt, actor, params }) => cancelRecipeSignIn(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^facades\/([^/]+)\/check$/, gated("automation.run", (c) => ({ connectionId: idParam(c) }), ({ rt, actor, params, body }) => checkFacadeSession(rt, actor, decodeURIComponent(params[0]!), optStr(body, "host") ? { host: optStr(body, "host")! } : {}))],
  ["POST", /^reviews\/([^/]+)\/confirm$/, ({ rt, actor, params, body }) => confirmIssuance(rt, actor, params[0]!, { ticks: Array.isArray(body.ticks) ? (body.ticks as string[]) : [], ...(optStr(body, "note") ? { note: optStr(body, "note")! } : {}), force: body.force === true })],
  ["POST", /^reviews\/([^/]+)\/reject$/, ({ rt, actor, params, body }) => rejectIssuance(rt, actor, params[0]!, optStr(body, "note"))],
  ["POST", /^secrets\/([^/]+)\/manual-value$/, ({ rt, actor, params, body }) => submitManualValue(rt, actor, params[0]!, str(body, "value"))],
  ["POST", /^approvals\/([^/]+)\/(approve|deny)$/, ({ rt, actor, params }) => resolveApproval(rt, actor, params[0]!, params[1] as "approve" | "deny")],
  // Writes the selected lines of a fresh plan to GitHub. The production confirmation is the existing checklist item "this affects production".
  ["POST", /^compare\/sync$/, ({ rt, actor, body }) => {
    const keys = Array.isArray(body["keys"]) ? (body["keys"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
    return runGitHubSync(rt, actor, { keys, confirmProduction: body["confirmProduction"] === true, ...(optStr(body, "repo") ? { repo: optStr(body, "repo")! } : {}) });
  }],
  ["POST", /^variables\/([^/]+)\/adopt$/, ({ rt, actor, params }) => adoptVariableFromGitHub(rt, actor, params[0]!)],
  ["DELETE", /^variables\/([^/]+)$/, async ({ rt, actor, params }) => { await removeVariable(rt, actor, params[0]!); return { ok: true }; }],
  ["POST", /^connections\/([^/]+)\/token$/, async ({ rt, actor, params, body }) => {
    // The id may carry a colon (stripe:<acct_id>:<mode>), which the client sends percent-encoded.
    const id = decodeURIComponent(params[0]!);
    const prefixProblem = typeof body["token"] === "string" ? tokenPrefixProblem(id, body["token"]) : undefined;
    if (prefixProblem) throw new InventoryError(prefixProblem);
    const expires = tokenExpiry(body);
    // The hook only ever sees the connection id, never the token.
    await authorize(rt, { actor, action: "integration.connect", subject: { connectionId: id } });
    if (body["remember"] === true) {
      if (!rt.connections.vault) throw new InventoryError("Der Tresor ist ausgeschaltet (vault.enabled in der Konfiguration).");
      await rt.connections.vault.set(id, str(body, "token"), expires);
      rt.connections.session.delete(id);
    } else {
      rt.connections.session.set(id, str(body, "token"), expires);
    }
    // A typed-in token replaces the team token the portal made: it is then listed as one to delete at GitHub.
    if (id === TEAM_SYNC_CONNECTION) await retireTeamToken(rt);
    return rt.connections.status(id);
  }],
  ["DELETE", /^connections\/([^/]+)\/token$/, async ({ rt, actor, params }) => {
    const id = decodeURIComponent(params[0]!);
    await authorize(rt, { actor, action: "integration.disconnect", subject: { connectionId: id } });
    rt.connections.session.delete(id);
    await rt.connections.vault?.delete(id);
    await deleteConnectionLabel(rt.connections, id);
    if (id === TEAM_SYNC_CONNECTION) await retireTeamToken(rt);
    return rt.connections.status(id);
  }],
  // Parameter der Anbieter: Spezifikation, Entdeckung beim verbundenen Konto, Vorschlaege (nur Vorschlaege), Vorabcheck. Siehe API.md.
  ["GET", /^secrets\/([^/]+)\/params$/, ({ rt, actor, params, query }) => getSecretParams(rt, actor, params[0]!, { live: query.get("live") !== "0" })],
  ["PUT", /^secrets\/([^/]+)\/params$/, ({ rt, actor, params, body }) => putSecretParams(rt, actor, params[0]!, body)],
  ["GET", /^providers\/([^/]+)\/params$/, ({ rt, actor, params, query }) => getProviderParams(rt, actor, decodeURIComponent(params[0]!), { ...(optQ(query, "repo") ? { repo: optQ(query, "repo")! } : {}), ...(optQ(query, "stage") ? { stage: optQ(query, "stage")! } : {}), live: query.get("live") !== "0", params: paramsFromQuery(query) })],
  ["GET", /^providers\/([^/]+)\/resources$/, ({ rt, actor, params, query }) => getProviderResources(rt, actor, decodeURIComponent(params[0]!), str({ kind: query.get("kind") ?? "" }, "kind"), { ...(optQ(query, "repo") ? { repo: optQ(query, "repo")! } : {}), ...(optQ(query, "stage") ? { stage: optQ(query, "stage")! } : {}), params: paramsFromQuery(query) })],
  ["GET", /^connections\/([^/]+)\/resources$/, ({ rt, actor, params, query }) => getConnectionResources(rt, actor, decodeURIComponent(params[0]!), { ...(optQ(query, "kind") ? { kind: optQ(query, "kind")! } : {}), ...(optQ(query, "repo") ? { repo: optQ(query, "repo")! } : {}), ...(optQ(query, "stage") ? { stage: optQ(query, "stage")! } : {}), params: paramsFromQuery(query) })],
  ["PUT", /^connections\/([^/]+)\/defaults$/, ({ rt, actor, params, body }) => putConnectionDefaults(rt, actor, decodeURIComponent(params[0]!), body)],
  ["GET", /^resource-map$/, ({ rt, actor }) => getResourceMap(rt, actor)],
  ["PUT", /^resource-map$/, ({ rt, actor, body }) => putResourceMap(rt, actor, body)],
  ["DELETE", /^resource-map$/, ({ rt, actor, body }) => deleteResourceMap(rt, actor, body)],
  ["POST", /^params\/suggest-all$/, ({ rt, actor }) => suggestAllParams(rt, actor)],
  ["GET", /^variable-sources$/, ({ rt, actor }) => listVariableSources(rt, actor)],
  ["POST", /^variable-sources\/value$/, ({ rt, actor, body }) => previewVariableSource(rt, actor, body)],
  ["POST", /^variables\/suggest-all$/, ({ rt, actor }) => suggestAllVariables(rt, actor)],
  ["POST", /^variables\/([^/]+)\/load-from-source$/, ({ rt, actor, params, body }) => loadVariableFromSource(rt, actor, params[0]!, body)],
  ["GET", /^connections\/github\/write-targets$/, ({ rt }) => listWriteTargets(rt)],
  // Only the deep check (it probes write access with a real, harmless write) is asked as connection.check; the plain check reads only.
  ["POST", /^connections\/([^/]+)\/check$/, async ({ rt, actor, params, body }) => {
    if (body["deep"] === true) await authorize(rt, { actor, action: "connection.check", subject: { connectionId: decodeURIComponent(params[0]!) } });
    return checkConnection(rt, decodeURIComponent(params[0]!), {
      deep: body["deep"] === true,
      targets: Array.isArray(body["targets"]) ? body["targets"].filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    });
  }],
  ["PUT", /^repos\/([^/]+)\/link$/, gated("repo.link", (c) => ({ repo: idParam(c) }), ({ rt, params, body }) => setLink(rt, decodeURIComponent(params[0]!), str(body, "path")))],
  // Inventar anpassen, wenn GitHub das Repository umbenannt hat. Aendert nichts in GitHub.
  ["POST", /^repos\/([^/]+)\/rename$/, gated("repo.link", (c) => ({ repo: idParam(c) }), ({ rt, params, body }) => renameInventoryRepo(rt, decodeURIComponent(params[0]!), str(body, "to")))],
  ["DELETE", /^repos\/([^/]+)\/link$/, gated("repo.link", (c) => ({ repo: idParam(c) }), ({ rt, params }) => removeLink(rt, decodeURIComponent(params[0]!)))],
  // The scan only lists folders that look like known repositories and changes nothing; the suggestion is applied with the link route.
  ["POST", /^repos\/scan$/, ({ rt }) => scanLocal(rt)],
  ["POST", /^team-import$/, async ({ rt, actor, body }) => {
    // Ersetzen loescht bestehende Eintraege: nur mit ausdruecklicher Bestaetigung (das Portal fragt vorher nach).
    if (body.replace === true && body.confirmReplace !== true) throw new InventoryError("Ersetzen braucht die ausdrueckliche Bestaetigung confirmReplace: true.");
    const mode = body.replace === true ? "replace" : "merge";
    const bundle = parseTeamBundle(str(body, "text"));
    await authorize(rt, { actor, action: "team.import", subject: { mode } });
    const merged = mergeTeamBundle(rt.inventory, bundle, mode);
    await rt.inventory.save();
    return merged;
  }],
];

const raw: [string, RegExp, Raw][] = [
  ["GET", /^team-export$/, async ({ rt }) => new Response(teamExport(rt), { headers: { "content-type": "text/yaml; charset=utf-8", "content-disposition": 'attachment; filename="secret-desk.team.yaml"', "cache-control": "no-store" } })],
];

const rawHuman: [string, RegExp, Raw][] = [
  // The image comes from an <img> tag, which cannot send the language header: it also reads ?lang=en. Without either it stays German.
  ["GET", /^evidence\/([^/]+)\/([^/]+)\/svg$/, async ({ rt, params, req, query }) => new Response(await evidenceSvg(rt, params[0]!, params[1]!, optQ(query, "lang") === "en" || req.headers.get("x-secret-desk-lang") === "en" ? "en" : "de"), { headers: { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", "cache-control": "no-store" } })],
  ["GET", /^evidence\/([^/]+)\/([^/]+)\/attachments\/([^/]+)$/, async ({ rt, params, err }) => {
    const a = await readAttachment(rt, params[0]!, params[1]!, params[2]!);
    if (!a) return err(404, "Anlage nicht gefunden");
    return new Response(new Uint8Array(a.bytes), { headers: { "content-type": a.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" } });
  }],
  ["POST", /^evidence\/([^/]+)\/([^/]+)\/attachments$/, async ({ rt, actor, params, req, json, err }) => {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return err(400, "Feld file fehlt");
    const note = form.get("note");
    const att = await attachEvidence(rt, actor, params[0]!, params[1]!, new Uint8Array(await file.arrayBuffer()), file.type, typeof note === "string" && note ? note : undefined);
    return json(att, 201);
  }],
];

/** Methode und Pfadmuster aller Routen unter /api/agent (fuer den Vertragstest gegen die OpenAPI-Beschreibungen). */
export function agentRoutes(): { method: string; pattern: RegExp }[] {
  return [...raw, ...common].map(([method, pattern]) => ({ method, pattern }));
}

/**
 * Eine Routing-Schicht fuer beide Zugaenge:
 *   /api/agent/...  Bearer-Token, Akteur "agent" (MCP). Kein Bestaetigen, keine Verbindungen, keine Anlagen.
 *   /api/ui/...     Portal-Sitzung (Cookie + CSRF), Akteur "human".
 * Jede Anfrage prueft zuerst Host (DNS-Rebinding) und bei Aenderungen den Ursprung.
 */
export async function route(req: Request, deps: RouterDeps): Promise<Response> {
  // Sprache der Oberflaeche: Backend-Texte sind deutsch und werden an dieser Grenze uebersetzt.
  const lang: "de" | "en" = req.headers.get("x-secret-desk-lang") === "en" ? "en" : "de";
  const json: JsonFn = (data, status = 200) => baseJson(translateDeep(data, lang), status);
  const err: ErrFn = (status, message) => json({ error: message }, status);
  if (!checkHost(req, deps.hosts)) return err(403, "Host nicht erlaubt");
  if (!checkOrigin(req, deps.hosts) && !req.headers.get("authorization")) return err(403, "Ursprung nicht erlaubt");
  const url = new URL(req.url);
  const m = /^\/api\/(agent|ui)\/(.*)$/.exec(url.pathname);
  if (!m) return err(404, "Nicht gefunden");
  const kind = m[1] as "agent" | "ui";
  const path = m[2]!.replace(/\/$/, "");

  let actor: Actor;
  if (kind === "agent") {
    if (!bearerMatches(req, deps.agentToken)) return err(401, "Agenten-Token fehlt oder ist falsch");
    actor = { kind: "agent", name: sanitizeAgentName(req.headers.get("x-agent-name")) };
  } else {
    // Beleg-Bilder werden per <img> geladen und koennen keinen CSRF-Header senden: nur lesend, nur mit Cookie.
    const imageRead = req.method === "GET" && /^evidence\/[^/]+\/[^/]+\/(svg|attachments\/[^/]+)$/.test(path);
    if (!(imageRead ? deps.session.validCookie(req) : deps.session.valid(req))) return err(401, "Portal-Sitzung ungueltig. Seite neu laden.");
    actor = { kind: "human", name: defaultUser() };
  }

  let body: Body = {};
  const contentType = req.headers.get("content-type") ?? "";
  if (req.method !== "GET" && req.method !== "HEAD" && contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return err(400, "Ungueltiges JSON");
    }
    // Nur ein JSON-Objekt ist ein gueltiger Body (kein Primitiv, kein Array, kein null).
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "Der Body muss ein JSON-Objekt sein.");
      body = parsed as Body;
    }
  }

  // Ids end up in the authorisation hook subject and in logs: no route has an id longer than 256 characters.
  if (path.split("/").some((segment) => segment.length > 256)) return err(404, "Nicht gefunden");
  const tables = kind === "ui" ? [...common, ...humanOnly] : common;
  const rawTables = kind === "ui" ? [...raw, ...rawHuman] : raw;
  try {
    for (const [method, re, fn] of rawTables) {
      const r = req.method === method ? re.exec(path) : null;
      if (r) return await fn({ rt: deps.rt, actor, req, params: r.slice(1), query: url.searchParams, body, json, err });
    }
    for (const [method, re, fn] of tables) {
      const r = req.method === method ? re.exec(path) : null;
      if (r) return json(await fn({ rt: deps.rt, actor, req, params: r.slice(1), query: url.searchParams, body, json, err }));
    }
    return err(404, "Nicht gefunden");
  } catch (e) {
    return mapError(e, json, err);
  }
}

function mapError(e: unknown, json: JsonFn, err: ErrFn): Response {
  if (e instanceof PolicyError) return err(403, e.message);
  // Parameter fehlen oder sind ungueltig: vor jedem Netzaufruf, mit Klartext und den betroffenen Schluesseln.
  if (e instanceof ParamsInvalidError) return json({ error: e.message, code: e.code, problems: e.problems }, 400);
  if (e instanceof PreflightError) return json({ error: e.message, code: e.code, findings: e.findings }, 409);
  if (e instanceof NotConnectedError) return json({ error: e.message, connection: e.connection, hint: e.hint, code: "not-connected" }, 409);
  if (e instanceof VariableError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, 400);
  if (e instanceof SyncError) return json({ error: e.message, code: e.code }, e.code === "production-confirmation" ? 409 : 400);
  if (e instanceof InventoryConflictError) return json({ error: e.message, code: "inventory-conflict" }, 409);
  if (e instanceof InventoryError || e instanceof EnvExportError || e instanceof EvidenceError || e instanceof TeamBundleError || e instanceof StageError || isNamed(e, "TemplateError")) return err(400, (e as Error).message);
  if (e instanceof VaultUnavailableError) return json({ error: e.message, code: "vault-unavailable" }, 409);
  if (e instanceof TeamSyncError) return json({ error: e.message, code: e.code }, e.code === "conflict" || e.code === "changed" || e.code === "too-soon" ? 409 : e.code === "denied" || e.code === "not-found" || e.code === "network" ? 502 : 400);
  if (e instanceof IssuanceError || e instanceof RotationError || e instanceof AutomationError || e instanceof LiveCheckBusyError) return err(409, e.message);
  if (e instanceof GitHubError) {
    if (e.status === 429) return json({ error: "GitHub begrenzt die Anfragen. Bitte spaeter erneut versuchen.", detail: e.message, code: "rate-limit" }, 429);
    if (e.status === 401 || e.status === 403) return json({ error: "GitHub hat den Zugriff abgelehnt. Die Rechte des GitHub-Tokens pruefen.", detail: e.message, code: "github-denied" }, 502);
    return err(502, e.message);
  }
  // Anbieter-Fehler (packages/providers): per Name erkannt, das Portal haengt nicht an diesem Paket.
  if (isNamed(e, "ProviderError")) {
    const status = (e as { status?: number | null }).status ?? null;
    const detail = (e as Error).message;
    if (status === 429) return json({ error: "Der Anbieter begrenzt die Anfragen. Bitte spaeter erneut versuchen.", detail, code: "rate-limit" }, 429);
    if (status === 401 || status === 403) return json({ error: "Der Anbieter hat den Zugriff abgelehnt. Das Token und seine Rechte pruefen.", detail, code: "provider-denied" }, 502);
    return json({ error: "Der Anbieter hat die Anfrage nicht akzeptiert.", detail, code: "provider-error" }, 502);
  }
  // Unbekannt: ohne Werte protokollieren (SecretValue ist maskiert), der Client sieht nur die Standardmeldung.
  console.error("[secret-desk] unerwarteter Fehler:", e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));
  return err(500, "Interner Fehler");
}

function isNamed(e: unknown, name: string): boolean {
  return e instanceof Error && e.name === name;
}
