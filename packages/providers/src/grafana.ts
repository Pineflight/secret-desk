import { SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider, type ProviderConfig, type VerifyContext } from "@secret-desk/core";
import { asList, getJson, needParam, readFailure, str, unknownKind } from "./discover.js";
import { check, daysApart, day, isRecord, probeWithConnection, probeWithValue, step, type Reply } from "./checks.js";
import { TIMEOUT_MS, badResponse, callWithToken, expiryFrom, JSON_HEADERS, optionalString, ProviderError, requireString, revokeIdempotent, seg, type CallContext } from "./http.js";

const ID = "grafana-service-account-token";

/**
 * Adresse der Grafana-Instanz. Der Token der Verbindung geht als Bearer an diese Adresse: Sie darf deshalb nicht frei
 * aus dem Inventar kommen (das kann aus fremden Quellen stammen). Erlaubt sind nur
 *   (a) https-Hosts, die auf .grafana.net enden, und
 *   (b) exakt die Hosts aus providers.grafana.allowedHosts der Konfiguration.
 * Kein Port, keine Zugangsdaten in der URL, kein Teilstring-Vergleich.
 */
export function baseUrl(params: Record<string, unknown>, cfg?: ProviderConfig): string {
  const raw = requireString(ID, params, "baseUrl");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError(ID, null, 'Parameter "baseUrl" ist keine gueltige URL');
  }
  if (u.protocol !== "https:") throw new ProviderError(ID, null, 'Parameter "baseUrl" muss mit https:// beginnen');
  if (u.username || u.password) throw new ProviderError(ID, null, 'Parameter "baseUrl" darf keine Zugangsdaten enthalten');
  if (u.port) throw new ProviderError(ID, null, 'Parameter "baseUrl" darf keinen Port enthalten');
  const host = u.hostname.toLowerCase();
  const allowed = (cfg?.grafana.allowedHosts ?? []).map((h) => h.toLowerCase());
  const cloud = host.length > ".grafana.net".length && host.endsWith(".grafana.net");
  if (!cloud && !allowed.includes(host)) {
    throw new ProviderError(ID, null, `Host "${host}" ist nicht erlaubt: nur *.grafana.net oder providers.grafana.allowedHosts in der Konfiguration`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

const SERVICE_ACCOUNT_ROLES = ["Viewer", "Editor", "Admin"] as const;
const SERVICE_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;

const specs: ParamSpec[] = [
  {
    key: "baseUrl",
    label: "Grafana-Adresse",
    labelEn: "Grafana URL",
    type: "url",
    required: true,
    help: "Adresse der Instanz, zum Beispiel https://<stack>.grafana.net. Andere Hosts muessen in der Konfiguration erlaubt sein.",
    helpEn: "Address of the instance, for example https://<stack>.grafana.net. Other hosts must be allowed in the configuration.",
    integrationDefault: true,
  },
  {
    key: "serviceAccountId",
    label: "Service-Account",
    labelEn: "Service account",
    type: "integer",
    // Either this or serviceAccountName: with a name the account is found or created when the token is issued.
    required: false,
    help: "Service-Account, dem der Token gehoert. Wird aus der Instanz gelesen. Leer lassen und unten einen Namen setzen, damit er bei Bedarf angelegt wird.",
    helpEn: "Service account the token belongs to. Read from the instance. Leave empty and set a name below to have it created when needed.",
    discover: "grafana.serviceAccount",
  },
  {
    key: "serviceAccountName",
    label: "Name des Service-Accounts",
    labelEn: "Service account name",
    type: "string",
    required: false,
    pattern: SERVICE_ACCOUNT_NAME.source,
    help: "Nur ohne Service-Account: secret-desk sucht ein Konto mit diesem Namen und legt es an, wenn es fehlt.",
    helpEn: "Only without a service account: secret-desk looks for an account with this name and creates it if it is missing.",
  },
  {
    key: "serviceAccountRole",
    label: "Rolle des neuen Service-Accounts",
    labelEn: "Role of the new service account",
    type: "enum",
    required: false,
    options: SERVICE_ACCOUNT_ROLES.map((r) => ({ value: r, label: r, labelEn: r })),
    defaultValue: "Viewer",
    help: "Gilt nur, wenn der Service-Account neu angelegt wird. Ein vorhandenes Konto behaelt seine Rolle.",
    helpEn: "Applies only when the service account is created. An existing account keeps its role.",
  },
];

// ---------------------------------------------------------------------------
// Stack API, with the Grafana Cloud API as the way around a stack token that may not do it
// ---------------------------------------------------------------------------

/** The Cloud API host is fixed: the connection token never goes to a host taken from the inventory. */
const GRAFANA_COM_ROOT = "https://grafana.com/api";
const CLOUD_CONNECTION = "grafana-cloud";

const isNotConnected = (err: unknown): boolean => err instanceof Error && err.name === "NotConnectedError";
const isDenied = (err: unknown): boolean => err instanceof ProviderError && (err.status === 401 || err.status === 403);

/**
 * The Cloud API route to the stack's own API: `https://grafana.com/api/instances/<stack>` + the stack path. Only for a
 * `<stack>.grafana.net` address without a path prefix; the slug is the host's first label. From memory of the Grafana Cloud
 * API (the stack service account endpoints): not verified live.
 */
export function cloudProxyBase(base: string): string | null {
  const u = new URL(base);
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".grafana.net") || (u.pathname !== "/" && u.pathname !== "")) return null;
  const slug = host.slice(0, -".grafana.net".length);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? `${GRAFANA_COM_ROOT}/instances/${slug}` : null;
}

