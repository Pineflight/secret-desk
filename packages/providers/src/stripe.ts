import { SecretValue, type Provider } from "@secret-desk/core";
import { badResponse, callWithToken, optionalString, requireString, requireStringArray, seg } from "./http.js";

const API = "https://api.stripe.com/v1/webhook_endpoints";
const ID = "stripe-webhook-secret";

function connectionOf(params: Record<string, unknown>): string {
  return optionalString(ID, params, "connection") ?? "stripe";
}

export const stripeWebhookProvider: Provider = {
  id: ID,
  label: "Stripe Webhook-Secret",
  kind: "automatic",
  connection: "stripe",
  async issue(ctx) {
    const url = requireString(ID, ctx.params, "url");
    const events = requireStringArray(ID, ctx.params, "events");
    const form = new URLSearchParams();
    form.append("url", url);
    for (const e of events) form.append("enabled_events[]", e);
    const res = await callWithToken<{ id?: string; secret?: string }>(ID, ctx, connectionOf(ctx.params), API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res || typeof res.secret !== "string" || typeof res.id !== "string") throw badResponse(ID);
    return { value: new SecretValue(res.secret), externalId: res.id, expiresAt: null };
  },
  async revoke(ctx) {
    await callWithToken(ID, ctx, connectionOf(ctx.params), `${API}/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

export const stripeProviders: Provider[] = [stripeWebhookProvider];
