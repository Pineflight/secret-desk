import {
  EnvExportError,
  EvidenceError,
  GitHubError,
  InventoryError,
  IssuanceError,
  NotConnectedError,
  RotationError,
  TeamBundleError,
  VariableError,
  mergeTeamBundle,
  parseTeamBundle,
  type Stage,
  type StatusLevel,
} from "@secret-desk/core";
import {
  PolicyError,
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
  listSecrets,
  listVariables,
  overview,
  readAttachment,
  rejectIssuance,
  removeVariable,
  requestApplyVariable,
  requestIssuance,
  resolveApproval,
  submitManualValue,
  teamExport,
  updateSecretMeta,
  updateVariable,
  type Actor,
  type Runtime,
} from "@secret-desk/runtime";
import { bearerMatches, checkHost, checkOrigin, type PortalSession } from "./security";

export interface RouterDeps {
  rt: Runtime;
  session: PortalSession;
  agentToken: string;
  hosts: Set<string>;
}

type Body = Record<string, unknown>;
type Ctx = { rt: Runtime; actor: Actor; req: Request; params: string[]; query: URLSearchParams; body: Body };
type Handler = (c: Ctx) => Promise<unknown> | unknown;
type Raw = (c: Ctx) => Promise<Response>;

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, message: string): Response => json({ error: message }, status);

const stage = (q: URLSearchParams): Stage | undefined => (q.get("stage") ? (q.get("stage") as Stage) : undefined);
const str = (b: Body, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || v === "") throw new InventoryError(`Feld fehlt: ${k}`);
  return v;
};
const optStr = (b: Body, k: string): string | undefined => (typeof b[k] === "string" ? (b[k] as string) : undefined);

