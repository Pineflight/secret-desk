"use client";
import Link from "next/link";
import type { IssuanceView } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, PageHeader, StageBadge } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { countdown, formatDateTime } from "@/lib/format";
import { useNow, useQuery } from "@/lib/hooks";
import { overallInfo } from "@/lib/status";

export default function ReviewsPage() {
  const q = useQuery<IssuanceView[]>("reviews", () => api<IssuanceView[]>("GET", "reviews"), { refreshMs: 10000 });
  const now = useNow(1000);
  return (
    <>
      <PageHeader title="Prüfen" subtitle="Neue Werte warten hier auf deine Bestätigung. Erst danach wird etwas in GitHub geschrieben." />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <ListSkeleton /> : null}
      {q.data && q.data.length === 0 ? <EmptyState title="Nichts zu prüfen." icon="shield">Wenn ein neuer Wert erzeugt oder eingefügt wird, erscheint er hier.</EmptyState> : null}
      {q.data && q.data.length > 0 ? (
        <Card className="!p-2">
          <ul className="divide-y divide-line">
            {q.data.map((r) => {
              const left = Date.parse(r.expiresAt) - now;
              return (
                <li key={r.id}>
                  <Link href={`/pruefen/${enc(r.id)}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-3 py-3 hover:bg-page">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.secretName}</span>
                      <span className="block text-xs text-muted">Erstellt {formatDateTime(r.createdAt)}</span>
                    </span>
                    <StageBadge stage={r.stage} />
                    <Badge info={overallInfo(r.overall)} />
                    <span className={`tabular inline-flex items-center gap-1 text-sm ${left <= 0 ? "text-danger-text" : "text-muted-text"}`}>
                      <Icon name="clock" className="h-3.5 w-3.5" />{left <= 0 ? "Abgelaufen" : countdown(left)}
                    </span>
                    <Icon name="chevron" className="h-4 w-4 text-muted" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
