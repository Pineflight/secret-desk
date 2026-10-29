"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Overview } from "@secret-desk/runtime";
import { ApiError, api, ensureSession, type SessionInfo } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/hooks";
import { LOCALES, LOCALE_NAMES, useI18n } from "@/lib/i18n";
import { subscribeRefresh } from "@/lib/refresh";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./Icons";
import { detectPlatform, isPaletteShortcut, isTouchDevice, shortcutLabel, type KeyPlatform } from "@/lib/platform-keys";
import { Notice } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: "reviews" | "approvals";
  divider?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "common.nav.overview", icon: "grid" },
  { href: "/entries", label: "common.nav.entries", icon: "key" },
  { href: "/compare", label: "common.nav.compare", icon: "compare" },
  { href: "/repos", label: "common.nav.repos", icon: "folder" },
  { href: "/reviews", label: "common.nav.reviews", icon: "shield", badge: "reviews" },
  { href: "/approvals", label: "common.nav.approvals", icon: "inbox", badge: "approvals" },
  { href: "/dev", label: "common.nav.dev", icon: "terminal", divider: true },
  { href: "/connections", label: "common.nav.integrations", icon: "plug" },
  { href: "/team", label: "common.nav.team", icon: "users" },
  { href: "/settings", label: "common.nav.settings", icon: "wrench" },
];

