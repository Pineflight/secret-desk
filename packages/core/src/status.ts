import type { Inventory, Place, SecretEntry } from "./types.js";

export type StatusLevel = "ok" | "unknown" | "soon" | "no-date" | "due" | "missing" | "expired";

/** Reihenfolge = Dringlichkeit, grosser Wert = dringender. */
const URGENCY: Record<StatusLevel, number> = { ok: 0, unknown: 1, soon: 2, "no-date": 3, due: 4, missing: 5, expired: 6 };

export interface LiveSecret {
  name: string;
  updatedAt: string;
}

/** Was im GitHub-Secret-Speicher tatsaechlich liegt, je Ziel (nur Namen und Zeitstempel). */
export type LiveSnapshot = Map<string, LiveSecret>;

export function placeKey(owner: string, place: Place, fallbackName: string): string {
  const name = place.name ?? fallbackName;
  const where = place.scope === "environment" ? `env:${place.environment}` : place.scope === "organization" ? "org" : "repo";
  return `${owner}/${place.repo}/${where}/${name}`;
}

export interface StatusResult {
  id: string;
  status: StatusLevel;
  urgency: number;
  /** Tage bis zum Ablauf, negativ = abgelaufen, null = kein Datum. */
  daysLeft: number | null;
  missingPlaces: Place[];
}

export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

export function computeStatus(
  secret: SecretEntry,
  today: Date,
  options: { thresholds?: number[]; live?: LiveSnapshot; owner?: string; /** Ziele, die beim Abgleich nicht lesbar waren: "fehlt" ist dort unbekannt. */ unreadable?: (place: Place) => boolean } = {},
): StatusResult {
  const thresholds = [...(options.thresholds ?? [30, 14, 7])].sort((a, b) => a - b);
  const soonLimit = thresholds[thresholds.length - 1] ?? 30;
  const dueLimit = thresholds[0] ?? 7;
  const daysLeft = secret.expires ? daysBetween(today, parseDay(secret.expires)) : null;

  const missingPlaces: Place[] = [];
  if (options.live && options.owner) {
    for (const place of secret.places) {
      if (options.unreadable?.(place)) continue;
      if (!options.live.has(placeKey(options.owner, place, secret.name))) missingPlaces.push(place);
    }
  }

  let status: StatusLevel = "ok";
  if (daysLeft !== null && daysLeft < 0) status = "expired";
  else if (missingPlaces.length > 0) status = "missing";
  else if (daysLeft !== null && daysLeft <= dueLimit) status = "due";
  else if (daysLeft === null && secret.expiry === "required") status = "no-date";
  else if (daysLeft !== null && daysLeft <= soonLimit) status = "soon";
  else if (daysLeft === null && secret.expiry === "unknown") status = "unknown";
  return { id: secret.id, status, urgency: URGENCY[status], daysLeft, missingPlaces };
}

export interface Finding {
  level: "expired" | "due" | "soon" | "no-date";
  id: string;
  key: string;
  text: string;
}

/** Entspricht dem bisherigen Ablauf-Check: eine Meldung je Stufe, damit je Stufe ein Issue entsteht. */
export function findings(inventory: Inventory, today: Date): Finding[] {
  const out: Finding[] = [];
  const thresholds = [...inventory.thresholds].sort((a, b) => a - b);
  for (const s of inventory.secrets) {
    const where = [...new Set(s.places.map((p) => `${p.repo}/${p.scope === "environment" ? p.environment : "repo"}`))].join(", ");
    const r = computeStatus(s, today, { thresholds });
    if (r.daysLeft !== null) {
      if (r.daysLeft < 0) {
        out.push({ level: "expired", id: s.id, key: `${s.id}:expired`, text: `${s.name} (${s.id}) ist seit ${-r.daysLeft} Tagen abgelaufen (${s.expires}). Betrifft: ${where || "-"}` });
      } else {
        const stage = thresholds.find((t) => r.daysLeft! <= t);
        if (stage !== undefined) {
          out.push({
            level: stage === thresholds[0] ? "due" : "soon",
            id: s.id,
            key: `${s.id}:${stage}`,
            text: `${s.name} (${s.id}) laeuft in ${r.daysLeft} Tagen ab (${s.expires}). Betrifft: ${where || "-"}`,
          });
        }
      }
    } else if (s.expiry === "required") {
      out.push({ level: "no-date", id: s.id, key: `${s.id}:no-date`, text: `${s.name} (${s.id}): Anbieter erzwingt ein Ablaufdatum, im Inventar steht keins.` });
    }
  }
  return out;
}
