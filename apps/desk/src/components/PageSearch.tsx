"use client";
import { useEffect, useRef } from "react";
import { isTypingTarget } from "@/lib/page-search";
import { useT } from "@/lib/i18n";
import { Icon } from "./Icons";

/** Suchfeld oberhalb der Filter: "/" fokussiert es, solange kein Eingabefeld aktiv ist und kein Dialog offen. */
export function PageSearch({ value, onChange, count, total }: { value: string; onChange: (v: string) => void; count: number | null; total: number | null }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null) || document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const active = value.trim() !== "";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-md">
        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          ref={input}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
          placeholder={t("common.pageSearchPlaceholder")}
          aria-label={t("common.pageSearch")}
          aria-keyshortcuts="/"
          autoComplete="off"
          className="w-full rounded-xl border border-line bg-card py-2 pl-9 pr-9 text-sm placeholder:text-muted"
        />
        {active ? (
          <button type="button" onClick={() => { onChange(""); input.current?.focus(); }} aria-label={t("common.pageSearchClear")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-ink">
            <Icon name="x" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {active && count !== null && total !== null ? <p className="tabular text-sm text-muted-text" role="status" aria-live="polite">{t("common.pageSearchCount", { count, total })}</p> : null}
    </div>
  );
}