type StackCtx = Pick<CallContext, "fetch" | "connections"> & { providerConfig?: ProviderConfig | undefined };

/**
 * A call to the stack API with the `grafana` connection. When that connection is missing or the stack refuses it (401/403),
 * the same call goes through the Cloud API with the `grafana-cloud` connection, if there is one and the address is a Cloud
 * stack. A refused call has changed nothing, so repeating it is safe. Without the second way the first error stays.
 */
async function stackCall<T>(ctx: StackCtx, params: Record<string, unknown>, path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<T | undefined> {
  const base = baseUrl(params, ctx.providerConfig);
  try {
    return await callWithToken<T>(ID, ctx, "grafana", `${base}${path}`, init);
  } catch (err) {
    if (!isNotConnected(err) && !isDenied(err)) throw err;
    const proxy = cloudProxyBase(base);
    if (!proxy) throw err;
    try {
      return await callWithToken<T>(ID, ctx, CLOUD_CONNECTION, `${proxy}${path}`, init);
    } catch (inner) {
      if (isNotConnected(inner)) throw err;
      throw inner;
    }
  }
}

/** The same for a check that does not throw on a status: the stack first, the Cloud API when the stack cannot answer. */
async function probeStack(ctx: VerifyContext, params: Record<string, unknown>, path: string): Promise<Reply> {
  const base = baseUrl(params, ctx.providerConfig);
  let first: Reply | undefined;
  let firstError: unknown;
  try {
    first = await probeWithConnection(ID, ctx, "grafana", `${base}${path}`);
    if (first.status !== 401 && first.status !== 403) return first;
  } catch (err) {
    if (!isNotConnected(err)) throw err;
    firstError = err;
  }
  const proxy = cloudProxyBase(base);
  const keep = (): Reply => {
    if (first) return first;
    throw firstError;
  };
  if (!proxy) return keep();
  try {
    return await probeWithConnection(ID, ctx, CLOUD_CONNECTION, `${proxy}${path}`);
  } catch (err) {
    if (isNotConnected(err)) return keep();
    throw err;
  }
}

/** An external id made of the account and the token (`7:42`) keeps verify and revoke working when the account came from a name. */
function splitExternalId(externalId: string | undefined): { accountId: number | null; tokenId: string } {
  const m = /^(\d{1,12}):(.+)$/.exec(externalId ?? "");
  return m ? { accountId: Number(m[1]), tokenId: m[2]! } : { accountId: null, tokenId: externalId ?? "" };
}

function accountIdOf(params: Record<string, unknown>, externalId?: string): number {
  const fromId = splitExternalId(externalId).accountId;
  if (fromId !== null) return fromId;
  const v = params["serviceAccountId"];
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  throw new ProviderError(ID, null, 'Parameter "serviceAccountId" muss eine positive ganze Zahl sein');
}

const hasAccountId = (params: Record<string, unknown>): boolean => typeof params["serviceAccountId"] === "number";

function nameAndRole(params: Record<string, unknown>): { name: string; role: string } {
  const name = optionalString(ID, params, "serviceAccountName");
  if (!name) throw new ProviderError(ID, null, 'Parameter "serviceAccountId" oder "serviceAccountName" fehlt');
  if (!SERVICE_ACCOUNT_NAME.test(name)) throw new ProviderError(ID, null, 'Parameter "serviceAccountName" hat nicht das erwartete Format');
  const role = optionalString(ID, params, "serviceAccountRole") ?? "Viewer";
  if (!(SERVICE_ACCOUNT_ROLES as readonly string[]).includes(role)) throw new ProviderError(ID, null, 'Parameter "serviceAccountRole" muss Viewer, Editor oder Admin sein');
  return { name, role };
}

async function findServiceAccount(ctx: StackCtx, params: Record<string, unknown>, name: string): Promise<number | null> {
  const r = await stackCall<unknown>(ctx, params, `/api/serviceaccounts/search?perpage=100&query=${seg(name)}`, { method: "GET" });
  const hit = asList(r, "serviceAccounts").find((a) => a["name"] === name && typeof a["id"] === "number");
  return hit ? (hit["id"] as number) : null;
}

/**
 * The service account a token is issued for: the given id, or the account with the given name, created when it does not exist
 * (`POST /api/serviceaccounts` with name, role, isDisabled). A create that the stack answers with 409 (the account exists but
 * the search did not show it, as with a token that may not read) is looked up once more through the Cloud API.
 */
async function resolveServiceAccount(ctx: StackCtx, params: Record<string, unknown>): Promise<{ id: number; byName: boolean }> {
  if (hasAccountId(params)) return { id: accountIdOf(params), byName: false };
  const { name, role } = nameAndRole(params);
  const found = await findServiceAccount(ctx, params, name);
  if (found !== null) return { id: found, byName: true };
  try {
    const created = await stackCall<{ id?: number }>(ctx, params, "/api/serviceaccounts", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, role, isDisabled: false }) });
    if (!created || typeof created.id !== "number") throw badResponse(ID);
    return { id: created.id, byName: true };
  } catch (err) {
    if (!(err instanceof ProviderError) || err.status !== 409) throw err;
    const proxy = cloudProxyBase(baseUrl(params, ctx.providerConfig));
    if (proxy) {
      try {
        const r = await callWithToken<unknown>(ID, ctx, CLOUD_CONNECTION, `${proxy}/api/serviceaccounts/search?perpage=100&query=${seg(name)}`, { method: "GET" });
        const hit = asList(r, "serviceAccounts").find((a) => a["name"] === name && typeof a["id"] === "number");
        if (hit) return { id: hit["id"] as number, byName: true };
      } catch {
        // the original conflict is the better message
      }
    }
    throw err;
  }
}

