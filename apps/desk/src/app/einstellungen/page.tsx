"use client";
import { useEffect, useState } from "react";
import type { StageView } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Checkbox, ErrorState, ListSkeleton, Notice, PageHeader, SectionLabel, SelectField, TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { MAX_STAGES, TONE_CHOICES, defaultEnvironment, newDraft, suggestId, toDrafts, toPayload, usageTotal, validateDrafts, type StageDraft } from "@/lib/stage-draft";
import { STAGE_KINDS, stageLook, type StageKind } from "@/lib/stages";
import { publishStages, useStages } from "@/lib/use-stages";
import { useToast } from "@/lib/toast";

export default function SettingsPage() {
  const t = useT();
  const { stages, reload } = useStages();
  return (
    <>
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
      {stages === undefined ? <ListSkeleton rows={4} /> : <StagesEditor stages={stages} onReload={reload} />}
    </>
  );
}

function StagesEditor({ stages, onReload }: { stages: StageView[]; onReload: () => void }) {
  const t = useT();
  const toast = useToast();
  const [drafts, setDrafts] = useState<StageDraft[]>(() => toDrafts(stages));
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) setDrafts(toDrafts(stages));
  }, [stages, dirty]);

  const save = useMutation(async (body: unknown) => api<StageView[]>("PUT", "stages", { stages: body }));
  const change = (next: StageDraft[]) => {
    setDrafts(next);
    setDirty(true);
    setLocalError(null);
  };
  const set = (i: number, patch: Partial<StageDraft>) => change(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const remove = (i: number) => {
    const d = drafts[i]!;
    if (d.usage.policy) return setLocalError(t("settings.removeBlockedPolicy", { id: d.id }));
    if (usageTotal(d.usage) > 0) return setLocalError(t("settings.removeBlocked", { id: d.id, secrets: d.usage.secrets, variables: d.usage.variables, templates: d.usage.templates }));
    change(drafts.filter((_, j) => j !== i));
  };

  const problemText = (): string | null => {
    const p = validateDrafts(drafts);
    if (!p) return null;
    switch (p.code) {
      case "empty": return t("settings.problemEmpty");
      case "max": return t("settings.problemMax", { max: MAX_STAGES });
      case "id": return t("settings.problemId", { row: p.row + 1 });
      default: return t("settings.problemDuplicate", { id: p.id });
    }
  };

  const submit = async () => {
    const problem = problemText();
    if (problem) return setLocalError(problem);
    const res = await save.run(toPayload(drafts));
    if (res) {
      publishStages(res);
      setDirty(false);
      toast.success(t("settings.saved"));
      onReload();
    }
  };

  const previewDefs = drafts.map((d) => ({ id: d.id || "…", kind: d.kind, ...(d.label.trim() ? { label: d.label.trim() } : {}), ...(d.tone ? { tone: d.tone } : {}) }));

  return (
    <Card>
      <SectionLabel>{t("settings.stagesTitle")}</SectionLabel>
      <p className="mt-3 text-sm text-muted-text">{t("settings.stagesIntro")}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-4 space-y-4">
        {drafts.map((d, i) => {
          const def = defaultEnvironment(d);
          return (
            <fieldset key={i} aria-label={t("settings.rowAria", { n: i + 1 })} className="rounded-xl border border-line p-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <TextField label={t("settings.id")} hint={d.isNew ? t("settings.idHint") : undefined} required readOnly={!d.isNew} value={d.id} onChange={(e) => set(i, { id: e.target.value.toLowerCase() })} autoComplete="off" />
                <TextField label={t("settings.label")} hint={t("settings.labelHint")} value={d.label} onChange={(e) => set(i, { label: e.target.value, ...(d.isNew && !d.id ? { id: suggestId(e.target.value) } : {}) })} autoComplete="off" />
                <SelectField label={t("settings.kind")} hint={t(`settings.kindHelp.${d.kind}`)} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as StageKind })}>
                  {STAGE_KINDS.map((k) => <option key={k} value={k}>{t(`settings.kind.${k}`)}</option>)}
                </SelectField>
                <div className="space-y-2">
                  <TextField label={t("settings.environment")} hint={t("settings.environmentHint", { default: def ?? t("settings.environmentNone") })} disabled={d.noEnvironment} placeholder={def ?? ""} value={d.environment} onChange={(e) => set(i, { environment: e.target.value })} autoComplete="off" />
                  <Checkbox checked={d.noEnvironment} onChange={(v) => set(i, { noEnvironment: v, ...(v ? { environment: "" } : {}) })}>{t("settings.noEnvironment")}</Checkbox>
                </div>
                <SelectField label={t("settings.tone")} value={d.tone} onChange={(e) => set(i, { tone: e.target.value as StageDraft["tone"] })}>
                  <option value="">{t("settings.toneDefault")}</option>
                  {TONE_CHOICES.map((tone) => <option key={tone} value={tone}>{t(`settings.tone.${tone}`)}</option>)}
                </SelectField>
                <div className="flex items-end justify-between gap-3">
                  <div className="text-xs text-muted">
                    <p className="mb-1">{t("settings.preview")}</p>
                    <Badge info={stageLook(previewDefs, d.id || "…")} />
                    <p className="mt-2">{usageTotal(d.usage) === 0 ? t("settings.usageNone") : t("settings.usage", { secrets: d.usage.secrets, variables: d.usage.variables, templates: d.usage.templates })}{d.usage.policy ? ` · ${t("settings.usagePolicy")}` : ""}</p>
                  </div>
                  <button type="button" aria-label={t("settings.remove", { id: d.id || String(i + 1) })} onClick={() => remove(i)} className="rounded-xl p-2 text-muted hover:bg-page">
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </fieldset>
          );
        })}
        <Button disabled={drafts.length >= MAX_STAGES} onClick={() => change([...drafts, newDraft()])}><Icon name="plus" />{t("settings.add")}</Button>
        <p className="text-xs text-muted">{t("settings.exportNote")}</p>
        {localError ? <Notice tone="danger">{localError}</Notice> : null}
        {save.error ? <ErrorState error={save.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={!dirty} onClick={() => { setDrafts(toDrafts(stages)); setDirty(false); setLocalError(null); save.reset(); }}>{t("settings.discard")}</Button>
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.pending}>{t("settings.save")}</Button>
        </div>
      </form>
    </Card>
  );
}
