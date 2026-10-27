import { SecretValue, type Check, type Provider, type ProviderConfig } from "@secret-desk/core";
import { check, daysApart, day, isRecord, probeWithConnection, step } from "./checks.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireInt, requireString, seg } from "./http.js";

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

export const grafanaProvider: Provider = {
  id: ID,
  label: "Grafana Service-Account-Token",
  kind: "automatic",
  connection: "grafana",
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
    await callWithToken(ID, ctx, "grafana", `${base}/api/serviceaccounts/${accountId}/tokens/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

export const grafanaProviders: Provider[] = [grafanaProvider];
