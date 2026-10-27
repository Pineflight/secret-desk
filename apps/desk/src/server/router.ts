import { userInfo } from "node:os";
import {
  EnvExportError,
  EvidenceError,
  GitHubError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  RotationError,
  StageError,
  VaultUnavailableError,
  TeamBundleError,
  VariableError,
  VariablePatchSchema,
  mergeTeamBundle,
  parseInput,
  parseTeamBundle,
  type Stage,
  type StatusLevel,
} from "@secret-desk/core";
import {
  AutomationError,
  PolicyError,
  checkConnection,
  listWriteTargets,
  tokenPrefixProblem,
  cancelAutomationRun,
  getAutomation,
  getAutomationRun,
  translateDeep,
  addEnvEntry,
  addEnvTemplate,
  addManualProvider,
  addSecret,
  addVariable,
  adoptVariableFromGitHub,
  attachEvidence,
  confirmIssuance,
  evidenceSvg,
  exportEnv,
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
  listRepos,
  getSettings,
  listStages,
  listSecrets,
  listVariables,
  overview,
  readAttachment,
  rejectIssuance,
  removeLink,
  removeVariable,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  scanLocal,
  setLink,
  setStages,
  submitManualValue,
  teamExport,
  updateSecretMeta,
  updateVariable,
  type Actor,
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
const optStr = (b: Body, k: string): string | undefined => (typeof b[k] === "string" ? (b[k] as string) : undefined);

/** Der Name kommt vom Agenten selbst (Kopf x-agent-name) und ist nicht verifiziert: gekuerzt und auf harmlose Zeichen beschraenkt. */
export function sanitizeAgentName(raw: string | null): string {
  const clean = (raw ?? "").replace(/[^A-Za-z0-9 ._:@/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return clean || "agent";
}

/** Gemeinsame Operationen. Alle Antworten sind JSON und enthalten nie einen geheimen Wert. */
const common: [string, RegExp, Handler][] = [
  ["GET", /^overview$/, ({ rt }) => overview(rt)],
  ["GET", /^stages$/, ({ rt }) => listStages(rt)],
  ["GET", /^secrets$/, ({ rt, query }) => listSecrets(rt, { ...(stage(query) ? { stage: stage(query)! } : {}), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), ...(query.get("product") ? { product: query.get("product")! } : {}), ...(query.get("status") ? { status: query.get("status") as StatusLevel } : {}), ...(query.get("provider") ? { provider: query.get("provider")! } : {}), ...(query.get("q") ? { q: query.get("q")! } : {}), ...(query.get("tag") ? { tag: query.get("tag")! } : {}), live: query.get("live") === "1" })],
  ["POST", /^secrets$/, ({ rt, actor, body }) => addSecret(rt, actor, body)],
  ["GET", /^secrets\/([^/]+)$/, ({ rt, params }) => getSecret(rt, params[0]!)],
  // Der Akteur bestimmt die erlaubten Felder (strikt, unbekannte Felder -> 400): Agenten nur Metadaten, Menschen alle bearbeitbaren.
  ["PATCH", /^secrets\/([^/]+)$/, ({ rt, actor, params, body }) => updateSecretMeta(rt, actor, params[0]!, body)],
  ["GET", /^dev-templates$/, ({ rt }) => rt.inventory.data.envTemplates.map((t) => ({ id: t.id, repo: t.repo, stage: t.stage, file: t.file, entries: t.entries.map((e) => ({ key: e.key, source: e.from.type, description: e.description ?? null, ...(e.from.type === "variable" ? { variable: e.from.variable } : {}), ...(e.from.type === "issue" ? { secret: e.from.secret } : {}), ...(e.from.type === "default" ? { value: e.from.value } : {}) })) }))],
  ["GET", /^providers$/, ({ rt }) => listProviders(rt)],
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
  ["POST", /^env-export$/, ({ rt, actor, body }) => exportEnv(rt, actor, { repo: str(body, "repo"), ...(optStr(body, "path") ? { path: optStr(body, "path")! } : {}), ...(optStr(body, "template") ? { template: optStr(body, "template")! } : {}), ...(optStr(body, "stage") ? { stage: optStr(body, "stage") as Stage } : {}), overwrite: body.overwrite === true, ...(body.prompts && typeof body.prompts === "object" ? { prompts: body.prompts as Record<string, string> } : {}) })],
];

/** Nur im Portal (Mensch): Bestaetigen, Eingeben, Freigeben, Verbindungen, Anlagen, Browser-Laeufe ansehen und abbrechen. */
const humanOnly: [string, RegExp, Handler][] = [
  // Stage-Definitionen aendert nur ein Mensch im Portal (Einstellungen); Agenten lesen sie.
  ["PUT", /^stages$/, ({ rt, body }) => setStages(rt, Array.isArray(body.stages) ? (body.stages as never[]) : (() => { throw new InventoryError("Feld fehlt: stages"); })())],
  // Gestartet wird ein Browser-Lauf ueber renewal-requests (oder die Freigabe); hier nur Zustand und Abbruch. Agenten sehen nichts davon.
  // Reine Metadaten der Konfiguration (Pfade, Schalter, aufgeloeste Richtlinie), nie Werte. Agenten bekommen 404.
  ["GET", /^settings$/, ({ rt }) => getSettings(rt)],
  ["GET", /^automation$/, ({ rt, actor }) => getAutomation(rt, actor)],
  ["GET", /^automation\/runs\/([^/]+)$/, ({ rt, actor, params }) => getAutomationRun(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^automation\/runs\/([^/]+)\/cancel$/, ({ rt, actor, params }) => cancelAutomationRun(rt, actor, decodeURIComponent(params[0]!))],
  ["POST", /^reviews\/([^/]+)\/confirm$/, ({ rt, actor, params, body }) => confirmIssuance(rt, actor, params[0]!, { ticks: Array.isArray(body.ticks) ? (body.ticks as string[]) : [], ...(optStr(body, "note") ? { note: optStr(body, "note")! } : {}), force: body.force === true })],
  ["POST", /^reviews\/([^/]+)\/reject$/, ({ rt, actor, params, body }) => rejectIssuance(rt, actor, params[0]!, optStr(body, "note"))],
  ["POST", /^secrets\/([^/]+)\/manual-value$/, ({ rt, actor, params, body }) => submitManualValue(rt, actor, params[0]!, str(body, "value"))],
  ["POST", /^approvals\/([^/]+)\/(approve|deny)$/, ({ rt, actor, params }) => resolveApproval(rt, actor, params[0]!, params[1] as "approve" | "deny")],
  ["POST", /^variables\/([^/]+)\/adopt$/, ({ rt, actor, params }) => adoptVariableFromGitHub(rt, actor, params[0]!)],
  ["DELETE", /^variables\/([^/]+)$/, async ({ rt, actor, params }) => { await removeVariable(rt, actor, params[0]!); return { ok: true }; }],
  ["POST", /^connections\/([^/]+)\/token$/, async ({ rt, params, body }) => {
    const id = params[0]!;
    const prefixProblem = typeof body["token"] === "string" ? tokenPrefixProblem(id, body["token"]) : undefined;
    if (prefixProblem) throw new InventoryError(prefixProblem);
    const expires = tokenExpiry(body);
    if (body["remember"] === true) {
      if (!rt.connections.vault) throw new InventoryError("Der Tresor ist ausgeschaltet (vault.enabled in der Konfiguration).");
      await rt.connections.vault.set(id, str(body, "token"), expires);
      rt.connections.session.delete(id);
    } else {
      rt.connections.session.set(id, str(body, "token"), expires);
    }
    return rt.connections.status(id);
  }],
  ["DELETE", /^connections\/([^/]+)\/token$/, async ({ rt, params }) => { rt.connections.session.delete(params[0]!); await rt.connections.vault?.delete(params[0]!); return rt.connections.status(params[0]!); }],
  ["GET", /^connections\/github\/write-targets$/, ({ rt }) => listWriteTargets(rt)],
  ["POST", /^connections\/([^/]+)\/check$/, ({ rt, params, body }) =>
    checkConnection(rt, params[0]!, {
      deep: body["deep"] === true,
      targets: Array.isArray(body["targets"]) ? body["targets"].filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    }),
  ],
  ["PUT", /^repos\/([^/]+)\/link$/, ({ rt, params, body }) => setLink(rt, decodeURIComponent(params[0]!), str(body, "path"))],
  ["DELETE", /^repos\/([^/]+)\/link$/, ({ rt, params }) => removeLink(rt, decodeURIComponent(params[0]!))],
  ["POST", /^repos\/scan$/, ({ rt }) => scanLocal(rt)],
  ["POST", /^team-import$/, async ({ rt, body }) => {
    // Ersetzen loescht bestehende Eintraege: nur mit ausdruecklicher Bestaetigung (das Portal fragt vorher nach).
    if (body.replace === true && body.confirmReplace !== true) throw new InventoryError("Ersetzen braucht die ausdrueckliche Bestaetigung confirmReplace: true.");
    const merged = mergeTeamBundle(rt.inventory, parseTeamBundle(str(body, "text")), body.replace === true ? "replace" : "merge");
    await rt.inventory.save();
    return merged;
  }],
];

const raw: [string, RegExp, Raw][] = [
  ["GET", /^team-export$/, async ({ rt }) => new Response(teamExport(rt), { headers: { "content-type": "text/yaml; charset=utf-8", "content-disposition": 'attachment; filename="secret-desk.team.yaml"', "cache-control": "no-store" } })],
];

const rawHuman: [string, RegExp, Raw][] = [
  ["GET", /^evidence\/([^/]+)\/([^/]+)\/svg$/, async ({ rt, params }) => new Response(await evidenceSvg(rt, params[0]!, params[1]!), { headers: { "content-type": "image/svg+xml", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", "cache-control": "no-store" } })],
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
  if (e instanceof NotConnectedError) return json({ error: e.message, connection: e.connection, hint: e.hint, code: "not-connected" }, 409);
  if (e instanceof VariableError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, 400);
  if (e instanceof InventoryError || e instanceof EnvExportError || e instanceof EvidenceError || e instanceof TeamBundleError || e instanceof StageError || isNamed(e, "TemplateError")) return err(400, (e as Error).message);
  if (e instanceof VaultUnavailableError) return json({ error: e.message, code: "vault-unavailable" }, 409);
  if (e instanceof IssuanceError || e instanceof RotationError || e instanceof AutomationError) return err(409, e.message);
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
