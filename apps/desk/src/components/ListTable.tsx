"use client";
import type { ReactNode } from "react";
import { Icon } from "./Icons";
import { Card } from "./ui";

/**
 * Gemeinsame Listenform von Secrets und Variablen: Filterzeile, Schlagwort-Chip, Tabelle mit Kopfzeile.
 * Aenderungen an Optik (Spaltenkopf, Zeilenhoehe, Hover, Trennlinien, Scrollen) passieren nur hier.
 */

export function FilterRow({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap gap-3">{children}</div>;
}

export function TagFilterChip({ tag, label, removeLabel, onClear }: { tag: string; label: string; removeLabel: string; onClear: () => void }) {
  if (!tag) return null;
  return (
    <div className="mb-4 flex items-center gap-2 text-sm">
      <span className="text-muted-text">{label}</span>
      <button type="button" onClick={onClear} aria-label={removeLabel} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2.5 py-0.5 text-xs font-medium text-primary">#{tag}<Icon name="x" className="h-3 w-3" /></button>
    </div>
  );
}

export const LIST_ROW_CLASS = "align-top hover:bg-page";
export const LIST_CELL_CLASS = "px-3 py-2";

/**
 * minWidth gilt nur, wenn der Platz wirklich nicht reicht (schmale Fenster scrollen weiter). stickyLast haelt die letzte Spalte
 * (Zeilenaktionen) am rechten Rand, damit sie auch dann sichtbar bleibt.
 */
export function ListTable({ columns, minWidth = 720, stickyLast = false, children }: { columns: ReactNode[]; minWidth?: number; stickyLast?: boolean; children: ReactNode }) {
  return (
    <Card className="overflow-x-auto !p-0">
      <table className={`w-full text-left text-sm ${stickyLast ? "sd-sticky-last" : ""}`} style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            {columns.map((c, i) => <th key={i} className="px-3 py-2 font-semibold">{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </Card>
  );
}

/** Kleiner Symbolknopf fuer Zeilenaktionen: immer mit Beschriftung fuer Screenreader und Tooltip. */
export function RowIconButton({ label, icon, onClick, disabled = false, loading = false, danger = false }: { label: string; icon: string; onClick: () => void; disabled?: boolean; loading?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "text-danger-text" : "text-muted-text hover:text-ink"}`}
    >
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : <Icon name={icon} />}
    </button>
  );
}
