import { sha256Hex } from "./sha256.js";
import type { SecretValue } from "./secret.js";
import type { Stage } from "./types.js";

export type CheckStatus = "pass" | "fail" | "warn" | "info";

/** Ein einzelner Befund der Pruefung. Nie ein Wert. */
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
}

/**
 * Who did something: a display name, the kind of caller and, when whatever authenticates the request supplies one, an opaque
 * principal id. This package never interprets the principal id; it only stores it next to the name. Never carries a value.
 */
export interface ActorRef {
  name: string;
  kind: "human" | "agent";
  principalId?: string;
}

export interface Confirmation {
  by: string;
  /** Opaque principal id of the deciding actor, only present when the request carried one. */
  principalId?: string;
  at: string;
  note?: string;
  ticks: string[];
  decision: "confirmed" | "rejected";
}

export interface Attachment {
  file: string;
  mime: string;
  note?: string;
  addedAt: string;
}

export interface CompanionSummary {
  entryId: string;
  /** Absent = secret. A variable companion holds a public value. */
  kind?: "secret" | "variable";
  name: string;
  targets: string[];
  fingerprint: string;
}

/** Was ueber eine Ausstellung oder Eingabe bekannt ist, damit ein Mensch sie beurteilen kann. */
export interface VerificationReport {
  id: string;
  secretId: string;
  secretName: string;
  createdAt: string;
  kind: "issued" | "manual";
  provider: string;
  stage: Stage;
  /** Name, unter dem der Wert beim Anbieter angelegt wurde. */
  label: string;
  externalId?: string;
  expiresAt?: string | null;
  targets: string[];
  checks: Check[];
  checklist: ChecklistItem[];
  /** Erste Zeichen eines SHA-256 des Wertes: erlaubt spaeteren Abgleich, verraet den Wert nicht. */
  fingerprint: string;
  /** Companion values of the same issuance (name, targets, fingerprint; never the value). */
  companions?: CompanionSummary[];
  attachments: Attachment[];
  confirmation?: Confirmation;
}

export function fingerprintOf(value: SecretValue): string {
  return sha256Hex(value.reveal()).slice(0, 12);
}

export type OverallStatus = "pass" | "warn" | "fail";

export function overallStatus(checks: Check[]): OverallStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COLORS = { pass: "#1f9d55", warn: "#e9a23b", fail: "#d64545", info: "#4a7dbd" } as const;
const SYMBOL = { pass: "OK", warn: "!", fail: "X", info: "i" } as const;

/** Language of the fixed texts of the evidence sheet. German is the default (and what stored evidence has always shown). */
export type EvidenceLang = "de" | "en";

/** Fixed texts of the sheet. German stays ASCII-transliterated like every other backend text (see i18n-en.ts in the runtime). */
const SHEET_TEXT = {
  de: {
    title: "Beleg",
    heading: "Pruefbeleg",
    pass: "bestanden",
    warn: "mit Hinweisen",
    fail: "fehlgeschlagen",
    secret: "Secret",
    stage: "Stage",
    provider: "Anbieter",
    label: "Name beim Anbieter",
    externalId: "Kennung",
    expires: "Laeuft ab",
    neverOrUnknown: "nie / nicht bekannt",
    targets: "Ziele",
    none: "keine",
    fingerprint: "Fingerabdruck",
    created: "Erstellt",
    checks: "Automatische Pruefungen",
    expected: "erwartet",
    actual: "gefunden",
    confirmed: "Bestaetigt",
    rejected: "Abgelehnt",
    by: "von",
    on: "am",
  },
  en: {
    title: "Evidence",
    heading: "Evidence sheet",
    pass: "passed",
    warn: "with notes",
    fail: "failed",
    secret: "Secret",
    stage: "Stage",
    provider: "Provider",
    label: "Name at the provider",
    externalId: "Identifier",
    expires: "Expires",
    neverOrUnknown: "never / not known",
    targets: "Targets",
    none: "none",
    fingerprint: "Fingerprint",
    created: "Created",
    checks: "Automatic checks",
    expected: "expected",
    actual: "found",
    confirmed: "Confirmed",
    rejected: "Rejected",
    by: "by",
    on: "on",
  },
} as const;

