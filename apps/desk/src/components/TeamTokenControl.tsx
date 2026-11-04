"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icons";
import { AccessPrompt, ApprovalNotice, CodePrompt, ConsentPrompt, CredentialsPrompt } from "@/components/RunPrompts";
import { Button, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import type { StepState } from "@/lib/facade";
import { formatDate } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import type { PushStrategy, TeamMode } from "@/lib/team-picker";
import { createLabelKey, teamTokenFailureText, teamTokenSteps, teamTokenView, tokenCovers, type TeamTokenInfo, type TeamTokenSessionCheck } from "@/lib/team-token";

const ICON: Record<StepState, { name: string; cls: string }> = {
  pending: { name: "dot", cls: "text-muted" },
  active: { name: "clock", cls: "animate-pulse text-primary" },
  waiting: { name: "hand", cls: "text-warn-text" },
  done: { name: "check", cls: "text-success" },
  failed: { name: "x", cls: "text-danger" },
};

interface Props {
  /** `owner/name` of the team repository. Nothing happens while it is empty. */
  repo: string;
  branch?: string;
  mode: TeamMode;
  strategy: PushStrategy;
  /** Called once when a new team token is ready, so the page can check the modes again. */
  onCreated?: () => void;
}

/**
 * Creates a separate GitHub token for team sync: limited to this repository and to the rights of the chosen mode. The browser
 * does the work; GitHub's sign-in and "Confirm access" are done by the person in the browser window. Shows the run like the
 * provider sign-in does. The token itself is never shown.
 */
export function TeamTokenControl({ repo, branch, mode, strategy, onCreated }: Props) {
  const { t, locale } = useI18n();
  const [following, setFollowing] = useState(false);
  const [signedIn, setSignedIn] = useState<TeamTokenSessionCheck | null>(null);
  const info = useQuery<TeamTokenInfo>("team-token-info", () => api<TeamTokenInfo>("GET", "team-sync/token"), { refreshMs: following ? 1500 : 0 });
  const data = info.data;
  const view = teamTokenView(data);
  const running = view === "running" || view === "waiting";

  // Follow the run while it goes; pick up a run that is already going (page reloaded).
  useEffect(() => {
    if (running !== following) setFollowing(running);
  }, [running, following]);
  // Announce a run that finished while this page was open (not one that was already done when the page loaded).
  const status = data?.run.status;
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status === "done" && (previous.current === "running" || previous.current === "waiting-human")) onCreated?.();
    previous.current = status;
  }, [status, onCreated]);

  const start = useMutation(async () => {
    setSignedIn(null);
    const run = await api("POST", "team-sync/token", { repo, mode, strategy, ...(branch ? { branch } : {}) });
    setFollowing(true);
    info.reload();
    return run;
  });
  const cancel = useMutation(async () => {
    await api("POST", "team-sync/token/cancel");
    info.reload();
  });
  const check = useMutation(async () => {
    const r = await api<TeamTokenSessionCheck>("POST", "team-sync/token/check");
    setSignedIn(r);
    return r;
  });
  const answer = useMutation(async (route: string, body?: Record<string, unknown>) => {
    const r = await api("POST", `team-sync/token/${route}`, body);
    info.reload();
    return r;
  });
  const revoked = useMutation(async () => {
    await api("POST", "team-sync/token/revocation-done");
    info.reload();
  });

  if (!data) return info.error ? <Notice tone="warn">{info.error.message}</Notice> : null;
  const run = data.run;
  const covered = tokenCovers(data.active, repo, mode, strategy);
  const rights = data.rights[mode].join(", ");
  const canStart = Boolean(repo) && data.available && !running;
  const expires = data.active?.expires ? formatDate(data.active.expires) : "";

  return (
    <div className="space-y-3 rounded-xl border border-line p-4 text-sm" data-testid="team-token">
      <p className="font-medium">{t("teamToken.title")}</p>
      <p className="text-muted-text">{t("teamToken.explain", { rights, days: data.days })}</p>

      {!data.available ? (
        <Notice tone="warn">
          {data.reason === "automation-off" ? t("teamToken.automationOff") : t("teamToken.recipeMissing")}
        </Notice>
      ) : null}

      {data.active && view !== "running" && view !== "waiting" ? (
        <p className={data.active.valid ? "text-success-text" : "text-warn-text"}>
          {data.active.valid ? `✓ ${t("teamToken.active", { name: data.active.tokenName, repo: data.active.repo, date: expires })}` : t("teamToken.expired", { name: data.active.tokenName })}
          {data.active.valid && !covered ? ` · ${t("teamToken.notCovered")}` : ""}
        </p>
      ) : null}

      {view === "running" || view === "waiting" || view === "failed" || view === "done" ? (
        <ol className="space-y-1.5" aria-label={t("facade.stepsLabel")}>
          {teamTokenSteps(run).map((s) => {
            const icon = ICON[s.state];
            return (
              <li key={s.phase} className={`flex items-center gap-2 ${s.state === "pending" ? "text-muted" : ""} ${s.state === "failed" ? "font-medium text-danger-text" : ""}`} aria-current={s.state === "active" || s.state === "waiting" ? "step" : undefined}>
                <Icon name={icon.name} className={`h-4 w-4 shrink-0 ${icon.cls}`} />
                <span>{t(`teamToken.step.${s.phase}`)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {view === "waiting" || view === "running" ? (
        <>
          {run.ask?.type === "credentials" ? (
            <CredentialsPrompt name="GitHub" methods={run.ask.methods} pending={answer.pending} onSend={(body) => void answer.run("credentials", body)} />
          ) : null}
          {run.ask?.type === "access" ? <AccessPrompt name="GitHub" ask={run.ask} pending={answer.pending} onSend={(body) => void answer.run("access", body)} /> : null}
          {run.needs === "mfa-code" ? <CodePrompt name="GitHub" pending={answer.pending} onSend={(code) => void answer.run("code", { code })} /> : null}
          {run.needs === "approval" ? <ApprovalNotice name="GitHub" number={run.detail} /> : null}
          {run.needs === "consent" ? (
            <ConsentPrompt idp="Google" name="GitHub" scopes={run.detail} pending={answer.pending} onAnswer={(accept) => void answer.run("confirm", { accept })} />
          ) : null}
          {view === "waiting" && !run.ask && !run.needs ? (
            <Notice tone="warn" title={t("teamToken.waitingTitle")}>
              <p>{run.phase === "signin" ? t("teamToken.waiting.signin") : t("teamToken.waiting.confirm")}</p>
            </Notice>
          ) : null}
        </>
      ) : null}
      {answer.error ? <Notice tone="danger">{answer.error.message}</Notice> : null}

      {view === "done" ? <Notice tone="success">{t("teamToken.done", { name: data.active?.tokenName ?? "", date: expires })}</Notice> : null}
      {view === "done" && run.result && typeof run.result === "object" && (run.result as { revoked?: boolean | null }).revoked === true ? <Notice tone="success">{t("teamToken.revoked")}</Notice> : null}

      {view === "failed" && run.failure ? (
        <Notice tone={run.status === "cancelled" ? "info" : "danger"} {...(run.status === "cancelled" ? {} : { title: t("teamToken.failedTitle") })}>
          {teamTokenFailureText(run.failure, locale, t)}
        </Notice>
      ) : null}

      {signedIn && !signedIn.signedIn && !signedIn.failure ? (
        <Notice tone="warn">
          <p>{t("teamToken.signedOut")}</p>
        </Notice>
      ) : null}
      {signedIn?.signedIn ? <Notice tone="success">{t("teamToken.signedIn")}</Notice> : null}
      {signedIn?.failure ? <Notice tone="warn">{signedIn.failure.message}</Notice> : null}

      {data.pendingRevocation ? (
        <Notice tone="warn" title={t("teamToken.pending.title")}>
          <p>{t("teamToken.pending.text", { name: data.pendingRevocation.tokenName, repo: data.pendingRevocation.repo })}</p>
          {data.pendingRevocation.reason ? <p className="mt-1 text-xs">{t("teamToken.pending.reason", { reason: data.pendingRevocation.reason })}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <a className="inline-flex items-center gap-1 font-medium underline" href={data.pendingRevocation.url} target="_blank" rel="noopener noreferrer">
              {t("teamToken.pending.link")}
              <Icon name="external" className="h-3.5 w-3.5" />
            </a>
            <Button loading={revoked.pending} onClick={() => void revoked.run()}>{t("teamToken.pending.done")}</Button>
          </div>
        </Notice>
      ) : null}

      {start.error ? <Notice tone="danger">{start.error.message}</Notice> : null}
      {check.error ? <Notice tone="danger">{check.error.message}</Notice> : null}
      {cancel.error ? <Notice tone="danger">{cancel.error.message}</Notice> : null}

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button loading={cancel.pending} onClick={() => void cancel.run()}>{t("facade.cancel")}</Button>
        ) : (
          <>
            <Button variant="primary" loading={start.pending} disabled={!canStart} onClick={() => void start.run()}>{t(createLabelKey(data))}</Button>
            {data.available ? <Button loading={check.pending} onClick={() => void check.run()}>{t("facade.checkSignin")}</Button> : null}
          </>
        )}
      </div>
    </div>
  );
}
