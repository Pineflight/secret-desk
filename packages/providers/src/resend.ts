import { SecretValue, type Check, type Provider } from "@secret-desk/core";
import { check, isRecord, probeWithConnection, step } from "./checks.js";
import { badResponse, callWithToken, JSON_HEADERS, optionalString, ProviderError, revokeIdempotent, seg } from "./http.js";

const API = "https://api.resend.com/api-keys";
const ID = "resend-api-key";

export const resendProvider: Provider = {
  id: ID,
  label: "Resend API-Key",
  kind: "automatic",
  connection: "resend",
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
