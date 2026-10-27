"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { selectClass } from "./ui";
import { Icon } from "./Icons";

import { SEARCH_FROM, filterOptions, optionsFromChildren, type SelectOption } from "@/lib/select-options";

interface Props {
  id?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  disabled?: boolean;
  required?: boolean;
  ["aria-label"]?: string;
  className?: string;
  /** Suchfeld erzwingen oder abschalten. Standard: ab SEARCH_FROM Optionen. */
  searchable?: boolean;
}

/**
 * Auswahlfeld mit Suche (ARIA-Combobox mit Listbox). Gleiche Schnittstelle wie <select>: <option>-Kinder, onChange mit event.target.value.
 * Die Liste liegt im Body (Portal), damit Dialoge sie nicht abschneiden.
 */
export function SelectBox({ id, value, onChange, children, disabled, required, className = "", searchable, ...aria }: Props) {
  const t = useT();
  const uid = useId();
  const options = useMemo(() => optionsFromChildren(children), [children]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const showSearch = searchable ?? options.length >= SEARCH_FROM;
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const selected = options.find((o) => o.value === value);
  const listId = `${uid}-list`;

  const close = (focus = true) => {
    setOpen(false);
    setQuery("");
    if (focus) button.current?.focus();
  };
  const choose = (o: SelectOption) => {
    onChange({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as ChangeEvent<HTMLSelectElement>);
    close();
  };
  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setPos(below < 280 && r.top > below ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 } : { left: r.left, width: r.width, top: r.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    (showSearch ? search.current : panel.current)?.focus();
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!panel.current?.contains(n) && !button.current?.contains(n)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) choose(o);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-required={required || undefined}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openList();
          }
        }}
        className={`${selectClass} flex items-center justify-between gap-2 text-left ${className}`}
      >
        <span className="truncate">{selected?.label ?? ""}</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panel}
              tabIndex={-1}
              onKeyDown={onPanelKey}
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 80 }}
              className="sd-fade overflow-hidden rounded-xl border border-line bg-card shadow-xl outline-none"
            >
              {showSearch ? (
                <div className="border-b border-line p-2">
                  <div className="relative">
                    <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                    <input
                      ref={search}
                      type="search"
                      role="searchbox"
                      aria-label={t("common.selectSearch")}
                      placeholder={t("common.selectSearch")}
                      aria-controls={listId}
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                      }}
                      autoComplete="off"
                      className="w-full rounded-lg border border-line bg-card py-1.5 pl-8 pr-2 text-sm"
                    />
                  </div>
                </div>
              ) : null}
              <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto py-1">
                {shown.map((o, i) => (
                  <li
                    key={o.value}
                    role="option"
                    data-index={i}
                    aria-selected={o.value === value}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${i === active ? "bg-primary-light" : ""} ${o.value === value ? "font-medium text-primary" : ""}`}
                  >
                    <span className="truncate">{o.label}</span>
                    {o.value === value ? <Icon name="check" className="h-4 w-4 shrink-0" /> : null}
                  </li>
                ))}
                {shown.length === 0 ? <li className="px-3 py-2 text-sm text-muted">{t("common.noMatches")}</li> : null}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