/**
 * Beleg als SVG-Bild. Enthaelt nur Metadaten, nie einen Wert. Alle Texte werden maskiert.
 * `lang` waehlt die festen Texte des Belegs (Standard "de", wie bisher). Texte der Pruefungen (`checks`) sind gespeicherte Daten und
 * bleiben, wie sie sind: wer sie uebersetzen will, tut das vorher (siehe evidenceSvg in der Laufzeit).
 */
export function renderEvidenceSvg(report: VerificationReport, lang: EvidenceLang = "de"): string {
  const t = SHEET_TEXT[lang];
  const width = 860;
  const rowH = 34;
  const facts: [string, string][] = [
    [t.secret, `${report.secretName} (${report.secretId})`],
    [t.stage, report.stage],
    [t.provider, report.provider],
    [t.label, report.label],
    ...(report.externalId ? ([[t.externalId, report.externalId]] as [string, string][]) : []),
    [t.expires, report.expiresAt ? report.expiresAt.slice(0, 10) : t.neverOrUnknown],
    [t.targets, report.targets.length ? report.targets.join(", ") : t.none],
    [t.fingerprint, report.fingerprint],
    [t.created, report.createdAt],
  ];
  const overall = overallStatus(report.checks);
  const headerH = 86;
  const factsH = facts.length * rowH + 20;
  const checksH = report.checks.length * 46 + 52;
  const confirmH = report.confirmation ? 64 : 0;
  const height = headerH + factsH + checksH + confirmH + 40;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, system-ui, -apple-system, sans-serif">`);
  parts.push(`<title>${t.title} ${esc(report.secretId)}</title>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#f7f6f3"/>`);
  parts.push(`<rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="18" fill="#ffffff" stroke="#e7e4de"/>`);
  parts.push(`<text x="48" y="64" font-size="22" font-weight="600" fill="#1a1a18">${t.heading}</text>`);
  parts.push(`<rect x="${width - 190}" y="40" width="142" height="34" rx="17" fill="${COLORS[overall]}" opacity="0.14"/>`);
  parts.push(`<text x="${width - 119}" y="62" text-anchor="middle" font-size="15" font-weight="600" fill="${COLORS[overall]}">${t[overall]}</text>`);
  let y = headerH + 24;
  for (const [k, v] of facts) {
    parts.push(`<text x="48" y="${y}" font-size="14" fill="#6b6960">${esc(k)}</text>`);
    parts.push(`<text x="250" y="${y}" font-size="14" fill="#1a1a18">${esc(v.length > 78 ? `${v.slice(0, 75)}...` : v)}</text>`);
    y += rowH;
  }
  y += 8;
  parts.push(`<line x1="48" y1="${y}" x2="${width - 48}" y2="${y}" stroke="#e7e4de"/>`);
  y += 32;
  parts.push(`<text x="48" y="${y}" font-size="15" font-weight="600" fill="#1a1a18">${t.checks}</text>`);
  y += 22;
  for (const c of report.checks) {
    parts.push(`<circle cx="62" cy="${y + 6}" r="13" fill="${COLORS[c.status]}" opacity="0.16"/>`);
    parts.push(`<text x="62" y="${y + 11}" text-anchor="middle" font-size="11" font-weight="700" fill="${COLORS[c.status]}">${SYMBOL[c.status]}</text>`);
    parts.push(`<text x="90" y="${y + 3}" font-size="14" fill="#1a1a18">${esc(c.label)}</text>`);
    const detail = [c.expected ? `${t.expected}: ${c.expected}` : "", c.actual ? `${t.actual}: ${c.actual}` : "", c.detail ?? ""].filter(Boolean).join("   ");
    if (detail) parts.push(`<text x="90" y="${y + 21}" font-size="12" fill="#6b6960">${esc(detail.length > 110 ? `${detail.slice(0, 107)}...` : detail)}</text>`);
    y += 46;
  }
  if (report.confirmation) {
    y += 8;
    const ok = report.confirmation.decision === "confirmed";
    parts.push(`<rect x="48" y="${y}" width="${width - 96}" height="48" rx="12" fill="${ok ? COLORS.pass : COLORS.fail}" opacity="0.12"/>`);
    parts.push(`<text x="68" y="${y + 29}" font-size="14" font-weight="600" fill="${ok ? COLORS.pass : COLORS.fail}">${ok ? t.confirmed : t.rejected} ${t.by} ${esc(report.confirmation.by)} ${t.on} ${esc(report.confirmation.at.slice(0, 16).replace("T", " "))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
