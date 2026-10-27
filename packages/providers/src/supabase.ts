import { SecretValue, type Provider } from "@secret-desk/core";
import { badResponse, callWithToken, JSON_HEADERS, ProviderError, requireString, seg } from "./http.js";

const API = "https://api.supabase.com";

interface ApiKey {
  id?: string;
  name?: string;
  api_key?: string;
}

const apiKeyProvider: Provider = {
  id: "supabase-api-key",
  label: "Supabase API-Key (experimentell, Endpunkt-Form nicht verifiziert)",
  kind: "automatic",
  connection: "supabase",
  async issue(ctx) {
    const id = "supabase-api-key";
    const ref = requireString(id, ctx.params, "projectRef");
    const type = ctx.params["type"] ?? "secret";
    if (type !== "secret" && type !== "publishable") throw new ProviderError(id, null, 'Parameter "type" muss "secret" oder "publishable" sein');
    const res = await callWithToken<ApiKey>(id, ctx, "supabase", `${API}/v1/projects/${seg(ref)}/api-keys?reveal=true`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type, name: ctx.label }),
    });
    if (!res || typeof res.api_key !== "string" || typeof res.id !== "string") throw badResponse(id);
    return { value: new SecretValue(res.api_key), externalId: res.id, expiresAt: null };
  },
  async revoke(ctx) {
    const id = "supabase-api-key";
    const ref = requireString(id, ctx.params, "projectRef");
    await callWithToken(id, ctx, "supabase", `${API}/v1/projects/${seg(ref)}/api-keys/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

const serviceRoleProvider: Provider = {
  id: "supabase-service-role",
  label: "Supabase service_role (nur lesen)",
  kind: "automatic",
  connection: "supabase",
  async issue(ctx) {
    const id = "supabase-service-role";
    const ref = requireString(id, ctx.params, "projectRef");
    const res = await callWithToken<ApiKey[]>(id, ctx, "supabase", `${API}/v1/projects/${seg(ref)}/api-keys?reveal=true`, { method: "GET" });
    if (!Array.isArray(res)) throw badResponse(id);
    const entry = res.find((k) => k.name === "service_role");
    if (!entry || typeof entry.api_key !== "string") throw new ProviderError(id, null, 'Kein Schluessel "service_role" im Projekt gefunden');
    return { value: new SecretValue(entry.api_key), expiresAt: null };
  },
};

export const supabaseProviders: Provider[] = [apiKeyProvider, serviceRoleProvider];
