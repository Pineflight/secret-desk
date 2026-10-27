"use client";
import Link from "next/link";
import { useState } from "react";
import type { Overview } from "@secret-desk/runtime";
import { api } from "@/lib/api";
import { daysLabel, placeText } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, SectionLabel, Skeleton, Stat, StageBadge, StatusBadge, Tabs } from "@/components/ui";
import { Icon } from "@/components/Icons";

type StageTab = "all" | "dev" | "staging" | "production" | "shared";

export default function OverviewPage() {
  const q = useQuery<Overview>("overview", () => api<Overview>("GET", "overview"), { refreshMs: 30000 });
  const [tab, setTab] = useState<StageTab>("all");
  const o = q.data;

  const tabs: { id: StageTab; label: string; count?: number }[] = [
    { id: "all", label: "Alle", ...(o ? { count: o.total } : {}) },
    ...(["dev", "staging", "production", "shared"] as const).map((s) => ({ id: s, label: s, ...(o ? { count: o.byStage[s] } : {}) })),
  ];
  const list = o ? o.attention.filter((s) => tab === "all" || s.stage === tab) : [];

  return (
    <>
      <PageHeader title="Übersicht" subtitle="Was abläuft, fehlt oder auf dich wartet." />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {o && (o.pendingReviews > 0 || o.pendingApprovals > 0) ? (
        <div className="mb-6 space-y-2">
          {o.pendingReviews > 0 ? (
            <Notice tone="warn" title={`${o.pendingReviews} ${o.pendingReviews === 1 ? "Prüfung wartet" : "Prüfungen warten"} auf dich`}>
              Es wird erst nach deiner Bestätigung etwas in GitHub geschrieben. <Link href="/pruefen" className="font-medium underline">Jetzt prüfen</Link>
            </Notice>
          ) : null}
          {o.pendingApprovals > 0 ? (
            <Notice tone="warn" title={`${o.pendingApprovals} ${o.pendingApprovals === 1 ? "Freigabe wartet" : "Freigaben warten"} auf dich`}>
              Ein Agent hat etwas angefragt. <Link href="/freigaben" className="font-medium underline">Zu den Freigaben</Link>
            </Notice>
          ) : null}
        </div>
      ) : null}

      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {o ? (
          <>
            <Stat label="Abgelaufen" value={o.byStatus.expired} tone={o.byStatus.expired > 0 ? "danger" : undefined} />
            <Stat label="Bald fällig" value={o.byStatus.soon + o.byStatus.due} tone={o.byStatus.soon + o.byStatus.due > 0 ? "warn" : undefined} />
            <Stat label="Fehlt" value={o.byStatus.missing} tone={o.byStatus.missing > 0 ? "danger" : undefined} />
            <Stat label="Offene Prüfungen" value={o.pendingReviews} tone={o.pendingReviews > 0 ? "info" : undefined} />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => (
            <Card key={i}><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-8 w-12" /></Card>
          ))
        )}
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SectionLabel>Braucht Aufmerksamkeit</SectionLabel>
          <Tabs label="Nach Stage filtern" tabs={tabs} value={tab} onChange={setTab} />
        </div>
        {q.loading && !o ? <ListSkeleton /> : null}
        {o && list.length === 0 ? (
          <EmptyState title="Alles in Ordnung" icon="check">Hier gibt es {tab === "all" ? "nichts" : `in ${tab} nichts`}, worum du dich kümmern musst.</EmptyState>
        ) : null}
        {list.length > 0 ? (
          <ul className="divide-y divide-line">
            {list.map((s) => (
              <li key={s.id}>
                <Link href={`/secrets/${encodeURIComponent(s.id)}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-3 hover:bg-page">
                  <StatusBadge level={s.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.title ?? s.name}</span>
                    <span className="block truncate text-xs text-muted">{s.places.length ? s.places.map(placeText).join(", ") : "Keine Ziele"}</span>
                  </span>
                  <StageBadge stage={s.stage} />
                  <span className="tabular w-44 text-right text-sm text-muted-text">{daysLabel(s.daysLeft)}</span>
                  <Icon name="chevron" className="h-4 w-4 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}
