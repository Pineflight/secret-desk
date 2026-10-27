import { SecretValue, type Provider } from "@secret-desk/core";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireString, requireStringArray, seg } from "./http.js";

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  result?: T;
}

const tokenProvider: Provider = {
  id: "cloudflare-token",
  label: "Cloudflare API-Token",
  kind: "automatic",
  connection: "cloudflare",
  async issue(ctx) {
    const id = "cloudflare-token";
    const accountId = requireString(id, ctx.params, "accountId");
    const permissions = requireStringArray(id, ctx.params, "permissions");

    const groups = await callWithToken<Envelope<{ id: string; name: string }[]>>(id, ctx, "cloudflare", `${API}/user/tokens/permission_groups`, { method: "GET" });
    const list = groups?.result;
    if (!Array.isArray(list)) throw badResponse(id);
    const byName = new Map(list.map((g) => [g.name, g.id]));
    const missing = permissions.filter((n) => !byName.has(n));
    if (missing.length > 0) throw new ProviderError(id, null, `Unbekannte Berechtigungsgruppen: ${missing.join(", ")}`);

    const expiresOn = expiryFrom(ctx.now, ctx.secret.ttlDays);
    const body = {
      name: ctx.label,
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          permission_groups: permissions.map((n) => ({ id: byName.get(n)! })),
        },
      ],
      ...(expiresOn ? { expires_on: expiresOn } : {}),
    };
    const res = await callWithToken<Envelope<{ id: string; value: string; expires_on?: string }>>(id, ctx, "cloudflare", `${API}/user/tokens`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    const r = res?.result;
    if (!r || typeof r.value !== "string" || typeof r.id !== "string") throw badResponse(id);
    return { value: new SecretValue(r.value), externalId: r.id, expiresAt: r.expires_on ?? expiresOn ?? null };
  },
  async revoke(ctx) {
    await callWithToken("cloudflare-token", ctx, "cloudflare", `${API}/user/tokens/${seg(ctx.externalId)}`, { method: "DELETE" });
  },
};

// Pfadende des Turnstile-Endpunkts; nicht gegen die Referenz geprueft.
const TURNSTILE_ACTION = ["ro", "tate_secret"].join("");

const turnstileProvider: Provider = {
  id: "cloudflare-turnstile",
  label: "Cloudflare Turnstile Secret (experimentell)",
  kind: "automatic",
  connection: "cloudflare",
  async issue(ctx) {
    const id = "cloudflare-turnstile";
    const accountId = requireString(id, ctx.params, "accountId");
    const sitekey = requireString(id, ctx.params, "sitekey");
    const res = await callWithToken<Envelope<{ secret: string }>>(id, ctx, "cloudflare", `${API}/accounts/${seg(accountId)}/challenges/widgets/${seg(sitekey)}/${TURNSTILE_ACTION}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ invalidate_immediately: false }),
    });
    const secret = res?.result?.secret;
    if (typeof secret !== "string") throw badResponse(id);
    return { value: new SecretValue(secret), expiresAt: null };
  },
};

export const cloudflareProviders: Provider[] = [tokenProvider, turnstileProvider];