async function listServiceAccounts(ctx: StackCtx, params: Record<string, unknown>): Promise<DiscoveredOption[]> {
  const r = await stackCall<unknown>(ctx, params, "/api/serviceaccounts/search?perpage=100", { method: "GET" });
  return asList(r, "serviceAccounts").flatMap((a) => (typeof a["id"] === "number" ? [{ value: a["id"], label: str(a["name"]) ?? String(a["id"]), detail: [str(a["login"]), str(a["role"])].filter(Boolean).join(", ") }] : []));
}

async function preflightGrafana(ctx: PreflightContext): Promise<PreflightResult> {
  const findings: PreflightFinding[] = [];
  let base: string;
  try {
    base = baseUrl(ctx.params, ctx.providerConfig);
  } catch (err) {
    return { resource: null, findings: [{ id: "baseUrl", level: "fail", label: err instanceof ProviderError ? err.message : "Adresse ungueltig" }] };
  }
  let resource: string | null = `Grafana ${base}`;
  try {
    const res = await ctx.fetch(`${base}/api/health`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    findings.push(res.ok ? { id: "reachable", level: "ok", label: `Die Instanz ${base} ist erreichbar` } : { id: "reachable", level: "warn", label: `Die Instanz ${base} antwortet mit HTTP ${res.status}` });
  } catch {
    findings.push({ id: "reachable", level: "fail", label: `Die Instanz ${base} ist nicht erreichbar` });
    return { resource, findings };
  }
  try {
    const accounts = await listServiceAccounts(ctx, ctx.params);
    if (!hasAccountId(ctx.params)) {
      const wanted = optionalString(ID, ctx.params, "serviceAccountName");
      if (!wanted) findings.push({ id: "serviceAccount", level: "fail", label: "Service-Account fehlt: serviceAccountId oder serviceAccountName angeben" });
      else if (accounts.some((a) => a.label === wanted)) {
        resource = `Grafana-Service-Account ${wanted} (${base})`;
        findings.push({ id: "serviceAccount", level: "ok", label: `Der Service-Account ${wanted} existiert` });
      } else findings.push({ id: "serviceAccount", level: "ok", label: `Der Service-Account ${wanted} wird beim Ausstellen angelegt`, detail: `Rolle ${optionalString(ID, ctx.params, "serviceAccountRole") ?? "Viewer"}` });
      return { resource, findings };
    }
    const hit = accounts.find((a) => String(a.value) === String(ctx.params["serviceAccountId"]));
    if (hit) {
      resource = `Grafana-Service-Account ${hit.label} (${base})`;
      findings.push({ id: "serviceAccount", level: "ok", label: `Der Service-Account ${hit.label} existiert` });
    } else if (accounts.length > 0) findings.push({ id: "serviceAccount", level: "fail", label: `Der Service-Account ${String(ctx.params["serviceAccountId"])} existiert in der Instanz nicht`, detail: `Verfuegbar: ${accounts.map((a) => a.label).join(", ")}` });
    else findings.push({ id: "serviceAccount", level: "warn", label: "Die Instanz liefert keine Service-Accounts: Zuordnung nicht pruefbar" });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    findings.push(readFailure(err, "Service-Accounts"));
  }
  return { resource, findings };
}

export const grafanaProvider: Provider = {
  id: ID,
  label: "Grafana Service-Account-Token",
  kind: "automatic",
  connection: "grafana",
  params: specs,
  async discover(kind: string, ctx: DiscoverContext) {
    if (kind !== "grafana.serviceAccount") return unknownKind(kind);
    return listServiceAccounts(ctx, ctx.params);
  },
  preflight: preflightGrafana,
  async issue(ctx) {
    const ttl = ctx.secret.ttlDays ?? SERVICE_ACCOUNT_TOKEN_DEFAULT_TTL_DAYS;
    baseUrl(ctx.params, ctx.providerConfig);
    const account = await resolveServiceAccount(ctx, ctx.params);
    const res = await stackCall<{ id?: number; key?: string }>(ctx, ctx.params, `/api/serviceaccounts/${account.id}/tokens`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: ctx.label, secondsToLive: ttl * 86_400 }),
    });
    if (!res || typeof res.key !== "string" || res.id === undefined) throw badResponse(ID);
    // An account that came from a name is not in the entry's parameters: the external id carries it for verify and revoke.
    return { value: new SecretValue(res.key), externalId: account.byName ? `${account.id}:${res.id}` : String(res.id), expiresAt: expiryFrom(ctx.now, ttl) ?? null };
  },
  verify(ctx) {
    return step(ctx, "exists", "Token beim Anbieter", async () => {
      baseUrl(ctx.params, ctx.providerConfig);
      const accountId = accountIdOf(ctx.params, ctx.externalId);
      const tokenId = splitExternalId(ctx.externalId).tokenId;
      const r = await probeStack(ctx, ctx.params, `/api/serviceaccounts/${accountId}/tokens`);
      const list = Array.isArray(r.json) ? r.json.filter(isRecord) : undefined;
      if (r.status < 200 || r.status >= 300 || !list) return [check("exists", "Token beim Anbieter", "warn", { actual: `HTTP ${r.status}`, detail: "Tokenliste nicht lesbar" })];
      const entry = list.find((t) => String(t["id"]) === tokenId);
      if (!tokenId || !entry) return [check("exists", "Token beim Anbieter", "fail", { expected: tokenId || "Kennung", actual: "nicht in der Liste" })];
      const out: Check[] = [check("exists", "Token beim Anbieter", "pass", { actual: `Kennung ${tokenId}` })];
      out.push(check("valid", "Token ist nicht abgelaufen", entry["hasExpired"] === false ? "pass" : "fail", { expected: "hasExpired false", actual: `hasExpired ${String(entry["hasExpired"])}` }));
      const actual = typeof entry["expiration"] === "string" ? entry["expiration"] : undefined;
      const expected = ctx.expiresAt ?? undefined;
      if (actual && expected) {
        const d = daysApart(actual, expected);
        out.push(check("expires", "Ablauf des Tokens", Number.isNaN(d) || d > 1 ? "warn" : "pass", { expected: day(expected), actual: day(actual) }));
      } else if (expected) {
        out.push(check("expires", "Ablauf des Tokens", "warn", { expected: day(expected), actual: "kein Ablauf", detail: "Der Token laeuft entgegen der Vorgabe nie ab" }));
      } else {
        out.push(check("expires", "Ablauf des Tokens", "info", { actual: actual ? day(actual) : "kein Ablauf" }));
      }
      return out;
    });
  },
  reviewChecklist(secret) {
    const acc = secret.params["serviceAccountId"] ?? secret.params["serviceAccountName"];
    return [
      acc ? `Der Token gehoert zum Service-Account ${String(acc)}` : "Der Token gehoert zum vorgesehenen Service-Account",
      "Die Rolle des Service-Accounts ist so klein wie moeglich",
      secret.ttlDays ? `Ablauf ist ${secret.ttlDays} Tage nach heute` : `Ablauf ist ${SERVICE_ACCOUNT_TOKEN_DEFAULT_TTL_DAYS} Tage nach heute (Standard)`,
    ];
  },
  async revoke(ctx) {
    baseUrl(ctx.params, ctx.providerConfig);
    const accountId = accountIdOf(ctx.params, ctx.externalId);
    await revokeIdempotent(() => stackCall(ctx, ctx.params, `/api/serviceaccounts/${accountId}/tokens/${seg(splitExternalId(ctx.externalId).tokenId)}`, { method: "DELETE" }));
  },
};

