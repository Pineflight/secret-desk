/** Reine Hilfen fuer die Integrationen-Karten: Ablauf-Ampel, Alter des gespeicherten Tokens, Praefix-Hinweis. */

export type ExpiryLevel = "ok" | "soon" | "critical" | "expired";

/** Ampel nach Restlaufzeit: ueber 14 Tage gruen, 7 bis 14 gelb, unter 7 rot, abgelaufen rot mit Hinweis. */
export function expiryLevel(daysLeft: number | null | undefined): ExpiryLevel | null {
  if (daysLeft === null || daysLeft === undefined) return null;
  if (daysLeft < 0) return "expired";
  if (daysLeft < 7) return "critical";
  if (daysLeft <= 14) return "soon";
  return "ok";
}

/** Tage seit dem Speichern (volle Tage, nie negativ). null bei fehlendem oder unlesbarem Zeitpunkt. */
export function daysSince(savedAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!savedAt) return null;
  const t = Date.parse(savedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export const STALE_NO_EXPIRY_DAYS = 90;

/** Token ohne Ablauf, der laenger als 90 Tage gespeichert ist. */
export function staleWithoutExpiry(expires: string | null | undefined, savedAt: string | null | undefined, now: Date = new Date()): number | null {
  if (expires !== null) return null;
  const d = daysSince(savedAt, now);
  return d !== null && d > STALE_NO_EXPIRY_DAYS ? d : null;
}

/** "live" oder "test", wenn der eingegebene Stripe-Schluessel nicht zur Verbindung passt; sonst null. Spiegel der Server-Pruefung. */
export function stripePrefixMismatch(connectionId: string, token: string): "live" | "test" | null {
  const mode = /^[rs]k_(test|live)_/.exec(token.trim())?.[1];
  if (connectionId === "stripe-test" && mode === "live") return "live";
  if (connectionId === "stripe-live" && mode === "test") return "test";
  return null;
}

/** Kurzform eines SHA-256 fuer die Anzeige. */
export const shortHash = (sha: string): string => (sha.length > 12 ? `${sha.slice(0, 12)}…` : sha);
