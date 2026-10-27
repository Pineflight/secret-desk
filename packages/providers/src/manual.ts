import type { Check, Provider, ProviderGuide, SecretEntry, Stage, VerifyContext } from "@secret-desk/core";
import { check, day, isRecord, probeWithValue, step } from "./checks.js";

type Extras = Pick<Provider, "verify" | "reviewChecklist">;

function manual(id: string, label: string, url: string, steps: string[], extras: Extras, openUrl?: ProviderGuide["openUrl"]): Provider {
  return { id, label, kind: "manual", guide: { url, steps, ...(openUrl ? { openUrl } : {}) }, ...extras };
}

const GITHUB_PERMISSION = /^[a-z_]{3,40}$/;
const GITHUB_LEVELS = new Set(["read", "write", "admin"]);

/**
 * Link auf GitHubs Formular fuer fine-grained Tokens mit vorausgefuellten Feldern
 * (Name, Beschreibung, Eigentuemer, Ablauf, Rechte aus params.permissions).
 * Die Repository-Auswahl laesst GitHub nicht per Link zu; sie bleibt bewusst beim Menschen.
 */
export function githubTokenUrl(secret: SecretEntry, owner: string, now: Date): string {
  const q = new URLSearchParams();
  q.set("name", `${secret.id}-${now.toISOString().slice(0, 10).replaceAll("-", "")}`.slice(0, 40));
  if (secret.description) q.set("description", secret.description.slice(0, 1024));
  q.set("target_name", owner);
  q.set("expires_in", String(Math.min(366, Math.max(1, secret.ttlDays ?? 30))));
  const perms = secret.params["permissions"];
  if (isRecord(perms)) {
    for (const [key, level] of Object.entries(perms)) {
      if (GITHUB_PERMISSION.test(key) && typeof level === "string" && GITHUB_LEVELS.has(level)) q.set(key, level);
    }
  }
  return `https://github.com/settings/personal-access-tokens/new?${q.toString()}`;
}

const stagePhrase = (stage: Stage): string =>
  stage === "production" ? "Es ist der Zugang fuer Produktion" : stage === "shared" ? "Der Zugang passt zu allen Stages, die ihn nutzen" : "Es ist ein Test- bzw. Sandbox-Zugang, kein Produktionszugang";

