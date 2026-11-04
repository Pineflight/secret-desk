import { createHash } from "node:crypto";
import { SecretValue, type Check, type DiscoverContext, type ParamSpec, type PreflightContext, type PreflightResult, type Provider, type VerifyContext } from "@secret-desk/core";
import { check, isRecord, probe, probeWithConnection, step, steps } from "./checks.js";
import { ACCOUNT_SCOPE, CLOUDFLARE_ACCOUNT_ID_SPEC, CLOUDFLARE_API, discoverCloudflare, expiryCheck, preflightCloudflare } from "./cloudflare.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, optionalString, ProviderError, requireString, revokeIdempotent, seg } from "./http.js";
import { signRequest } from "./sigv4.js";

const ID = "cloudflare-r2-credentials";
const CONNECTION = "cloudflare";
const DEFAULT_TTL_DAYS = 90;

/** The two values of an R2 S3 key pair. */
const VALUES = ["accessKeyId", "secretAccessKey"] as const;
type PairValue = (typeof VALUES)[number];
const ACCESS = ["read", "write", "admin"] as const;
type Access = (typeof ACCESS)[number];
const JURISDICTIONS = ["default", "eu", "fedramp"] as const;

/**
 * Permission groups per access level, by the names the Cloudflare permission list shows. Not verified against a live account;
 * a name the account does not list aborts the issuance with that name (fail closed).
 * read and write are bucket-item groups (objects only); admin is the account-level R2 group (also creates and deletes buckets).
 */
export const R2_PERMISSIONS: Record<Access, readonly string[]> = {
  read: ["Workers R2 Storage Bucket Item Read"],
  write: ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"],
  admin: ["Workers R2 Storage Read", "Workers R2 Storage Write"],
};

const specs: ParamSpec[] = [
  CLOUDFLARE_ACCOUNT_ID_SPEC,
  {
    key: "value",
    label: "Dieser Eintrag enthaelt",
    labelEn: "This entry holds",
    type: "enum",
    required: true,
    options: [
      { value: "secretAccessKey", label: "Secret Access Key", labelEn: "Secret access key" },
      { value: "accessKeyId", label: "Access Key ID", labelEn: "Access key ID" },
    ],
    help: "Welchen Teil des S3-Schluesselpaars dieser Eintrag bekommt. Der andere Teil geht an companionEntry. Den Anbieter nur an einen der beiden Eintraege haengen.",
    helpEn: "Which half of the S3 key pair this entry receives. The other half goes to companionEntry. Attach the provider to one of the two entries only.",
  },
  {
    key: "companionEntry",
    label: "Eintrag fuer die andere Haelfte",
    labelEn: "Entry for the other half",
    type: "string",
    required: true,
    pattern: "^[a-z0-9][a-z0-9-]*$",
    help: "Id des Secret-Eintrags (Inventar), der die andere Haelfte des Schluesselpaars aus derselben Ausstellung bekommt.",
    helpEn: "Inventory id of the secret entry that receives the other half of the key pair from the same issuance.",
  },
  {
    key: "access",
    label: "Zugriff",
    labelEn: "Access",
    type: "enum",
    required: true,
    options: [
      { value: "read", label: "Nur lesen (Objekte)", labelEn: "Read only (objects)" },
      { value: "write", label: "Lesen und schreiben (Objekte)", labelEn: "Read and write (objects)" },
      { value: "admin", label: "Admin (Konto, auch Buckets anlegen)", labelEn: "Admin (account, also manages buckets)" },
    ],
    help: "Wie viel der Schluessel in R2 darf. admin gilt fuer das ganze Konto und laesst sich nicht auf Buckets einschraenken.",
    helpEn: "What the key may do in R2. admin applies to the whole account and cannot be limited to buckets.",
  },
  {
    key: "buckets",
    label: "Buckets",
    labelEn: "Buckets",
    type: "stringList",
    required: false,
    help: "Bucket-Namen, auf die der Schluessel beschraenkt wird. Ohne Angabe gilt er fuer alle Buckets des Kontos (nicht mit admin).",
    helpEn: "Bucket names the key is limited to. Without them it applies to every bucket of the account (not with admin).",
  },
  {
    key: "jurisdiction",
    label: "Jurisdiktion",
    labelEn: "Jurisdiction",
    type: "enum",
    required: false,
    defaultValue: "default",
    options: [
      { value: "default", label: "Standard", labelEn: "Default" },
      { value: "eu", label: "EU", labelEn: "EU" },
      { value: "fedramp", label: "FedRAMP", labelEn: "FedRAMP" },
    ],
    help: "Jurisdiktion der Buckets. Sie bestimmt Bucket-Ressource und S3-Adresse (EU: <konto>.eu.r2.cloudflarestorage.com).",
    helpEn: "Jurisdiction of the buckets. It decides the bucket resource and the S3 endpoint (EU: <account>.eu.r2.cloudflarestorage.com).",
  },
];

