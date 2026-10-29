"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { clearHistory, loadHistory, recordItem, recordQuery, setHistoryEnabled, type History } from "@/lib/palette-history";
import { buildIndex, filterValues, type PaletteDoc } from "@/lib/palette-index";
import { didYouMean, parseQuery, search, suggestFilters, vocabularyOf, type Suggestion } from "@/lib/smart-search";
import { Icon } from "./Icons";
import { Marked } from "./Marked";
import { nextActive, nextGroupStart, trapTarget } from "@/lib/palette-nav";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';
const GROUP_ORDER = ["secret", "variable", "repo", "connection", "provider", "stage", "page", "action"];
const MAX_PER_GROUP = 6;
const TONE: Record<string, string> = { ok: "bg-success-light text-success-text", warn: "bg-warn-light text-warn-text", danger: "bg-danger-light text-danger-text", info: "bg-info-light text-info-text", muted: "bg-page text-muted-text" };

/** Indexquellen (nur Metadaten, keine Werte) werden einzeln geladen und kurz gemerkt; die Palette zeigt, was schon da ist. */
type Sources = Partial<Omit<Parameters<typeof buildIndex>[0], "t">>;
const SOURCES: [keyof Sources, string, (r: unknown) => unknown][] = [
  ["secrets", "secrets", (r) => r],
  ["variables", "variables", (r) => r],
  ["stages", "stages", (r) => r],
  ["providers", "providers", (r) => r],
  ["repos", "repos", (r) => (r as { repos?: unknown[] }).repos ?? []],
  ["connections", "connections", (r) => r],
];
const cache = new Map<string, { at: number; data: unknown }>();
function loadSource(key: keyof Sources, path: string, pick: (r: unknown) => unknown): Promise<unknown> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return Promise.resolve(hit.data);
  return api<unknown>("GET", path).then(pick).catch(() => []).then((data) => {
    cache.set(key, { at: Date.now(), data });
    return data;
  });
}

type Row = { type: "doc"; doc: PaletteDoc; hits: string[] } | { type: "suggestion"; s: Suggestion } | { type: "recent-query"; q: string };