/** Gemeinsame Pruefpunkte: Name, Rechte, Ablauf, Umgebung. */
function checklist(secret: SecretEntry, what: string, extra: string[] = []): string[] {
  return [
    `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
    `${what} nur die Rechte, die der Dienst braucht`,
    secret.ttlDays ? `Ablauf ist ${secret.ttlDays} Tage nach heute` : "Ablauf ist gesetzt, sofern der Anbieter einen anbietet",
    stagePhrase(secret.stage),
    ...extra,
  ];
}

export type StripeMode = "test" | "live";

/** Modus aus dem Praefix. restricted = rk_, sonst sk_. */
export function stripeKeyInfo(value: string): { mode: StripeMode; restricted: boolean } | undefined {
  const m = /^(rk|sk)_(test|live)_/.exec(value);
  return m ? { mode: m[2] as StripeMode, restricted: m[1] === "rk" } : undefined;
}

async function verifyStripeKey(ctx: VerifyContext): Promise<Check[]> {
  const info = stripeKeyInfo(ctx.value.reveal());
  const out: Check[] = [];
  const actual = info ? (info.mode === "live" ? "Live" : "Sandbox") : "unbekannt";
  if (!info) {
    out.push(check("mode", "Modus des Schluessels", "warn", { actual, detail: "Praefix ist weder rk_/sk_ test noch live" }));
  } else if (ctx.stage === "production") {
    out.push(check("mode", "Modus passt zur Stage", info.mode === "live" ? "pass" : "fail", { expected: "Live", actual }));
  } else if (ctx.stage === "shared") {
    out.push(check("mode", "Modus des Schluessels", "info", { actual, detail: "Stage shared: Modus bitte selbst beurteilen" }));
  } else {
    out.push(check("mode", "Modus passt zur Stage", info.mode === "test" ? "pass" : "fail", { expected: "Sandbox", actual }));
  }
  if (info) out.push(check("restricted", "Eingeschraenkter Schluessel", info.restricted ? "pass" : "warn", { actual: info.restricted ? "rk_" : "sk_", ...(info.restricted ? {} : { detail: "Kein eingeschraenkter Schluessel" }) }));
  const live = await step(ctx, "works", "Schluessel funktioniert", async () => {
    const r = await probeWithValue("stripe-restricted-key", ctx, "https://api.stripe.com/v1/balance");
    if (r.status >= 200 && r.status < 300) return [check("works", "Schluessel funktioniert", "pass", { actual: "HTTP 200" })];
    if (r.status === 401) return [check("works", "Schluessel funktioniert", "fail", { actual: "HTTP 401", detail: "Stripe lehnt den Schluessel ab" })];
    if (r.status === 403) return [check("works", "Schluessel funktioniert", "info", { actual: "HTTP 403", detail: "Schluessel hat keine Leserechte auf Guthaben (bei eingeschraenkten Schluesseln normal)" })];
    return [check("works", "Schluessel funktioniert", "warn", { actual: `HTTP ${r.status}` })];
  });
  return [...out, ...live];
}

async function verifyGithub(ctx: VerifyContext): Promise<Check[]> {
  return step(ctx, "works", "Token funktioniert", async () => {
    const r = await probeWithValue("github-fine-grained-token", ctx, "https://api.github.com/user", { Accept: "application/vnd.github+json" });
    if (r.status === 401) return [check("works", "Token funktioniert", "fail", { actual: "HTTP 401", detail: "GitHub lehnt den Token ab" })];
    if (r.status < 200 || r.status >= 300) return [check("works", "Token funktioniert", "warn", { actual: `HTTP ${r.status}` })];
    const login = isRecord(r.json) && typeof r.json["login"] === "string" ? r.json["login"] : "unbekannt";
    const out: Check[] = [check("works", "Token funktioniert", "pass", { actual: login })];
    const header = r.headers.get("github-authentication-token-expiration");
    const date = header ? new Date(header.replace(" UTC", "Z").replace(" ", "T")) : undefined;
    if (!header || !date || Number.isNaN(date.getTime())) {
      out.push(check("expires", "Ablauf des Tokens", "warn", { actual: "kein Ablauf", detail: "Der Token laeuft nie ab" }));
    } else {
      const days = (date.getTime() - ctx.now.getTime()) / 86_400_000;
      out.push(check("expires", "Ablauf des Tokens", days > 400 ? "warn" : "pass", { actual: day(date.toISOString()), ...(days > 400 ? { detail: "Ablauf liegt mehr als 400 Tage in der Zukunft" } : {}) }));
    }
    return out;
  });
}

async function verifySupabaseToken(ctx: VerifyContext): Promise<Check[]> {
  return step(ctx, "works", "Token funktioniert", async () => {
    const r = await probeWithValue("supabase-access-token", ctx, "https://api.supabase.com/v1/organizations");
    if (r.status === 401) return [check("works", "Token funktioniert", "fail", { actual: "HTTP 401", detail: "Supabase lehnt den Token ab" })];
    if (r.status < 200 || r.status >= 300) return [check("works", "Token funktioniert", "warn", { actual: `HTTP ${r.status}` })];
    const out: Check[] = [check("works", "Token funktioniert", "pass", { actual: "HTTP 200" })];
    if (Array.isArray(r.json)) out.push(check("organizations", "Sichtbare Organisationen", "info", { actual: String(r.json.length) }));
    return out;
  });
}

async function verifyOpenai(ctx: VerifyContext): Promise<Check[]> {
  return step(ctx, "works", "Schluessel funktioniert", async () => {
    const r = await probeWithValue("openai", ctx, "https://api.openai.com/v1/models?limit=1");
    if (r.status >= 200 && r.status < 300) return [check("works", "Schluessel funktioniert", "pass", { actual: "HTTP 200" })];
    if (r.status === 401) return [check("works", "Schluessel funktioniert", "fail", { actual: "HTTP 401", detail: "OpenAI lehnt den Schluessel ab" })];
    return [check("works", "Schluessel funktioniert", "warn", { actual: `HTTP ${r.status}` })];
  });
}

export const manualProviders: Provider[] = [
  manual("stripe-restricted-key", "Stripe Restricted Key", "https://dashboard.stripe.com/apikeys", [
    "Im Stripe-Dashboard oben das richtige Konto waehlen.",
    "Fuer Tests in die Sandbox wechseln, fuer Produktion im Live-Modus bleiben.",
    "Unter Entwickler > API-Schluessel \"Eingeschraenkten Schluessel erstellen\" waehlen.",
    "Nur die Rechte vergeben, die der Dienst braucht, und einen Namen mit Datum setzen.",
    "Schluessel kopieren und im Portal einfuegen; danach den alten Schluessel im Dashboard loeschen.",
  ], {
    verify: verifyStripeKey,
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat", ["Das Stripe-Konto ist das des richtigen Produkts"]),
  }),
  manual("supabase-access-token", "Supabase Access Token", "https://supabase.com/dashboard/account/tokens", [
    "Im Supabase-Dashboard unter Account > Access Tokens oeffnen.",
    "\"Generate new token\" waehlen und einen Namen mit Datum vergeben.",
    "Token sofort kopieren, er wird nur einmal angezeigt.",
    "Im Portal einfuegen und den alten Token in der Liste loeschen.",
  ], {
    verify: verifySupabaseToken,
    reviewChecklist: (secret) => checklist(secret, "Der Token hat", ["Der Token gehoert zum richtigen Supabase-Konto"]),
  }),
  manual("github-fine-grained-token", "GitHub Fine-grained Token", "https://github.com/settings/personal-access-tokens/new", [
    "Token-Namen mit Datum vergeben und Ablaufdatum setzen (hoechstens 90 Tage empfohlen).",
    "Name, Eigentuemer, Ablauf und Rechte sind ueber den Knopf bereits vorausgefuellt: kurz gegenpruefen.",
    "Unter Repository access nur die benoetigten Repositories waehlen (das kann GitHub nicht vorausfuellen).",
    "Token erzeugen, kopieren und im Portal einfuegen.",
    "Alten Token unter Settings > Developer settings widerrufen.",
  ], {
    verify: verifyGithub,
    reviewChecklist: (secret) => checklist(secret, "Der Token hat", ["Eigentuemer ist die Organisation Pineflight, nur die noetigen Repositories sind gewaehlt"]),
  }, (secret, ctx) => githubTokenUrl(secret, ctx.owner, ctx.now)),
  manual("peecho", "Peecho", "https://www.peecho.com", [
    "Im Peecho-Konto den Bereich fuer API-Zugang oeffnen.",
    "Neuen API-Schluessel erzeugen (Sandbox oder Live passend zur Stage).",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel im Peecho-Konto deaktivieren.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat", ["Sandbox oder Live passt zur Stage"]),
  }),
  manual("vesselapi", "VesselAPI", "https://vesselapi.com", [
    "Im VesselAPI-Konto den Bereich API-Keys oeffnen.",
    "Neuen Schluessel erzeugen und einen Namen mit Datum setzen.",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel loeschen.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat"),
  }),
  manual("dip-bundestag", "DIP Bundestag", "https://dip.bundestag.de/api", [
    "Auf der DIP-API-Seite die Hinweise zum API-Schluessel oeffnen.",
    "Aktuellen oeffentlichen Schluessel bzw. einen neu beantragten Schluessel uebernehmen.",
    "Wert kopieren und im Portal einfuegen.",
    "Pruefen, ob der alte Schluessel noch gilt, und ihn ersetzen.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat", ["Der Schluessel ist aktuell und nicht abgelaufen"]),
  }),
  manual("telegram-bot", "Telegram Bot Token", "https://t.me/BotFather", [
    "Im Chat mit @BotFather /mybots senden und den Bot waehlen.",
    "Bot Settings > API Token > Revoke current token waehlen.",
    "Den neuen Token kopieren (der alte ist sofort ungueltig).",
    "Im Portal einfuegen und alle Ziele des Secrets zuegig aktualisieren.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Bot hat", ["Der Token gehoert zum richtigen Bot, bei Staging nicht zum Produktions-Bot"]),
  }),
  manual("awin", "Awin", "https://ui.awin.com", [
    "Bei Awin anmelden und unter Konto > API Credentials oeffnen.",
    "Neues OAuth2-Token bzw. neuen Publisher-API-Schluessel erzeugen.",
    "Wert kopieren und im Portal einfuegen.",
    "Alten Schluessel entfernen, sobald alle Ziele aktualisiert sind.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Zugang hat"),
  }),
  manual("revenuecat", "RevenueCat", "https://app.revenuecat.com", [
    "Im RevenueCat-Dashboard das richtige Projekt waehlen.",
    "Unter Projekteinstellungen > API keys einen neuen Schluessel anlegen (passenden Typ waehlen).",
    "Schluessel kopieren und im Portal einfuegen.",
    "Alten Schluessel in der Liste loeschen.",
  ], {
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat", ["Das Projekt und der Schluesseltyp (public/secret) stimmen"]),
  }),
  manual("openai", "OpenAI API-Key", "https://platform.openai.com/api-keys", [
    "Im richtigen Projekt der OpenAI-Plattform \"Create new secret key\" waehlen.",
    "Namen mit Datum vergeben und Rechte auf das Noetige begrenzen.",
    "Schluessel sofort kopieren, er wird nur einmal angezeigt.",
    "Im Portal einfuegen und den alten Schluessel in der Liste widerrufen.",
    "Kostenlimit des Projekts pruefen.",
  ], {
    verify: verifyOpenai,
    reviewChecklist: (secret) => checklist(secret, "Der Schluessel hat", ["Das Projekt ist das richtige und hat ein Kostenlimit"]),
  }),
];
