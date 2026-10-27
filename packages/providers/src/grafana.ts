import { SecretValue, type Provider } from "@secret-desk/core";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireInt, requireString, seg } from "./http.js";

const ID = "grafana-service-account-token";

function baseUrl(params: Record<string, unknown>): string {
  const raw = requireString(ID, params, "baseUrl");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError(ID, null, 'Parameter "baseUrl" ist keine gueltige URL');
  }
  if (u.protocol !== "https:") throw new ProviderError(ID, null, 'Parameter "baseUrl" muss mit https:// beginnen');
  return raw.replace(/\/+$/, "");
}

export const grafanaProvider: Provider = {
  id: ID,
  label: "Grafana Service-Account-Token",
  kind: "automatic",
  connection: "grafana",
  async issue(ctx) {
    const base = baseUrl(ctx.params);
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
  async revoke(ctx) {
    const base = baseUrl(ctx.params);
    const accountId = requireInt(ID, ctx.params, "serviceAccountId");
    await callWithToken(ID, ctx, "grafana", `${base}/api/serviceaccounts/${accountId}/tokens/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

export const grafanaProviders: Provider[] = [grafanaProvider];
