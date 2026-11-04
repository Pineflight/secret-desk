import { NotConnectedError, type Check, type ConnectionStore, type DiscoverContext, type DiscoveredOption, type IssueContext, type ParamSpec, type Provider, type RevokeContext, type VerifyContext } from "@secret-desk/core";
import { asList, str, unknownKind } from "./discover.js";
import { check, isRecord, probe, step } from "./checks.js";
import { callJson, expiryFrom, ProviderError, revokeIdempotent, seg } from "./http.js";

/**
 * Anthropic. The Admin API (an organization Admin key, stored as the `anthropic` connection) can list workspaces and list,
 * rename and deactivate API keys. It never returns a key's secret and cannot create a key: a key is created only in the
 * Console. So the key comes from the browser recipe `anthropic-api-key`, and this module adds what the API can do around it:
 * workspace discovery, the "does the key work" check, an expiry date, and revoking through the Admin API.
 */

const API = "https://api.anthropic.com/v1";
const ID = "anthropic";
const VERSION = "2023-06-01";
/** Safety stop for pagination: 20 pages of up to 100 items. */
const MAX_PAGES = 20;
/** Anthropic keys never expire. An entry without its own `ttlDays` is rotated on this horizon, so the expiry date is always filled. */
export const ANTHROPIC_DEFAULT_ROTATION_DAYS = 90;
/** Every organization has a default workspace. The Admin API list does not name it (not verified), so discovery adds it. */
export const ANTHROPIC_DEFAULT_WORKSPACE = "Default";
/** The recipe whose browser provider gets the Admin API extras. */
export const ANTHROPIC_KEY_RECIPE = "anthropic-api-key";

type FetchFn = typeof fetch;
type Ctx = { connections: ConnectionStore; fetch: FetchFn };

const adminHeaders = (token: string): Record<string, string> => ({ "x-api-key": token, "anthropic-version": VERSION, Accept: "application/json" });

/** Call with the Admin key of the `anthropic` connection (header `x-api-key`, not a bearer token). */
async function adminCall<T>(ctx: Ctx, url: string, init: { method: string; body?: string }): Promise<T | undefined> {
  const token = (await ctx.connections.token("anthropic")).reveal();
  const headers = init.body !== undefined ? { ...adminHeaders(token), "Content-Type": "application/json" } : adminHeaders(token);
  return callJson<T>(ID, ctx.fetch, url, { ...init, headers }, [token]);
}

/** Pages through an Admin API list (`after_id` = last id, `has_more` is the continue signal). */
async function listAll(ctx: Ctx, path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const json = await adminCall<unknown>(ctx, `${API}${path}${sep}limit=100${after ? `&after_id=${seg(after)}` : ""}`, { method: "GET" });
    const items = asList(json, "data");
    out.push(...items);
    const last = (isRecord(json) ? str(json["last_id"]) : undefined) ?? (items.length > 0 ? str(items[items.length - 1]!["id"]) : undefined);
    if (!(isRecord(json) && json["has_more"] === true) || !last) return out;
    after = last;
  }
  return out;
}

/** Workspaces to choose from: the default workspace first, then the active ones (archived workspaces are skipped). */
export async function listWorkspaces(ctx: Ctx): Promise<{ name: string; id: string | null }[]> {
  const items = await listAll(ctx, "/organizations/workspaces");
  const out: { name: string; id: string | null }[] = [{ name: ANTHROPIC_DEFAULT_WORKSPACE, id: null }];
  for (const w of items) {
    const name = str(w["name"]);
    if (!name || str(w["archived_at"]) !== undefined || name === ANTHROPIC_DEFAULT_WORKSPACE) continue;
    out.push({ name, id: str(w["id"]) ?? null });
  }
  return out;
}

async function discoverAnthropic(kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  if (kind !== "anthropic.workspace") return unknownKind(kind);
  return (await listWorkspaces(ctx)).map((w) => ({ value: w.name, label: w.name, ...(w.id ? { detail: w.id } : {}) }));
}

