import type { DiscoveredOption, DiscoverContext } from "@secret-desk/core";
import { asList, getJson, str } from "./discover.js";
import { ProviderError } from "./http.js";

const SUPABASE = "https://api.supabase.com";

/**
 * Liest ein erlaubtes Feld einer entdeckten Ressource (Allowlist: core/variable-sources.ts). Nur lesend und nur oeffentliche
 * Felder. Der oeffentliche Supabase-Schluessel kommt aus der Schluesselliste OHNE reveal und nur aus Eintraegen vom Typ
 * publishable bzw. anon; service_role und secret werden nie ausgewaehlt.
 */
export async function readVariableField(kind: string, field: string, option: DiscoveredOption, ctx: Pick<DiscoverContext, "connections" | "fetch">): Promise<string> {
  const id = String(option.value);
  switch (`${kind}:${field}`) {
    case "supabase.project:ref":
    case "cloudflare.account:accountId":
    case "cloudflare.zone:zoneId":
    case "cloudflare.turnstileWidget:sitekey":
    case "resend.domain:domainId":
      return id;
    case "cloudflare.zone:name":
    case "resend.domain:name":
      return option.label;
    case "supabase.project:url":
      return `https://${id}.supabase.co`;
    case "supabase.project:publishableKey": {
      const keys = asList(await getJson<unknown>("supabase", ctx, "supabase", `${SUPABASE}/v1/projects/${encodeURIComponent(id)}/api-keys`));
      const pub = keys.find((k) => (k["type"] === "publishable" || k["name"] === "anon" || k["name"] === "publishable") && k["name"] !== "service_role" && k["type"] !== "secret" && str(k["api_key"]));
      if (!pub) throw new ProviderError("supabase", null, "Kein oeffentlicher Schluessel im Projekt gefunden");
      return str(pub["api_key"])!;
    }
    default:
      throw new ProviderError(kind, null, `Feld nicht erlaubt: ${field}`);
  }
}
