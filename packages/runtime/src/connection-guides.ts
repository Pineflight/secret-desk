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
        actions_variables: "write",
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
        description: "Erzeugt, prueft und widerruft weitere Cloudflare-Tokens (Benutzer-Tokens).",
        url: "https://dash.cloudflare.com/profile/api-tokens",
        steps: [
          "My Profile, API Tokens, \"Create Token\", dann die Vorlage \"Create additional tokens\" waehlen.",
          "Keine weiteren Rechte hinzufuegen: Ein Token, der Tokens erzeugen darf, kann Zugriff auf alle Ressourcen deines Benutzers vergeben.",
          "Ablauf kurz setzen (zum Beispiel 1 bis 7 Tage) und wenn moeglich die IP-Adresse des Rechners eintragen, auf dem das Portal laeuft.",
          "Token erzeugen, kopieren und unten einfuegen.",
        ],
        permissions: [
          "User > API Tokens > Edit (nur in der Vorlage \"Create additional tokens\" waehlbar)",
        ],
      };
    case "cloudflare-turnstile":
      return {
        label: "Cloudflare Turnstile",
        description: "Erneuert das Secret eines Turnstile-Widgets. Eigener Token, weil das Recht zum Erzeugen von Tokens nicht mit anderen Rechten kombiniert werden kann.",
        url: "https://dash.cloudflare.com/profile/api-tokens",
        steps: [
          "My Profile, API Tokens, \"Create Token\", dann \"Create Custom Token\" waehlen.",
          "Recht \"Account, Turnstile, Edit\" hinzufuegen und unter Account Resources nur das Konto mit dem Widget waehlen.",
          "Ablauf kurz setzen, Token erzeugen, kopieren und unten einfuegen.",
        ],
        permissions: [
          "Account > Turnstile > Edit (der Name in Cloudflares Rechteliste kann abweichen, siehe GET /user/tokens/permission_groups)",
          "Konto-Ressource: nur das Konto mit dem Widget",
        ],
      };
    case "supabase":
      return {
        label: "Supabase",
        description: "Liest, erzeugt und loescht API-Keys von Supabase-Projekten ueber die Management-API.",
        url: "https://supabase.com/dashboard/account/tokens",
        steps: [
          "Account, Access Tokens, \"Generate new token\".",
          "Als Zugriff nur die Organisation bzw. die Projekte waehlen, deren Keys das Portal verwalten soll, und die oben genannten Rechte setzen. Ein Token kann nie mehr als deine eigene Rolle im Projekt (Owner oder Admin noetig).",
          "Ein Token mit vollem Kontozugriff (\"Legacy\") funktioniert auch, ist aber nicht empfohlen.",
          "Token kopieren und unten einfuegen. Er wird nur einmal angezeigt.",
        ],
        permissions: [
          "API Keys: Read-write (Keys erzeugen und loeschen)",
          "API Key Secrets: Read (Keys mit Wert lesen)",
          "Optional Project Settings: Read, Projects: Read (Projekt nachschlagen)",
        ],
      };
    case "stripe":
      return {
        label: "Stripe",
        description: "Legt Webhook-Endpunkte an und widerruft sie, und liest damit deren Signaturschluessel.",
        url: "https://dashboard.stripe.com/apikeys",
        steps: [
          "Developers, API keys, \"Create restricted key\".",
          "Alle Ressourcen auf \"None\" lassen und nur \"Webhook Endpoints\" auf \"Write\" setzen.",
          "Pro Modus ein Schluessel: Sandbox (rk_test_) fuer Test-Stages, Live (rk_live_) fuer Produktion.",
          "Schluessel kopieren und unten einfuegen. Er wird nur einmal angezeigt.",
        ],
        permissions: [
          "Webhook Endpoints: Write (schliesst Lesen ein)",
          "Optional Balance: Read (Funktionstest des Schluessels, ohne das Recht nur ein Hinweis)",
        ],
      };
    case "resend":
      return {
        label: "Resend",
        description: "Erzeugt, listet und widerruft Resend-API-Keys.",
        url: "https://resend.com/api-keys",
        steps: [
          "API Keys, \"Create API Key\" mit der Berechtigung \"Full access\".",
          "Key kopieren und unten einfuegen. Er wird nur einmal angezeigt. Die von secret-desk erzeugten Keys sind dagegen eng gefasst (\"Sending access\", optional auf eine Domain beschraenkt).",
        ],
        permissions: [
          "Full access (nur dieser Typ darf API-Keys verwalten; \"Sending access\" kann nur Mails senden)",
        ],
      };
    case "grafana":
      return {
        label: "Grafana Cloud",
        description: "Erzeugt und widerruft Token von Service-Accounts in einem Grafana-Stack.",
        url: "https://grafana.com/orgs",
        steps: [
          "Im Grafana-Stack unter Administration, Users and access, Service accounts einen Service-Account fuer secret-desk anlegen (Rolle Admin, damit er Tokens anderer Service-Accounts verwalten darf).",
          "Fuer diesen Service-Account einen Token mit kurzem Ablauf erzeugen, kopieren und unten einfuegen.",
          "Die Basis-Adresse des Stacks und die Id des Ziel-Service-Accounts tragen die Secrets im Inventar als Parameter.",
        ],
        permissions: [
          "serviceaccounts:write auf serviceaccounts:id:* (Token erzeugen und loeschen)",
          "serviceaccounts:read auf serviceaccounts:id:* (Token auflisten, pruefen)",
          "Praktisch: Service-Account des Stacks mit der Rolle Admin",
        ],
      };
    default:
      return undefined;
  }
}
