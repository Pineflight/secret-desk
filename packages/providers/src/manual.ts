import type { Provider } from "@secret-desk/core";

function manual(id: string, label: string, url: string, steps: string[]): Provider {
  return { id, label, kind: "manual", guide: { url, steps } };
}

export const manualProviders: Provider[] = [
  manual("stripe-restricted-key", "Stripe Restricted Key", "https://dashboard.stripe.com/apikeys", [
    "Im Stripe-Dashboard oben das richtige Konto waehlen.",
    "Fuer Tests in die Sandbox wechseln, fuer Produktion im Live-Modus bleiben.",
    "Unter Entwickler > API-Schluessel \"Eingeschraenkten Schluessel erstellen\" waehlen.",
    "Nur die Rechte vergeben, die der Dienst braucht, und einen Namen mit Datum setzen.",
    "Schluessel kopieren und im Portal einfuegen; danach den alten Schluessel im Dashboard loeschen.",
  ]),
  manual("supabase-access-token", "Supabase Access Token", "https://supabase.com/dashboard/account/tokens", [
    "Im Supabase-Dashboard unter Account > Access Tokens oeffnen.",
    "\"Generate new token\" waehlen und einen Namen mit Datum vergeben.",
    "Token sofort kopieren, er wird nur einmal angezeigt.",
    "Im Portal einfuegen und den alten Token in der Liste loeschen.",
  ]),
  manual("github-fine-grained-token", "GitHub Fine-grained Token", "https://github.com/settings/personal-access-tokens/new", [
    "Token-Namen mit Datum vergeben und Ablaufdatum setzen (hoechstens 90 Tage empfohlen).",
    "Als Ressourcen-Eigentuemer die Organisation Pineflight waehlen.",
    "Nur die benoetigten Repositories und minimalen Rechte auswaehlen.",
    "Token erzeugen, kopieren und im Portal einfuegen.",
    "Alten Token unter Settings > Developer settings widerrufen.",
  ]),
  manual("peecho", "Peecho", "https://www.peecho.com", [
    "Im Peecho-Konto den Bereich fuer API-Zugang oeffnen.",
    "Neuen API-Schluessel erzeugen (Sandbox oder Live passend zur Stage).",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel im Peecho-Konto deaktivieren.",
  ]),
  manual("vesselapi", "VesselAPI", "https://vesselapi.com", [
    "Im VesselAPI-Konto den Bereich API-Keys oeffnen.",
    "Neuen Schluessel erzeugen und einen Namen mit Datum setzen.",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel loeschen.",
  ]),
  manual("dip-bundestag", "DIP Bundestag", "https://dip.bundestag.de/api", [
    "Auf der DIP-API-Seite die Hinweise zum API-Schluessel oeffnen.",
    "Aktuellen oeffentlichen Schluessel bzw. einen neu beantragten Schluessel uebernehmen.",
    "Wert kopieren und im Portal einfuegen.",
    "Pruefen, ob der alte Schluessel noch gilt, und ihn ersetzen.",
  ]),
  manual("telegram-bot", "Telegram Bot Token", "https://t.me/BotFather", [
    "Im Chat mit @BotFather /mybots senden und den Bot waehlen.",
    "Bot Settings > API Token > Revoke current token waehlen.",
    "Den neuen Token kopieren (der alte ist sofort ungueltig).",
    "Im Portal einfuegen und alle Ziele des Secrets zuegig aktualisieren.",
  ]),
  manual("awin", "Awin", "https://ui.awin.com", [
    "Bei Awin anmelden und unter Konto > API Credentials oeffnen.",
    "Neues OAuth2-Token bzw. neuen Publisher-API-Schluessel erzeugen.",
    "Wert kopieren und im Portal einfuegen.",
    "Alten Schluessel entfernen, sobald alle Ziele aktualisiert sind.",
  ]),
  manual("revenuecat", "RevenueCat", "https://app.revenuecat.com", [
    "Im RevenueCat-Dashboard das richtige Projekt waehlen.",
    "Unter Projekteinstellungen > API keys einen neuen Schluessel anlegen (passenden Typ waehlen).",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel in der Liste loeschen.",
  ]),
  manual("openai", "OpenAI API-Key", "https://platform.openai.com/api-keys", [
    "Im richtigen Projekt der OpenAI-Plattform \"Create new secret key\" waehlen.",
    "Namen mit Datum vergeben und Rechte auf das Noetige begrenzen.",
    "Schluessel sofort kopieren, er wird nur einmal angezeigt.",
    "Im Portal einfuegen und den alten Schluessel in der Liste widerrufen.",
    "Kostenlimit des Projekts pruefen.",
  ]),
];
