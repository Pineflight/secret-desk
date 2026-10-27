/** Beschreibung der Zugaenge, mit denen das Portal arbeitet: Wofuer, wo man ihn anlegt und was er koennen muss. Keine Werte. */
export interface ConnectionGuide {
  label: string;
  description: string;
  /** Feste Seite des Anbieters. */
  url: string;
  /** Seite mit vorausgefuellten Feldern, falls der Anbieter es per Link erlaubt. */
  openUrl?: string;
  steps: string[];
  /** Rechte, die der Zugang braucht. */
  permissions: string[];
}

export function connectionGuide(id: string, owner: string): ConnectionGuide | undefined {
  switch (id) {
    case "github": {
      const q = new URLSearchParams({
        name: "secret-desk",
        description: "secret-desk: Secrets und Variablen verwalten",
        target_name: owner,
        expires_in: "90",
        secrets: "write",
        variables: "write",
        environments: "read",
        metadata: "read",
      });
      return {
        label: "GitHub",
        description: "Schreibt Secrets und Variablen in die Repositories. Hier liegen am Ende alle Werte.",
        url: "https://github.com/settings/personal-access-tokens/new",
        openUrl: `https://github.com/settings/personal-access-tokens/new?${q.toString()}`,
        steps: [
          "Der Link oeffnet das Formular mit Name, Eigentuemer, Ablauf (90 Tage) und Rechten schon eingetragen: kurz gegenpruefen.",
          "Unter Repository access \"Only select repositories\" waehlen und nur die Repositories ankreuzen, die das Portal verwalten soll (das kann GitHub nicht vorausfuellen).",
          "Token erzeugen, kopieren und unten einfuegen.",
          "Fuer Organisations-Secrets braucht der Token zusaetzlich das Organisationsrecht \"Secrets\" (Read and write).",
        ],
        permissions: ["Secrets: Read and write", "Variables: Read and write", "Environments: Read", "Metadata: Read"],
      };
    }
    case "cloudflare":
      return {
        label: "Cloudflare",
        description: "Erzeugt und widerruft Cloudflare-Tokens und Turnstile-Schluessel.",
        url: "https://dash.cloudflare.com/profile/api-tokens",
        steps: [
          "My Profile, API Tokens, \"Create Token\", dann \"Custom token\".",
          "Recht \"User, API Tokens, Edit\" waehlen (fuer Turnstile zusaetzlich \"Account, Turnstile, Edit\").",
          "Kurzen Ablauf setzen (zum Beispiel 1 bis 7 Tage), Token erzeugen und unten einfuegen.",
        ],
        permissions: ["User > API Tokens > Edit", "Account > Turnstile > Edit (nur fuer Turnstile)"],
      };
    case "supabase":
      return {
        label: "Supabase",
        description: "Liest und erneuert API-Keys der Supabase-Projekte.",
        url: "https://supabase.com/dashboard/account/tokens",
        steps: ["Account, Access Tokens, \"Generate new token\".", "Name mit Datum, Ablauf setzen, Token kopieren und unten einfuegen."],
        permissions: ["Zugriff auf die Organisation der Projekte"],
      };
    case "stripe":
      return {
        label: "Stripe",
        description: "Verwaltet Webhook-Endpunkte und Signaturschluessel.",
        url: "https://dashboard.stripe.com/apikeys",
        steps: ["Developers, API keys, \"Create restricted key\".", "Nur Webhook Endpoints (Write) freigeben, Schluessel kopieren und unten einfuegen."],
        permissions: ["Webhook Endpoints: Write"],
      };
    case "resend":
      return {
        label: "Resend",
        description: "Erzeugt und widerruft Resend-API-Keys.",
        url: "https://resend.com/api-keys",
        steps: ["API Keys, \"Create API Key\" mit Recht \"Full access\" (Keys anlegen geht nur damit).", "Key kopieren und unten einfuegen."],
        permissions: ["Full access"],
      };
    case "grafana":
      return {
        label: "Grafana Cloud",
        description: "Erzeugt und widerruft Grafana-Cloud-Tokens.",
        url: "https://grafana.com/orgs",
        steps: ["Organisation, Access Policies, Policy mit Recht zum Verwalten von Tokens anlegen.", "Token der Policy erzeugen, kopieren und unten einfuegen."],
        permissions: ["Access Policies: Write (Tokens verwalten)"],
      };
    default:
      return undefined;
  }
}
