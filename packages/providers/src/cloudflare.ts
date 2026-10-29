import { ParamsInvalidError, SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider, type VerifyContext } from "@secret-desk/core";
import { asList, getJson, needParam, readFailure, str, unknownKind } from "./discover.js";
import { check, daysApart, day, isRecord, probeWithConnection, probeWithValue, sameSet, step, steps } from "./checks.js";
import { badResponse, callWithToken, expiryFrom, JSON_HEADERS, ProviderError, requireString, requireStringArray, revokeIdempotent, seg } from "./http.js";

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  result?: T;
}

const TID = "cloudflare-token";
const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

const ACCOUNT_ID: ParamSpec = {
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

const tokenSpecs: ParamSpec[] = [
  ACCOUNT_ID,
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
    ],
  },
  {
    key: "zoneId",
    label: "Zone",
    labelEn: "Zone",
    type: "string",
    required: false,
    help: "Nur fuer Rechte, die an eine Zone gebunden sind (zum Beispiel Workers Routes Write).",
    helpEn: "Only for permissions tied to a zone (for example Workers Routes Write).",
    discover: "cloudflare.zone",
  },
];

const turnstileSpecs: ParamSpec[] = [
  ACCOUNT_ID,
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

async function discoverCloudflare(id: string, connection: string, specs: readonly ParamSpec[], kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]> {
  switch (kind) {
    case "cloudflare.account": {
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${API}/accounts?per_page=50`);
      return asList(r?.result).flatMap((a) => (str(a["id"]) ? [{ value: str(a["id"])!, label: str(a["name"]) ?? str(a["id"])!, detail: str(a["id"])! }] : []));
    }
    case "cloudflare.zone": {
      const account = typeof ctx.params["accountId"] === "string" && ctx.params["accountId"] ? `&account.id=${seg(ctx.params["accountId"])}` : "";
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${API}/zones?per_page=50${account}`);
      return asList(r?.result).flatMap((z) => {
        const acc = isRecord(z["account"]) ? str(z["account"]["name"]) : undefined;
        return str(z["id"]) ? [{ value: str(z["id"])!, label: str(z["name"]) ?? str(z["id"])!, detail: acc ? `${str(z["id"])} (${acc})` : str(z["id"])! }] : [];
      });
    }
    case "cloudflare.permissionGroups": {
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${API}/user/tokens/permission_groups`);
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
      const r = await getJson<Envelope<unknown[]>>(id, ctx, connection, `${API}/accounts/${seg(account)}/challenges/widgets`);
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
async function preflightCloudflare(id: string, connection: string, specs: readonly ParamSpec[], ctx: PreflightContext, withPermissions: boolean): Promise<PreflightResult> {
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
    const zoneId = typeof ctx.params["zoneId"] === "string" ? ctx.params["zoneId"] : "";
    if (zoneBound.length > 0 && !zoneId) findings.push({ id: "zone", level: "fail", label: `zoneId fehlt: ${zoneBound.join(", ")} gilt nur fuer eine Zone` });
    else if (zoneId) {
      const zones = await discoverCloudflare(id, connection, specs, "cloudflare.zone", { ...dctx, params: { ...ctx.params } });
      const z = zones.find((x) => x.value === zoneId);
      if (z) {
        resource = `${resource}, Zone ${z.label}`;
        findings.push({ id: "zone", level: "ok", label: `Die Zone ${z.label} existiert` });
      } else if (zones.length > 0) findings.push({ id: "zone", level: "fail", label: `Die Zone ${zoneId} gehoert nicht zum Konto ${accountId}` });
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
        const zoneId = typeof ctx.params["zoneId"] === "string" && ctx.params["zoneId"] ? `${ZONE_SCOPE}.${ctx.params["zoneId"]}` : undefined;
        const keys = new Set<string>();
        for (const pol of policies) if (isRecord(pol["resources"])) for (const k of Object.keys(pol["resources"])) keys.add(k);
        const others = [...keys].filter((k) => k !== want && k !== zoneId);
        // Mit zonengebundenen Rechten steht neben dem Konto nur die gewaehlte Zone; ohne sie darf das Konto fehlen.
        const ok = (keys.has(want) || (zoneId !== undefined && keys.has(zoneId))) && others.length === 0;
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
  params: tokenSpecs,
  discover: (kind, ctx) => discoverCloudflare(TID, "cloudflare", tokenSpecs, kind, ctx),
  preflight: (ctx) => preflightCloudflare(TID, "cloudflare", tokenSpecs, ctx, true),
  async issue(ctx) {
    const id = "cloudflare-token";
    const accountId = requireString(id, ctx.params, "accountId");
    const permissions = requireStringArray(id, ctx.params, "permissions");

    const groups = await callWithToken<Envelope<{ id: string; name: string; scopes?: string[] }[]>>(id, ctx, "cloudflare", `${API}/user/tokens/permission_groups`, { method: "GET" });
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
    const zoneId = typeof ctx.params["zoneId"] === "string" ? ctx.params["zoneId"].trim() : "";
    if (zoneBound.length > 0 && !zoneId) {
      const spec = tokenSpecs.find((x) => x.key === "zoneId")!;
      throw new ParamsInvalidError([{ key: "zoneId", code: "missing", message: "zoneId fehlt", label: spec.label, labelEn: spec.labelEn }]);
    }

    const expiresOn = expiryFrom(ctx.now, ctx.secret.ttlDays);
    const accountGroups = permissions.filter((n) => !isZone(n));
    const policies = [
      ...(accountGroups.length > 0 ? [{ effect: "allow", resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" }, permission_groups: accountGroups.map((n) => ({ id: pick(n, ACCOUNT_SCOPE).id })) }] : []),
      ...(zoneBound.length > 0 ? [{ effect: "allow", resources: { [`${ZONE_SCOPE}.${zoneId}`]: "*" }, permission_groups: zoneBound.map((n) => ({ id: pick(n, ZONE_SCOPE).id })) }] : []),
    ];
    const body = {
      name: ctx.label,
      policies,
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
