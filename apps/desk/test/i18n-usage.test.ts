import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDORS, VENDOR_CATEGORIES } from "@secret-desk/core";
import { messages } from "../src/messages";

/** Jeder in den Parameter-Oberflaechen benutzte Textschluessel existiert in Deutsch und Englisch. */
const FILES = [
  "components/ParamsForm.tsx",
  "components/ParamsCard.tsx",
  "components/CompleteParamsDialog.tsx",
  "components/NormalizeDialog.tsx",
  "components/ConnectionResources.tsx",
  "components/ResourceMap.tsx",
  "components/VariableSource.tsx",
  "lib/params-form.ts",
  "app/entries/page.tsx",
  "components/NewEntryDialog.tsx",
  "components/SecretForm.tsx",
  "components/VariableDialogs.tsx",
  "app/secrets/[id]/page.tsx",
  "app/connections/page.tsx",
  "app/page.tsx",
  "components/IntegrationsOverview.tsx",
  "components/ProviderFacade.tsx",
  "components/ProviderCards.tsx",
];

describe("i18n keys used by the parameter screens", () => {
  it("are defined in both languages", () => {
    const missing: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(join(__dirname, "../src", f), "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([a-zA-Z]+\.[\w.]+)"/g)) {
        const key = m[1]!;
        const has = (l: "de" | "en") => key in messages[l] || `${key}.other` in messages[l];
        if (!has("de") || !has("en")) missing.push(`${f}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("covers the dynamic problem and kind keys", () => {
    for (const code of ["missing", "wrong_type", "not_in_options", "unknown_key"]) {
      expect(messages.de[`params.problem.${code}`]).toBeTruthy();
      expect(messages.en[`params.problem.${code}`]).toBeTruthy();
    }
    for (const kind of ["cloudflare.account", "cloudflare.zone", "cloudflare.permissionGroups", "cloudflare.turnstileWidget", "supabase.project", "resend.domain", "revenuecat.project", "revenuecat.app", "revenuecat.publicApiKey", "grafana.serviceAccount"]) {
      expect(messages.de[`params.kind.${kind}`]).toBeTruthy();
    }
    for (const key of ["params.conn.empty.cloudflare.account", "params.conn.empty.cloudflare.zone"]) {
      expect(messages.de[key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });
  it("has a name and a purpose for every category and vendor in both languages", () => {
    for (const l of ["de", "en"] as const) {
      for (const c of [...VENDOR_CATEGORIES]) expect(messages[l][`category.${c}`], `${l} category.${c}`).toBeTruthy();
      for (const v of VENDORS) expect(messages[l][`vendor.${v.id}.purpose`], `${l} vendor.${v.id}.purpose`).toBeTruthy();
    }
  });
});
