export function daysLabel(daysLeft: number | null | undefined): string {
  if (daysLeft === null || daysLeft === undefined) return "kein Ablauf";
  if (daysLeft === 0) return "heute";
  const n = Math.abs(daysLeft);
  const unit = n === 1 ? "Tag" : "Tagen";
  return daysLeft > 0 ? `in ${n} ${unit}` : `seit ${n} ${unit} abgelaufen`;
}

/** TT.MM.JJJJ aus JJJJ-MM-TT oder ISO-Zeit, ohne Zeitzonen-Verschiebung bei reinen Datumsangaben. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "–";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return formatDate(value);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** mm:ss, nie negativ. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function placeText(p: { repo: string; scope: string; environment?: string | undefined }): string {
  return `${p.repo} / ${p.scope === "environment" ? (p.environment ?? "Umgebung") : p.scope === "organization" ? "Organisation" : "Repository"}`;
}

export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}