// ---------------------------------------------------------------------------
// Grafana Cloud access policy tokens (grafana.com API, not a stack)
// ---------------------------------------------------------------------------

const POLICY_ID = "grafana-access-policy-token";
const POLICY_CONNECTION = "grafana-cloud";
/** The Cloud API host is fixed: the connection token never goes to a host taken from the inventory. */
const GRAFANA_COM = "https://www.grafana.com/api/v1";
const POLICY_TTL_DEFAULT = 90;
/** A service account token never expires without `secondsToLive`: the expiry is always set, 90 days by default. */
const SERVICE_ACCOUNT_TOKEN_DEFAULT_TTL_DAYS = 90;

const policySpecs: ParamSpec[] = [
  {
    key: "region",
    label: "Region",
    labelEn: "Region",
    type: "string",
    required: true,
    pattern: "^[a-z0-9][a-z0-9-]{1,39}$",
    help: "Region der Zugriffsrichtlinie, zum Beispiel us oder eu (steht in den Details der Richtlinie bei grafana.com).",
    helpEn: "Region of the access policy, for example us or eu (shown in the policy details at grafana.com).",
    integrationDefault: true,
  },
  {
    key: "accessPolicyId",
    label: "Zugriffsrichtlinie",
    labelEn: "Access policy",
    type: "string",
    required: true,
    help: "Richtlinie, der der Token gehoert. Wird aus Grafana Cloud gelesen.",
    helpEn: "Access policy the token belongs to. Read from Grafana Cloud.",
    discover: "grafana.accessPolicy",
  },
];

