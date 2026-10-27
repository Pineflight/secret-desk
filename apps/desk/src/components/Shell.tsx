"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { Overview } from "@secret-desk/runtime";
import { api, ensureSession, type SessionInfo } from "@/lib/api";
import { useDebounced, useQuery } from "@/lib/hooks";
import { subscribeRefresh } from "@/lib/refresh";
import { Icon } from "./Icons";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: "reviews" | "approvals";
  divider?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Übersicht", icon: "grid" },
  { href: "/secrets", label: "Secrets", icon: "key" },
  { href: "/variablen", label: "Variablen", icon: "sliders" },
  { href: "/pruefen", label: "Prüfen", icon: "shield", badge: "reviews" },
  { href: "/freigaben", label: "Freigaben", icon: "inbox", badge: "approvals" },
  { href: "/dev", label: "Dev-Umgebung", icon: "terminal", divider: true },
  { href: "/verbindungen", label: "Verbindungen", icon: "plug" },
  { href: "/team", label: "Team", icon: "users" },
];

const isActive = (path: string, href: string): boolean => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
const SEARCHABLE = ["/secrets", "/variablen", "/freigaben"];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q, 250);
  const overview = useQuery<Overview>("shell-overview", () => api<Overview>("GET", "overview"), { refreshMs: 15000 });
  const reloadOverview = overview.reload;
  useEffect(() => subscribeRefresh(reloadOverview), [reloadOverview]);

  useEffect(() => {
    ensureSession().then(setSession).catch(() => setSession(null));
  }, []);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => setQ(params.get("q") ?? ""), [params]);
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
  const newHref = path.startsWith("/variablen") ? "/variablen?neu=1" : "/secrets?neu=1";

  return (
    <div className="min-h-screen lg:pl-[248px]">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded-lg focus:bg-card focus:p-2">Zum Inhalt springen</a>
      {open ? <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <aside id="seitenleiste" className={`fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-line bg-card transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`} aria-label="Seitenleiste">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-white"><Icon name="lock" className="h-4 w-4" /></span>
          <span className="text-base font-semibold tracking-tight">secret-desk</span>
        </div>
        <nav aria-label="Hauptnavigation" className="flex-1 overflow-y-auto px-3 pb-3">
          <ul className="space-y-1">
            {NAV.map((n) => {
              const active = isActive(path, n.href);
              const count = n.badge ? counts[n.badge] : 0;
              return (
                <li key={n.href} className={n.divider ? "mt-3 border-t border-line pt-3" : ""}>
                  <Link href={n.href} aria-current={active ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium ${active ? "bg-primary-light text-primary" : "text-muted-text hover:bg-page hover:text-ink"}`}>
                    <Icon name={n.icon} className="h-[18px] w-[18px]" />
                    <span className="flex-1">{n.label}</span>
                    {count > 0 ? <span className="tabular rounded-full bg-danger-fill px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white" aria-label={`${count} offen`}>{count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="m-3 rounded-2xl border border-line bg-page p-3 text-sm">
          <p className="font-medium">{session?.user ?? "…"}</p>
          <p className="text-xs text-muted">Lokal auf diesem Rechner</p>
          {session?.demo ? <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-accent-light px-2 py-0.5 text-[11px] font-medium text-[#a8420f]">Demo, simuliertes GitHub</p> : null}
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-page/90 px-4 py-3 backdrop-blur sm:px-8">
        <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-xl p-2 hover:bg-card lg:hidden" aria-label="Menü öffnen oder schließen" aria-expanded={open} aria-controls="seitenleiste">
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <form
          role="search"
          className="relative flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!SEARCHABLE.includes(path)) router.push(q ? `/secrets?q=${encodeURIComponent(q)}` : "/secrets");
          }}
        >
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suchen nach Name, Repository oder Produkt" aria-label="Suchen" autoComplete="off" className="w-full rounded-xl border border-line bg-card py-2 pl-9 pr-3 text-sm placeholder:text-muted" />
        </form>
        <Link href={newHref} className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-white hover:brightness-95">
          <Icon name="plus" /><span className="hidden sm:inline">Neuer Eintrag</span><span className="sr-only sm:hidden">Neuer Eintrag</span>
        </Link>
        <Link href={counts.reviews > 0 || counts.approvals === 0 ? "/pruefen" : "/freigaben"} className="relative rounded-xl p-2 hover:bg-card" aria-label={alerts > 0 ? `${alerts} offene Prüfungen und Freigaben` : "Keine offenen Prüfungen oder Freigaben"}>
          <Icon name="bell" className="h-5 w-5" />
          {alerts > 0 ? <span className="tabular absolute -right-0.5 -top-0.5 rounded-full bg-danger-fill px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{alerts}</span> : null}
        </Link>
      </header>

      <main id="inhalt" className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{children}</main>
    </div>
  );
}
