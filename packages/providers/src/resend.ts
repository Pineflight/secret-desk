import { SecretValue, type Provider } from "@secret-desk/core";
import { badResponse, callWithToken, JSON_HEADERS, optionalString, ProviderError, seg } from "./http.js";

const API = "https://api.resend.com/api-keys";
const ID = "resend-api-key";

export const resendProvider: Provider = {
  id: ID,
  label: "Resend API-Key",
  kind: "automatic",
  connection: "resend",
  async issue(ctx) {
    const permission = ctx.params["permission"] ?? "sending_access";
    if (permission !== "sending_access" && permission !== "full_access") {
      throw new ProviderError(ID, null, 'Parameter "permission" muss "sending_access" oder "full_access" sein');
    }
    const domainId = optionalString(ID, ctx.params, "domainId");
    const res = await callWithToken<{ id?: string; token?: string }>(ID, ctx, "resend", API, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: ctx.label, permission, ...(domainId ? { domain_id: domainId } : {}) }),
    });
    if (!res || typeof res.token !== "string" || typeof res.id !== "string") throw badResponse(ID);
    return { value: new SecretValue(res.token), externalId: res.id, expiresAt: null };
  },
  async revoke(ctx) {
    await callWithToken(ID, ctx, "resend", `${API}/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

export const resendProviders: Provider[] = [resendProvider];
