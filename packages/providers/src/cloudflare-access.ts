import { SecretValue, type Check, type ParamSpec, type Provider, type VerifyContext, type PreflightContext, type PreflightResult } from "@secret-desk/core/portable";
import { check } from "./checks.js";
import { ACCOUNT_SCOPE, CLOUDFLARE_ACCOUNT_ID_SPEC, CLOUDFLARE_API, discoverCloudflare, preflightCloudflare } from "./cloudflare.js";
import { badResponse, callJson, callWithToken, JSON_HEADERS, ProviderError, requireString, revokeIdempotent, seg, type CallContext } from "./http.js";

const ID = "cloudflare-access-service-token";
const CONNECTION = "cloudflare";

/**
 * Names under which Cloudflare lists the write permission for Access service tokens. The reference tables show both
 * "Edit" and "Write"; the first name the account's permission list contains is used. Not verified against a live account.
 */
export const ACCESS_PERMISSION_NAMES = ["Access: Service Tokens Write", "Access: Service Tokens Edit"] as const;

/** Lifetime of the helper token that only exists to make the Access call. */
const HELPER_MINUTES = 10;

const DURATIONS = ["8760h", "720h", "2160h", "forever"] as const;
const DEFAULT_DURATION = "8760h";

const specs: ParamSpec[] = [
  CLOUDFLARE_ACCOUNT_ID_SPEC,
  {
    key: "duration",
    label: "Gueltigkeit des Tokens",
    labelEn: "Token lifetime",
    type: "enum",
    required: false,
    defaultValue: DEFAULT_DURATION,
    options: [
      { value: "8760h", label: "1 Jahr (8760h)", labelEn: "1 year (8760h)" },
      { value: "720h", label: "30 Tage (720h)", labelEn: "30 days (720h)" },
      { value: "2160h", label: "90 Tage (2160h)", labelEn: "90 days (2160h)" },
      { value: "forever", label: "Unbegrenzt", labelEn: "Never expires" },
    ],
    help: "Wie lange der Service-Token gilt. Cloudflare setzt ohne Angabe 1 Jahr.",
    helpEn: "How long the service token is valid. Cloudflare uses 1 year when none is given.",
  },
  {
    key: "clientIdTarget",
    label: "Eintrag fuer die Client-ID",
    labelEn: "Entry for the client ID",
    type: "string",
    required: true,
    pattern: "^[a-z0-9][a-z0-9-]*$",
    help: "Id des Secret-Eintrags (Inventar), der die Client-ID aus derselben Ausstellung bekommt, zum Beispiel CLOUDFLARE_ACCESS_CLIENT_ID.",
    helpEn: "Inventory id of the secret entry that receives the client ID from the same issuance, for example CLOUDFLARE_ACCESS_CLIENT_ID.",
  },
];

interface Envelope<T> {
  result?: T;
}

interface AccessToken {
  id?: string;
  client_id?: string;
  client_secret?: string;
  expires_at?: string;
}

/** Permission-group names, ids and scopes as Cloudflare lists them. */
async function findAccessGroup(ctx: CallContext): Promise<{ id: string; name: string }> {
  const r = await callWithToken<Envelope<{ id: string; name: string; scopes?: string[] }[]>>(ID, ctx, CONNECTION, `${CLOUDFLARE_API}/user/tokens/permission_groups`, { method: "GET" });
  const list = r?.result;
  if (!Array.isArray(list)) throw badResponse(ID);
  for (const name of ACCESS_PERMISSION_NAMES) {
    const hit = list.find((g) => g.name === name && (g.scopes ?? [ACCOUNT_SCOPE]).includes(ACCOUNT_SCOPE));
    if (hit) return { id: hit.id, name };
  }
  throw new ProviderError(ID, null, `Berechtigungsgruppe fuer Access-Service-Tokens nicht gefunden (gesucht: ${ACCESS_PERMISSION_NAMES.join(", ")})`);
}

