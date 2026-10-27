import { createHash } from "node:crypto";
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

export interface Confirmation {
  by: string;
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
  attachments: Attachment[];
  confirmation?: Confirmation;
}

export function fingerprintOf(value: SecretValue): string {
  return createHash("sha256").update(value.reveal()).digest("hex").slice(0, 12);
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

/** Beleg als SVG-Bild. Enthaelt nur Metadaten, nie einen Wert. Alle Texte werden maskiert. */
export function renderEvidenceSvg(report: VerificationReport): string {
  const width = 860;
  const rowH = 34;
  const facts: [string, string][] = [
    ["Secret", `${report.secretName} (${report.secretId})`],
    ["Stage", report.stage],
    ["Anbieter", report.provider],
    ["Name beim Anbieter", report.label],
    ...(report.externalId ? ([["Kennung", report.externalId]] as [string, string][]) : []),
    ["Laeuft ab", report.expiresAt ? report.expiresAt.slice(0, 10) : "nie / nicht bekannt"],
    ["Ziele", report.targets.length ? report.targets.join(", ") : "keine"],
    ["Fingerabdruck", report.fingerprint],
    ["Erstellt", report.createdAt],
  ];
  const overall = overallStatus(report.checks);
  const headerH = 86;
  const factsH = facts.length * rowH + 20;
  const checksH = report.checks.length * 46 + 52;
  const confirmH = report.confirmation ? 64 : 0;
  const height = headerH + factsH + checksH + confirmH + 40;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, system-ui, -apple-system, sans-serif">`);
  parts.push(`<title>Beleg ${esc(report.secretId)}</title>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#f7f6f3"/>`);
  parts.push(`<rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="18" fill="#ffffff" stroke="#e7e4de"/>`);
  parts.push(`<text x="48" y="64" font-size="22" font-weight="600" fill="#1a1a18">Pruefbeleg</text>`);
  parts.push(`<rect x="${width - 190}" y="40" width="142" height="34" rx="17" fill="${COLORS[overall]}" opacity="0.14"/>`);
  parts.push(`<text x="${width - 119}" y="62" text-anchor="middle" font-size="15" font-weight="600" fill="${COLORS[overall]}">${overall === "pass" ? "bestanden" : overall === "warn" ? "mit Hinweisen" : "fehlgeschlagen"}</text>`);
  let y = headerH + 24;
  for (const [k, v] of facts) {
    parts.push(`<text x="48" y="${y}" font-size="14" fill="#6b6960">${esc(k)}</text>`);
    parts.push(`<text x="250" y="${y}" font-size="14" fill="#1a1a18">${esc(v.length > 78 ? `${v.slice(0, 75)}...` : v)}</text>`);
    y += rowH;
  }
  y += 8;
  parts.push(`<line x1="48" y1="${y}" x2="${width - 48}" y2="${y}" stroke="#e7e4de"/>`);
  y += 32;
  parts.push(`<text x="48" y="${y}" font-size="15" font-weight="600" fill="#1a1a18">Automatische Pruefungen</text>`);
  y += 22;
  for (const c of report.checks) {
    parts.push(`<circle cx="62" cy="${y + 6}" r="13" fill="${COLORS[c.status]}" opacity="0.16"/>`);
    parts.push(`<text x="62" y="${y + 11}" text-anchor="middle" font-size="11" font-weight="700" fill="${COLORS[c.status]}">${SYMBOL[c.status]}</text>`);
    parts.push(`<text x="90" y="${y + 3}" font-size="14" fill="#1a1a18">${esc(c.label)}</text>`);
    const detail = [c.expected ? `erwartet: ${c.expected}` : "", c.actual ? `gefunden: ${c.actual}` : "", c.detail ?? ""].filter(Boolean).join("   ");
    if (detail) parts.push(`<text x="90" y="${y + 21}" font-size="12" fill="#6b6960">${esc(detail.length > 110 ? `${detail.slice(0, 107)}...` : detail)}</text>`);
    y += 46;
  }
  if (report.confirmation) {
    y += 8;
    const ok = report.confirmation.decision === "confirmed";
    parts.push(`<rect x="48" y="${y}" width="${width - 96}" height="48" rx="12" fill="${ok ? COLORS.pass : COLORS.fail}" opacity="0.12"/>`);
    parts.push(`<text x="68" y="${y + 29}" font-size="14" font-weight="600" fill="${ok ? COLORS.pass : COLORS.fail}">${ok ? "Bestaetigt" : "Abgelehnt"} von ${esc(report.confirmation.by)} am ${esc(report.confirmation.at.slice(0, 16).replace("T", " "))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
