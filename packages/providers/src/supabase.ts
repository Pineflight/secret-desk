import { contextKind, SecretValue, type Check, type Provider, type StageKind, type VerifyContext } from "@secret-desk/core";
import { check, probe, step, steps } from "./checks.js";
import { badResponse, callWithToken, JSON_HEADERS, ProviderError, requireString, seg } from "./http.js";

const API = "https://api.supabase.com";

interface ApiKey {
  id?: string;
  name?: string;
  api_key?: string;
}

/** Form des Schluessels: nur der Praefix und die Laenge, nie ein Teil des Wertes darueber hinaus. */
function shapeCheck(value: string, expected: "secret" | "publishable" | "service_role" | undefined): Check {
  const m = /^(sb_secret_|sb_publishable_)/.exec(value);
  const kind = m ? (m[1] === "sb_secret_" ? "secret" : "publishable") : /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ? "jwt" : undefined;
  const actual = m ? `Praefix ${m[1]}, ${value.length} Zeichen` : kind === "jwt" ? `altes JWT-Format, ${value.length} Zeichen` : `unbekanntes Format, ${value.length} Zeichen`;
  if (!kind) return check("shape", "Form des Schluessels", "warn", { actual });
  if (expected === "service_role") return check("shape", "Form des Schluessels", kind === "jwt" || kind === "secret" ? "info" : "fail", { actual, expected: "service_role (JWT oder sb_secret_)" });
  if (expected && kind !== "jwt" && kind !== expected) return check("shape", "Form des Schluessels", "fail", { actual, expected: expected === "secret" ? "Praefix sb_secret_" : "Praefix sb_publishable_" });
  return check("shape", "Form des Schluessels", "info", { actual });
}

async function verifyKey(id: string, expected: "secret" | "publishable" | "service_role" | undefined, ctx: VerifyContext): Promise<Check[]> {
  const out: Check[] = [shapeCheck(ctx.value.reveal(), expected)];
  const raw = ctx.params["url"];
  if (typeof raw !== "string" || !raw.trim()) return out;
  const rest = await step(ctx, "rest", "Schluessel wird vom Projekt akzeptiert", async () => {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      return [check("rest", "Schluessel wird vom Projekt akzeptiert", "warn", { detail: "Parameter url ist keine gueltige URL" })];
    }
    if (u.protocol !== "https:" || !u.hostname.endsWith(".supabase.co")) {
      return [check("rest", "Schluessel wird vom Projekt akzeptiert", "warn", { detail: "Parameter url ist kein https://<ref>.supabase.co" })];
    }
    const v = ctx.value.reveal();
    const r = await probe(id, ctx, `${u.origin}/rest/v1/`, { method: "GET", headers: { apikey: v } }, [v]);
    const status = r.status >= 200 && r.status < 300 ? "pass" : r.status === 401 || r.status === 403 ? "fail" : "warn";
    return [check("rest", "Schluessel wird vom Projekt akzeptiert", status, { expected: "HTTP 2xx", actual: `HTTP ${r.status}`, detail: u.hostname })];
  });
  return steps([Promise.resolve(out), Promise.resolve(rest)]);
}

function keyChecklist(secret: { stage: string; params: Record<string, unknown> }, ctx?: { stageKind: StageKind }): string[] {
  const kind = ctx?.stageKind ?? contextKind({ stage: secret.stage });
  const ref = typeof secret.params["projectRef"] === "string" ? secret.params["projectRef"] : undefined;
  const type = typeof secret.params["type"] === "string" ? secret.params["type"] : undefined;
  return [
    ref ? `Das Projekt ist ${ref}` : "Das Projekt ist das vorgesehene (Ref pruefen)",
    type ? `Der Typ ist ${type}` : "Der Typ stimmt (secret oder publishable)",
    kind === "test" ? "Es ist das Staging-Projekt, nicht das Produktionsprojekt" : kind === "live" ? "Es ist das Produktionsprojekt" : "Das Projekt passt zur Stage",
    "Der Name beim Anbieter traegt das heutige Datum",
  ];
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
  verify: (ctx) => {
    const t = ctx.params["type"];
    return verifyKey("supabase-api-key", t === "publishable" ? "publishable" : "secret", ctx);
  },
  reviewChecklist: keyChecklist,
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
  verify: (ctx) => verifyKey("supabase-service-role", "service_role", ctx),
  reviewChecklist: keyChecklist,
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