/**
 * Runs `work` with a short-lived helper token that may manage Access service tokens in one account. The connection token
 * ("Create additional tokens") cannot call the Access API itself. The helper is created here, lives in memory only and is
 * deleted in `finally`, also when `work` fails. If the delete itself fails the helper still expires after a few minutes.
 */
async function withHelperToken<T>(ctx: CallContext & { now?: Date }, accountId: string, label: string, work: (helper: string) => Promise<T>): Promise<T> {
  const group = await findAccessGroup(ctx);
  const now = ctx.now ?? new Date();
  const expiresOn = new Date(now.getTime() + HELPER_MINUTES * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const body = {
    name: `${label}-helper`,
    policies: [{ effect: "allow", resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" }, permission_groups: [{ id: group.id }] }],
    expires_on: expiresOn,
  };
  const created = await callWithToken<Envelope<{ id: string; value: string }>>(ID, ctx, CONNECTION, `${CLOUDFLARE_API}/user/tokens`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const helper = created?.result;
  if (!helper || typeof helper.id !== "string") throw badResponse(ID);
  try {
    if (typeof helper.value !== "string") throw new ProviderError(ID, null, `Antwort ohne Wert fuer das Hilfs-Token (Kennung ${helper.id}); es laeuft nach wenigen Minuten ab.`);
    return await work(helper.value);
  } finally {
    await revokeIdempotent(() => callWithToken(ID, ctx, CONNECTION, `${CLOUDFLARE_API}/user/tokens/${seg(helper.id)}`, { method: "DELETE" })).catch(() => undefined);
  }
}

/** Call with the helper token as bearer; the helper value is scrubbed from errors. */
async function callHelper<T>(ctx: CallContext, helper: string, url: string, init: { method: string; body?: string }): Promise<T | undefined> {
  // The connection token is scrubbed too: an error body from Cloudflare could echo either.
  const conn = (await ctx.connections.token(CONNECTION)).reveal();
  return callJson<T>(ID, ctx.fetch, url, { ...init, headers: { Authorization: `Bearer ${helper}`, ...(init.body ? JSON_HEADERS : {}) } }, [helper, conn]);
}

const tokensUrl = (accountId: string): string => `${CLOUDFLARE_API}/accounts/${seg(accountId)}/access/service_tokens`;

function durationOf(params: Record<string, unknown>): string {
  const d = params["duration"];
  return typeof d === "string" && d !== "" ? d : DEFAULT_DURATION;
}

/** Expiry from the duration, only as a fallback when the API does not return `expires_at`. */
function expiryFromDuration(now: Date, duration: string): string | null {
  const m = /^(\d+)h$/.exec(duration);
  return m ? new Date(now.getTime() + Number(m[1]) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** Whether the entry's service token still exists at Cloudflare (then it is rotated, otherwise created). */
async function tokenExists(ctx: CallContext, helper: string, accountId: string, tokenId: string): Promise<boolean> {
  try {
    await callHelper(ctx, helper, `${tokensUrl(accountId)}/${seg(tokenId)}`, { method: "GET" });
    return true;
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) return false;
    throw err;
  }
}

async function preflight(ctx: PreflightContext): Promise<PreflightResult> {
  const base = await preflightCloudflare(ID, CONNECTION, specs, ctx, false);
  try {
    const group = await findAccessGroup({ connections: ctx.connections, fetch: ctx.fetch });
    base.findings.push({ id: "helper-token", level: "ok", label: `Ein kurzlebiges Hilfs-Token mit "${group.name}" kann angelegt werden` });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    base.findings.push({ id: "helper-token", level: "fail", label: "Das Hilfs-Token fuer die Access-API kann nicht angelegt werden", detail: err instanceof Error ? err.message : "Fehler" });
  }
  return base;
}

/** Rotation keeps the provider id; the entry's own id in the inventory tells which path `issue` took. */
const isRotation = (ctx: VerifyContext): boolean => ctx.externalId !== undefined && ctx.externalId === ctx.secret.externalId;

export const cloudflareAccessProvider: Provider = {
  id: ID,
  label: "Cloudflare Access Service-Token (Client-ID und Secret)",
  kind: "automatic",
  connection: CONNECTION,
  params: specs,
  companionParams: ["clientIdTarget"],
  discover: (kind, ctx) => discoverCloudflare(ID, CONNECTION, specs, kind, ctx),
  preflight,
  async issue(ctx) {
    const accountId = requireString(ID, ctx.params, "accountId");
    const targetId = requireString(ID, ctx.params, "clientIdTarget");
    const duration = durationOf(ctx.params);
    const oldId = ctx.secret.externalId;
    return withHelperToken({ ...ctx }, accountId, ctx.label, async (helper) => {
      const rotate = oldId !== undefined && oldId !== "" && (await tokenExists(ctx, helper, accountId, oldId));
      if (rotate) {
        const res = await callHelper<Envelope<AccessToken>>(ctx, helper, `${tokensUrl(accountId)}/${seg(oldId!)}/rotate`, { method: "POST", body: "{}" });
        const r = res?.result;
        if (!r || typeof r.client_secret !== "string") throw badResponse(ID);
        // The client ID stays the same, so the companion entry is not rewritten.
        return { value: new SecretValue(r.client_secret), externalId: oldId!, expiresAt: r.expires_at ?? expiryFromDuration(ctx.now, duration) };
      }
      const res = await callHelper<Envelope<AccessToken>>(ctx, helper, tokensUrl(accountId), { method: "POST", body: JSON.stringify({ name: ctx.label, duration }) });
      const r = res?.result;
      if (r && typeof r.id === "string" && (typeof r.client_secret !== "string" || typeof r.client_id !== "string")) {
        // The token exists at Cloudflare but the one-time values did not arrive: it must not orphan unnoticed.
        throw new ProviderError(ID, null, `Antwort ohne Werte: bei Cloudflare koennte ein verwaister Service-Token bestehen (Kennung ${r.id}). Im Dashboard pruefen und loeschen.`);
      }
      if (!r || typeof r.id !== "string" || typeof r.client_secret !== "string" || typeof r.client_id !== "string") throw badResponse(ID);
      return {
        value: new SecretValue(r.client_secret),
        externalId: r.id,
        expiresAt: duration === "forever" ? null : (r.expires_at ?? expiryFromDuration(ctx.now, duration)),
        companions: [{ entryId: targetId, value: new SecretValue(r.client_id) }],
      };
    });
  },
  async verify(ctx) {
    const out: Check[] = [];
    const rotation = isRotation(ctx);
    out.push(
      rotation
        ? check("mode", "Vorgehen", "warn", { actual: "Secret des bestehenden Service-Tokens rotiert", detail: "Die Client-ID bleibt. Das alte Secret wird bei Cloudflare mit der Rotation ungueltig, auch wenn du verwirfst." })
        : check("mode", "Vorgehen", "info", { actual: "Neuer Service-Token", detail: "Der alte Service-Token wird erst nach deiner Bestaetigung geloescht." }),
    );
    const d = durationOf(ctx.params);
    out.push(check("duration", "Gueltigkeit", "info", { actual: d === "forever" ? "unbegrenzt" : d }));
    return out;
  },
  reviewChecklist(secret) {
    const target = typeof secret.params["clientIdTarget"] === "string" ? secret.params["clientIdTarget"] : undefined;
    return [
      `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
      target ? `Die Client-ID geht an den Eintrag ${target} und an keinen anderen` : "Die Client-ID geht an den vorgesehenen Eintrag",
      "Die Apps hinter Cloudflare Access verweisen auf diesen Service-Token",
    ];
  },
  async revoke(ctx) {
    const accountId = requireString(ID, ctx.params, "accountId");
    const c = { connections: ctx.connections, fetch: ctx.fetch };
    await revokeIdempotent(() => withHelperToken(c, accountId, `${ctx.secret.id}-revoke`, (helper) => callHelper(c, helper, `${tokensUrl(accountId)}/${seg(ctx.externalId)}`, { method: "DELETE" })));
  },
};

export const cloudflareAccessProviders: Provider[] = [cloudflareAccessProvider];