/** `GET /v1/models?limit=1` with the issued key. */
async function verifyKey(ctx: VerifyContext): Promise<Check[]> {
  return step(ctx, "works", "Schluessel funktioniert", async () => {
    const value = ctx.value.reveal();
    const r = await probe(ID, ctx, `${API}/models?limit=1`, { method: "GET", headers: adminHeaders(value) }, [value]);
    if (r.status >= 200 && r.status < 300) return [check("works", "Schluessel funktioniert", "pass", { actual: "HTTP 200" })];
    if (r.status === 401) return [check("works", "Schluessel funktioniert", "fail", { actual: "HTTP 401", detail: "Anthropic lehnt den Schluessel ab" })];
    return [check("works", "Schluessel funktioniert", "warn", { actual: `HTTP ${r.status}` })];
  });
}

/**
 * Deactivates the key by its name through the Admin API: `status` goes to `inactive`, then to `archived` (not verified that
 * the API accepts that value, so a refusal of the second step is not an error: the key is already deactivated).
 * A key that is not listed any more (or already archived) counts as revoked.
 */
async function revokeViaAdmin(ctx: RevokeContext): Promise<void> {
  const keys = await listAll(ctx, "/organizations/api_keys");
  const hit = keys.find((k) => str(k["name"]) === ctx.externalId && str(k["status"]) !== "archived");
  const id = hit ? str(hit["id"]) : undefined;
  if (!id) return;
  const url = `${API}/organizations/api_keys/${seg(id)}`;
  await revokeIdempotent(() => adminCall(ctx, url, { method: "POST", body: JSON.stringify({ status: "inactive" }) }));
  try {
    await adminCall(ctx, url, { method: "POST", body: JSON.stringify({ status: "archived" }) });
  } catch (err) {
    if (!(err instanceof ProviderError && err.status !== null && err.status >= 400 && err.status < 500)) throw err;
  }
}

async function adminConnected(ctx: Pick<RevokeContext, "connections">): Promise<boolean> {
  try {
    await ctx.connections.token("anthropic");
    return true;
  } catch (err) {
    if (err instanceof NotConnectedError) return false;
    throw err;
  }
}

const workspaceSpec = (base: ParamSpec | undefined): ParamSpec => ({
  key: "workspace",
  label: "Workspace",
  labelEn: "Workspace",
  type: "string",
  required: false,
  help: "Workspace, in dem der Schluessel angelegt wird. Ohne Auswahl gilt der Default-Workspace.",
  helpEn: "Workspace the key is created in. Without a choice the Default workspace is used.",
  ...(base?.defaultValue !== undefined ? { defaultValue: base.defaultValue } : {}),
  discover: "anthropic.workspace",
});

/**
 * Adds what the Admin API can do to the browser provider of the recipe `anthropic-api-key`: workspace discovery (so the
 * provider shows under the `anthropic` connection), the key check, an expiry date that is always filled, and revoking through
 * the Admin API when the connection exists (otherwise the recipe's own revoke steps run in the browser).
 */
export function withAnthropicAdmin<T extends Provider>(base: T): T {
  const params: ParamSpec[] = [...(base.params ?? []).filter((p) => p.key !== "workspace"), workspaceSpec((base.params ?? []).find((p) => p.key === "workspace"))];
  const extended: Provider = {
    ...base,
    connection: "anthropic",
    params,
    discover: discoverAnthropic,
    verify: verifyKey,
    reviewChecklist: (secret) => [
      `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
      "Der Schluessel gehoert zum richtigen Workspace",
      "Der Workspace hat ein Ausgabelimit",
      "Anthropic-Schluessel laufen nicht ab: das Ablaufdatum ist die Erneuerungsfrist von secret-desk",
    ],
    async issue(ctx: IssueContext) {
      const issued = await base.issue!(ctx);
      return { ...issued, expiresAt: issued.expiresAt ?? expiryFrom(ctx.now, ctx.secret.ttlDays ?? ANTHROPIC_DEFAULT_ROTATION_DAYS) ?? null };
    },
    async revoke(ctx: RevokeContext) {
      if (await adminConnected(ctx)) return revokeViaAdmin(ctx);
      return base.revoke!(ctx);
    },
  };
  return extended as T;
}
