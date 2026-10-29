import { z } from "zod";

/**
 * Quelle einer Variable: Der Sollwert kann aus der verbundenen Integration gelesen werden (Projekt-Ref, Konto-Kennung,
 * Sitekey ...), statt ihn abzutippen. Erlaubt sind nur Felder auf dieser Liste; sie sind oeffentlich oder reine Kennungen.
 * Geheime Felder (service_role, Secret Keys, Turnstile-Secret ...) stehen hier nie und werden nie geladen.
 */
export interface VariableSourceField {
  field: string;
  label: string;
  labelEn: string;
}

export interface VariableSourceKind {
  kind: string;
  /** Verbindung der Integration, aus der gelesen wird. */
  connection: string;
  label: string;
  labelEn: string;
  fields: VariableSourceField[];
}

export const VARIABLE_SOURCES: readonly VariableSourceKind[] = [
  {
    kind: "supabase.project",
    connection: "supabase",
    label: "Supabase-Projekt",
    labelEn: "Supabase project",
    fields: [
      { field: "ref", label: "Projekt-Ref", labelEn: "Project ref" },
      { field: "url", label: "Projekt-Adresse", labelEn: "Project URL" },
      { field: "publishableKey", label: "Oeffentlicher Schluessel (publishable/anon)", labelEn: "Public key (publishable/anon)" },
    ],
  },
  {
    kind: "cloudflare.account",
    connection: "cloudflare",
    label: "Cloudflare-Konto",
    labelEn: "Cloudflare account",
    fields: [{ field: "accountId", label: "Konto-Kennung", labelEn: "Account id" }],
  },
  {
    kind: "cloudflare.zone",
    connection: "cloudflare",
    label: "Cloudflare-Zone",
    labelEn: "Cloudflare zone",
    fields: [
      { field: "zoneId", label: "Zonen-Kennung", labelEn: "Zone id" },
      { field: "name", label: "Zonenname", labelEn: "Zone name" },
    ],
  },
  {
    kind: "cloudflare.turnstileWidget",
    connection: "cloudflare-turnstile",
    label: "Turnstile-Widget",
    labelEn: "Turnstile widget",
    fields: [{ field: "sitekey", label: "Sitekey (oeffentlich)", labelEn: "Sitekey (public)" }],
  },
  {
    kind: "resend.domain",
    connection: "resend",
    label: "Resend-Domain",
    labelEn: "Resend domain",
    fields: [
      { field: "domainId", label: "Domain-Kennung", labelEn: "Domain id" },
      { field: "name", label: "Domainname", labelEn: "Domain name" },
    ],
  },
];

export const variableSourceKind = (kind: string): VariableSourceKind | undefined => VARIABLE_SOURCES.find((k) => k.kind === kind);

export const VariableSourceSchema = z
  .strictObject({
    connection: z.string().min(1).max(60),
    kind: z.string().min(1).max(60),
    /** Wert der gewaehlten Ressource (Projekt-Ref, Konto-Id ...), wie die Entdeckung ihn liefert. */
    resource: z.string().min(1).max(200),
    field: z.string().min(1).max(40),
  })
  .superRefine((s, ctx) => {
    const k = variableSourceKind(s.kind);
    if (!k) return void ctx.addIssue({ code: "custom", message: `Unbekannte Quelle: ${s.kind}`, path: ["kind"] });
    if (k.connection !== s.connection) ctx.addIssue({ code: "custom", message: `Die Quelle ${s.kind} gehoert zur Verbindung ${k.connection}`, path: ["connection"] });
    if (!k.fields.some((f) => f.field === s.field)) ctx.addIssue({ code: "custom", message: `Feld nicht erlaubt: ${s.field}`, path: ["field"] });
  });
export type VariableSource = z.infer<typeof VariableSourceSchema>;
