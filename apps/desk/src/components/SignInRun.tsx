"use client";
import { useEffect, useState } from "react";
import { AccessPrompt, ApprovalNotice, CodePrompt, ConsentPrompt } from "@/components/RunPrompts";
import { Icon } from "@/components/Icons";
import { Notice, TextField } from "@/components/ui";
import { IDP_NAMES, clock, elapsedSeconds, failureText, isRunning, methodsOf, needsPassword, remainingSeconds, stepsOf, type FacadeInfo, type FacadeMethodId, type FacadeState, type StepState, type SudoMethodId } from "@/lib/facade";
import { useI18n } from "@/lib/i18n";

/**
 * The parts of a browser sign-in that the provider dialog (sign in, then create a key) and the plain sign-in of a browser-only
 * vendor share: the way to sign in and the credential fields, and the live view of a run with its prompts. Typed values stay in
 * the caller's state and leave it the moment they are sent.
 */

/** A ticking clock (once a second) while `active`, for elapsed time and the time limit. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const ICON: Record<StepState, { name: string; cls: string }> = {
  pending: { name: "dot", cls: "text-muted" },
  active: { name: "clock", cls: "animate-pulse text-primary" },
  waiting: { name: "hand", cls: "text-warn-text" },
  done: { name: "check", cls: "text-success" },
  failed: { name: "x", cls: "text-danger" },
};

/** The steps of a run, live: what was done, what happens now, what comes next. `signInOnly`: no key is created. */
export function Stepper({ state, signInOnly = false }: { state: FacadeState | null; signInOnly?: boolean }) {
  const { t } = useI18n();
  return (
    <ol className="space-y-1.5 text-sm" aria-label={t("facade.stepsLabel")}>
      {stepsOf(state, { signInOnly }).map((s) => {
        const kind = s.state === "done" ? "done" : s.state === "active" || s.state === "waiting" ? "active" : "step";
        const icon = ICON[s.state];
        return (
          <li key={s.phase} className={`flex items-center gap-2 ${s.state === "pending" ? "text-muted" : ""} ${s.state === "failed" ? "font-medium text-danger-text" : ""}`} aria-current={s.state === "active" || s.state === "waiting" ? "step" : undefined}>
            <Icon name={icon.name} className={`h-4 w-4 shrink-0 ${icon.cls}`} />
            <span>{t(`facade.${kind}.${s.phase}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The way to sign in (when the provider offers several) and the email and password fields. `before` goes between the method hint
 * and the credentials (the provider dialog's inputs). A passwordless email sign-in asks for the email only.
 */
export function SignInFields({ info, name, method, onMethod, email, onEmail, password, onPassword, idPrefix, before }: {
  info: Pick<FacadeInfo, "methods" | "passwordless">;
  name: string;
  method: FacadeMethodId;
  onMethod: (id: FacadeMethodId) => void;
  email: string;
  onEmail: (v: string) => void;
  password: string;
  onPassword: (v: string) => void;
  idPrefix: string;
  before?: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const methods = methodsOf(info);
  const sso = method !== "email";
  return (
    <>
      {methods.length > 1 ? (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{t("facade.chooseMethod", { name })}</legend>
          {methods.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="radio" name={`${idPrefix}-method`} value={m.id} checked={method === m.id} onChange={() => onMethod(m.id)} />
              <span>{m.label && locale === "de" ? m.label : m.labelEn && locale === "en" ? m.labelEn : t(`facade.method.${m.id}`)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {sso ? <p className="text-xs text-muted">{t("facade.methodHint.sso", { name, idp: IDP_NAMES[method] })}</p> : null}
      {before}
      <TextField label={t(`facade.methodEmail.${method}`, { name })} type="email" name={`${idPrefix}-email`} autoComplete="off" spellCheck={false} data-autofocus data-1p-ignore data-lpignore="true" value={email} onChange={(e) => onEmail(e.target.value)} />
      {needsPassword(info, method) ? (
        <TextField label={t(`facade.methodPassword.${method}`, { name })} type="password" name={`${idPrefix}-password`} autoComplete="new-password" data-1p-ignore data-lpignore="true" value={password} onChange={(e) => onPassword(e.target.value)} />
      ) : (
        <p className="text-xs text-muted">{t("facade.passwordless", { name })}</p>
      )}
    </>
  );
}

/** What a run shows while it goes on and after it failed: steps, time, the question it asks the human, and the failure. */
export function RunStatus({ run, name, method, now, signInOnly = false, codePending, onCode, confirmPending, onConfirm, accessPending = false, onAccess }: {
  run: FacadeState;
  name: string;
  method: FacadeMethodId;
  now: number;
  signInOnly?: boolean;
  codePending: boolean;
  onCode: (code: string) => void;
  confirmPending: boolean;
  onConfirm: (accept: boolean) => void;
  /** Runs that verify the identity in the middle (a password or a code): the answer goes to the run once. */
  accessPending?: boolean;
  onAccess?: (body: { method: SudoMethodId; code?: string; password?: string }) => void;
}) {
  const { t, locale } = useI18n();
  const running = isRunning(run);
  const failed = run.status === "failed" || run.status === "cancelled";
  const remaining = remainingSeconds(run.timeoutAt, now);
  return (
    <>
      <Stepper state={run} signInOnly={signInOnly} />
      <p className="text-xs text-muted" aria-live="polite">
        {t("facade.elapsed", { elapsed: clock(elapsedSeconds(run.startedAt, now)) })}
        {running && remaining !== null ? ` · ${t("facade.remaining", { remaining: clock(remaining) })}` : ""}
      </p>
      {running && run.needs === "mfa-code" ? <CodePrompt name={name} pending={codePending} onSend={onCode} /> : null}
      {running && run.needs === "approval" ? <ApprovalNotice name={name} number={run.detail} /> : null}
      {running && run.needs === "consent" ? <ConsentPrompt idp={IDP_NAMES[method]} name={name} scopes={run.detail} pending={confirmPending} onAnswer={onConfirm} /> : null}
      {running && onAccess && run.ask?.type === "access" ? <AccessPrompt name={name} ask={run.ask} pending={accessPending} onSend={onAccess} /> : null}
      {failed && run.failure ? (
        <Notice tone={run.status === "cancelled" ? "info" : "danger"} {...(run.status === "cancelled" ? {} : { title: t("facade.failedTitle") })}>
          {failureText(run.failure, locale, t)}
        </Notice>
      ) : null}
    </>
  );
}
