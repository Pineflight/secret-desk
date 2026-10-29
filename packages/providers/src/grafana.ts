import { SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider, type ProviderConfig } from "@secret-desk/core";
import { asList, getJson, readFailure, str, unknownKind } from "./discover.js";
import { check, daysApart, day, isRecord, probeWithConnection, step } from "./checks.js";
import { TIMEOUT_MS, badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireInt, requireString, revokeIdempotent, seg } from "./http.js";

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
    required: true,
    help: "Service-Account, dem der Token gehoert. Wird aus der Instanz gelesen.",
    helpEn: "Service account the token belongs to. Read from the instance.",
    discover: "grafana.serviceAccount",
  },
];

async function listServiceAccounts(ctx: Pick<DiscoverContext, "connections" | "fetch" | "providerConfig">, params: Record<string, unknown>): Promise<DiscoveredOption[]> {
  const base = baseUrl(params, ctx.providerConfig);
  const r = await getJson<unknown>(ID, ctx, "grafana", `${base}/api/serviceaccounts/search?perpage=100`);
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
    const base = baseUrl(ctx.params, ctx.providerConfig);
    const accountId = requireInt(ID, ctx.params, "serviceAccountId");
    const ttl = ctx.secret.ttlDays;
    const res = await callWithToken<{ id?: number; key?: string }>(ID, ctx, "grafana", `${base}/api/serviceaccounts/${accountId}/tokens`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: ctx.label, ...(ttl ? { secondsToLive: ttl * 86_400 } : {}) }),
    });
    if (!res || typeof res.key !== "string" || res.id === undefined) throw badResponse(ID);
    return { value: new SecretValue(res.key), externalId: String(res.id), expiresAt: expiryFrom(ctx.now, ttl) ?? null };
  },
  verify(ctx) {
    return step(ctx, "exists", "Token beim Anbieter", async () => {
      const base = baseUrl(ctx.params, ctx.providerConfig);
      const accountId = requireInt(ID, ctx.params, "serviceAccountId");
      const r = await probeWithConnection(ID, ctx, "grafana", `${base}/api/serviceaccounts/${accountId}/tokens`);
      const list = Array.isArray(r.json) ? r.json.filter(isRecord) : undefined;
      if (r.status < 200 || r.status >= 300 || !list) return [check("exists", "Token beim Anbieter", "warn", { actual: `HTTP ${r.status}`, detail: "Tokenliste nicht lesbar" })];
      const entry = list.find((t) => String(t["id"]) === ctx.externalId);
      if (!ctx.externalId || !entry) return [check("exists", "Token beim Anbieter", "fail", { expected: ctx.externalId ?? "Kennung", actual: "nicht in der Liste" })];
      const out: Check[] = [check("exists", "Token beim Anbieter", "pass", { actual: `Kennung ${ctx.externalId}` })];
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
    const acc = secret.params["serviceAccountId"];
    return [
      acc ? `Der Token gehoert zum Service-Account ${String(acc)}` : "Der Token gehoert zum vorgesehenen Service-Account",
      "Die Rolle des Service-Accounts ist so klein wie moeglich",
      secret.ttlDays ? `Ablauf ist ${secret.ttlDays} Tage nach heute` : "Ablauf ist wie vorgesehen gesetzt",
    ];
  },
  async revoke(ctx) {
    const base = baseUrl(ctx.params, ctx.providerConfig);
    const accountId = requireInt(ID, ctx.params, "serviceAccountId");
    await revokeIdempotent(() => callWithToken(ID, ctx, "grafana", `${base}/api/serviceaccounts/${accountId}/tokens/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

export const grafanaProviders: Provider[] = [grafanaProvider];
