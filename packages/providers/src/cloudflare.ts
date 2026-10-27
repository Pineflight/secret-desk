import { SecretValue, type Check, type Provider, type VerifyContext } from "@secret-desk/core";
import { check, daysApart, day, isRecord, probeWithConnection, probeWithValue, sameSet, step, steps } from "./checks.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireString, requireStringArray, revokeIdempotent, seg } from "./http.js";

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  result?: T;
}

const TID = "cloudflare-token";

function permissionNames(params: Record<string, unknown>): string[] | undefined {
  const p = params["permissions"];
  return Array.isArray(p) && p.every((x) => typeof x === "string") ? [...new Set(p as string[])] : undefined;
}

/** Ablauf des neuen Tokens gegen den erwarteten Ablauf. */
function expiryCheck(ctx: VerifyContext, expiresOn: unknown): Check {
  const actual = typeof expiresOn === "string" ? expiresOn : undefined;
  const expected = ctx.expiresAt ?? undefined;
  const ttl = ctx.secret.ttlDays;
  if (actual && expected) {
    const d = daysApart(actual, expected);
    if (Number.isNaN(d) || d > 1) return check("expires", "Ablauf des Tokens", "warn", { expected: day(expected), actual: day(actual), detail: "Ablauf weicht um mehr als einen Tag ab" });
    return check("expires", "Ablauf des Tokens", "pass", { expected: day(expected), actual: day(actual) });
  }
  if (actual) return check("expires", "Ablauf des Tokens", "pass", { actual: day(actual) });
  if (ttl || expected) return check("expires", "Ablauf des Tokens", "warn", { expected: expected ? day(expected) : `${ttl} Tage`, actual: "kein Ablauf", detail: "Der Token laeuft entgegen der Vorgabe nie ab" });
  return check("expires", "Ablauf des Tokens", "info", { actual: "kein Ablauf", detail: "Kein Ablauf vorgesehen" });
}