function policyRegion(params: Record<string, unknown>): string {
  const region = requireString(POLICY_ID, params, "region");
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(region)) throw new ProviderError(POLICY_ID, null, 'Parameter "region" ist keine gueltige Region (nur Kleinbuchstaben, Ziffern und Bindestrich)');
  return region;
}

const policiesUrl = (region: string): string => `${GRAFANA_COM}/accesspolicies?region=${seg(region)}`;

async function listAccessPolicies(ctx: Pick<DiscoverContext, "connections" | "fetch">, params: Record<string, unknown>): Promise<DiscoveredOption[]> {
  const region = policyRegion({ region: needParam(policySpecs, params, "region") });
  // Response shape ({ items: [{ id, name, displayName, scopes }] }) is from memory of the API: not verified live.
  const r = await getJson<unknown>(POLICY_ID, ctx, POLICY_CONNECTION, policiesUrl(region));
  return asList(r, "items").flatMap((a) => {
    const id = str(a["id"]);
    return id ? [{ value: id, label: str(a["displayName"]) ?? str(a["name"]) ?? id, detail: Array.isArray(a["scopes"]) ? a["scopes"].filter((x) => typeof x === "string").join(", ") : "" }] : [];
  });
}

function policyTtl(ttlDays: number | undefined): number {
  return ttlDays && ttlDays > 0 ? ttlDays : POLICY_TTL_DEFAULT;
}

