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

/** Direktlink auf die Service Accounts eines Stacks, nur fuer eine plausible https-Stack-Adresse. */
export function grafanaServiceAccountsUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && !u.username && !u.password ? `${u.origin}${u.pathname.replace(/\/+$/, "")}/org/serviceaccounts` : undefined;
  } catch {
    return undefined;
  }
}

export function connectionGuide(id: string, owner: string, options: { grafanaBaseUrl?: string; teamRepo?: string; teamRights?: string[] } = {}): ConnectionGuide | undefined {
  switch (id) {
    case "github": {
      const q = new URLSearchParams({
        name: "secret-desk",
        description: "secret-desk: Secrets und Variablen verwalten",
        target_name: owner,
        expires_in: "90",
        secrets: "write",
        actions_variables: "write",
        environments: "write",
        contents: "read",
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
          "Optional: Contents (Read-only). Damit liest der Stage-Vergleich die Workflow-Dateien (.github/workflows) und zeigt, welche Secrets und Variablen sie brauchen. Ohne das Recht funktioniert alles andere; lokal verknuepfte Repositories brauchen es nicht.",
        ],
        permissions: ["Secrets: Read and write", "Variables: Read and write", "Environments: Read and write (needed for environment secrets)", "Contents: Read (optional, to read workflow files)", "Metadata: Read"],
      };
    }
    case "team-sync": {
      const repo = options.teamRepo ?? "";
      const [repoOwner, repoName] = repo.split("/");
      const rights = options.teamRights ?? ["Contents: Read", "Metadata: Read"];
      const q = new URLSearchParams({
        name: "secret-desk team sync",
        description: "secret-desk: Team-Datei im Team-Repository lesen und schreiben (keine Werte)",
        target_name: repoOwner ?? owner,
        expires_in: "90",
        contents: rights.some((r) => r.startsWith("Contents: Read and write")) ? "write" : "read",
        ...(rights.some((r) => r.startsWith("Pull requests")) ? { pull_requests: "write" } : {}),
        metadata: "read",
      });
      return {
        label: "Team-Repository",
        description: "Liest (und, wenn eingestellt, schreibt) die Team-Datei im privaten GitHub-Repository. Ohne eigenes Token hier wird die GitHub-Integration verwendet; bei einer GitHub App fordert das Portal je Lauf ein kurzlebiges Token nur fuer dieses Repository an. Die Datei enthaelt nur Struktur, keine Werte.",
        url: "https://github.com/settings/personal-access-tokens/new",
        openUrl: `https://github.com/settings/personal-access-tokens/new?${q.toString()}`,
        steps: [
          "Nur noetig, wenn die GitHub-Integration nicht reicht (zum Beispiel ein PAT ohne Zugriff auf das Team-Repository). Fine-grained Tokens lassen sich bei GitHub nicht per API erzeugen.",
          `Der Link oeffnet das Formular mit Name, Eigentuemer${repoOwner ? ` (${repoOwner})` : ""}, Ablauf (90 Tage) und Rechten schon eingetragen: kurz gegenpruefen.`,
          `Unter Repository access "Only select repositories" waehlen und genau ${repoName ? `${repoName}` : "das Team-Repository"} ankreuzen (das kann GitHub nicht vorausfuellen).`,
          `Rechte: ${rights.join(", ")}.`,
          "Token erzeugen, kopieren und unten einfuegen. Er wird nie in eine Datei geschrieben.",
          "Mit Browser-Automatisierung (nicht im Container) laesst sich dafuer ein Eintrag mit dem Anbieter github-fine-grained-token anlegen; die Rechte oben gelten auch dort.",
        ],
        permissions: rights,
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
          "Konten und Zonen lassen sich im Portal nur auswaehlen, wenn das Token sie lesen darf. Mit der Vorlage geht das nicht: Dann die Konto-ID einmal von Hand als Standardwert eintragen (Cloudflare-Dashboard, Konto-Uebersicht, Konto-ID kopieren).",
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
    case "stripe-test":
    case "stripe-live": {
      const live = id === "stripe-live";
      return {
        label: live ? "Stripe (Live)" : "Stripe (Sandbox)",
        description: live
          ? "Legt Webhook-Endpunkte im Live-Modus an und widerruft sie. Wird fuer Stages der Art live bevorzugt."
          : "Legt Webhook-Endpunkte in der Sandbox an und widerruft sie. Wird fuer Stages der Art test bevorzugt.",
        url: "https://dashboard.stripe.com/apikeys",
        steps: [
          live ? "Developers, API keys, im Live-Modus \"Create restricted key\"." : "In der Sandbox: Developers, API keys, \"Create restricted key\".",
          "Alle Ressourcen auf \"None\" lassen und nur \"Webhook Endpoints\" auf \"Write\" setzen.",
          live ? "Der Schluessel beginnt mit rk_live_. Ein Sandbox-Schluessel (rk_test_) wird hier abgelehnt." : "Der Schluessel beginnt mit rk_test_. Ein Live-Schluessel (rk_live_) wird hier abgelehnt.",
          "Schluessel kopieren und unten einfuegen. Er wird nur einmal angezeigt.",
        ],
        permissions: [
          "Webhook Endpoints: Write (schliesst Lesen ein)",
          "Optional Balance: Read (Funktionstest des Schluessels, ohne das Recht nur ein Hinweis)",
        ],
      };
    }
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
        // Ohne Stack-Adresse fuehrt grafana.com/profile/org angemeldete Nutzer auf ihre Organisation (grafana.com/orgs braucht einen Slug und liefert 404).
        url: "https://grafana.com/profile/org",
        ...(grafanaServiceAccountsUrl(options.grafanaBaseUrl) ? { openUrl: grafanaServiceAccountsUrl(options.grafanaBaseUrl)! } : {}),
        steps: [
          "Den Stack oeffnen (ueber den Link oder in grafana.com unter Ihrer Organisation, dann \"Launch\").",
          "Im Stack unter Administration, Users and access, Service accounts einen Service-Account fuer secret-desk anlegen (Rolle Admin, damit er Tokens anderer Service-Accounts verwalten darf).",
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

/**
 * Passt das Praefix des Tokens zur Verbindung? Nur fuer Stripe getrennt nach Modus (stripe-test / stripe-live).
 * Gibt eine Fehlermeldung zurueck oder undefined. Unbekannte Praefixe werden nicht beanstandet.
 */
export function tokenPrefixProblem(id: string, token: string): string | undefined {
  const mode = /^[rs]k_(test|live)_/.exec(token.trim())?.[1];
  if (!mode) return undefined;
  if (id === "stripe-test" && mode === "live") return "Das ist ein Live-Schluessel (rk_live_). Die Verbindung Stripe (Sandbox) braucht einen Sandbox-Schluessel (rk_test_). Fuer Live die Verbindung Stripe (Live) verwenden.";
  if (id === "stripe-live" && mode === "test") return "Das ist ein Sandbox-Schluessel (rk_test_). Die Verbindung Stripe (Live) braucht einen Live-Schluessel (rk_live_). Fuer die Sandbox die Verbindung Stripe (Sandbox) verwenden.";
  return undefined;
}