interface Envelope<T> {
  result?: T;
}

/** S3 key pair of an R2 API token as Cloudflare documents it: key id = token id, secret = SHA-256 (hex) of the token value. */
export function deriveS3Credentials(tokenId: string, tokenValue: string): { accessKeyId: string; secretAccessKey: string } {
  return { accessKeyId: tokenId, secretAccessKey: createHash("sha256").update(tokenValue).digest("hex") };
}

/**
 * User tokens (`/user/tokens`), like `cloudflare-token`: the integration's token (the "Create additional tokens" template)
 * may create user tokens but gets 403 on the account-owned token endpoints (seen live on 2026-11-04). The account id still
 * scopes the token's resources.
 */
const tokensUrl = (_accountId: string): string => `${CLOUDFLARE_API}/user/tokens`;

function accessOf(params: Record<string, unknown>): Access {
  const a = requireString(ID, params, "access");
  if (!(ACCESS as readonly string[]).includes(a)) throw new ProviderError(ID, null, `Parameter "access" muss read, write oder admin sein`);
  return a as Access;
}

function jurisdictionOf(params: Record<string, unknown>): (typeof JURISDICTIONS)[number] {
  const j = optionalString(ID, params, "jurisdiction") ?? "default";
  if (!(JURISDICTIONS as readonly string[]).includes(j)) throw new ProviderError(ID, null, `Parameter "jurisdiction" muss default, eu oder fedramp sein`);
  return j as (typeof JURISDICTIONS)[number];
}

function bucketsOf(params: Record<string, unknown>): string[] {
  const b = params["buckets"];
  return Array.isArray(b) ? [...new Set(b.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))] : [];
}

function valueOf(params: Record<string, unknown>): PairValue {
  const v = requireString(ID, params, "value");
  if (!(VALUES as readonly string[]).includes(v)) throw new ProviderError(ID, null, `Parameter "value" muss accessKeyId oder secretAccessKey sein`);
  return v as PairValue;
}

/** `com.cloudflare.edge.r2.bucket.<account>_<jurisdiction>_<bucket>` */
export const bucketResource = (accountId: string, jurisdiction: string, bucket: string): string => `com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction}_${bucket}`;

