import { contextKind, SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider, type StageKind, type VerifyContext } from "@secret-desk/core";
import { asList, getJson, readFailure, str, unknownKind } from "./discover.js";
import { check, probe, step, steps } from "./checks.js";
import { badResponse, callWithToken, JSON_HEADERS, ProviderError, requireString, revokeIdempotent, seg } from "./http.js";

const API = "https://api.supabase.com";

const PROJECT_REF: ParamSpec = {
  key: "projectRef",
  label: "Supabase-Projekt",
  labelEn: "Supabase project",
  type: "string",
  required: true,
  help: "Projekt, fuer das der Schluessel gilt. Je Repository und Stage ein eigenes Projekt.",
  helpEn: "Project the key applies to. One project per repository and stage.",
  discover: "supabase.project",
};
const PROJECT_URL: ParamSpec = {
  key: "url",
  label: "Projekt-Adresse",
  labelEn: "Project URL",
  type: "url",
  required: false,
  help: "https://<ref>.supabase.co, fuer die Funktionspruefung des Schluessels.",
  helpEn: "https://<ref>.supabase.co, used to test the key against the project.",
};
const apiKeySpecs: ParamSpec[] = [
  PROJECT_REF,
  {
    key: "type",
    label: "Schluesseltyp",
    labelEn: "Key type",
    type: "enum",
    required: false,
    defaultValue: "secret",
    help: "secret fuer den Server, publishable fuer den Browser.",
    helpEn: "secret for the server, publishable for the browser.",
    options: [
      { value: "secret", label: "secret (Server)", labelEn: "secret (server)" },
      { value: "publishable", label: "publishable (Browser)", labelEn: "publishable (browser)" },
    ],
  },
  PROJECT_URL,
];
const serviceRoleSpecs: ParamSpec[] = [PROJECT_REF, PROJECT_URL];

/** Projekte der Verbindung (lesend). Die Verwaltungs-API nennt die Projektkennung als ref (oder id). */
async function listProjects(id: string, ctx: Pick<DiscoverContext, "connections" | "fetch">): Promise<DiscoveredOption[]> {
  const r = await getJson<unknown>(id, ctx, "supabase", `${API}/v1/projects`);
  return asList(r).flatMap((p) => {
    const ref = str(p["ref"]) ?? str(p["id"]);
    return ref ? [{ value: ref, label: str(p["name"]) ?? ref, detail: [ref, str(p["region"]), str(p["status"])].filter(Boolean).join(", ") }] : [];
  });
}

async function discoverSupabase(id: string, kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  if (kind !== "supabase.project") return unknownKind(kind);
  return listProjects(id, ctx);
}

const STAGING_WORD = /(^|[^a-z0-9])(staging|stage|test|dev)([^a-z0-9]|$)/i;
const PROD_WORD = /(^|[^a-z0-9])(production|prod|live)([^a-z0-9]|$)/i;

async function preflightSupabase(id: string, ctx: PreflightContext): Promise<PreflightResult> {
  const ref = String(ctx.params["projectRef"]);
  const findings: PreflightFinding[] = [];
  let resource: string | null = `Supabase-Projekt ${ref}`;
  try {
    const projects = await listProjects(id, ctx);
    const hit = projects.find((p) => p.value === ref);
    if (hit) {
      resource = `Supabase-Projekt ${hit.label} (ref ${ref})`;
      findings.push({ id: "project", level: "ok", label: `Das Projekt ${hit.label} gehoert zur Verbindung` });
      const kind = contextKind(ctx);
      if (kind === "live" && STAGING_WORD.test(hit.label) && !PROD_WORD.test(hit.label)) findings.push({ id: "stage", level: "warn", label: `Der Projektname ${hit.label} deutet auf Staging, die Stage ist Produktion` });
      if (kind === "test" && PROD_WORD.test(hit.label) && !STAGING_WORD.test(hit.label)) findings.push({ id: "stage", level: "warn", label: `Der Projektname ${hit.label} deutet auf Produktion, die Stage ist Test` });
    } else if (projects.length > 0) findings.push({ id: "project", level: "fail", label: `Das Projekt ${ref} steht nicht in der Projektliste der Verbindung`, detail: `Verfuegbar: ${projects.map((p) => p.label).join(", ")}` });
    else findings.push({ id: "project", level: "warn", label: "Die Verbindung liefert keine Projekte: Zuordnung nicht pruefbar" });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    findings.push(readFailure(err, "Projekte"));
  }
  return { resource, findings };
}

interface ApiKey {
  id?: string;
  name?: string;
  api_key?: string;
}

function jwtRole(value: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}

/** Form des Schluessels: nur der Praefix und die Laenge, nie ein Teil des Wertes darueber hinaus. */
function shapeCheck(value: string, expected: "secret" | "publishable" | "service_role" | undefined): Check {
  const m = /^(sb_secret_|sb_publishable_)/.exec(value);
  const kind = m ? (m[1] === "sb_secret_" ? "secret" : "publishable") : /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ? "jwt" : undefined;
  const actual = m ? `Praefix ${m[1]}, ${value.length} Zeichen` : kind === "jwt" ? `altes JWT-Format, ${value.length} Zeichen` : `unbekanntes Format, ${value.length} Zeichen`;
  if (!kind) return check("shape", "Form des Schluessels", "warn", { actual });
  if (expected === "service_role") return check("shape", "Form des Schluessels", kind === "jwt" || kind === "secret" ? "info" : "fail", { actual, expected: "service_role (JWT oder sb_secret_)" });
  if (kind === "jwt" && (expected === "secret" || expected === "publishable")) {
    // Altes JWT-Format: nur mit passender Rolle (secret = service_role, publishable = anon). Ein anon-JWT ist kein Secret.
    const role = jwtRole(value);
    const want = expected === "secret" ? "service_role" : "anon";
    if (role !== want) return check("shape", "Form des Schluessels", "fail", { actual: `${actual}, Rolle ${role ?? "unbekannt"}`, expected: `JWT mit Rolle ${want} oder passender Praefix` });
    return check("shape", "Form des Schluessels", "info", { actual: `${actual}, Rolle ${role}` });
  }
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
  params: apiKeySpecs,
  discover: (kind, ctx) => discoverSupabase("supabase-api-key", kind, ctx),
  preflight: (ctx) => preflightSupabase("supabase-api-key", ctx),
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
    await revokeIdempotent(() => callWithToken(id, ctx, "supabase", `${API}/v1/projects/${seg(ref)}/api-keys/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

const serviceRoleProvider: Provider = {
  id: "supabase-service-role",
  label: "Supabase service_role (nur lesen)",
  kind: "automatic",
  connection: "supabase",
  params: serviceRoleSpecs,
  discover: (kind, ctx) => discoverSupabase("supabase-service-role", kind, ctx),
  preflight: (ctx) => preflightSupabase("supabase-service-role", ctx),
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
