import { ParamsInvalidError, SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider, type VerifyContext } from "@secret-desk/core";
import { asList, getJson, needParam, readFailure, str, unknownKind } from "./discover.js";
import { check, daysApart, day, isRecord, probeWithConnection, probeWithValue, sameSet, step, steps } from "./checks.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireString, requireStringArray, revokeIdempotent, seg } from "./http.js";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  result?: T;
}

const TID = "cloudflare-token";
export const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

export const CLOUDFLARE_ACCOUNT_ID_SPEC: ParamSpec = {
  key: "accountId",
  label: "Cloudflare-Konto",
  labelEn: "Cloudflare account",
  type: "string",
  required: true,
  help: "Konto, fuer das der Token gilt. Wird aus der verbundenen Integration gelesen.",
  helpEn: "Account the token applies to. Read from the connected integration.",
  discover: "cloudflare.account",
  integrationDefault: true,
};

/**
 * Permission sets behind the presets terraform-plan, terraform-apply and saas-custom-hostnames. The names are the ones the
 * Cloudflare permission-group list shows as far as known; none was checked against a live account. A name the account does
 * not list aborts the issuance with that name (fail closed), and an inventory entry can always set `permissions` itself.
 * Zone-bound groups need `zones`, `zoneId` or `allZones`.
 */
export const TERRAFORM_PLAN_PERMISSIONS = [
  "Account Settings Read",
  "Zone Read",
  "DNS Read",
  "Zone Settings Read",
  "Page Rules Read",
  "Config Settings Read",
  "Workers Routes Read",
  "Workers Scripts Read",
  "Workers R2 Storage Read",
  "Access: Apps and Policies Read",
  "Turnstile Sites Read",
  "Cloudflare Pages Read",
] as const;

export const TERRAFORM_APPLY_PERMISSIONS = [
  "Account Settings Read",
  "Zone Read",
  "DNS Write",
  "Zone Settings Write",
  "Page Rules Write",
  "Config Settings Write",
  "Workers Routes Write",
  "Workers Scripts Write",
  "Workers R2 Storage Write",
  "Access: Apps and Policies Write",
  "Turnstile Sites Write",
  "Cloudflare Pages Write",
] as const;

/** Cloudflare for SaaS: custom hostnames are managed under the zone's SSL and certificates; no separate group is known. */
export const SAAS_CUSTOM_HOSTNAMES_PERMISSIONS = ["SSL and Certificates Write", "Zone Read"] as const;

