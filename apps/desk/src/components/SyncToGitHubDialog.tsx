"use client";
import { useEffect, useMemo, useState } from "react";
import type { SyncLine, SyncOutcome, SyncPlan, SyncResult } from "@secret-desk/core";
import { Dialog } from "@/components/Dialog";
import { Badge, Button, Checkbox, ErrorState, ListSkeleton, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { batches, defaultSelection, groupByRepository, needsProduction, summarize, writable } from "@/lib/sync-view";
import { useToast } from "@/lib/toast";

type T = ReturnType<typeof useT>;

const ACTION_TONE = { set: "info", write: "info", skip: "neutral" } as const;

function LineText({ l, t }: { l: SyncLine; t: T }) {
  return (
    <div className="min-w-0 text-sm">
      <p className="break-all font-medium">
        {l.name} <span className="text-xs font-normal text-muted">{t(l.kind === "secret" ? "compare.kindSecretOne" : "compare.kindVariableOne")} · {l.placeLabel}</span>
      </p>
      <p className="text-xs text-muted">
        {t(`compare.sync.reason.${l.reason}`)}
        {l.production ? ` · ${t("compare.sync.production")}` : ""}
        {l.renewable ? ` · ${t("compare.sync.renewable")}` : ""}
        {l.detail ? ` · ${l.detail}` : ""}
      </p>
      {l.warning ? <p className="text-xs text-warn-text">{t("compare.sync.warnNewer")}</p> : null}
    </div>
  );
}

/** Review screen for "sync everything to GitHub": plan (read-only), selection, production confirmation, batched execution. */
export function SyncToGitHubDialog({ repo, onClose, onDone }: { repo?: string | undefined; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [production, setProduction] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<SyncOutcome[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const load = (): void => {
    setPlan(null);
    setError(null);
    api<SyncPlan>("POST", "compare/sync-plan", repo ? { repo } : {})
      .then((p) => {
        setPlan(p);
        setSelected(defaultSelection(p));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e : new Error(String(e))));
  };
  useEffect(load, [repo]);

  const groups = useMemo(() => (plan ? groupByRepository(plan.lines) : []), [plan]);
  const count = plan ? writable(plan).filter((l) => selected.has(l.key)).length : 0;
  const prod = plan ? needsProduction(plan, selected) : false;
  const busy = progress !== null;

  const run = async (): Promise<void> => {
    if (!plan || count === 0) return;
    const parts = batches(plan, selected);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all: SyncOutcome[] = [];
    setRunError(null);
    setProgress({ done: 0, total });
    try {
      for (const keys of parts) {
        const r = await api<SyncResult>("POST", "compare/sync", { keys, confirmProduction: prod && production, ...(repo ? { repo } : {}) });
        all.push(...r.outcomes);
        setProgress({ done: all.length, total });
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
    setProgress(null);
    setOutcomes(all);
    const s = summarize(all);
    if (s.failed.length === 0 && all.length === total) toast.success(t("compare.sync.done", { count: s.ok }));
    else toast.error(t("compare.sync.doneFailed", { ok: s.ok, failed: s.failed.length + (total - all.length) }));
    if (s.ok > 0) onDone();
  };

  const toggle = (key: string, on: boolean): void => setSelected((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });
  const summary = outcomes ? summarize(outcomes) : null;

  return (
    <Dialog title={t("compare.sync.title")} description={t("compare.sync.text")} onClose={busy ? () => undefined : onClose} wide>
      <div className="space-y-4">
        {error ? <ErrorState error={error} onRetry={load} /> : null}
        {!plan && !error ? <ListSkeleton rows={4} /> : null}
        {plan && !outcomes ? (
          <>
            <p className="text-sm" aria-live="polite">{t("compare.sync.counts", { set: plan.counts.set, write: plan.counts.write, skip: plan.counts.skip, unchanged: plan.counts.unchanged })}</p>
            {writable(plan).length === 0 ? <Notice tone="success">{t("compare.sync.nothing")}</Notice> : null}
            <div className="max-h-[26rem] space-y-4 overflow-y-auto">
              {groups.map((g) => (
                <section key={g.repo} aria-label={g.repo}>
                  <p className="sd-group-head text-sm font-semibold">{g.repo} <span className="text-xs font-normal text-muted">{g.lines.length}</span></p>
                  <ul className="mt-1 space-y-2">
                    {g.lines.map((l) => (
                      <li key={l.key} className="grid items-center gap-2 rounded-xl border border-line p-2 sm:grid-cols-[auto_1fr_auto]">
                        {l.action === "skip" ? <span className="h-5 w-5" aria-hidden="true" /> : <Checkbox checked={selected.has(l.key)} onChange={(v) => toggle(l.key, v)} disabled={busy}><span className="sr-only">{t("compare.sync.include", { name: l.name })}</span></Checkbox>}
                        <LineText l={l} t={t} />
                        <Badge info={{ label: t(`compare.sync.action.${l.action}`), tone: ACTION_TONE[l.action], icon: l.action === "skip" ? "info" : "check" }} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {prod ? (
              <Notice tone="warn" title={t("compare.sync.productionTitle")}>
                <Checkbox checked={production} onChange={setProduction} disabled={busy}>{t("compare.sync.productionConfirm")}</Checkbox>
              </Notice>
            ) : null}
            {progress ? <p className="text-sm" role="status">{t("compare.sync.progress", { done: progress.done, total: progress.total })}</p> : null}
            <div className="flex justify-end gap-2">
              <Button onClick={onClose} disabled={busy}>{t("compare.cancel")}</Button>
              <Button variant="primary" loading={busy} disabled={count === 0 || (prod && !production)} onClick={() => void run()}>{t("compare.sync.confirm", { count })}</Button>
            </div>
          </>
        ) : null}
        {outcomes && summary ? (
          <>
            {runError ? <Notice tone="danger">{runError}</Notice> : null}
            <Notice tone={summary.failed.length === 0 && !runError ? "success" : "warn"}>{t("compare.sync.summary", { ok: summary.ok, failed: summary.failed.length, skipped: summary.skipped })}</Notice>
            {summary.failed.length > 0 ? (
              <ul className="max-h-60 list-disc space-y-1 overflow-y-auto pl-5 text-xs">
                {summary.failed.map((o) => <li key={o.key}><span className="font-medium">{o.name}</span> · {o.placeLabel}: {o.error}</li>)}
              </ul>
            ) : null}
            <div className="flex justify-end"><Button variant="primary" onClick={onClose}>{t("compare.close")}</Button></div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
