"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Badge, Button, Checkbox, ErrorState, Notice, SelectField, TextField } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { TONE_CHOICES, defaultEnvironment, suggestId, validateDraft, type StageDraft } from "@/lib/stage-draft";
import { STAGE_KINDS, stageLook, type StageKind } from "@/lib/stages";

/** Eine Stage anlegen oder bearbeiten. Speichern geschieht im Aufrufer (ganze Liste per PUT), Fehler des Servers kommen als `error` zurueck. */
export function StageDialog({ initial, others, pending, error, onSave, onClose }: { initial: StageDraft; others: StageDraft[]; pending: boolean; error: Error | null; onSave: (d: StageDraft) => void; onClose: () => void }) {
  const t = useT();
  const [d, setD] = useState<StageDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<StageDraft>) => {
    setD((cur) => ({ ...cur, ...patch }));
    setProblem(null);
  };
  const def = defaultEnvironment(d);
  const look = stageLook([{ id: d.id || "…", kind: d.kind, ...(d.label.trim() ? { label: d.label.trim() } : {}), ...(d.tone ? { tone: d.tone } : {}) }], d.id || "…");

  const submit = () => {
    const err = validateDraft(d, others);
    if (err) return setProblem(err.code === "id" ? t("settings.errId") : t("settings.errDuplicate", { id: err.id }));
    onSave(d);
  };

  return (
    <Dialog title={initial.isNew ? t("settings.addTitle") : t("settings.editTitle", { id: initial.id })} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-xl bg-page px-4 py-3">
          <span className="text-xs text-muted">{t("settings.preview")}</span>
          <Badge info={look} />
        </div>
        <TextField data-autofocus="" label={t("settings.label")} hint={t("settings.labelHint")} value={d.label} onChange={(e) => set({ label: e.target.value, ...(d.isNew && (!d.id || d.id === suggestId(d.label)) ? { id: suggestId(e.target.value) } : {}) })} autoComplete="off" />
        <TextField label={t("settings.id")} hint={d.isNew ? t("settings.idHint") : undefined} required readOnly={!d.isNew} value={d.id} onChange={(e) => set({ id: e.target.value.toLowerCase() })} autoComplete="off" />
        <SelectField searchable label={t("settings.kind")} hint={t(`settings.kindHelp.${d.kind}`)} value={d.kind} onChange={(e) => set({ kind: e.target.value as StageKind })}>
          {STAGE_KINDS.map((k) => <option key={k} value={k}>{t(`settings.kind.${k}`)}</option>)}
        </SelectField>
        <div className="space-y-2">
          <TextField label={t("settings.environment")} hint={t("settings.environmentHint", { default: def ?? t("settings.environmentNone") })} disabled={d.noEnvironment} placeholder={def ?? ""} value={d.environment} onChange={(e) => set({ environment: e.target.value })} autoComplete="off" />
          <Checkbox checked={d.noEnvironment} onChange={(v) => set({ noEnvironment: v, ...(v ? { environment: "" } : {}) })}>{t("settings.noEnvironment")}</Checkbox>
        </div>
        <SelectField label={t("settings.tone")} value={d.tone} onChange={(e) => set({ tone: e.target.value as StageDraft["tone"] })}>
          <option value="">{t("settings.toneDefault")}</option>
          {TONE_CHOICES.map((tone) => <option key={tone} value={tone}>{t(`settings.tone.${tone}`)}</option>)}
        </SelectField>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {error ? <ErrorState error={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t("settings.cancel")}</Button>
          <Button type="submit" variant="primary" loading={pending}>{t("settings.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