/** Resources of the token policy: the named buckets, or the whole account when no bucket is given. */
function resourcesOf(accountId: string, access: Access, jurisdiction: string, buckets: string[]): Record<string, string> {
  if (access === "admin") {
    if (buckets.length > 0) throw new ProviderError(ID, null, "access admin gilt fuer das ganze Konto und laesst sich nicht auf buckets einschraenken");
    return { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" };
  }
  if (buckets.length === 0) return { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" };
  return Object.fromEntries(buckets.map((b) => [bucketResource(accountId, jurisdiction, b), "*"]));
}

const s3Host = (accountId: string, jurisdiction: string): string => `${accountId}.${jurisdiction === "default" ? "" : `${jurisdiction}.`}r2.cloudflarestorage.com`;

async function permissionGroups(ctx: { connections: DiscoverContext["connections"]; fetch: typeof fetch }, accountId: string): Promise<Map<string, string>> {
  const r = await callWithToken<Envelope<{ id: string; name: string }[]>>(ID, ctx, CONNECTION, `${tokensUrl(accountId)}/permission_groups`, { method: "GET" });
  if (!Array.isArray(r?.result)) throw badResponse(ID);
  const out = new Map<string, string>();
  for (const g of r.result) if (typeof g.name === "string" && typeof g.id === "string" && !out.has(g.name)) out.set(g.name, g.id);
  return out;
}

async function preflight(ctx: PreflightContext): Promise<PreflightResult> {
  const base = await preflightCloudflare(ID, CONNECTION, specs, ctx, false);
  try {
    const access = accessOf(ctx.params);
    const groups = await permissionGroups({ connections: ctx.connections, fetch: ctx.fetch }, requireString(ID, ctx.params, "accountId"));
    const missing = R2_PERMISSIONS[access].filter((n) => !groups.has(n));
    base.findings.push(missing.length > 0 ? { id: "permissions", level: "fail", label: `Unbekannte Berechtigungsgruppen: ${missing.join(", ")}` } : { id: "permissions", level: "ok", label: "Alle R2-Berechtigungsgruppen existieren" });
    if (access === "admin" && bucketsOf(ctx.params).length > 0) base.findings.push({ id: "buckets", level: "fail", label: "access admin laesst sich nicht auf buckets einschraenken" });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    base.findings.push({ id: "permissions", level: "fail", label: "Die R2-Berechtigungsgruppen sind nicht lesbar", detail: err instanceof Error ? err.message : "Fehler" });
  }
  return base;
}

/** S3 ListObjectsV2 (max-keys=1) with the key pair: proves that the derived credentials work and reach the bucket. */
async function s3List(ctx: VerifyContext, accountId: string, bucket: string, creds: { accessKeyId: string; secretAccessKey: string }): Promise<{ status: number }> {
  const url = `https://${s3Host(accountId, jurisdictionOf(ctx.params))}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`;
  // A new token reaches the S3 endpoint only after a few seconds (live on 2026-11-04: 401 right away, 200 after 5 s), so
  // 401/403 are retried with growing pauses before they count.
  let status = 0;
  const started = Date.now();
  const base = ctx.now instanceof Date ? ctx.now.getTime() : started;
  for (const pauseMs of S3_RETRY_PAUSES_MS) {
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const signed = signRequest({ method: "GET", url, region: "auto", service: "s3", ...creds, now: new Date(base + (Date.now() - started)), contentSha256Header: true });
    status = (await probe(ID, ctx, url, { method: "GET", headers: signed.headers }, [creds.secretAccessKey])).status;
    if (status !== 401 && status !== 403) break;
  }
  return { status };
}

/** Pauses before each S3 attempt; exported for tests. */
export const S3_RETRY_PAUSES_MS: number[] = [0, 3_000, 6_000, 12_000];

async function verify(ctx: VerifyContext): Promise<Check[]> {
  const accountId = typeof ctx.params["accountId"] === "string" ? ctx.params["accountId"] : undefined;
  const holds = typeof ctx.params["value"] === "string" ? ctx.params["value"] : undefined;
  const buckets = bucketsOf(ctx.params);
  return steps([
    step(ctx, "token", "Token ist aktiv", async () => {
      if (!accountId || !ctx.externalId) return [check("token", "Token ist aktiv", "warn", { detail: "Konto oder Token-Kennung fehlt, Token nicht abrufbar" })];
      // The token value itself is not available here (the entry may hold only its hash), so the connection reads the token.
      const r = await probeWithConnection(ID, ctx, CONNECTION, `${tokensUrl(accountId)}/${seg(ctx.externalId)}`);
      const result = isRecord(r.json) && isRecord(r.json["result"]) ? r.json["result"] : undefined;
      if (r.status < 200 || r.status >= 300 || !result) return [check("token", "Token ist aktiv", "warn", { detail: `Token konnte nicht gelesen werden (HTTP ${r.status})` })];
      const status = typeof result["status"] === "string" ? result["status"] : undefined;
      return [check("token", "Token ist aktiv", status === "active" ? "pass" : "fail", { expected: "active", actual: status ?? "unbekannt" }), expiryCheck(ctx, result["expires_on"])];
    }),
    step(ctx, "s3", "S3-Zugang (ListObjectsV2)", async () => {
      if (!accountId) return [check("s3", "S3-Zugang (ListObjectsV2)", "warn", { detail: "Parameter accountId fehlt" })];
      if (buckets.length === 0) return [check("s3", "S3-Zugang (ListObjectsV2)", "info", { detail: "Kein Bucket angegeben: der S3-Zugang wird nicht geprueft, nur der Token" })];
      // Both halves are needed: the access key id is the token id, the secret is this entry's value.
      if (holds !== "secretAccessKey" || !ctx.externalId) return [check("s3", "S3-Zugang (ListObjectsV2)", "info", { detail: "Dieser Eintrag haelt nicht den Secret Access Key: der S3-Zugang wird nicht geprueft" })];
      const { status } = await s3List(ctx, accountId, buckets[0]!, { accessKeyId: ctx.externalId, secretAccessKey: ctx.value.reveal() });
      return [check("s3", "S3-Zugang (ListObjectsV2)", status >= 200 && status < 300 ? "pass" : "fail", { expected: `HTTP 2xx auf ${buckets[0]}`, actual: `HTTP ${status}` })];
    }),
  ]);
}

export const cloudflareR2Provider: Provider = {
  id: ID,
  label: "Cloudflare R2 S3-Zugang (Access Key ID und Secret Access Key)",
  kind: "automatic",
  connection: CONNECTION,
  params: specs,
  companionParams: ["companionEntry"],
  discover: (kind, ctx) => discoverCloudflare(ID, CONNECTION, specs, kind, ctx),
  preflight,
  async issue(ctx) {
    const accountId = requireString(ID, ctx.params, "accountId");
    const access = accessOf(ctx.params);
    const jurisdiction = jurisdictionOf(ctx.params);
    const holds = valueOf(ctx.params);
    const companionId = requireString(ID, ctx.params, "companionEntry");
    const resources = resourcesOf(accountId, access, jurisdiction, bucketsOf(ctx.params));

    const groups = await permissionGroups(ctx, accountId);
    const wanted = R2_PERMISSIONS[access];
    const missing = wanted.filter((n) => !groups.has(n));
    if (missing.length > 0) throw new ProviderError(ID, null, `Unbekannte Berechtigungsgruppen: ${missing.join(", ")}`);

    // The expiry is always set: the entry's ttlDays, else 90 days.
    const expiresOn = expiryFrom(ctx.now, ctx.secret.ttlDays ?? DEFAULT_TTL_DAYS)!;
    const body = {
      name: ctx.label,
      policies: [{ effect: "allow", resources, permission_groups: wanted.map((n) => ({ id: groups.get(n)! })) }],
      expires_on: expiresOn,
    };
    const res = await callWithToken<Envelope<{ id: string; value: string; expires_on?: string }>>(ID, ctx, CONNECTION, tokensUrl(accountId), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const r = res?.result;
    if (r && typeof r.id === "string" && typeof r.value !== "string") {
      throw new ProviderError(ID, null, `Antwort ohne Wert: bei Cloudflare koennte ein verwaister Token bestehen (Kennung ${r.id}). Im Dashboard pruefen und widerrufen.`);
    }
    if (!r || typeof r.value !== "string" || typeof r.id !== "string") throw badResponse(ID);
    const pair = deriveS3Credentials(r.id, r.value);
    const other: PairValue = holds === "accessKeyId" ? "secretAccessKey" : "accessKeyId";
    return {
      value: new SecretValue(pair[holds]),
      externalId: r.id,
      expiresAt: r.expires_on ?? expiresOn,
      companions: [{ entryId: companionId, value: new SecretValue(pair[other]) }],
    };
  },
  verify,
  reviewChecklist(secret) {
    const access = typeof secret.params["access"] === "string" ? secret.params["access"] : undefined;
    const buckets = bucketsOf(secret.params);
    const other = typeof secret.params["companionEntry"] === "string" ? secret.params["companionEntry"] : undefined;
    return [
      `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
      access ? `Zugriff ist ${access}` : "Zugriff entspricht dem, was der Dienst braucht",
      buckets.length > 0 ? `Nur diese Buckets sind freigegeben: ${buckets.join(", ")}` : access === "admin" ? "Der Schluessel gilt fuer das ganze Konto (admin)" : "Der Schluessel gilt fuer alle Buckets des Kontos",
      other ? `Die andere Haelfte des Schluesselpaars geht an den Eintrag ${other} und an keinen anderen` : "Die andere Haelfte geht an den vorgesehenen Eintrag",
      `Ablauf ist ${secret.ttlDays ?? DEFAULT_TTL_DAYS} Tage nach heute`,
    ];
  },
  async revoke(ctx) {
    const accountId = requireString(ID, ctx.params, "accountId");
    await revokeIdempotent(() => callWithToken(ID, ctx, CONNECTION, `${tokensUrl(accountId)}/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

export const cloudflareR2Providers: Provider[] = [cloudflareR2Provider];
