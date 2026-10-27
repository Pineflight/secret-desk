"use client";
import { useState } from "react";
import type { StageView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, ErrorState, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { MAX_STAGES, applyDraft, moveItem, newDraft, removeBlock, toDrafts, toPayload, usageText, validateDrafts, type StageDraft } from "@/lib/stage-draft";
import { KIND_TONES, STAGE_KINDS, stageLook } from "@/lib/stages";
import { publishStages } from "@/lib/use-stages";
import { useToast } from "@/lib/toast";
import { StageDialog } from "./StageDialog";

const GRID = "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_auto] md:items-center md:gap-4";
const iconBtn = "rounded-xl p-2 text-muted hover:bg-page disabled:cursor-not-allowed disabled:opacity-40";

/** Stage-Liste: kompakt, jede Aenderung wird sofort als ganze Liste gespeichert (der Server prueft wie bisher). */
export function StagesPanel({ stages }: { stages: StageView[] }) {
  const t = useT();
  const toast = useToast();
  const drafts = toDrafts(stages);
  const [editing, setEditing] = useState<{ index: number | null; draft: StageDraft } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [how, setHow] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const save = useMutation(async (list: StageDraft[]) => api<StageView[]>("PUT", "stages", { stages: toPayload(list) }));

  const commit = async (list: StageDraft[], message: string): Promise<boolean> => {
    const p = validateDrafts(list);
    if (p) {
      setListError(p.code === "max" ? t("settings.problemMax", { max: MAX_STAGES }) : p.code === "empty" ? t("settings.problemEmpty") : t("settings.errId"));
      return false;
    }
    setListError(null);
    const res = await save.run(list);
    if (!res) return false;
    publishStages(res);
    toast.success(message);
    return true;
  };

  const defs = stages.map((s) => ({ id: s.id, kind: s.kind, ...(s.label ? { label: s.label } : {}), ...(s.tone ? { tone: s.tone } : {}) }));
  const atMax = drafts.length >= MAX_STAGES;
  const removeIndex = removing;
  const removeDraft = removeIndex === null ? null : drafts[removeIndex] ?? null;
  const block = removeDraft ? removeBlock(removeDraft.usage) : null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-text">{t("settings.stagesIntro")}</p>
        <Button variant="primary" disabled={atMax} title={atMax ? t("settings.maxReached", { max: MAX_STAGES }) : undefined} onClick={() => { save.reset(); setEditing({ index: null, draft: newDraft() }); }}><Icon name="plus" />{t("settings.add")}</Button>
      </div>

      <div className="mt-4 rounded-xl border border-line">
        <button type="button" aria-expanded={how} aria-controls="stages-how" onClick={() => setHow(!how)} className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium hover:bg-page">
          <Icon name="chevron" className={`h-4 w-4 transition-transform ${how ? "rotate-90" : ""}`} />
          {t("settings.howTitle")}
        </button>
        {how ? (
          <div id="stages-how" className="space-y-3 border-t border-line px-4 py-3 text-sm">
            <p className="text-muted-text">{t("settings.howBody")}</p>
            <dl className="grid gap-3 sm:grid-cols-2">
              {STAGE_KINDS.map((k) => (
                <div key={k} className="space-y-1">
                  <dt><Badge info={{ label: t(`settings.kind.${k}`), tone: KIND_TONES[k], icon: "dot" }} /></dt>
                  <dd className="text-xs text-muted">{t(`settings.kindHelp.${k}`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>

      <p className="mt-4 text-xs text-muted">{t("settings.orderNote")}</p>
      <div role="table" aria-label={t("settings.listAria")} className="mt-2">
        <div role="row" className={`hidden border-b border-line px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted ${GRID}`}>
          <span role="columnheader">{t("settings.col.stage")}</span>
          <span role="columnheader">{t("settings.col.kind")}</span>
          <span role="columnheader">{t("settings.col.environment")}</span>
          <span role="columnheader">{t("settings.col.usage")}</span>
          <span role="columnheader" className="text-right">{t("settings.col.actions")}</span>
        </div>
        <div role="rowgroup" className="divide-y divide-line">
          {stages.map((s, i) => {
            const d = drafts[i]!;
            return (
              <div key={s.id} role="row" className={`space-y-2 px-3 py-3 md:space-y-0 ${GRID}`}>
                <div role="cell" className="min-w-0">
                  <Badge info={stageLook(defs, s.id)} />
                  <p className="mt-1 truncate font-mono text-xs text-muted">{s.id}</p>
                </div>
                <div role="cell" className="text-sm">
                  <span className="mr-2 text-xs text-muted md:hidden">{t("settings.col.kind")}</span>
                  <Badge info={{ label: t(`settings.kind.${s.kind}`), tone: KIND_TONES[s.kind], icon: "dot" }} />
                </div>
                <div role="cell" className="min-w-0 text-sm">
                  <span className="mr-2 text-xs text-muted md:hidden">{t("settings.col.environment")}</span>
                  {s.environmentName ? <span className="font-mono text-xs">{s.environmentName}</span> : <span className="text-muted">{t("settings.environmentNone")}</span>}
                </div>
                <div role="cell" className="text-sm text-muted-text">
                  <span className="mr-2 text-xs text-muted md:hidden">{t("settings.col.usage")}</span>
                  {usageText(d.usage, t)}
                </div>
                <div role="cell" className="flex items-center justify-end gap-1">
                  <button type="button" className={iconBtn} aria-label={t("settings.moveUp", { id: s.id })} title={t("settings.moveUp", { id: s.id })} disabled={i === 0 || save.pending} onClick={() => void commit(moveItem(drafts, i, -1), t("settings.saved"))}><Icon name="arrow-up" className="h-4 w-4" /></button>
                  <button type="button" className={iconBtn} aria-label={t("settings.moveDown", { id: s.id })} title={t("settings.moveDown", { id: s.id })} disabled={i === stages.length - 1 || save.pending} onClick={() => void commit(moveItem(drafts, i, 1), t("settings.saved"))}><Icon name="arrow-down" className="h-4 w-4" /></button>
                  <button type="button" className={iconBtn} aria-label={t("settings.editAria", { id: s.id })} title={t("settings.edit")} onClick={() => { save.reset(); setEditing({ index: i, draft: d }); }}><Icon name="pencil" className="h-4 w-4" /></button>
                  <button type="button" className={iconBtn} aria-label={t("settings.removeAria", { id: s.id })} title={t("settings.remove")} onClick={() => { save.reset(); setRemoving(i); }}><Icon name="trash" className="h-4 w-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted">{t("settings.exportNote")}</p>
      {listError ? <div className="mt-3"><Notice tone="danger">{listError}</Notice></div> : null}
      {!editing && removing === null && save.error ? <div className="mt-3"><ErrorState error={save.error} /></div> : null}

      {editing ? (
        <StageDialog
          initial={editing.draft}
          others={drafts.filter((_, j) => j !== editing.index)}
          pending={save.pending}
          error={save.error}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            if (await commit(applyDraft(drafts, editing.index, d), t("settings.saved"))) setEditing(null);
          }}
        />
      ) : null}

      {removeDraft ? (
        <Dialog title={t("settings.removeTitle", { id: removeDraft.id })} onClose={() => setRemoving(null)}>
          <div className="space-y-4">
            {block === "policy" ? (
              <Notice tone="warn">{t("settings.removeBlockedPolicy", { id: removeDraft.id })}</Notice>
            ) : block === "used" ? (
              <Notice tone="warn">{t("settings.removeBlocked", { id: removeDraft.id, usage: usageText({ ...removeDraft.usage, policy: false }, t) })}</Notice>
            ) : (
              <p className="text-sm text-muted-text">{t("settings.removeBody")}</p>
            )}
            {save.error ? <ErrorState error={save.error} /> : null}
            <div className="flex justify-end gap-2">
              <Button data-autofocus="" onClick={() => setRemoving(null)}>{t("settings.cancel")}</Button>
              <Button variant="danger" disabled={block !== null} loading={save.pending} onClick={async () => {
                if (await commit(drafts.filter((_, j) => j !== removeIndex), t("settings.removed", { id: removeDraft.id }))) setRemoving(null);
              }}><Icon name="trash" />{t("settings.remove")}</Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