export const grafanaAccessPolicyProvider: Provider = {
  id: POLICY_ID,
  label: "Grafana Cloud Access-Policy-Token (nicht live verifiziert)",
  kind: "automatic",
  connection: POLICY_CONNECTION,
  params: policySpecs,
  async discover(kind: string, ctx: DiscoverContext) {
    if (kind !== "grafana.accessPolicy") return unknownKind(kind);
    return listAccessPolicies(ctx, ctx.params);
  },
  async preflight(ctx: PreflightContext): Promise<PreflightResult> {
    const findings: PreflightFinding[] = [];
    let resource: string | null = null;
    try {
      const policies = await listAccessPolicies(ctx, ctx.params);
      const id = String(ctx.params["accessPolicyId"]);
      const hit = policies.find((p) => String(p.value) === id);
      if (hit) {
        resource = `Grafana-Zugriffsrichtlinie ${hit.label}`;
        findings.push({ id: "accessPolicy", level: "ok", label: `Die Zugriffsrichtlinie ${hit.label} existiert` });
      } else if (policies.length > 0) findings.push({ id: "accessPolicy", level: "fail", label: `Die Zugriffsrichtlinie ${id} existiert in der Region nicht`, detail: `Verfuegbar: ${policies.map((p) => p.label).join(", ")}` });
      else findings.push({ id: "accessPolicy", level: "warn", label: "Die Region liefert keine Zugriffsrichtlinien: Zuordnung nicht pruefbar" });
    } catch (err) {
      if (err instanceof Error && err.name === "NotConnectedError") throw err;
      findings.push(readFailure(err, "Zugriffsrichtlinien"));
    }
    return { resource, findings };
  },
  async issue(ctx) {
    const region = policyRegion(ctx.params);
    const policyId = requireString(POLICY_ID, ctx.params, "accessPolicyId");
    const ttl = policyTtl(ctx.secret.ttlDays);
    const expiresAt = expiryFrom(ctx.now, ttl)!;
    // Request shape (POST /tokens?region=, body accessPolicyId, name, displayName, expiresAt) is from memory: not verified live.
    const res = await callWithToken<{ id?: string; token?: string; expiresAt?: string }>(POLICY_ID, ctx, POLICY_CONNECTION, `${GRAFANA_COM}/tokens?region=${seg(region)}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accessPolicyId: policyId, name: ctx.label, displayName: ctx.label, expiresAt }),
    });
    if (!res || typeof res.token !== "string" || typeof res.id !== "string") throw badResponse(POLICY_ID);
    return { value: new SecretValue(res.token), externalId: res.id, expiresAt: typeof res.expiresAt === "string" ? res.expiresAt : expiresAt };
  },
  verify(ctx) {
    return step(ctx, "works", "Token funktioniert", async () => {
      const region = policyRegion(ctx.params);
      const out: Check[] = [];
      // A token whose policy may not read access policies (for example metrics:read only) cannot probe the policy list: Grafana
      // answers 401 for it, which would look like a rejected token. Then the token is checked through the connection instead:
      // it must exist at Grafana Cloud under its id. The policy list and the token come from the connection, never the new value.
      const policyId = String(ctx.params["accessPolicyId"] ?? "");
      const policies = await listAccessPolicies(ctx, ctx.params).catch(() => null);
      const hit = policies?.find((p) => String(p.value) === policyId);
      const scopes = hit?.detail ?? "";
      const canReadPolicies = hit ? scopes.split(", ").includes("accesspolicies:read") : true;
      if (!canReadPolicies) {
        const id = ctx.externalId;
        const found = id ? await getJson<{ id?: string }>(POLICY_ID, ctx, POLICY_CONNECTION, `${GRAFANA_COM}/tokens/${seg(id)}?region=${seg(region)}`).catch(() => undefined) : undefined;
        if (found && found.id === id) out.push(check("works", "Token funktioniert", "pass", { actual: "Token bei Grafana Cloud vorhanden", detail: `Geltungsbereich ${scopes}: der Token selbst kann keine Richtlinien lesen, geprueft ueber die Verbindung` }));
        else out.push(check("works", "Token funktioniert", "info", { actual: "nicht pruefbar", detail: `Geltungsbereich ${scopes}: der Token selbst kann keine Richtlinien lesen, und die Verbindung fand ihn nicht` }));
        const expected = ctx.expiresAt ?? undefined;
        out.push(check("expires", "Ablauf des Tokens", "info", { actual: expected ? day(expected) : "kein Ablauf" }));
        return out;
      }
      const r = await probeWithValue(POLICY_ID, ctx, policiesUrl(region));
      if (r.status >= 200 && r.status < 300) out.push(check("works", "Token funktioniert", "pass", { actual: `HTTP ${r.status}` }));
      else if (r.status === 401) out.push(check("works", "Token funktioniert", "fail", { actual: "HTTP 401", detail: "Grafana Cloud lehnt den Token ab" }));
      else if (r.status === 403) out.push(check("works", "Token funktioniert", "info", { actual: "HTTP 403", detail: "Mit diesem Geltungsbereich nicht pruefbar: der Token ist gueltig, darf diese Abfrage aber nicht" }));
      else out.push(check("works", "Token funktioniert", "info", { actual: `HTTP ${r.status}`, detail: "Mit diesem Geltungsbereich nicht pruefbar" }));
      const expected = ctx.expiresAt ?? undefined;
      out.push(check("expires", "Ablauf des Tokens", "info", { actual: expected ? day(expected) : "kein Ablauf" }));
      return out;
    });
  },
  reviewChecklist(secret) {
    const policy = secret.params["accessPolicyId"];
    return [
      policy ? `Der Token gehoert zur Zugriffsrichtlinie ${String(policy)}` : "Der Token gehoert zur vorgesehenen Zugriffsrichtlinie",
      "Die Geltungsbereiche der Zugriffsrichtlinie sind so klein wie moeglich",
      `Ablauf ist ${policyTtl(secret.ttlDays)} Tage nach heute`,
    ];
  },
  async revoke(ctx) {
    const region = policyRegion(ctx.params);
    await revokeIdempotent(() => callWithToken(POLICY_ID, ctx, POLICY_CONNECTION, `${GRAFANA_COM}/tokens/${seg(ctx.externalId)}?region=${seg(region)}`, { method: "DELETE" }));
  },
};

export const grafanaProviders: Provider[] = [grafanaProvider, grafanaAccessPolicyProvider];
