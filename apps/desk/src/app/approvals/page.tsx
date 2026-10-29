"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Approval, SecretView, VariableView } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { formatDateTime, matchesQuery } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { approvalStateInfo } from "@/lib/status";
import { truncate } from "@/lib/tags";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";

const ACTION_KEYS: Record<string, string> = { issue: "approvals.actionIssue", "apply-variable": "approvals.actionApplyVariable" };

export default function ApprovalsPage() {
  const t = useT();
  const q = (useSearchParams().get("q") ?? "").trim();
  const list = useQuery<Approval[]>("approvals", () => api<Approval[]>("GET", "approvals"), { refreshMs: 10000 });
  const rows = (list.data ?? []).filter((a) => matchesQuery(q, a.targetId, a.requestedBy, a.reason, ACTION_KEYS[a.action] ? t(ACTION_KEYS[a.action]!) : undefined));
  return (
    <>
      <PageHeader title={t("approvals.title")} subtitle={t("approvals.subtitle")} />
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <ListSkeleton /> : null}
      {list.data && rows.length === 0 ? <EmptyState title={t("approvals.emptyTitle")} icon="inbox">{t("approvals.emptyText")}</EmptyState> : null}
      <div className="space-y-3">{rows.map((a) => <ApprovalCard key={a.id} a={a} onChanged={list.reload} />)}</div>
    </>
  );
}

function ApprovalCard({ a, onChanged }: { a: Approval; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const decide = useMutation(async (d: "approve" | "deny") => api<Approval>("POST", `approvals/${enc(a.id)}/${d}`));
  const act = async (d: "approve" | "deny") => {
    const r = await decide.run(d);
    if (!r) return;
    toast.success(d === "approve" ? t("approvals.approved") : t("approvals.denied"));
    onChanged();
  };
  const target = useQuery<SecretView | VariableView>(`approval-target:${a.action}:${a.targetId}`, () => api<SecretView | VariableView>("GET", `${a.action === "issue" ? "secrets" : "variables"}/${enc(a.targetId)}`));
  const state = approvalStateInfo(a.state);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{ACTION_KEYS[a.action] ? t(ACTION_KEYS[a.action]!) : a.action}</p>
          <p className="text-sm text-muted-text">{t("approvals.target")} <span className="font-mono text-ink">{a.targetId}</span> · {t("approvals.requestedByUnverified", { user: a.requestedBy, date: formatDateTime(a.createdAt) })}</p>
        </div>
        <Badge info={state} />
      </div>
      {target.data?.description ? <p className="mt-2 text-sm text-muted-text" title={target.data.description}>{target.data.name}: {truncate(target.data.description, 160)}</p> : null}
      {a.snapshot ? (
        <div className="mt-3 rounded-xl border border-line bg-muted p-3 text-sm">
          <p className="font-medium">{t("approvals.snapshotTitle")}</p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            {Object.entries(a.snapshot).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-text">{t(`approvals.snapshot.${k}`)}</dt>
                <dd className="break-words font-mono">{Array.isArray(v) ? v.join(", ") : v === null ? "-" : String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {a.state === "stale" ? <div className="mt-3"><Notice tone="warn">{t("approvals.stale")}</Notice></div> : null}
      {a.reason ? <p className="mt-2 text-sm">{t("approvals.reason", { reason: a.reason })}</p> : null}
      {a.result ? <p className="mt-2 text-sm text-muted-text">{t("approvals.result", { result: a.result })}</p> : null}
      {decide.error ? <div className="mt-3"><Notice tone="danger">{decide.error.message}</Notice></div> : null}
      {a.state === "pending" ? (
        <div className="mt-4 flex gap-2">
          <Button variant="primary" loading={decide.pending} onClick={() => void act("approve")}><Icon name="check" />{t("approvals.approve")}</Button>
          <Button onClick={() => void act("deny")} disabled={decide.pending}>{t("approvals.deny")}</Button>
        </div>
      ) : null}
      {a.state === "approved" && a.action === "issue" ? <p className="mt-3 text-sm"><Link href="/reviews" className="font-medium text-primary underline">{t("approvals.toReview")}</Link></p> : null}
    </Card>
  );
}
