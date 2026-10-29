"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { refreshCounts } from "@/lib/refresh";
import { useToast } from "@/lib/toast";
import { loadStages } from "@/lib/use-stages";
import type { PushPlan, SyncCheck, SyncStatus } from "@/lib/team-sync";
import { Button, Card, Notice, SectionLabel } from "./ui";
import { SyncDiff } from "./SyncDiff";

export function TeamSyncPanel() {
  const t = useT();
  const toast = useToast();
  const status = useQuery<SyncStatus>("team-sync-status", () => api<SyncStatus>("GET", "team-sync/status"));
  const [check, setCheck] = useState<SyncCheck | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [plan, setPlan] = useState<PushPlan | null>(null);
  const [pushUrl, setPushUrl] = useState<string | null>(null);
  const checkM = useMutation(async () => api<SyncCheck>("POST", "team-sync/check"));
  const applyM = useMutation(async (resolution: "merge" | "replace" | "keep-local") => api("POST", "team-sync/apply", { expectSha: check?.remoteSha, resolution, ...(resolution === "replace" ? { confirmReplace: true } : {}) }));
  const planM = useMutation(async () => api<PushPlan>("POST", "team-sync/push-plan"));
  const pushM = useMutation(async () => api<{ pushed: boolean; pullRequest?: { url: string } }>("POST", "team-sync/push", { confirm: true, expectLocalHash: plan?.localHash, expectRemoteSha: plan?.remoteSha }));
  const s = status.data;

  const sync = async () => {
    setCheck(null);
    setConfirmReplace(false);
    const r = await checkM.run();
    if (r) setCheck(r);
    status.reload();
  };
  const apply = async (resolution: "merge" | "replace" | "keep-local") => {
    const r = await applyM.run(resolution);
    if (r) {
      toast.success(t("teamSync.apply.done"));
      setCheck(null);
      void loadStages(true);
      refreshCounts();
      status.reload();
    }
  };
  const loadPlan = async () => {
    setPushUrl(null);
    const r = await planM.run();
    if (r) setPlan(r);
  };
  const push = async () => {
    const r = await pushM.run();
    if (r) {
      toast.success(t("teamSync.push.done"));
      setPushUrl(r.pullRequest?.url ?? null);
      setPlan(null);
      status.reload();
    }
  };

  if (!s) return null;
  const canApply = check?.remoteSha && check.diff && !check.diff.empty;
  return (
    <Card>
      <SectionLabel>{t("teamSync.title")}</SectionLabel>
      <p className="mt-3 text-sm text-muted-text">{t("teamSync.intro")}</p>
      {!s.configured ? (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span>{t("teamSync.notConfigured")}</span>
          <Link href="/setup" className="text-primary underline">{t("teamSync.setupLink")}</Link>
        </div>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-text">{t("teamSync.repo")}</dt><dd className="font-mono">{s.repo}</dd>
            <dt className="text-muted-text">{t("teamSync.file")}</dt><dd className="font-mono">{s.path} @ {s.branch}</dd>
            <dt className="text-muted-text">{t("teamSync.mode")}</dt><dd>{t(`teamSync.mode.${s.mode}`)}</dd>
            <dt className="text-muted-text">{t("teamSync.source")}</dt><dd>{t(`teamSync.source.${s.tokenSource}`)}</dd>
            <dt className="text-muted-text">{t("teamSync.neededRights")}</dt><dd>{s.neededRights.join(", ")}</dd>
            <dt className="text-muted-text">{t("teamSync.lastSync")}</dt><dd>{s.lastSyncAt ?? t("teamSync.never")}</dd>
          </dl>
          {s.lastError ? <div className="mt-3"><Notice tone="warn" title={t("teamSync.error")}>{s.lastError}</Notice></div> : null}
          {s.pendingPullUrl ? <p className="mt-3 text-sm">{t("teamSync.push.pending", { url: s.pendingPullUrl })}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={checkM.pending} disabled={!s.connected} onClick={() => void sync()}>{t("teamSync.syncNow")}</Button>
            {s.mode === "pull-push" ? <Button loading={planM.pending} disabled={!s.connected} onClick={() => void loadPlan()}>{t("teamSync.push.title")}</Button> : null}
          </div>
          {checkM.error ? <div className="mt-3"><Notice tone="danger">{checkM.error.message}</Notice></div> : null}
          {check ? (
            <div className="mt-4 space-y-3">
              <Notice tone={check.state === "conflict" ? "warn" : "info"}>{t(`teamSync.state.${check.state}`)}</Notice>
              {check.state === "conflict" ? <p className="text-sm">{t("teamSync.conflictHint")}</p> : null}
              {check.diff ? (
                <>
                  <h3 className="text-sm font-medium">{t("teamSync.previewTitle")}</h3>
                  <p className="text-xs text-muted-text">{t("teamSync.previewHint")}</p>
                  <SyncDiff diff={check.diff} />
                </>
              ) : null}
              {applyM.error ? <Notice tone="danger">{applyM.error.message}</Notice> : null}
              {canApply ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" loading={applyM.pending} onClick={() => void apply("merge")}>{t("teamSync.apply.merge")}</Button>
                  {confirmReplace ? (
                    <Button variant="danger" loading={applyM.pending} onClick={() => void apply("replace")}>{t("teamSync.apply.replaceConfirm")}</Button>
                  ) : (
                    <Button onClick={() => setConfirmReplace(true)}>{t("teamSync.apply.replace")}</Button>
                  )}
                  <Button onClick={() => void apply("keep-local")}>{t("teamSync.apply.keepLocal")}</Button>
                  <Button onClick={() => { setCheck(null); setConfirmReplace(false); }}>{t("teamSync.apply.cancel")}</Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {planM.error ? <div className="mt-3"><Notice tone="danger">{planM.error.message}</Notice></div> : null}
          {plan ? (
            <div className="mt-4 space-y-3">
              <h3 className="text-sm font-medium">{t("teamSync.push.title")}</h3>
              <p className="text-sm text-muted-text">{plan.strategy === "direct" ? t("teamSync.push.direct", { branch: plan.targetBranch }) : t("teamSync.push.pr", { branch: s.branch ?? "", pushBranch: plan.targetBranch })}</p>
              <SyncDiff diff={plan.diff} />
              {pushM.error ? <Notice tone="danger">{pushM.error.message}</Notice> : null}
              {plan.diff.empty ? <p className="text-sm">{t("teamSync.push.nothing")}</p> : (
                <div className="flex gap-2">
                  <Button variant="primary" loading={pushM.pending} onClick={() => void push()}>{t("teamSync.push.confirm")}</Button>
                  <Button onClick={() => setPlan(null)}>{t("teamSync.apply.cancel")}</Button>
                </div>
              )}
            </div>
          ) : null}
          {pushUrl ? <div className="mt-3"><Notice tone="success">{t("teamSync.push.donePr", { url: pushUrl })}</Notice></div> : null}
        </>
      )}
    </Card>
  );
}