export function CommandPalette({ onClose, shortcut }: { onClose: () => void; shortcut: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [sources, setSources] = useState<Sources>({});
  const [pending, setPending] = useState(SOURCES.length);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [history, setHistory] = useState<History>({ items: [], queries: [], enabled: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const store = typeof window !== "undefined" ? safeStorage() : undefined;

  useEffect(() => {
    setHistory(loadHistory(store));
    let alive = true;
    for (const [key, path, pick] of SOURCES) {
      void loadSource(key, path, pick).then((data) => {
        if (!alive) return;
        setSources((prev) => ({ ...prev, [key]: data }));
        setPending((n) => n - 1);
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const docs = useMemo<PaletteDoc[]>(() => buildIndex({ secrets: [], variables: [], repos: [], stages: [], connections: [], providers: [], ...sources, t }), [sources, locale]);
  const loading = pending > 0;

  // Fokus: ins Feld, Falle im Dialog, danach zurueck zum vorherigen Element.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && rootRef.current) {
        const items = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (target !== null) { e.preventDefault(); items[target]?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byId = useMemo(() => new Map(docs.map((d) => [d.recentId, d])), [docs]);
  const values = useMemo(() => filterValues(docs), [docs]);
  const parsed = useMemo(() => parseQuery(query), [query]);
  const recencyRank = useMemo(() => new Map(history.items.map((id, i) => [id, history.items.length - i])), [history.items]);

  const { rows, groups, mean } = useMemo(() => {
    const out: { label: string; key: string; rows: Row[] }[] = [];
    let didMean: string | null = null;
    if (query.trim() === "") {
      const recent = history.items.map((id) => byId.get(id)).filter((d): d is PaletteDoc => !!d);
      if (recent.length) out.push({ key: "recent", label: t("palette.empty.recentItems"), rows: recent.map((doc) => ({ type: "doc", doc, hits: [] })) });
      if (history.queries.length) out.push({ key: "queries", label: t("palette.empty.recentQueries"), rows: history.queries.map((q) => ({ type: "recent-query", q })) });
      const typical = ["new-secret", "run-compare", "add-connection", "team-sync", "dev-env"].map((id) => byId.get(`action:${id}`)).filter((d): d is PaletteDoc => !!d);
      out.push({ key: "typical", label: t("palette.empty.suggestions"), rows: typical.map((doc) => ({ type: "doc", doc, hits: [] })) });
    } else {
      const sug = suggestFilters(query, { values: values as never });
      if (sug.length) out.push({ key: "filters", label: t("palette.empty.suggestions"), rows: sug.map((s) => ({ type: "suggestion", s })) });
      const found = search(docs, query, { recency: (d) => recencyRank.get(d.recentId) ?? 0 });
      const byKind = new Map<string, PaletteDoc[]>();
      for (const h of found) byKind.set(h.doc.kind, [...(byKind.get(h.doc.kind) ?? []), h.doc]);
      for (const kind of GROUP_ORDER) {
        const list = byKind.get(kind);
        if (list?.length) out.push({ key: kind, label: t(`palette.group.${kind}`), rows: list.slice(0, MAX_PER_GROUP).map((doc) => ({ type: "doc", doc, hits: parsed.terms })) });
      }
      if (found.length === 0) didMean = didYouMean(query, vocabularyOf(docs));
    }
    return { rows: out.flatMap((g) => g.rows), groups: out, mean: didMean };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, query, history, locale]);

  useEffect(() => setActive(0), [query]);
  const docCount = rows.filter((r) => r.type === "doc").length;
  const announcement = query.trim() === "" ? "" : docCount === 0 ? t("palette.noResults", { query }) : t("palette.count", { count: docCount });

  const go = (row: Row) => {
    if (row.type === "suggestion") { setQuery(row.s.query); inputRef.current?.focus(); return; }
    if (row.type === "recent-query") { setQuery(row.q); inputRef.current?.focus(); return; }
    recordItem(store, row.doc.recentId);
    recordQuery(store, query);
    onClose();
    router.push(row.doc.href);
  };
  const onInputKey = (e: React.KeyboardEvent) => {
    const moved = nextActive(active, rows.length, e.key);
    if (moved !== null) { e.preventDefault(); setActive(moved); return; }
    if (e.key === "Enter") { const r = rows[active]; if (r) { e.preventDefault(); go(r); } }
    else if (e.key === "Tab" && !e.shiftKey && groups.length > 1 && rows.length > 0) {
      e.preventDefault();
      setActive(nextGroupStart(active, groups.map((g) => g.rows.length)));
    }
  };
  useEffect(() => {
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  let counter = -1;
  return (
    <div className="sd-fade fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-3 pt-[8vh] sm:p-6 sm:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={rootRef} role="dialog" aria-modal="true" aria-label={t("palette.title")} className="sd-slide flex max-h-[min(34rem,calc(100dvh-4rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xl">
        <div className="sd-palette-bar flex items-center gap-2 border-b border-line px-4 py-3 transition-shadow">
          <Icon name="search" className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows.length ? `${listId}-opt-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={t("palette.placeholder")}
            placeholder={t("palette.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="sd-bare-input min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <button type="button" onClick={onClose} className="rounded-lg px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-inset ring-line hover:bg-page" aria-label={t("palette.close")}>Esc</button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
        {loading ? <p className="px-4 pt-2 text-[11px] text-muted" aria-hidden="true">{t("palette.loading")}</p> : null}
        <div id={listId} role="listbox" aria-label={t("palette.title")} className="min-h-0 flex-1 overflow-y-auto p-2">
          {query.trim() !== "" && docCount === 0 && !groups.some((g) => g.key === "filters") ? (
            <div className="px-3 py-6 text-center text-sm">
              <p className="text-muted-text">{t("palette.noResults", { query })}</p>
              {mean ? <p className="mt-2">{t("palette.didYouMean")} <button type="button" className="font-medium text-primary underline" onClick={() => setQuery(mean)}>{mean}</button>?</p> : null}
              <p className="mt-3 text-xs text-muted">{t("palette.suggest.filters")}</p>
            </div>
          ) : null}
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.label} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
              {g.rows.map((row) => {
                counter += 1;
                const i = counter;
                const selected = i === active;
                const base = `flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ${selected ? "bg-primary-light text-ink ring-1 ring-inset ring-primary/25" : "hover:bg-page"}`;
                if (row.type === "suggestion" || row.type === "recent-query") {
                  const label = row.type === "suggestion" ? row.s.label : row.q;
                  return (
                    <div key={`${g.key}-${i}`} id={`${listId}-opt-${i}`} role="option" aria-selected={selected} onMouseMove={() => setActive(i)} onClick={() => go(row)} className={`${base} cursor-pointer`}>
                      <Icon name={row.type === "suggestion" ? "sliders" : "clock"} className="h-4 w-4 shrink-0 text-muted" />
                      <span className="font-mono text-xs">{label}</span>
                    </div>
                  );
                }
                const d = row.doc;
                return (
                  <div key={d.id} id={`${listId}-opt-${i}`} role="option" aria-selected={selected} onMouseMove={() => setActive(i)} onClick={() => go(row)} className={`${base} cursor-pointer`}>
                    <Icon name={d.icon} className="h-4 w-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium"><Marked text={d.title} terms={row.hits} /></span>
                      {d.subtitle ? <span className="block truncate text-xs text-muted-text">{d.subtitle}</span> : null}
                    </span>
                    {d.badge ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[d.badge.tone]}`}>{d.badge.text}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>{t("palette.kbd.navigate")} · {t("palette.kbd.open")} · {t("palette.kbd.close")}</span>
          <span className="flex items-center gap-2">
            {history.enabled && (history.items.length > 0 || history.queries.length > 0) ? <button type="button" className="underline" onClick={() => { clearHistory(store); setHistory(loadHistory(store)); }}>{t("palette.empty.clear")}</button> : null}
            <button type="button" className="underline" onClick={() => { setHistoryEnabled(store, !history.enabled); setHistory(loadHistory(store)); }}>{history.enabled ? t("palette.empty.historyOff") : t("palette.empty.historyOn")}</button>
            {shortcut ? <kbd className="rounded bg-page px-1.5 py-0.5 ring-1 ring-inset ring-line">{shortcut}</kbd> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