const tokenSpecs: ParamSpec[] = [
  CLOUDFLARE_ACCOUNT_ID_SPEC,
  {
    key: "permissions",
    label: "Berechtigungen",
    labelEn: "Permissions",
    type: "stringList",
    required: true,
    help: "Namen der Berechtigungsgruppen, zum Beispiel Workers Scripts Write.",
    helpEn: "Names of the permission groups, for example Workers Scripts Write.",
    discover: "cloudflare.permissionGroups",
    presets: [
      { id: "worker-deploy", label: "Worker-Deploy", labelEn: "Worker deploy", values: { permissions: ["Workers Scripts Write", "Account Settings Read"] } },
      { id: "worker-deploy-custom-domain", label: "Worker-Deploy mit Custom Domain", labelEn: "Worker deploy with custom domain", values: { permissions: ["Workers Scripts Write", "Account Settings Read", "Workers Routes Write"] }, needs: ["zoneId"] },
      { id: "terraform-plan", label: "Terraform plan (lesend)", labelEn: "Terraform plan (read-only)", values: { permissions: [...TERRAFORM_PLAN_PERMISSIONS] }, needs: ["zones"] },
      { id: "terraform-apply", label: "Terraform apply (schreibend)", labelEn: "Terraform apply (write)", values: { permissions: [...TERRAFORM_APPLY_PERMISSIONS] }, needs: ["zones"] },
      { id: "saas-custom-hostnames", label: "Cloudflare for SaaS (Custom Hostnames)", labelEn: "Cloudflare for SaaS (custom hostnames)", values: { permissions: [...SAAS_CUSTOM_HOSTNAMES_PERMISSIONS] }, needs: ["zoneId"] },
    ],
  },
  {
    key: "zoneId",
    label: "Zone",
    labelEn: "Zone",
    type: "string",
    required: false,
    help: "Nur fuer Rechte, die an eine Zone gebunden sind (zum Beispiel Workers Routes Write). Fuer mehrere Zonen: zones oder allZones.",
    helpEn: "Only for permissions tied to a zone (for example Workers Routes Write). For several zones use zones or allZones.",
    discover: "cloudflare.zone",
  },
  {
    key: "zones",
    label: "Zonen (Namen)",
    labelEn: "Zones (names)",
    type: "stringList",
    required: false,
    help: "Zonennamen fuer zonengebundene Rechte, zum Beispiel acme.example. Jeder Name wird ueber die Cloudflare-API zur Zonen-Kennung aufgeloest; ein unbekannter Name bricht ab. Braucht ein Leserecht fuer Zonen.",
    helpEn: "Zone names for zone-bound permissions, for example acme.example. Each name is resolved to a zone id through the Cloudflare API; an unknown name aborts. Needs a read permission for zones.",
    discover: "cloudflare.zoneName",
  },
  {
    key: "allZones",
    label: "Alle Zonen des Kontos",
    labelEn: "All zones of the account",
    type: "enum",
    required: false,
    defaultValue: "false",
    options: [
      { value: "false", label: "Nein", labelEn: "No" },
      { value: "true", label: "Ja, alle Zonen des Kontos (auch kuenftige)", labelEn: "Yes, every zone of the account (future ones too)" },
    ],
    help: "Zonengebundene Rechte gelten fuer jede Zone des Kontos, auch fuer spaeter angelegte. Nicht zusammen mit zoneId oder zones.",
    helpEn: "Zone-bound permissions apply to every zone of the account, including ones created later. Not together with zoneId or zones.",
  },
];

const turnstileSpecs: ParamSpec[] = [
  CLOUDFLARE_ACCOUNT_ID_SPEC,
  {
    key: "sitekey",
    label: "Turnstile-Widget (Sitekey)",
    labelEn: "Turnstile widget (sitekey)",
    type: "string",
    required: true,
    help: "Oeffentlicher Sitekey des Widgets, dessen Secret erneuert wird.",
    helpEn: "Public sitekey of the widget whose secret is renewed.",
    discover: "cloudflare.turnstileWidget",
  },
];

