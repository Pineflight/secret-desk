import { SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type Provider } from "@secret-desk/core/portable";
import { asList, getJson, str, unknownKind } from "./discover.js";
import { check, isRecord, probeWithValue, step } from "./checks.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireString, revokeIdempotent, seg } from "./http.js";

const API = "https://api.openai.com/v1";
const ID = "openai";
/** Safety stop for pagination: 20 pages of up to 100 projects. */
const MAX_PAGES = 20;
/** OpenAI keys never expire. An entry without its own `ttlDays` is rotated on this horizon, so the expiry date is always filled. */
export const OPENAI_DEFAULT_ROTATION_DAYS = 90;

const PROJECT_PATTERN = /^proj_[A-Za-z0-9]+$/;

type Ctx = Pick<DiscoverContext, "connections" | "fetch">;

/** Lists the organization's projects (cursor pagination: `after` = id of the last item, `has_more` is the continue signal). */
async function listProjects(ctx: Ctx): Promise<{ id: string; name: string; status: string | undefined }[]> {
  const out: { id: string; name: string; status: string | undefined }[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await getJson<unknown>(ID, ctx, "openai", `${API}/organization/projects?limit=100${after ? `&after=${seg(after)}` : ""}`);
    const items = asList(json, "data");
    for (const p of items) {
      const id = str(p["id"]);
      if (id) out.push({ id, name: str(p["name"]) ?? id, status: str(p["status"]) });
    }
    const last = items.length > 0 ? str(items[items.length - 1]!["id"]) : undefined;
    if (!(isRecord(json) && json["has_more"] === true) || !last) return out;
    after = last;
  }
  return out;
}

const specs: ParamSpec[] = [
  {
    key: "projectId",
    label: "OpenAI-Projekt",
    labelEn: "OpenAI project",
    type: "string",
    required: true,
    pattern: PROJECT_PATTERN.source,
    help: "Projekt, in dem der Service-Account und sein Schluessel angelegt werden (proj_...).",
    helpEn: "Project that the service account and its key are created in (proj_...).",
    discover: "openai.project",
  },
];

async function discoverOpenai(kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  if (kind !== "openai.project") return unknownKind(kind);
  return (await listProjects(ctx)).filter((p) => p.status !== "archived").map((p) => ({ value: p.id, label: p.name, detail: p.id }));
}

function projectOf(params: Record<string, unknown>): string {
  const id = requireString(ID, params, "projectId");
  if (!PROJECT_PATTERN.test(id)) throw new ProviderError(ID, null, "Parameter \"projectId\" hat nicht das erwartete Format (proj_...)");
  return id;
}

/** `GET /v1/models?limit=1` with the issued key. */
async function verifyKey(ctx: Parameters<NonNullable<Provider["verify"]>>[0]): Promise<Check[]> {
  return step(ctx, "works", "Schluessel funktioniert", async () => {
    const r = await probeWithValue(ID, ctx, `${API}/models?limit=1`);
    if (r.status >= 200 && r.status < 300) return [check("works", "Schluessel funktioniert", "pass", { actual: "HTTP 200" })];
    if (r.status === 401) return [check("works", "Schluessel funktioniert", "fail", { actual: "HTTP 401", detail: "OpenAI lehnt den Schluessel ab" })];
    return [check("works", "Schluessel funktioniert", "warn", { actual: `HTTP ${r.status}` })];
  });
}

/**
 * OpenAI key of a project. The Admin API (admin key stored as the `openai` connection, created once through the browser)
 * creates a service account with its own key and deletes it again on revoke. The key value is shown once, in the issue answer.
 */
export const openaiProvider: Provider = {
  id: ID,
  label: "OpenAI API-Key",
  kind: "automatic",
  connection: "openai",
  params: specs,
  discover: discoverOpenai,
  async issue(ctx) {
    const projectId = projectOf(ctx.params);
    const res = await callWithToken<{ id?: unknown; api_key?: { value?: unknown } }>(ID, ctx, "openai", `${API}/organization/projects/${seg(projectId)}/service_accounts`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: ctx.label }),
    });
    const value = res?.api_key?.value;
    if (!res || typeof res.id !== "string" || typeof value !== "string" || !value) throw badResponse(ID);
    return { value: new SecretValue(value), externalId: res.id, expiresAt: expiryFrom(ctx.now, ctx.secret.ttlDays ?? OPENAI_DEFAULT_ROTATION_DAYS) ?? null };
  },
  verify: verifyKey,
  reviewChecklist(secret) {
    const project = secret.params["projectId"];
    return [
      project ? `Der Schluessel gehoert zum Projekt ${String(project)}` : "Der Schluessel gehoert zum richtigen Projekt",
      "Das Projekt hat ein Kostenlimit",
      "Der Name beim Anbieter traegt das heutige Datum",
    ];
  },
  async revoke(ctx) {
    const projectId = projectOf(ctx.params);
    await revokeIdempotent(() => callWithToken(ID, ctx, "openai", `${API}/organization/projects/${seg(projectId)}/service_accounts/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

export const openaiProviders: Provider[] = [openaiProvider];
