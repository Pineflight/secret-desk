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

const ACTION: Record<string, string> = { issue: "Neuen Wert erzeugen", "apply-variable": "Variable in GitHub setzen" };

export default function ApprovalsPage() {
  const q = (useSearchParams().get("q") ?? "").trim();
  const list = useQuery<Approval[]>("approvals", () => api<Approval[]>("GET", "approvals"), { refreshMs: 10000 });
  const rows = (list.data ?? []).filter((a) => matchesQuery(q, a.targetId, a.requestedBy, a.reason, ACTION[a.action]));
  return (
    <>
      <PageHeader title="Freigaben" subtitle="Anfragen von Agenten, die ein Mensch freigeben muss." />
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <ListSkeleton /> : null}
      {list.data && rows.length === 0 ? <EmptyState title="Keine Anfragen" icon="inbox">Wenn ein Agent etwas in staging oder production auslösen will, erscheint es hier.</EmptyState> : null}
      <div className="space-y-3">{rows.map((a) => <ApprovalCard key={a.id} a={a} onChanged={list.reload} />)}</div>
    </>
  );
}

function ApprovalCard({ a, onChanged }: { a: Approval; onChanged: () => void }) {
  const toast = useToast();
  const decide = useMutation(async (d: "approve" | "deny") => api<Approval>("POST", `approvals/${enc(a.id)}/${d}`));
  const act = async (d: "approve" | "deny") => {
    const r = await decide.run(d);
    if (!r) return;
    toast.success(d === "approve" ? "Freigegeben." : "Abgelehnt.");
    onChanged();
  };
  const target = useQuery<SecretView | VariableView>(`approval-target:${a.action}:${a.targetId}`, () => api<SecretView | VariableView>("GET", `${a.action === "issue" ? "secrets" : "variables"}/${enc(a.targetId)}`));
  const state = approvalStateInfo(a.state);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{ACTION[a.action] ?? a.action}</p>
          <p className="text-sm text-muted-text">Ziel: <span className="font-mono text-ink">{a.targetId}</span> · angefragt von {a.requestedBy} am {formatDateTime(a.createdAt)}</p>
        </div>
        <Badge info={state} />
      </div>
      {target.data?.description ? <p className="mt-2 text-sm text-muted-text" title={target.data.description}>{target.data.name}: {truncate(target.data.description, 160)}</p> : null}
      {a.reason ? <p className="mt-2 text-sm">Grund: {a.reason}</p> : null}
      {a.result ? <p className="mt-2 text-sm text-muted-text">Ergebnis: {a.result}</p> : null}
      {decide.error ? <div className="mt-3"><Notice tone="danger">{decide.error.message}</Notice></div> : null}
      {a.state === "pending" ? (
        <div className="mt-4 flex gap-2">
          <Button variant="primary" loading={decide.pending} onClick={() => void act("approve")}><Icon name="check" />Freigeben</Button>
          <Button onClick={() => void act("deny")} disabled={decide.pending}>Ablehnen</Button>
        </div>
      ) : null}
      {a.state === "approved" && a.action === "issue" ? <p className="mt-3 text-sm"><Link href="/pruefen" className="font-medium text-primary underline">Zur Prüfung des neuen Werts</Link></p> : null}
    </Card>
  );
}
