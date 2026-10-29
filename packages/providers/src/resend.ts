import { SecretValue, type Check, type DiscoverContext, type DiscoveredOption, type ParamSpec, type PreflightContext, type PreflightFinding, type PreflightResult, type Provider } from "@secret-desk/core";
import { asList, getJson, readFailure, str, unknownKind } from "./discover.js";
import { check, isRecord, probeWithConnection, step } from "./checks.js";
import { badResponse, callWithToken, JSON_HEADERS, optionalString, ProviderError, revokeIdempotent, seg } from "./http.js";

const API = "https://api.resend.com/api-keys";
const ID = "resend-api-key";
const DOMAINS = "https://api.resend.com/domains";

const specs: ParamSpec[] = [
  {
    key: "permission",
    label: "Berechtigung",
    labelEn: "Permission",
    type: "enum",
    required: false,
    defaultValue: "sending_access",
    help: "sending_access darf nur senden und gilt fuer genau eine Domain, full_access fuer das ganze Konto.",
    helpEn: "sending_access may only send and applies to exactly one domain, full_access to the whole account.",
    options: [
      { value: "sending_access", label: "Nur senden (eine Domain)", labelEn: "Sending only (one domain)" },
      { value: "full_access", label: "Voller Zugriff (ganzes Konto)", labelEn: "Full access (whole account)" },
    ],
  },
  {
    key: "domainId",
    label: "Domain",
    labelEn: "Domain",
    type: "string",
    required: false,
    requiredWhen: { key: "permission", equals: "sending_access" },
    help: "Domain, fuer die der Schluessel senden darf. Pflicht bei sending_access, entfaellt bei full_access.",
    helpEn: "Domain the key may send for. Required for sending_access, not used for full_access.",
    discover: "resend.domain",
  },
];

async function listDomains(ctx: Pick<DiscoverContext, "connections" | "fetch">): Promise<(DiscoveredOption & { status?: string; name: string })[]> {
  const r = await getJson<unknown>(ID, ctx, "resend", DOMAINS);
  return asList(r, "data").flatMap((d) => {
    const id = str(d["id"]);
    const name = str(d["name"]);
    return id && name ? [{ value: id, label: name, name, ...(str(d["status"]) ? { status: str(d["status"])! } : {}), detail: `${str(d["status"]) ?? "unbekannt"}, ${id}` }] : [];
  });
}

async function preflightResend(ctx: PreflightContext): Promise<PreflightResult> {
  const permission = ctx.params["permission"] ?? "sending_access";
  if (permission === "full_access") return { resource: "Key mit vollem Zugriff (alle Domains)", findings: [{ id: "permission", level: "warn", label: "Voller Zugriff: der Schluessel gilt fuer das ganze Konto" }] };
  const domainId = String(ctx.params["domainId"]);
  const findings: PreflightFinding[] = [];
  let resource: string | null = `Key nur fuer Domain ${domainId}`;
  try {
    const domains = await listDomains(ctx);
    const hit = domains.find((d) => d.value === domainId);
    if (hit) {
      resource = `Key nur fuer Domain ${hit.name}`;
      findings.push({ id: "domain", level: "ok", label: `Die Domain ${hit.name} existiert im verbundenen Konto` });
      if (hit.status !== "verified") findings.push({ id: "verified", level: "warn", label: `Die Domain ${hit.name} ist nicht verifiziert (Status ${hit.status ?? "unbekannt"}): Senden schlaegt fehl, bis die DNS-Eintraege stimmen` });
    } else if (domains.length > 0) findings.push({ id: "domain", level: "fail", label: `Die Domain ${domainId} existiert im verbundenen Konto nicht`, detail: `Verfuegbar: ${domains.map((d) => d.name).join(", ")}` });
    else findings.push({ id: "domain", level: "warn", label: "Die Verbindung liefert keine Domains: Zuordnung nicht pruefbar" });
  } catch (err) {
    if (err instanceof Error && err.name === "NotConnectedError") throw err;
    findings.push(readFailure(err, "Domains"));
  }
  return { resource, findings };
}

export const resendProvider: Provider = {
  id: ID,
  label: "Resend API-Key",
  kind: "automatic",
  connection: "resend",
  params: specs,
  async discover(kind: string, ctx: DiscoverContext) {
    if (kind !== "resend.domain") return unknownKind(kind);
    return listDomains(ctx);
  },
  preflight: preflightResend,
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
  verify(ctx) {
    return step(ctx, "exists", "Schluessel beim Anbieter", async () => {
      // Die Liste ist seitenweise: alle Seiten lesen (bis zu 20), sonst fehlt ein aelterer Schluessel scheinbar.
      let r = await probeWithConnection(ID, ctx, "resend", `${API}?limit=100`);
      const pageOf = (json: unknown) => (isRecord(json) && Array.isArray(json["data"]) ? json["data"].filter(isRecord) : undefined);
      let list = pageOf(r.json);
      for (let page = 1; page < 20 && list && list.length > 0 && isRecord(r.json) && r.json["has_more"] === true && !list.some((k) => String(k["id"]) === ctx.externalId); page += 1) {
        r = await probeWithConnection(ID, ctx, "resend", `${API}?limit=100&after=${seg(String(list[list.length - 1]!["id"]))}`);
        const next = pageOf(r.json);
        if (!next || r.status < 200 || r.status >= 300) {
          list = undefined;
          break;
        }
        list = [...list, ...next];
      }
      if (r.status < 200 || r.status >= 300 || !list) return [check("exists", "Schluessel beim Anbieter", "warn", { actual: `HTTP ${r.status}`, detail: "Liste der Schluessel nicht lesbar" })];
      const entry = list.find((k) => String(k["id"]) === ctx.externalId);
      if (!ctx.externalId || !entry) return [check("exists", "Schluessel beim Anbieter", "fail", { expected: ctx.externalId ?? "Kennung", actual: "nicht in der Liste" })];
      const out: Check[] = [check("exists", "Schluessel beim Anbieter", "pass", { actual: `Kennung ${ctx.externalId}` })];
      const want = ctx.params["permission"] ?? "sending_access";
      const have = entry["permission"];
      if (typeof have === "string") out.push(check("permission", "Berechtigung", have === want ? "pass" : "fail", { expected: String(want), actual: have }));
      else out.push(check("permission", "Berechtigung", "info", { expected: String(want), detail: "Die Liste weist die Berechtigung nicht aus, bitte im Dashboard ansehen" }));
      return out;
    });
  },
  reviewChecklist(secret) {
    const perm = secret.params["permission"] ?? "sending_access";
    const domain = typeof secret.params["domainId"] === "string" ? secret.params["domainId"] : undefined;
    return [
      `Berechtigung ist ${String(perm)}`,
      domain ? `Der Schluessel ist auf die Domain ${domain} beschraenkt` : "Der Schluessel gilt fuer die vorgesehene Domain",
      "Der Name beim Anbieter traegt das heutige Datum",
    ];
  },
  async revoke(ctx) {
    await revokeIdempotent(() => callWithToken(ID, ctx, "resend", `${API}/${seg(ctx.externalId)}`, { method: "DELETE" }));
  },
};

export const resendProviders: Provider[] = [resendProvider];
