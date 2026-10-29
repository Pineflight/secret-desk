"use client";
import Link from "next/link";
import { useState } from "react";
import type { ParamSuggestion, ParamsView, SecretView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton, Notice, StageBadge } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { canApplyRow, isUnambiguous, suggestedKeys, suggestionBody, unambiguousRows, type RowState } from "@/lib/params-list";
import { useToast } from "@/lib/toast";

interface Result {
  state: RowState;
  error?: string;
  stillMissing?: string[];
}

/** Alle Eintraege mit fehlenden Parametern samt Vorschlaegen. Gespeichert wird nur per Klick, und nur, was das Portal eindeutig fand. */
export function CompleteParamsDialog({ secrets, onClose, onChanged }: { secrets: SecretView[]; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const q = useQuery<{ suggestions: ParamSuggestion[] }>("params-suggest-all", () => api<{ suggestions: ParamSuggestion[] }>("POST", "params/suggest-all"));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const rows = q.data?.suggestions ?? [];
  const nameOf = (id: string) => secrets.find((s) => s.id === id);

  const apply = async (row: ParamSuggestion): Promise<boolean> => {
    setBusy((b) => new Set(b).add(row.secretId));
    try {
      const view = await api<ParamsView>("PUT", `secrets/${enc(row.secretId)}/params`, { params: suggestionBody(row) });
      setResults((r) => ({ ...r, [row.secretId]: { state: "applied", stillMissing: view.problems.filter((p) => p.code === "missing").map((p) => p.key) } }));
      return true;
    } catch (e) {
      setResults((r) => ({ ...r, [row.secretId]: { state: "error", error: e instanceof Error ? e.message : String(e) } }));
      return false;
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(row.secretId); return n; });
    }
  };

  const applyOne = async (row: ParamSuggestion) => {
    if (await apply(row)) onChanged();
  };
  const pending = unambiguousRows(rows).filter((r) => results[r.secretId]?.state !== "applied");
  const applyAll = async () => {
    let ok = 0;
    let failed = 0;
    for (const row of pending) {
      if (await apply(row)) ok++;
      else failed++;
    }
    onChanged();
    if (failed > 0) toast.error(t("params.complete.doneFailed", { ok, failed }));
    else toast.success(t("params.complete.done", { count: ok }));
  };

  return (
    <Dialog title={t("params.complete.title")} description={t("params.complete.desc")} onClose={onClose} wide>
      {q.loading && !q.data ? <><p className="mb-3 text-sm text-muted">{t("params.complete.loading")}</p><ListSkeleton rows={3} /></> : null}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.data && rows.length === 0 ? <EmptyState title={t("params.complete.empty")} icon="check" /> : null}
      {rows.length > 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">{pending.length === 0 ? t("params.complete.nothingToApply") : ""}</p>
            <Button variant="primary" disabled={pending.length === 0 || busy.size > 0} loading={busy.size > 0} onClick={() => void applyAll()}><Icon name="check" />{t("params.complete.applyAll", { count: pending.length })}</Button>
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {rows.map((row) => {
              const s = nameOf(row.secretId);
              const res = results[row.secretId];
              const keys = suggestedKeys(row);
              return (
                <li key={row.secretId} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/secrets/${enc(row.secretId)}`} className="font-medium text-primary hover:underline">{s?.title ?? s?.name ?? row.secretId}</Link>
                    <span className="font-mono text-xs text-muted">{row.secretId}</span>
                    <StageBadge stage={row.stage} />
                    <Badge info={statusInfo(row, t)} />
                  </div>
                  <dl className="space-y-1">
                    {row.missing.map((k) => {
                      const sg = row.suggestions[k];
                      return (
                        <div key={k} className="flex flex-wrap gap-x-3">
                          <dt className="w-40 shrink-0 font-mono text-xs text-muted-text">{k}</dt>
                          <dd className="min-w-0 flex-1">{sg ? <><span className="font-medium">{sg.label}</span> <span className="text-xs text-muted">({sg.reason})</span></> : <span className="text-muted-text">–</span>}</dd>
                        </div>
                      );
                    })}
                  </dl>
                  {res?.state === "applied" ? <p className="text-success-text">{t("params.complete.applied")}{res.stillMissing && res.stillMissing.length > 0 ? ` · ${t("params.complete.stillMissing", { keys: res.stillMissing.join(", ") })}` : ""}</p> : null}
                  {res?.state === "error" ? <Notice tone="danger">{res.error}</Notice> : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {res?.state !== "applied" ? <Button disabled={!canApplyRow(row)} loading={busy.has(row.secretId)} onClick={() => void applyOne(row)}>{t("params.complete.apply")}{keys.length < row.missing.length && keys.length > 0 ? ` (${keys.length}/${row.missing.length})` : ""}</Button> : null}
                    {row.status === "not-connected" ? <Link href="/connections" className="text-sm font-medium text-primary underline">{t("params.toConnections")}</Link> : null}
                    {res?.state !== "applied" && !isUnambiguous(row) ? <Link href={`/secrets/${enc(row.secretId)}`} className="text-sm text-primary underline">{t("params.complete.manual")}</Link> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>{t("params.complete.close")}</Button></div>
    </Dialog>
  );
}

function statusInfo(row: ParamSuggestion, t: (k: string) => string) {
  if (row.status === "suggested") return { label: t("params.complete.statusSuggested"), tone: "success" as const, icon: "check" as const };
  if (row.status === "partial") return { label: t("params.complete.statusPartial"), tone: "warn" as const, icon: "alert" as const };
  if (row.status === "not-connected") return { label: t("params.complete.statusNotConnected"), tone: "danger" as const, icon: "plug" as const };
  return { label: t("params.complete.statusNone"), tone: "warn" as const, icon: "info" as const };
}