/** Gemeinsame Operationen. Alle Antworten sind JSON und enthalten nie einen geheimen Wert. */
const common: [string, RegExp, Handler][] = [
  ["GET", /^overview$/, ({ rt }) => overview(rt)],
  ["GET", /^secrets$/, ({ rt, query }) => listSecrets(rt, { ...(stage(query) ? { stage: stage(query)! } : {}), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), ...(query.get("product") ? { product: query.get("product")! } : {}), ...(query.get("status") ? { status: query.get("status") as StatusLevel } : {}), ...(query.get("provider") ? { provider: query.get("provider")! } : {}), ...(query.get("q") ? { q: query.get("q")! } : {}), ...(query.get("tag") ? { tag: query.get("tag")! } : {}), live: query.get("live") === "1" })],
  ["POST", /^secrets$/, ({ rt, body }) => addSecret(rt, body as never)],
  ["GET", /^secrets\/([^/]+)$/, ({ rt, params }) => getSecret(rt, params[0]!)],
  ["PATCH", /^secrets\/([^/]+)$/, ({ rt, params, body }) => updateSecretMeta(rt, params[0]!, body as never)],
  ["GET", /^dev-templates$/, ({ rt }) => rt.inventory.data.envTemplates.map((t) => ({ id: t.id, repo: t.repo, stage: t.stage, file: t.file, entries: t.entries.map((e) => ({ key: e.key, source: e.from.type, description: e.description ?? null, ...(e.from.type === "variable" ? { variable: e.from.variable } : {}), ...(e.from.type === "issue" ? { secret: e.from.secret } : {}), ...(e.from.type === "default" ? { value: e.from.value } : {}) })) }))],
  ["GET", /^providers$/, ({ rt }) => listProviders(rt)],
  ["POST", /^providers$/, ({ rt, body }) => addManualProvider(rt, body as never)],
  ["GET", /^connections$/, ({ rt }) => listConnections(rt)],
  ["POST", /^env-templates$/, ({ rt, body }) => addEnvTemplate(rt, body as never)],
  ["POST", /^env-templates\/([^/]+)\/entries$/, ({ rt, params, body }) => addEnvEntry(rt, params[0]!, body as never)],
  ["POST", /^renewal-requests$/, ({ rt, actor, body }) => requestIssuance(rt, actor, str(body, "secretId"), { ...(optStr(body, "reason") ? { reason: optStr(body, "reason")! } : {}), dryRun: body.dryRun === true })],
  ["GET", /^reviews$/, ({ rt }) => listIssuances(rt)],
  ["GET", /^reviews\/([^/]+)$/, ({ rt, params }) => getIssuance(rt, params[0]!)],
  ["GET", /^evidence\/([^/]+)$/, ({ rt, params }) => listEvidence(rt, params[0]!)],
  ["GET", /^evidence\/([^/]+)\/([^/]+)$/, ({ rt, params }) => getEvidence(rt, params[0]!, params[1]!)],
  ["GET", /^variables$/, ({ rt, query }) => listVariables(rt, { ...(stage(query) ? { stage: stage(query)! } : {}), ...(query.get("repo") ? { repo: query.get("repo")! } : {}), ...(query.get("product") ? { product: query.get("product")! } : {}), ...(query.get("q") ? { q: query.get("q")! } : {}), ...(query.get("tag") ? { tag: query.get("tag")! } : {}) })],
  ["POST", /^variables$/, ({ rt, actor, body }) => addVariable(rt, actor, body as never, { acknowledgedPublic: body.acknowledgedPublic === true })],
  ["GET", /^variables\/([^/]+)$/, ({ rt, params }) => getVariable(rt, params[0]!)],
  ["GET", /^variables\/([^/]+)\/status$/, ({ rt, params }) => inspectVariableLive(rt, params[0]!)],
  ["PATCH", /^variables\/([^/]+)$/, ({ rt, actor, params, body }) => updateVariable(rt, actor, params[0]!, { ...("value" in body ? { value: body.value as string | null } : {}), ...("description" in body ? { description: body.description as string | null } : {}), ...("owner" in body ? { owner: body.owner as string | null } : {}), ...("link" in body ? { link: body.link as string | null } : {}), ...("tags" in body ? { tags: body.tags as string[] | null } : {}) }, { acknowledgedPublic: body.acknowledgedPublic === true })],
  ["POST", /^variables\/([^/]+)\/apply$/, ({ rt, actor, params, body }) => requestApplyVariable(rt, actor, params[0]!, { ...(optStr(body, "reason") ? { reason: optStr(body, "reason")! } : {}), acknowledgedPublic: body.acknowledgedPublic === true })],
  ["GET", /^approvals$/, ({ rt }) => listApprovals(rt)],
  ["GET", /^approvals\/([^/]+)$/, ({ rt, params }) => getApproval(rt, params[0]!)],
  ["POST", /^env-export$/, ({ rt, actor, body }) => exportEnv(rt, actor, { repo: str(body, "repo"), path: str(body, "path"), ...(optStr(body, "template") ? { template: optStr(body, "template")! } : {}), ...(optStr(body, "stage") ? { stage: optStr(body, "stage") as Stage } : {}), overwrite: body.overwrite === true, ...(body.prompts && typeof body.prompts === "object" ? { prompts: body.prompts as Record<string, string> } : {}) })],
];

