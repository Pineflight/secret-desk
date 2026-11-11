"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { refreshCounts } from "@/lib/refresh";
import { formatDate } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { loadStages } from "@/lib/use-stages";
import type { PushPlan, SyncCheck, SyncStatus } from "@/lib/team-sync";
import { tokenDetailsOpen, tokenLine } from "@/lib/team-sync-view";
import { teamTokenView, type TeamTokenInfo } from "@/lib/team-token";
import { Button, Card, Disclosure, LinkButton, Notice, SectionLabel } from "./ui";
import { SyncDiff } from "./SyncDiff";
import { TeamTokenControl } from "./TeamTokenControl";

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
  // The status line and the details need the token state; the control inside reports every change through `onChanged`, which reloads this query.
  const [polling, setPolling] = useState(false);
  const tokenInfo = useQuery<TeamTokenInfo>("team-token-info-panel", () => api<TeamTokenInfo>("GET", "team-sync/token"), { refreshMs: polling ? 1500 : 0 });
  const tokenView = teamTokenView(tokenInfo.data);
  const tokenRunning = tokenView === "running" || tokenView === "waiting";
  useEffect(() => {
    if (tokenRunning !== polling) setPolling(tokenRunning);
  }, [tokenRunning, polling]);
  // The details open as soon as there is something to do there; the person can still close them.
  const [manageOpen, setManageOpen] = useState(false);
  const wantOpen = s?.repo && s.mode ? tokenDetailsOpen(tokenInfo.data, tokenLine(tokenInfo.data, s.repo, s.mode, s.pushStrategy ?? "pull-request")) : false;
  useEffect(() => {
    if (wantOpen) setManageOpen(true);
  }, [wantOpen]);

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
  const strategy = s.pushStrategy ?? "pull-request";
  const line = s.repo && s.mode ? tokenLine(tokenInfo.data, s.repo, s.mode, strategy) : null;
  if (!s.configured) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <SectionLabel>{t("teamSync.title")}</SectionLabel>
            <p className="mt-1 text-sm">{t("teamSync.notConfigured")}</p>
          </div>
          <LinkButton href="/setup" variant="primary" className="min-h-10">{t("teamSync.setupLink")}</LinkButton>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionLabel>{t("teamSync.title")}</SectionLabel>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="break-all font-mono">{s.repo}</span>
            <span className="break-all font-mono text-muted-text">{s.path} @ {s.branch}</span>
            <span className="rounded-full bg-page px-2.5 py-0.5 text-xs text-muted-text ring-1 ring-inset ring-line">{t(`teamSync.mode.${s.mode}`)}</span>
            <span className="text-muted-text">{t("teamSync.lastSync")}: <span>{s.lastSyncAt ?? t("teamSync.never")}</span></span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" className="min-h-10" loading={checkM.pending} disabled={!s.connected} onClick={() => void sync()}>{t("teamSync.syncNow")}</Button>
          {s.mode === "pull-push" ? <Button className="min-h-10" loading={planM.pending} disabled={!s.connected} onClick={() => void loadPlan()}>{strategy === "direct" ? t("teamSync.push.title") : t("teamSync.push.createPr")}</Button> : null}
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {s.lastError ? <Notice tone="warn" title={t("teamSync.error")}>{s.lastError}</Notice> : null}
        {checkM.error ? <Notice tone="danger">{checkM.error.message}</Notice> : null}
        {planM.error ? <Notice tone="danger">{planM.error.message}</Notice> : null}
        {s.pendingPullUrl ? <p className="text-sm">{t("teamSync.push.pending")} <a href={s.pendingPullUrl} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">{s.pendingPullUrl}</a></p> : null}
        {pushUrl ? <Notice tone="success">{t("teamSync.push.donePr")} <a href={pushUrl} target="_blank" rel="noopener noreferrer" className="break-all font-medium underline">{pushUrl}</a></Notice> : null}
      </div>
      {check ? (
        <div className="mt-4 space-y-3">
          <Notice tone={check.state === "conflict" ? "warn" : "info"}>{t(`teamSync.state.${check.state}`)}</Notice>
          {check.state === "conflict" ? <p className="text-sm">{t("teamSync.conflictHint")}</p> : null}
          {applyM.error ? <Notice tone="danger">{applyM.error.message}</Notice> : null}
          {canApply ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" className="min-h-10" loading={applyM.pending} onClick={() => void apply("merge")}>{t("teamSync.apply.merge")}</Button>
              {confirmReplace ? (
                <Button variant="danger" className="min-h-10" loading={applyM.pending} onClick={() => void apply("replace")}>{t("teamSync.apply.replaceConfirm")}</Button>
              ) : (
                <Button className="min-h-10" onClick={() => setConfirmReplace(true)}>{t("teamSync.apply.replace")}</Button>
              )}
              <Button className="min-h-10" onClick={() => void apply("keep-local")}>{t("teamSync.apply.keepLocal")}</Button>
              <Button className="min-h-10" onClick={() => { setCheck(null); setConfirmReplace(false); }}>{t("teamSync.apply.cancel")}</Button>
            </div>
          ) : null}
          {check.diff ? (
            <>
              <h3 className="text-sm font-medium">{t("teamSync.previewTitle")}</h3>
              <p className="text-xs text-muted-text">{t("teamSync.previewHint")}</p>
              <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line p-3"><SyncDiff diff={check.diff} /></div>
            </>
          ) : null}
        </div>
      ) : null}
      {plan ? (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-medium">{t("teamSync.push.title")}</h3>
          <p className="text-sm text-muted-text">{plan.strategy === "direct" ? t("teamSync.push.direct", { branch: plan.targetBranch }) : t("teamSync.push.pr", { branch: s.branch ?? "", pushBranch: plan.targetBranch })}</p>
          {pushM.error ? <Notice tone="danger">{pushM.error.message}</Notice> : null}
          {plan.diff.empty ? <p className="text-sm">{t("teamSync.push.nothing")}</p> : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" className="min-h-10" loading={pushM.pending} onClick={() => void push()}>{t("teamSync.push.confirm")}</Button>
              <Button className="min-h-10" onClick={() => setPlan(null)}>{t("teamSync.apply.cancel")}</Button>
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line p-3"><SyncDiff diff={plan.diff} /></div>
        </div>
      ) : null}
      {s.repo && s.mode ? (
        <div className="mt-4 border-t border-line pt-3">
          {line ? (
            <p className={`text-sm ${line === "valid" ? "text-success-text" : "text-warn-text"}`}>
              {line === "valid" ? `✓ ${t("teamSync.token.valid", { date: formatDate(tokenInfo.data?.active?.expires) })}` : t(`teamSync.token.${line}`)}
            </p>
          ) : null}
          <Disclosure summary={t("teamSync.token.manage")} open={manageOpen} onToggle={setManageOpen}>
            <TeamTokenControl heading repo={s.repo} {...(s.branch ? { branch: s.branch } : {})} mode={s.mode} strategy={strategy} onCreated={() => status.reload()} onChanged={() => tokenInfo.reload()} />
          </Disclosure>
        </div>
      ) : null}
      <div className="mt-2 border-t border-line pt-1">
        <Disclosure summary={t("teamSync.details")}>
          <p className="text-sm text-muted-text">{t("teamSync.intro")}</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-text">{t("teamSync.source")}</dt><dd>{t(`teamSync.source.${s.tokenSource}`)}</dd>
            <dt className="text-muted-text">{t("teamSync.neededRights")}</dt><dd>{s.neededRights.join(", ")}</dd>
          </dl>
        </Disclosure>
      </div>
    </Card>
  );
}