export async function discoverCloudflare(id: string, connection: string, specs: readonly ParamSpec[], kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  switch (kind) {
    case "cloudflare.account": {
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${CLOUDFLARE_API}/accounts?per_page=50`);
      return asList(r?.result).flatMap((a) => (str(a["id"]) ? [{ value: str(a["id"])!, label: str(a["name"]) ?? str(a["id"])!, detail: str(a["id"])! }] : []));
    }
    case "cloudflare.zone": {
      const account = typeof ctx.params["accountId"] === "string" && ctx.params["accountId"] ? `&account.id=${seg(ctx.params["accountId"])}` : "";
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${CLOUDFLARE_API}/zones?per_page=50${account}`);
      return asList(r?.result).flatMap((z) => {
        const acc = isRecord(z["account"]) ? str(z["account"]["name"]) : undefined;
        return str(z["id"]) ? [{ value: str(z["id"])!, label: str(z["name"]) ?? str(z["id"])!, detail: acc ? `${str(z["id"])} (${acc})` : str(z["id"])! }] : [];
      });
    }
    case "cloudflare.zoneName": {
      const account = typeof ctx.params["accountId"] === "string" && ctx.params["accountId"] ? `&account.id=${seg(ctx.params["accountId"])}` : "";
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${CLOUDFLARE_API}/zones?per_page=50${account}`);
      return asList(r?.result).flatMap((z) => (str(z["name"]) ? [{ value: str(z["name"])!, label: str(z["name"])!, detail: str(z["id"]) ?? "" }] : []));
    }
    case "cloudflare.permissionGroups": {
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${CLOUDFLARE_API}/user/tokens/permission_groups`);
      // Gleiche Namen gibt es je Geltungsbereich mehrfach (zum Beispiel Konto und Zone): eine Option je Name, Bereiche vereinigt.
      const scopesByName = new Map<string, Set<string>>();
      for (const g of asList(r?.result)) {
        const name = str(g["name"]);
        if (!name) continue;
        const set = scopesByName.get(name) ?? new Set<string>();
        for (const x of Array.isArray(g["scopes"]) ? g["scopes"] : []) if (typeof x === "string") set.add(x);
        scopesByName.set(name, set);
      }
      return [...scopesByName].map(([name, scopes]) => ({ value: name, label: name, detail: groupScope([...scopes]) }));
    }
    case "cloudflare.turnstileWidget": {
      const account = needParam(specs, ctx.params, "accountId");
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${CLOUDFLARE_API}/accounts/${seg(account)}/challenges/widgets`);
      return asList(r?.result).flatMap((w) => {
        const domains = Array.isArray(w["domains"]) ? w["domains"].filter((x): x is string => typeof x === "string").join(", ") : "";
        return str(w["sitekey"]) ? [{ value: str(w["sitekey"])!, label: str(w["name"]) ?? str(w["sitekey"])!, detail: domains ? `${str(w["sitekey"])} (${domains})` : str(w["sitekey"])! }] : [];
      });
    }
    default:
      return unknownKind(kind);
  }
}

/** account, zone oder gemischt - anhand der Geltungsbereiche, die Cloudflare je Berechtigungsgruppe nennt. */
function groupScope(scopes: string[]): string {
  const account = scopes.includes(ACCOUNT_SCOPE);
  const zone = scopes.includes(ZONE_SCOPE);
  return account && zone ? "account, zone" : zone ? "zone" : account ? "account" : scopes.join(", ");
}

/** Konto und Berechtigungen gegen das Token der Verbindung pruefen (lesend). */
export async function preflightCloudflare(id: string, connection: string, specs: readonly ParamSpec[], ctx: PreflightContext, withPermissions: boolean): Promise<PreflightResult> {
  const findings: PreflightFinding[] = [];
  const dctx = { connections: ctx.connections, fetch: ctx.fetch, params: ctx.params, hint: { repos: [] } } satisfies DiscoverContext;
  const accountId = needParam(specs, ctx.params, "accountId");
  let resource: string | null = `Cloudflare-Konto ${accountId}`;
  try {
    const accounts = await discoverCloudflare(id, connection, specs, "cloudflare.account", dctx);
    const hit = accounts.find((a) => a.value === accountId);
    if (hit) {
      resource = `Cloudflare-Konto ${hit.label} (${accountId})`;
      findings.push({ id: "account", level: "ok", label: `Das Konto ${hit.label} gehoert zum Token der Verbindung` });
    } else if (accounts.length > 0) findings.push({ id: "account", level: "fail", label: `Das Konto ${accountId} gehoert nicht zum Token der Verbindung`, detail: `Verfuegbar: ${accounts.map((a) => a.label).join(", ")}` });
    else findings.push({ id: "account", level: "warn", label: "Die Verbindung liefert keine Konten: Zuordnung nicht pruefbar" });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    findings.push(readFailure(err, "Konten"));
  }
  if (!withPermissions) return { resource, findings };
  const wanted = permissionNames(ctx.params) ?? [];
  try {
    const groups = await discoverCloudflare(id, connection, specs, "cloudflare.permissionGroups", dctx);
    const known = new Map(groups.map((g) => [String(g.value), g.detail ?? ""]));
    const missing = wanted.filter((n) => !known.has(n));
    if (missing.length > 0) findings.push({ id: "permissions", level: "fail", label: `Unbekannte Berechtigungsgruppen: ${missing.join(", ")}` });
    else findings.push({ id: "permissions", level: "ok", label: "Alle Berechtigungsgruppen existieren" });
    const zoneBound = wanted.filter((n) => known.get(n) === "zone");
    const target = zoneTargetOf(id, ctx.params);
    if (zoneBound.length > 0 && !hasZoneTarget(target)) findings.push({ id: "zone", level: "fail", label: `Zone fehlt (zoneId, zones oder allZones): ${zoneBound.join(", ")} gilt nur fuer Zonen` });
    else if (target.all) {
      resource = `${resource}, alle Zonen`;
      findings.push({ id: "zone", level: "warn", label: "Die Rechte gelten fuer jede Zone des Kontos, auch fuer spaeter angelegte" });
    } else if (target.zoneId || target.zoneNames.length > 0) {
      const zones = await discoverCloudflare(id, connection, specs, "cloudflare.zone", { ...dctx, params: { ...ctx.params } });
      const wantedZones = [
        ...(target.zoneId ? [{ by: target.zoneId, hit: zones.find((x) => x.value === target.zoneId) }] : []),
        ...target.zoneNames.map((n) => ({ by: n, hit: zones.find((x) => x.label.toLowerCase() === n) })),
      ];
      const found = wantedZones.filter((w) => w.hit);
      if (found.length > 0) resource = `${resource}, Zone ${found.map((w) => w.hit!.label).join(", ")}`;
      const notFound = wantedZones.filter((w) => !w.hit).map((w) => w.by);
      if (zones.length === 0) findings.push({ id: "zone", level: "warn", label: "Die Verbindung liefert keine Zonen: Zuordnung nicht pruefbar" });
      else if (notFound.length === 0) findings.push({ id: "zone", level: "ok", label: `Alle Zonen existieren im Konto (${found.map((w) => w.hit!.label).join(", ")})` });
      else findings.push({ id: "zone", level: "fail", label: `Zonen nicht im Konto ${accountId}: ${notFound.join(", ")}` });
    }
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    findings.push(readFailure(err, "Berechtigungsgruppen"));
  }
  return { resource, findings };
}

function permissionNames(params: Record<string, unknown>): string[] | undefined {
  const p = params["permissions"];
  return Array.isArray(p) && p.every((x) => typeof x === "string") ? [...new Set(p as string[])] : undefined;
}

/** Which zones a token's zone-bound permissions cover: one id, several names, or every zone of the account. */
interface ZoneTarget {
  zoneId: string;
  zoneNames: string[];
  all: boolean;
}

function zoneTargetOf(id: string, params: Record<string, unknown>): ZoneTarget {
  const zoneId = typeof params["zoneId"] === "string" ? params["zoneId"].trim() : "";
  const names = params["zones"];
  const zoneNames = Array.isArray(names) ? [...new Set(names.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))] : [];
  const a = params["allZones"];
  const all = a === true || a === "true";
  if (all && (zoneId || zoneNames.length > 0)) throw new ProviderError(id, null, "allZones gilt fuer jede Zone des Kontos und laesst sich nicht mit zoneId oder zones kombinieren");
  return { zoneId, zoneNames, all };
}

const hasZoneTarget = (t: ZoneTarget): boolean => t.all || t.zoneId !== "" || t.zoneNames.length > 0;

/** A zone id as Cloudflare prints it: 32 hex characters. */
const ZONE_ID = /^[0-9a-f]{32}$/;

/**
 * Resolves zone names to ids through the API (exact name, inside the account). A name that does not resolve aborts: fail
 * closed. An entry that already is a zone id is taken as it is, so a connection token without *Zone Read* can still bind
 * several zones.
 */
async function resolveZoneNames(id: string, ctx: { connections: DiscoverContext["connections"]; fetch: typeof fetch }, accountId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (ZONE_ID.test(name)) {
      ids.push(name);
      continue;
    }
    const r = await callWithToken<Envelope<{ id?: string; name?: string }[]>>(id, ctx, "cloudflare", `${CLOUDFLARE_API}/zones?name=${seg(name)}&account.id=${seg(accountId)}&per_page=5`, { method: "GET" });
    const hit = Array.isArray(r?.result) ? r!.result.find((z) => typeof z.id === "string" && typeof z.name === "string" && z.name.toLowerCase() === name) : undefined;
    if (hit?.id) ids.push(hit.id);
    else missing.push(name);
  }
  if (missing.length > 0) throw new ProviderError(id, null, `Zonen nicht gefunden (oder nicht lesbar mit dem Token der Verbindung): ${missing.join(", ")}`);
  return [...new Set(ids)];
}

/** Ablauf des neuen Tokens gegen den erwarteten Ablauf. */
export function expiryCheck(ctx: VerifyContext, expiresOn: unknown): Check {
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
      const r = await probeWithValue(TID, ctx, `${CLOUDFLARE_API}/user/tokens/verify`);
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
      const r = await probeWithConnection(TID, ctx, "cloudflare", `${CLOUDFLARE_API}/user/tokens/${seg(ctx.externalId)}`);
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
        const target = zoneTargetOf(TID, ctx.params);
        const zonePrefix = `${ZONE_SCOPE}.`;
        const keys = new Set<string>();
        for (const pol of policies) if (isRecord(pol["resources"])) for (const k of Object.keys(pol["resources"])) keys.add(k);
        // Zone names are not resolved here: with zones (names) any zone resource of the account is accepted, its number is compared.
        const zoneKeys = [...keys].filter((k) => k.startsWith(zonePrefix));
        const zoneCountOk = target.zoneNames.length === 0 || zoneKeys.length === target.zoneNames.length + (target.zoneId ? 1 : 0);
        const zoneAllowed = (k: string): boolean => !target.all && k.startsWith(zonePrefix) && (target.zoneNames.length > 0 || k === `${zonePrefix}${target.zoneId}`);
        const others = [...keys].filter((k) => k !== want && !zoneAllowed(k));
        // Mit zonengebundenen Rechten steht neben dem Konto nur die gewaehlte Zone; ohne sie darf das Konto fehlen.
        const ok = (keys.has(want) || zoneKeys.length > 0) && others.length === 0 && zoneCountOk;
        out.push(
          check("account-scope", "Nur das erwartete Konto", ok ? "pass" : "fail", {
            expected: want,
            actual: [...keys].join(", ") || "keine Ressourcen",
            ...(ok ? {} : { detail: others.length ? `Weitere Ressourcen: ${others.join(", ")}` : !zoneCountOk ? `Anzahl der Zonen weicht ab: erwartet ${target.zoneNames.length + (target.zoneId ? 1 : 0)}, gefunden ${zoneKeys.length}` : "Erwartetes Konto fehlt" }),
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
  params: tokenSpecs,
  discover: (kind, ctx) => discoverCloudflare(TID, "cloudflare", tokenSpecs, kind, ctx),
  preflight: (ctx) => preflightCloudflare(TID, "cloudflare", tokenSpecs, ctx, true),
  async issue(ctx) {
    const id = "cloudflare-token";
    const accountId = requireString(id, ctx.params, "accountId");
    const permissions = requireStringArray(id, ctx.params, "permissions");

    const groups = await callWithToken<Envelope<{ id: string; name: string; scopes?: string[] }[]>>(id, ctx, "cloudflare", `${CLOUDFLARE_API}/user/tokens/permission_groups`, { method: "GET" });
    const list = groups?.result;
    if (!Array.isArray(list)) throw badResponse(id);
    // Gleiche Namen gibt es je Geltungsbereich mehrfach: je Richtlinie die Gruppe des passenden Bereichs nehmen.
    const byName = new Map<string, typeof list>();
    for (const g of list) byName.set(g.name, [...(byName.get(g.name) ?? []), g]);
    const pick = (n: string, scope: string): { id: string; name: string; scopes?: string[] } => {
      const all = byName.get(n)!;
      return all.find((g) => (g.scopes ?? []).includes(scope)) ?? all[0]!;
    };
    const missing = permissions.filter((n) => !byName.has(n));
    if (missing.length > 0) throw new ProviderError(id, null, `Unbekannte Berechtigungsgruppen: ${missing.join(", ")}`);
    // Zonengebundene Rechte (Geltungsbereich nur zone) brauchen eine eigene Richtlinie auf der Zone.
    const isZone = (n: string): boolean => {
      const all = byName.get(n)!;
      return all.some((g) => (g.scopes ?? []).includes(ZONE_SCOPE)) && !all.some((g) => (g.scopes ?? []).includes(ACCOUNT_SCOPE));
    };
    const zoneBound = permissions.filter(isZone);
    const target = zoneTargetOf(id, ctx.params);
    if (zoneBound.length > 0 && !hasZoneTarget(target)) {
      const spec = tokenSpecs.find((x) => x.key === "zoneId")!;
      throw new ParamsInvalidError([{ key: "zoneId", code: "missing", message: "zoneId, zones oder allZones fehlt", label: spec.label, labelEn: spec.labelEn }]);
    }
    if (zoneBound.length === 0 && hasZoneTarget(target)) throw new ProviderError(id, null, "Zonen angegeben, aber keine zonengebundene Berechtigung gewaehlt");
    const zoneIds = [...(target.zoneId ? [target.zoneId] : []), ...(target.zoneNames.length > 0 ? await resolveZoneNames(id, ctx, accountId, target.zoneNames) : [])];
    const zoneResources: Record<string, unknown> = target.all ? { [`${ACCOUNT_SCOPE}.${accountId}`]: { [`${ZONE_SCOPE}.*`]: "*" } } : Object.fromEntries([...new Set(zoneIds)].map((z) => [`${ZONE_SCOPE}.${z}`, "*"]));

    const expiresOn = expiryFrom(ctx.now, ctx.secret.ttlDays);
    const accountGroups = permissions.filter((n) => !isZone(n));
    const policies = [
      ...(accountGroups.length > 0 ? [{ effect: "allow", resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" }, permission_groups: accountGroups.map((n) => ({ id: pick(n, ACCOUNT_SCOPE).id })) }] : []),
      ...(zoneBound.length > 0 ? [{ effect: "allow", resources: zoneResources, permission_groups: zoneBound.map((n) => ({ id: pick(n, ZONE_SCOPE).id })) }] : []),
    ];
    const body = {
      name: ctx.label,
      policies,
      ...(expiresOn ? { expires_on: expiresOn } : {}),
    };
    const res = await callWithToken<Envelope<{ id: string; value: string; expires_on?: string }>>(id, ctx, "cloudflare", `${CLOUDFLARE_API}/user/tokens`, {
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
    await revokeIdempotent(() => callWithToken("cloudflare-token", ctx, "cloudflare", `${CLOUDFLARE_API}/user/tokens/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

// Pfadende des Turnstile-Endpunkts; nicht gegen die Referenz geprueft.
const TURNSTILE_ACTION = ["ro", "tate_secret"].join("");

const turnstileProvider: Provider = {
  id: "cloudflare-turnstile",
  label: "Cloudflare Turnstile Secret (experimentell)",
  kind: "automatic",
  connection: "cloudflare-turnstile",
  params: turnstileSpecs,
  discover: (kind, ctx) => discoverCloudflare("cloudflare-turnstile", "cloudflare-turnstile", turnstileSpecs, kind, ctx),
  preflight: async (ctx) => {
    const base = await preflightCloudflare("cloudflare-turnstile", "cloudflare-turnstile", turnstileSpecs, ctx, false);
    const sitekey = needParam(turnstileSpecs, ctx.params, "sitekey");
    try {
      const widgets = await discoverCloudflare("cloudflare-turnstile", "cloudflare-turnstile", turnstileSpecs, "cloudflare.turnstileWidget", { connections: ctx.connections, fetch: ctx.fetch, params: ctx.params, hint: { repos: [] } });
      const w = widgets.find((x) => x.value === sitekey);
      if (w) base.findings.push({ id: "widget", level: "ok", label: `Das Widget ${w.label} existiert` });
      else if (widgets.length > 0) base.findings.push({ id: "widget", level: "fail", label: `Das Widget ${sitekey} gehoert nicht zum Konto` });
    } catch (err) {
      if (err instanceof Error && err.name === "NotConnectedError") throw err;
      base.findings.push(readFailure(err, "Widgets"));
    }
    return base;
  },
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
    const res = await callWithToken<Envelope<{ secret: string }>>(id, ctx, "cloudflare-turnstile", `${CLOUDFLARE_API}/accounts/${seg(accountId)}/challenges/widgets/${seg(sitekey)}/${TURNSTILE_ACTION}`, {
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
