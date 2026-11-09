import { randomInt } from "node:crypto";
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
const DB_PASSWORD_MIN = 24;
const DB_PASSWORD_MAX = 64;
const DB_PASSWORD_DEFAULT = 40;
const dbPasswordSpecs: ParamSpec[] = [
  PROJECT_REF,
  {
    key: "length",
    label: "Laenge",
    labelEn: "Length",
    type: "integer",
    required: false,
    defaultValue: String(DB_PASSWORD_DEFAULT),
    min: DB_PASSWORD_MIN,
    max: DB_PASSWORD_MAX,
    help: "24 bis 64 Zeichen, Standard 40. Nur Buchstaben und Ziffern, damit das Passwort ohne Maskierung in eine Postgres-URL passt.",
    helpEn: "24 to 64 characters, default 40. Letters and digits only, so the password fits a Postgres URL without escaping.",
  },
];
/** Default connection string template of the Supabase connection pooler; {{ref}}, {{password}} and {{region}} are replaced. */
export const DB_URL_TEMPLATE_DEFAULT = "postgresql://postgres.{{ref}}:{{password}}@aws-0-{{region}}.pooler.supabase.com:6543/postgres";
dbPasswordSpecs.push(
  {
    key: "dbUrlTarget",
    label: "Eintrag fuer die Verbindungs-URL",
    labelEn: "Entry for the connection URL",
    type: "string",
    required: false,
    pattern: "^[a-z0-9][a-z0-9-]*$",
    help: "Id des Secret-Eintrags (Inventar), der die Verbindungs-URL mit dem neuen Passwort bekommt, zum Beispiel SUPABASE_DB_URL. Ohne Angabe gibt es keine URL.",
    helpEn: "Inventory id of the secret entry that receives the connection URL with the new password, for example SUPABASE_DB_URL. Without it no URL is written.",
  },
  {
    key: "urlTemplate",
    label: "Vorlage der Verbindungs-URL",
    labelEn: "Connection URL template",
    type: "string",
    required: false,
    defaultValue: DB_URL_TEMPLATE_DEFAULT,
    help: "Mit {{ref}}, {{password}} und {{region}}. Standard ist die Adresse des Connection Poolers (Port 6543); das Passwort wird URL-kodiert eingesetzt.",
    helpEn: "With {{ref}}, {{password}} and {{region}}. Default is the connection pooler address (port 6543); the password is inserted URL-encoded.",
  },
  {
    key: "region",
    label: "Region des Projekts",
    labelEn: "Project region",
    type: "string",
    required: false,
    pattern: "^[a-z0-9][a-z0-9-]{1,39}$",
    help: "Nur noetig, wenn die Vorlage {{region}} nutzt, zum Beispiel eu-central-1.",
    helpEn: "Only needed when the template uses {{region}}, for example eu-central-1.",
  },
);
const serviceRoleSpecs: ParamSpec[] = [PROJECT_REF, PROJECT_URL];

/** Projekte der Verbindung (lesend). Die Verwaltungs-API nennt die Projektkennung als ref (oder id). */
async function listProjectsWithStatus(id: string, ctx: Pick<DiscoverContext, "connections" | "fetch">): Promise<{ option: DiscoveredOption; status: string | undefined }[]> {
  const r = await getJson<unknown>(id, ctx, "supabase", `${API}/v1/projects`);
  return asList(r).flatMap((p) => {
    const ref = str(p["ref"]) ?? str(p["id"]);
    const status = str(p["status"]);
    return ref ? [{ option: { value: ref, label: str(p["name"]) ?? ref, detail: [ref, str(p["region"]), status].filter(Boolean).join(", ") }, status }] : [];
  });
}

async function listProjects(id: string, ctx: Pick<DiscoverContext, "connections" | "fetch">): Promise<DiscoveredOption[]> {
  return (await listProjectsWithStatus(id, ctx)).map((p) => p.option);
}

async function discoverSupabase(id: string, kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  if (kind !== "supabase.project") return unknownKind(kind);
  return listProjects(id, ctx);
}

const STAGING_WORD = /(^|[^a-z0-9])(staging|stage|test|dev)([^a-z0-9]|$)/i;
const PROD_WORD = /(^|[^a-z0-9])(production|prod|live)([^a-z0-9]|$)/i;