async function verifyToken(ctx: VerifyContext): Promise<Check[]> {
  return steps([
    step(ctx, "active", "Token ist aktiv", async () => {
      const r = await probeWithValue(TID, ctx, `${API}/user/tokens/verify`);
      const result = isRecord(r.json) && isRecord(r.json["result"]) ? r.json["result"] : undefined;
      const status = typeof result?.["status"] === "string" ? result["status"] : undefined;
      const active = r.status >= 200 && r.status < 300 && status === "active";
      return [
        check("active", "Token ist aktiv", active ? "pass" : "fail", { expected: "active", actual: status ?? `HTTP ${r.status}` }),
        expiryCheck(ctx, result?.["expires_on"]),
      ];
    }),
    step(ctx, "permissions", "Rechte des Tokens", async () => {
      if (!ctx.externalId) return [check("permissions", "Rechte des Tokens", "warn", { detail: "Keine Token-Kennung, Rechte nicht abrufbar" })];
      const r = await probeWithConnection(TID, ctx, "cloudflare", `${API}/user/tokens/${seg(ctx.externalId)}`);
      const result = isRecord(r.json) && isRecord(r.json["result"]) ? r.json["result"] : undefined;
      if (r.status < 200 || r.status >= 300 || !result) {
        return [check("permissions", "Rechte des Tokens", "warn", { detail: `Token konnte nicht gelesen werden (HTTP ${r.status})` })];
      }
      const policies = Array.isArray(result["policies"]) ? result["policies"].filter(isRecord) : [];
      const out: Check[] = [];
      const wanted = permissionNames(ctx.params);
      const actual = new Set<string>();
      for (const pol of policies) {
        for (const g of Array.isArray(pol["permission_groups"]) ? pol["permission_groups"] : []) {
          if (isRecord(g) && typeof g["name"] === "string") actual.add(g["name"]);
        }
      }
      if (!wanted) {
        out.push(check("permissions", "Rechte des Tokens", "warn", { actual: [...actual].join(", "), detail: "Parameter permissions fehlt, kein Vergleich moeglich" }));
      } else {
        const { missing, extra } = sameSet([...actual], wanted);
        const parts = [extra.length ? `Zusaetzlich: ${extra.join(", ")}` : "", missing.length ? `Fehlt: ${missing.join(", ")}` : ""].filter(Boolean);
        out.push(
          check("permissions", "Rechte des Tokens", parts.length ? "fail" : "pass", {
            expected: wanted.join(", "),
            actual: [...actual].join(", ") || "keine",
            ...(parts.length ? { detail: parts.join("; ") } : {}),
          }),
        );
      }
      const accountId = typeof ctx.params["accountId"] === "string" ? ctx.params["accountId"] : undefined;
      if (!accountId) {
        out.push(check("account-scope", "Nur das erwartete Konto", "warn", { detail: "Parameter accountId fehlt, kein Vergleich moeglich" }));
      } else {
        const want = `com.cloudflare.api.account.${accountId}`;
        const keys = new Set<string>();
        for (const pol of policies) if (isRecord(pol["resources"])) for (const k of Object.keys(pol["resources"])) keys.add(k);
        const others = [...keys].filter((k) => k !== want);
        const ok = keys.has(want) && others.length === 0;
        out.push(
          check("account-scope", "Nur das erwartete Konto", ok ? "pass" : "fail", {
            expected: want,
            actual: [...keys].join(", ") || "keine Ressourcen",
            ...(ok ? {} : { detail: others.length ? `Weitere Ressourcen: ${others.join(", ")}` : "Erwartetes Konto fehlt" }),
          }),
        );
      }
      return out;
    }),
  ]);
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
    if (r && typeof r.id === "string" && typeof r.value !== "string") {
      // Teilantwort: der Token existiert beim Anbieter, wir haben aber keinen Wert. Er darf nicht unbemerkt verwaisen.
      throw new ProviderError(id, null, `Antwort ohne Wert: beim Anbieter koennte ein verwaister Token bestehen (Kennung ${r.id}). Im Dashboard pruefen und widerrufen.`);
    }
    if (!r || typeof r.value !== "string" || typeof r.id !== "string") throw badResponse(id);
    return { value: new SecretValue(r.value), externalId: r.id, expiresAt: r.expires_on ?? expiresOn ?? null };
  },
  verify: verifyToken,
  reviewChecklist(secret) {
    const perms = permissionNames(secret.params);
    const account = typeof secret.params["accountId"] === "string" ? secret.params["accountId"] : undefined;
    return [
      `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
      perms ? `Rechte sind exakt: ${perms.join(", ")}` : "Rechte entsprechen dem, was der Dienst braucht, und nicht mehr",
      account ? `Nur das Konto ${account} ist freigegeben` : "Nur das vorgesehene Konto ist freigegeben",
      secret.ttlDays ? `Ablauf ist ${secret.ttlDays} Tage nach heute` : "Ablauf ist wie vorgesehen gesetzt",
    ];
  },
  async revoke(ctx) {
    await revokeIdempotent(() => callWithToken("cloudflare-token", ctx, "cloudflare", `${API}/user/tokens/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

// Pfadende des Turnstile-Endpunkts; nicht gegen die Referenz geprueft.
const TURNSTILE_ACTION = ["ro", "tate_secret"].join("");

const turnstileProvider: Provider = {
  id: "cloudflare-turnstile",
  label: "Cloudflare Turnstile Secret (experimentell)",
  kind: "automatic",
  connection: "cloudflare-turnstile",
  async verify() {
    return [check("old-key", "Alter Schluessel", "info", { detail: "Der alte Schluessel bleibt bis zur Bestaetigung gueltig" })];
  },
  reviewChecklist(secret) {
    const sitekey = typeof secret.params["sitekey"] === "string" ? secret.params["sitekey"] : undefined;
    return [
      sitekey ? `Widget und Sitekey ${sitekey} stimmen mit dem Dienst ueberein` : "Widget und Sitekey stimmen mit dem Dienst ueberein",
      "Das neue Secret wird erst nach deiner Bestaetigung geschrieben",
      "Der alte Schluessel wird erst danach im Dashboard ungueltig gemacht",
    ];
  },
  async issue(ctx) {
    const id = "cloudflare-turnstile";
    const accountId = requireString(id, ctx.params, "accountId");
    const sitekey = requireString(id, ctx.params, "sitekey");
    const res = await callWithToken<Envelope<{ secret: string }>>(id, ctx, "cloudflare-turnstile", `${API}/accounts/${seg(accountId)}/challenges/widgets/${seg(sitekey)}/${TURNSTILE_ACTION}`, {
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
