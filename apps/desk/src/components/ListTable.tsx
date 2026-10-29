"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
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

/**
 * Segmented switch for a filter with few values (for example the kind: all, secrets, variables). Buttons with aria-pressed,
 * so it works with the keyboard and screen readers without tab semantics.
 */
export function SegmentSwitch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-page p-1 ring-1 ring-inset ring-line">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={value === o.id}
            onClick={() => onChange(o.id)}
            className={`rounded-lg px-3 py-1 text-sm font-medium ${value === o.id ? "bg-card text-ink shadow-sm" : "text-muted-text hover:text-ink"}`}
          >
            {o.label}
            {o.count !== undefined ? <span className="tabular ml-1.5 text-xs text-muted">{o.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Menu with secondary list actions (bulk actions), so the page header keeps one primary button. Closes on Escape, outside click and after a choice. */
export function ActionMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-card px-3.5 py-2 text-sm font-medium text-ink hover:bg-page">
        {label}<Icon name="chevron" className={`h-3.5 w-3.5 ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {open ? <div role="menu" onClick={() => setOpen(false)} className="absolute right-0 top-full z-20 mt-1 flex min-w-[15rem] flex-col rounded-xl border border-line bg-card p-1 shadow-lg">{children}</div> : null}
    </div>
  );
}

export function MenuItem({ icon, onClick, disabled = false, children }: { icon: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-page disabled:cursor-not-allowed disabled:opacity-40">
      <Icon name={icon} className="h-4 w-4 text-muted-text" />{children}
    </button>
  );
}