async function preflightSupabase(id: string, ctx: PreflightContext, checkHealth = false, failOnPaused = false): Promise<PreflightResult> {
  const ref = String(ctx.params["projectRef"]);
  const findings: PreflightFinding[] = [];
  let resource: string | null = `Supabase-Projekt ${ref}`;
  try {
    const listed = await listProjectsWithStatus(id, ctx);
    const projects = listed.map((p) => p.option);
    const hit = projects.find((p) => p.value === ref);
    if (hit) {
      if (checkHealth) {
        const status = listed.find((p) => p.option.value === ref)?.status;
        if (status && PAUSED_STATUS.test(status) && failOnPaused) findings.push({ id: "health", level: "fail", label: `Das Projekt ${hit.label} ist pausiert oder nicht aktiv (Status ${status}): erst das Projekt starten, es wurde nichts geaendert` });
        else if (status && status !== "ACTIVE_HEALTHY") findings.push({ id: "health", level: "warn", label: `Das Projekt ${hit.label} hat den Status ${status}, nicht ACTIVE_HEALTHY: ein pausiertes Projekt lehnt die Aenderung ab` });
      }
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
    const payload = JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString("utf8")) as { role?: unknown };
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

/** Supabase accepts key names of lowercase letters, digits and underscores that start with a letter or underscore. */
export function supabaseKeyName(label: string): string {
  const name = label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(name) ? name : `_${name}`;
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
      body: JSON.stringify({ type, name: supabaseKeyName(ctx.label) }),
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

/** Letters and digits only: safe in a Postgres connection URL without percent-encoding. */
const DB_PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function dbPasswordLength(id: string, params: Record<string, unknown>): number {
  const v = params["length"] ?? DB_PASSWORD_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < DB_PASSWORD_MIN || v > DB_PASSWORD_MAX) {
    throw new ProviderError(id, null, 'Parameter "length" muss eine ganze Zahl von 24 bis 64 sein');
  }
  return v;
}

/** CSPRNG, uniform over the alphabet (randomInt avoids modulo bias). */
function generateDbPassword(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += DB_PASSWORD_ALPHABET[randomInt(DB_PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * Fills the connection URL template. The password is percent-encoded (the generator only uses letters and digits, but a
 * template or a future alphabet must never break the URL). Throws before anything is changed when the template cannot be filled.
 */
export function buildDbUrl(id: string, params: Record<string, unknown>, ref: string, password: string): string {
  const raw = params["urlTemplate"] ?? DB_URL_TEMPLATE_DEFAULT;
  if (typeof raw !== "string" || !/^postgres(ql)?:\/\//.test(raw)) throw new ProviderError(id, null, 'Parameter "urlTemplate" muss mit postgresql:// beginnen');
  if (!raw.includes("{{password}}")) throw new ProviderError(id, null, 'Parameter "urlTemplate" muss {{password}} enthalten');
  const unknown = [...raw.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]!).filter((k) => !["ref", "password", "region"].includes(k));
  if (unknown.length > 0) throw new ProviderError(id, null, `Parameter "urlTemplate" kennt den Platzhalter nicht: ${unknown.join(", ")}`);
  const region = params["region"];
  if (raw.includes("{{region}}") && (typeof region !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(region))) {
    throw new ProviderError(id, null, 'Parameter "region" fehlt: die Vorlage der Verbindungs-URL braucht ihn');
  }
  return raw.replaceAll("{{ref}}", encodeURIComponent(ref)).replaceAll("{{region}}", encodeURIComponent(String(region ?? ""))).replaceAll("{{password}}", encodeURIComponent(password));
}

/** Project states in which the Management API cannot change the database password: the project must be started first. */
const PAUSED_STATUS = /^(INACTIVE|PAUSED|PAUSING|GOING_DOWN|RESTORING|COMING_UP|INIT_FAILED)$/i;
const PAUSED_BODY = /paus|inactive|not active|restor|coming up/i;

/** Adds a hint to API failures; the message stays free of the token and the new password. */
function dbPasswordFailure(id: string, err: unknown): never {
  if (!(err instanceof ProviderError) || err.status === null) throw err;
  const body = err.message.replace(/^[^:]*:\s*/, "");
  let hint: string;
  // Wording of the "paused" answer is not verified live; a 4xx/5xx body that names a paused or inactive project counts.
  if (err.status !== 401 && err.status !== 403 && err.status !== 429 && PAUSED_BODY.test(body)) {
    throw new ProviderError(id, err.status, `Das Projekt ist pausiert oder nicht aktiv: erst das Projekt starten (in Supabase fortsetzen), dann erneut versuchen. Das Passwort wurde nicht geaendert. ${body}`);
  }
  if (err.status === 401 || err.status === 403) hint = 'dem Token fehlt die Berechtigung "Database config: write" (database_config_write) oder er gilt nicht fuer dieses Projekt';
  else if (err.status === 429) hint = "Rate-Limit erreicht, spaeter erneut versuchen";
  else hint = "das Projekt muss gesund sein (ein pausiertes Projekt lehnt die Aenderung ab)";
  throw new ProviderError(id, err.status, `${hint}. ${body}`);
}

const dbPasswordProvider: Provider = {
  id: "supabase-db-password",
  label: "Supabase Datenbank-Passwort (nicht live verifiziert)",
  kind: "automatic",
  connection: "supabase",
  params: dbPasswordSpecs,
  discover: (kind, ctx) => discoverSupabase("supabase-db-password", kind, ctx),
  companionParams: ["dbUrlTarget"],
  preflight: (ctx) => preflightSupabase("supabase-db-password", ctx, true, true),
  async issue(ctx) {
    const id = "supabase-db-password";
    const ref = requireString(id, ctx.params, "projectRef");
    const length = dbPasswordLength(id, ctx.params);
    const password = generateDbPassword(length);
    const targetId = typeof ctx.params["dbUrlTarget"] === "string" && ctx.params["dbUrlTarget"] ? ctx.params["dbUrlTarget"] : undefined;
    // Built before the API call: a template that cannot be filled must not leave a changed password nobody can use.
    const url = targetId ? buildDbUrl(id, ctx.params, ref, password) : undefined;
    try {
      await callWithToken(id, ctx, "supabase", `${API}/v1/projects/${seg(ref)}/database/password`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ password }) }, [password]);
    } catch (err) {
      dbPasswordFailure(id, err);
    }
    return { value: new SecretValue(password), externalId: ref, expiresAt: null, ...(targetId && url ? { companions: [{ entryId: targetId, value: new SecretValue(url) }] } : {}) };
  },
  async verify(ctx) {
    const v = ctx.value.reveal();
    const bounds = "24 bis 64 Zeichen, nur Buchstaben und Ziffern";
    const ok = v.length >= DB_PASSWORD_MIN && v.length <= DB_PASSWORD_MAX && /^[A-Za-z0-9]+$/.test(v);
    return [
      check("shape", "Laenge und Zeichen", ok ? "pass" : "fail", { expected: bounds, actual: `${v.length} Zeichen` }),
      ctx.externalId
        ? check("applied", "Beim Anbieter gesetzt", "pass", { detail: "Die Supabase-API hat die Aenderung beim Ausstellen mit 2xx bestaetigt" })
        : check("applied", "Beim Anbieter gesetzt", "info", { detail: "Wert wurde nicht von secret-desk ausgestellt: Anwendung beim Anbieter nicht pruefbar" }),
      check("login", "Anmeldung an Postgres", "info", { detail: "Nicht geprueft: die API liefert das Passwort nicht zurueck, und secret-desk meldet sich nicht an der Datenbank an" }),
    ];
  },
  reviewChecklist: (secret, ctx) => [
    ...keyChecklist(secret, ctx).slice(0, 1),
    "Das bisherige Passwort wird beim Anbieter sofort ersetzt; alles, was es noch nutzt, scheitert, bis es das neue erhaelt",
    "Alle Verbraucher (CI, supabase db push und link, Verbindungs-URLs) bekommen das neue Passwort",
    ...(typeof secret.params["dbUrlTarget"] === "string" && secret.params["dbUrlTarget"] ? [`Die Verbindungs-URL mit dem neuen Passwort geht an den Eintrag ${secret.params["dbUrlTarget"]} und an keinen anderen`] : []),
  ],
};

export const supabaseProviders: Provider[] = [apiKeyProvider, serviceRoleProvider, dbPasswordProvider];