const isActive = (path: string, href: string): boolean => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`) || (href === "/entries" && path.startsWith("/secrets/")));
const SEARCHABLE = ["/entries", "/approvals"];

export function Shell({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const path = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [launchRequired, setLaunchRequired] = useState(false);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [platform, setPlatform] = useState<KeyPlatform>("other");
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const nav = navigator as Parameters<typeof detectPlatform>[0];
    const plat = detectPlatform(nav);
    setPlatform(plat);
    setTouch(isTouchDevice(nav, window.matchMedia?.("(pointer: coarse)").matches));
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e, plat)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const dq = useDebounced(q, 250);
  const overview = useQuery<Overview>("shell-overview", () => api<Overview>("GET", "overview"), { refreshMs: 15000 });
  const about = useQuery<{ version: string }>("shell-about", () => api<{ version: string }>("GET", "about"));
  const reloadOverview = overview.reload;
  useEffect(() => subscribeRefresh(reloadOverview), [reloadOverview]);

  useEffect(() => {
    ensureSession().then(setSession).catch((err: unknown) => { setSession(null); setLaunchRequired(err instanceof ApiError && err.code === "launch-required"); });
  }, []);
  useEffect(() => setOpen(false), [path]);
  // Erststart ohne Inventar: statt einer leeren Oberflaeche den Einrichtungsassistenten zeigen.
  useEffect(() => {
    if (!session || path === "/setup") return;
    api<{ setupNeeded: boolean }>("GET", "team-sync/status").then((s) => { if (s.setupNeeded) router.replace("/setup"); }).catch(() => undefined);
  }, [session, path, router]);
  useEffect(() => setQ(params.get("q") ?? ""), [params]);
  // Suche, Schlagwort und Repository-Filter pro Seite merken: Wer in einen Eintrag springt und per Seitenleiste
  // oder Zurueck-Knopf wiederkommt, findet die Liste so vor, wie er sie verlassen hat.
  const arrivedAt = useRef("");
  useEffect(() => {
    if (!SEARCHABLE.includes(path)) {
      arrivedAt.current = "";
      return;
    }
    const key = `sd:query:${path}`;
    const keep = new URLSearchParams();
    for (const k of ["q", "tag", "repo", "kind", "stage", "status"]) {
      const v = params.get(k);
      if (v) keep.set(k, v);
    }
    const arriving = arrivedAt.current !== path;
    arrivedAt.current = path;
    try {
      if (arriving && keep.toString() === "") {
        const saved = window.sessionStorage.getItem(key);
        if (saved) {
          const next = new URLSearchParams(saved);
          const flag = params.get("new") ?? (params.get("neu") === "1" ? "1" : null);
          if (flag) next.set("new", flag);
          router.replace(`${path}?${next}`);
          return;
        }
      }
      if (keep.toString()) window.sessionStorage.setItem(key, keep.toString());
      else window.sessionStorage.removeItem(key);
    } catch {
      /* Speicher gesperrt: dann gilt der Filter nur bis zum Verlassen der Seite */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, params]);
  useEffect(() => {
    if (!SEARCHABLE.includes(path)) return;
    if ((params.get("q") ?? "") === dq) return;
    const next = new URLSearchParams(params.toString());
    if (dq) next.set("q", dq);
    else next.delete("q");
    const s = next.toString();
    router.replace(s ? `${path}?${s}` : path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const counts = { reviews: overview.data?.pendingReviews ?? 0, approvals: overview.data?.pendingApprovals ?? 0 };
  const alerts = counts.reviews + counts.approvals;
  const newHref = path === "/entries" && params.get("kind") ? `/entries?kind=${params.get("kind")}&new=1` : "/entries?new=1";

  return (
    <div className="min-h-screen lg:pl-[248px]">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded-lg focus:bg-card focus:p-2">{t("common.skip")}</a>
      {open ? <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <aside id="seitenleiste" className={`fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-line bg-card transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`} aria-label={t("common.sidebar")}>
        <div className="flex items-center gap-2.5 px-5 py-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={32} height={32} className="h-8 w-8 rounded-xl" />
          <span className="text-base font-semibold tracking-tight">secret-desk</span>
        </div>
        <nav aria-label={t("common.mainNav")} className="flex-1 overflow-y-auto px-3 pb-3">
          <ul className="space-y-1">
            {NAV.map((n) => {
              const active = isActive(path, n.href);
              const count = n.badge ? counts[n.badge] : 0;
              return (
                <li key={n.href} className={n.divider ? "mt-3 border-t border-line pt-3" : ""}>
                  <Link href={n.href} aria-current={active ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium ${active ? "bg-primary-light text-primary" : "text-muted-text hover:bg-page hover:text-ink"}`}>
                    <Icon name={n.icon} className="h-[18px] w-[18px]" />
                    <span className="flex-1">{t(n.label)}</span>
                    {count > 0 ? <span className="tabular rounded-full bg-danger-fill px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white" aria-label={t("common.pendingBadge", { count })}>{count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="m-3 rounded-2xl border border-line bg-page p-3 text-sm">
          <p className="font-medium">{session?.user ?? "…"}</p>
          <p className="text-xs text-muted">{t("common.userLocal")}</p>
          {session?.demo ? <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-accent-light px-2 py-0.5 text-[11px] font-medium text-[#a8420f]">{t("common.demo")}</p> : null}
          <div role="group" aria-label={t("common.language")} className="mt-3 flex gap-1 rounded-xl bg-card p-1 ring-1 ring-inset ring-line">
            {LOCALES.map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={locale === l} title={LOCALE_NAMES[l]} onClick={() => setLocale(l)} className={`flex-1 rounded-lg px-2 py-1 text-xs font-medium ${locale === l ? "bg-primary text-white" : "text-muted-text hover:bg-page"}`}>{l.toUpperCase()}</button>
            ))}
          </div>
          <p className="mt-3 text-center text-[11px] leading-snug text-muted">
            {t("about.footer")}
            <br />
            <Link href="/about" className="underline hover:text-ink">{t("about.footerAbout")}</Link>
            {about.data ? <span className="tabular"> · v{about.data.version}</span> : null}
            {" · "}
            <a href="https://github.com/Pineflight/secret-desk" target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">{t("about.footerSource")}</a>
          </p>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-[var(--sd-topbar-h)] items-center gap-3 border-b border-line bg-page/90 px-4 py-3 backdrop-blur sm:px-8">
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-xl p-2 hover:bg-card lg:hidden" aria-label={t("common.menuToggle")} aria-expanded={open} aria-controls="seitenleiste">
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <form
          role="search"
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!SEARCHABLE.includes(path)) router.push(q ? `/entries?q=${encodeURIComponent(q)}` : "/entries");
          }}
        >
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.searchPlaceholder")} aria-label={t("common.search")} autoComplete="off" className={`w-full rounded-xl border border-line bg-card py-2 pl-9 text-sm placeholder:text-muted ${touch ? "pr-3" : "pr-20"}`} />
          {!touch ? (
            <button type="button" onClick={() => setPaletteOpen(true)} title={t("palette.hint.shortcut", { key: shortcutLabel(platform, locale) })} aria-label={t("palette.open")} aria-keyshortcuts={platform === "mac" ? "Meta+K" : "Control+K"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-page px-1.5 py-0.5 text-[11px] font-medium text-muted-text ring-1 ring-inset ring-line hover:text-ink">
              <kbd className="font-sans">{shortcutLabel(platform, locale)}</kbd>
            </button>
          ) : null}
        </form>
        {touch ? (
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label={t("palette.open")} className="rounded-xl p-2 hover:bg-card"><Icon name="search" className="h-5 w-5" /></button>
        ) : null}
        <Link href={newHref} className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-white hover:brightness-95">
          <Icon name="plus" /><span className="hidden sm:inline">{t("common.newEntry")}</span><span className="sr-only sm:hidden">{t("common.newEntry")}</span>
        </Link>
        <Link href={counts.reviews > 0 || counts.approvals === 0 ? "/reviews" : "/approvals"} className="relative rounded-xl p-2 hover:bg-card" aria-label={alerts > 0 ? t("common.alertsSome", { count: alerts }) : t("common.alertsNone")}>
          <Icon name="bell" className="h-5 w-5" />
          {alerts > 0 ? <span className="tabular absolute -right-0.5 -top-0.5 rounded-full bg-danger-fill px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{alerts}</span> : null}
        </Link>
      </header>

      {paletteOpen ? <CommandPalette shortcut={touch ? "" : shortcutLabel(platform, locale)} onClose={() => setPaletteOpen(false)} /> : null}
      <main id="inhalt" className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{launchRequired ? <div className="mb-6"><Notice tone="warn" title={t("common.err.launchTitle")}>{t("common.err.launch")}</Notice></div> : null}{children}</main>
    </div>
  );
}
