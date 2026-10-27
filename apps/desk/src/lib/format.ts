import { getLocale, translate } from "./i18n";

export function daysLabel(daysLeft: number | null | undefined): string {
  if (daysLeft === null || daysLeft === undefined) return translate("common.days.none");
  if (daysLeft === 0) return translate("common.days.today");
  const n = Math.abs(daysLeft);
  return translate(daysLeft > 0 ? "common.days.future" : "common.days.past", { count: n });
}

/** TT.MM.JJJJ (de) bzw. DD/MM/YYYY (en) aus JJJJ-MM-TT oder ISO-Zeit, ohne Zeitzonen-Verschiebung bei reinen Datumsangaben. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return dayText(m[3]!, m[2]!, m[1]!);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return dayText(pad(d.getDate()), pad(d.getMonth() + 1), String(d.getFullYear()));
}

function dayText(dd: string, mm: string, yyyy: string): string {
  return getLocale() === "en" ? `${dd}/${mm}/${yyyy}` : `${dd}.${mm}.${yyyy}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "–";
  // Reines Datum (JJJJ-MM-TT) hat keine Uhrzeit und darf in keiner Zeitzone auf den Vortag fallen.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return formatDate(value);
  return `${dayText(pad(d.getDate()), pad(d.getMonth() + 1), String(d.getFullYear()))}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** mm:ss, nie negativ. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function placeText(p: { repo: string; scope: string; environment?: string | undefined }): string {
  return `${p.repo} / ${p.scope === "environment" ? (p.environment ?? translate("common.env")) : p.scope === "organization" ? translate("common.org") : translate("common.repo")}`;
}

export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}
