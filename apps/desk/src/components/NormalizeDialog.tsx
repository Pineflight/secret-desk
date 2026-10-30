"use client";
import { useMemo, useState } from "react";
import type { NormalizationChange, NormalizationKind, NormalizationPlan, NormalizationResult } from "@secret-desk/core";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton, Notice, SectionLabel, StageBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { useToast } from "@/lib/toast";

/** Reihenfolge der Gruppen im Dialog. */
export const NORMALIZE_KINDS: NormalizationKind[] = ["rename", "provider", "source", "stage", "merge", "manual-only"];

/** Der Plan der Vereinheitlichung (nur Namen, Stages, Anbieter, Parameter-Schluessel; nie Werte). */
export const useNormalizationPlan = () => useQuery<NormalizationPlan>("normalization", () => api<NormalizationPlan>("GET", "normalization"));

export const countApplicable = (changes: readonly NormalizationChange[]): number => changes.filter((c) => c.autoApplicable).length;

/** Kleine Warnung mit dem Namensvorschlag fuer den Kopf der Detailseiten. Nichts, wenn der Name der Konvention folgt. */
export function NameHint({ entryId }: { entryId: string }) {
  const t = useT();
  const plan = useNormalizationPlan();
  const rename = plan.data?.changes.find((c) => c.kind === "rename" && c.entryIds.includes(entryId));
  if (!rename) return null;
  return <Badge info={{ label: t("normalize.suggested", { name: rename.after[0]!.name }), tone: "warn", icon: "alert" }} />;
}

/** Eine Zeile "vorher -> nachher" je nach Art der Aenderung. */
function Transition({ change }: { change: NormalizationChange }) {
  const t = useT();
  const b = change.before[0]!;
  const a = change.after[0];
  const name = (n: string) => <span className="font-mono text-xs [overflow-wrap:anywhere]">{n}</span>;
  const arrow = <Icon name="arrow-down" className="h-3.5 w-3.5 shrink-0 -rotate-90 text-muted" />;
  if (change.kind === "rename" && a) return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{name(b.name)}{arrow}{name(a.name)}</div>;
  if (change.kind === "stage" && a) return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{name(b.name)}<StageBadge stage={b.stage} />{arrow}<StageBadge stage={a.stage} /></div>;
  if (change.kind === "provider" && a) return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{name(b.name)}{name(b.provider ?? "")}{arrow}{name(a.provider ?? "")}</div>;
  if (change.kind === "source" && a?.source) {
    const source = `${t(`params.kind.${a.source.kind}`)} · ${a.source.field}`;
    return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{name(b.name)}{arrow}<span className="text-xs">{t("normalize.source", { source })}</span>{a.source.resource === null ? <Badge info={{ label: t("normalize.pickResource"), tone: "warn", icon: "info" }} /> : null}</div>;
  }
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{change.before.map((x) => <span key={x.id}>{name(x.name)} <span className="text-xs text-muted">({x.id})</span></span>)}</div>;
}

function Row({ change, checked, onToggle }: { change: NormalizationChange; checked: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  const id = `normalize-${change.id}`;
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      {change.autoApplicable ? (
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} aria-label={change.before.map((x) => x.name).join(", ")} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--sd-primary)]" />
      ) : (
        <span className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <Transition change={change} />
        <p className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{change.entryIds.join(", ")}</p>
        <ul className="space-y-1 text-xs text-muted-text">
          {change.reasons.map((r) => <li key={r.code}>{r.text}</li>)}
          {change.kind === "merge" ? <li>{t("normalize.mergeHint")}</li> : null}
          {change.kind === "manual-only" ? <li>{t("normalize.manualHint")}</li> : null}
        </ul>
        {change.needsWorkflowChange || !change.autoApplicable || change.missingParams.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {change.needsWorkflowChange ? <Badge info={{ label: t("normalize.badge.workflow"), tone: "warn", icon: "alert" }} /> : null}
            {!change.autoApplicable && change.kind !== "manual-only" ? <Badge info={{ label: t("normalize.badge.manual"), tone: "neutral", icon: "info" }} /> : null}
            {change.missingParams.length > 0 ? <Badge info={{ label: t("normalize.badge.params", { keys: change.missingParams.join(", ") }), tone: "info", icon: "wrench" }} /> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Vorschau der Vereinheitlichung, nach Art gruppiert. Uebernommen wird nur per Klick und nur, was eindeutig ist. Aendert
 * nur das Inventar, nie GitHub. Danach fuehrt ein Hinweis zu "Parameter vervollstaendigen".
 */
export function NormalizeDialog({ onClose, onChanged, onCompleteParams }: { onClose: () => void; onChanged: () => void; onCompleteParams: () => void }) {
  const t = useT();
  const toast = useToast();
  const q = useNormalizationPlan();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NormalizationResult | null>(null);
  const changes = q.data?.changes ?? [];
  const applicable = useMemo(() => changes.filter((c) => c.autoApplicable), [changes]);
  const chosen = applicable.filter((c) => selected.has(c.id));
  const hasRename = changes.some((c) => c.needsWorkflowChange);

  const apply = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await api<NormalizationResult>("POST", "normalization/apply", { changeIds: ids });
      setResult(r);
      setSelected(new Set());
      toast.success(t("normalize.applied", { count: r.applied.length }));
      onChanged();
      q.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  return (
    <Dialog title={t("normalize.title")} description={t("normalize.desc")} onClose={onClose} wide>
      <div className="space-y-6">
        {result && result.needsParams.length > 0 ? (
          <Notice tone="success" title={t("normalize.nextTitle")}>
            <p>{t("normalize.nextText", { count: result.needsParams.length })}</p>
            <div className="mt-3"><Button variant="primary" onClick={onCompleteParams}><Icon name="wrench" />{t("normalize.nextAction")}</Button></div>
          </Notice>
        ) : null}
        {q.loading && !q.data ? <ListSkeleton rows={4} /> : null}
        {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
        {q.data && changes.length === 0 ? <EmptyState title={t("normalize.empty")} icon="check" /> : null}
        {hasRename ? <Notice tone="warn" title={t("normalize.workflowTitle")}>{t("normalize.workflowText")}</Notice> : null}
        {NORMALIZE_KINDS.map((kind) => {
          const list = changes.filter((c) => c.kind === kind);
          if (list.length === 0) return null;
          return (
            <section key={kind} className="space-y-2">
              <SectionLabel>{t(`normalize.kind.${kind}`)} ({list.length})</SectionLabel>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {list.map((c) => <Row key={c.id} change={c} checked={selected.has(c.id)} onToggle={(on) => toggle(c.id, on)} />)}
              </ul>
            </section>
          );
        })}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={onClose}>{t("normalize.close")}</Button>
          <Button disabled={chosen.length === 0 || busy} loading={busy} onClick={() => void apply(chosen.map((c) => c.id))}>{t("normalize.applySelected", { count: chosen.length })}</Button>
          <Button variant="primary" disabled={applicable.length === 0 || busy} onClick={() => void apply(applicable.map((c) => c.id))}><Icon name="check" />{t("normalize.applyAll", { count: applicable.length })}</Button>
        </div>
      </div>
    </Dialog>
  );
}