/** Nur im Portal (Mensch): Bestaetigen, Eingeben, Freigeben, Verbindungen, Anlagen. */
const humanOnly: [string, RegExp, Handler][] = [
  ["POST", /^reviews\/([^/]+)\/confirm$/, ({ rt, actor, params, body }) => confirmIssuance(rt, actor, params[0]!, { ticks: Array.isArray(body.ticks) ? (body.ticks as string[]) : [], ...(optStr(body, "note") ? { note: optStr(body, "note")! } : {}), force: body.force === true })],
  ["POST", /^reviews\/([^/]+)\/reject$/, ({ rt, actor, params, body }) => rejectIssuance(rt, actor, params[0]!, optStr(body, "note"))],
  ["POST", /^secrets\/([^/]+)\/manual-value$/, ({ rt, actor, params, body }) => submitManualValue(rt, actor, params[0]!, str(body, "value"))],
  ["POST", /^approvals\/([^/]+)\/(approve|deny)$/, ({ rt, actor, params }) => resolveApproval(rt, actor, params[0]!, params[1] as "approve" | "deny")],
  ["POST", /^variables\/([^/]+)\/adopt$/, ({ rt, actor, params }) => adoptVariableFromGitHub(rt, actor, params[0]!)],
  ["DELETE", /^variables\/([^/]+)$/, async ({ rt, actor, params }) => { await removeVariable(rt, actor, params[0]!); return { ok: true }; }],
  ["POST", /^connections\/([^/]+)\/token$/, ({ rt, params, body }) => { rt.connections.session.set(params[0]!, str(body, "token")); return rt.connections.status(params[0]!); }],
  ["DELETE", /^connections\/([^/]+)\/token$/, ({ rt, params }) => { rt.connections.session.delete(params[0]!); return rt.connections.status(params[0]!); }],
  ["POST", /^team-import$/, async ({ rt, body }) => {
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
  ["GET", /^evidence\/([^/]+)\/([^/]+)\/attachments\/([^/]+)$/, async ({ rt, params }) => {
    const a = await readAttachment(rt, params[0]!, params[1]!, params[2]!);
    if (!a) return err(404, "Anlage nicht gefunden");
    return new Response(new Uint8Array(a.bytes), { headers: { "content-type": a.mime, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" } });
  }],
  ["POST", /^evidence\/([^/]+)\/([^/]+)\/attachments$/, async ({ rt, actor, params, req }) => {
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
    actor = { kind: "agent", name: req.headers.get("x-agent-name") ?? "agent" };
  } else {
    // Beleg-Bilder werden per <img> geladen und koennen keinen CSRF-Header senden: nur lesend, nur mit Cookie.
    const imageRead = req.method === "GET" && /^evidence\/[^/]+\/[^/]+\/(svg|attachments\/[^/]+)$/.test(path);
    if (!(imageRead ? deps.session.validCookie(req) : deps.session.valid(req))) return err(401, "Portal-Sitzung ungueltig. Seite neu laden.");
    actor = { kind: "human", name: process.env.SECRET_DESK_USER ?? "niklas" };
  }

  let body: Body = {};
  const contentType = req.headers.get("content-type") ?? "";
  if (req.method !== "GET" && req.method !== "HEAD" && contentType.includes("application/json")) {
    try {
      body = ((await req.json()) as Body) ?? {};
    } catch {
      return err(400, "Ungueltiges JSON");
    }
  }

  const tables = kind === "ui" ? [...common, ...humanOnly] : common;
  const rawTables = kind === "ui" ? [...raw, ...rawHuman] : raw;
  try {
    for (const [method, re, fn] of rawTables) {
      const r = req.method === method ? re.exec(path) : null;
      if (r) return await fn({ rt: deps.rt, actor, req, params: r.slice(1), query: url.searchParams, body });
    }
    for (const [method, re, fn] of tables) {
      const r = req.method === method ? re.exec(path) : null;
      if (r) return json(await fn({ rt: deps.rt, actor, req, params: r.slice(1), query: url.searchParams, body }));
    }
    return err(404, "Nicht gefunden");
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): Response {
  if (e instanceof PolicyError) return err(403, e.message);
  if (e instanceof NotConnectedError) return json({ error: e.message, connection: e.connection, hint: e.hint, code: "not-connected" }, 409);
  if (e instanceof InventoryError || e instanceof VariableError || e instanceof EnvExportError || e instanceof EvidenceError || e instanceof TeamBundleError) return err(400, e.message);
  if (e instanceof IssuanceError || e instanceof RotationError) return err(409, e.message);
  if (e instanceof GitHubError) return err(502, e.message);
  return err(500, "Interner Fehler");
}
