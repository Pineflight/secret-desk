"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RunStatus, SignInFields, Stepper, useNow } from "@/components/SignInRun";
import { Button, Notice, SelectField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { chosenMethod, initialPortal, isFinished, isRunning, recipeSignInBody, recipeSignInButtonState, type FacadeState, type RecipeSignInSubject } from "@/lib/facade";
import { useMutation } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";

/**
 * The sign-in dialog of a browser-only vendor (a recipe with a guided sign-in, no provider dialog of its own). It only signs in:
 * no key is created. The run, its prompts (one-time code, approval, consent) and the credential rules are those of the provider
 * dialog. The typed values leave the form state the moment they are sent.
 */
export function RecipeSignInFlow({ subject, name, portal: wantedPortal, onChanged, onDone }: { subject: RecipeSignInSubject; name: string; portal?: string | null; onChanged: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const base = `recipes/${enc(subject.id)}/sign-in`;
  const [state, setState] = useState<FacadeState | null>(null);
  const [started, setStarted] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [portal, setPortal] = useState(() => initialPortal(subject, wantedPortal));
  const [methodId, setMethodId] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const notified = useRef(false);

  const signIn = useMutation(async (body: { method: string; username: string; password: string; host?: string }) => api<FacadeState>("POST", base, body));
  const sendCode = useMutation(async (c: string) => api<FacadeState>("POST", `${base}/code`, { code: c }));
  const cancel = useMutation(async () => api<FacadeState>("POST", `${base}/cancel`));
  const confirm = useMutation(async (accept: boolean) => api<FacadeState>("POST", `${base}/confirm`, { accept }));

  // Pick up a run that is already going (the page was reloaded).
  useEffect(() => {
    let stop = false;
    api<FacadeState>("GET", `${base}/state`)
      .then((s) => {
        if (stop || !isRunning(s)) return;
        setState(s);
        setStarted(true);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [base]);

  // Follow the run once a second until it ends.
  const following = started && !isFinished(state);
  useEffect(() => {
    if (!following) return;
    let stop = false;
    const id = setInterval(() => {
      api<FacadeState>("GET", `${base}/state`)
        .then((s) => {
          if (!stop) setState(s);
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [following, base]);

  // The sign-in is remembered by the server: the cards read it again.
  useEffect(() => {
    if (state?.status === "done" && !notified.current) {
      notified.current = true;
      onChanged();
    }
  }, [state?.status, onChanged]);

  const now = useNow(started && !isFinished(state));
  const method = chosenMethod(subject, methodId);
  const buttonState = recipeSignInButtonState(subject, portal, email, password, signIn.pending, method);

  const submit = useCallback(async () => {
    if (recipeSignInButtonState(subject, portal, email, password, false, method) !== "ready") return;
    // Copy, then clear: the form never keeps the password after sending.
    const body = recipeSignInBody(subject, portal, method, email, password);
    setEmail("");
    setPassword("");
    notified.current = false;
    const s = await signIn.run(body);
    body.password = "";
    if (s) {
      setState(s);
      setStarted(true);
      setCancelling(false);
    }
  }, [subject, portal, method, email, password, signIn]);

  const run = state && started ? state : null;
  const running = isRunning(run);
  const failed = run !== null && (run.status === "failed" || run.status === "cancelled");
  const portalName = subject.hosts.find((h) => h.value === portal)?.value ?? "";
  const host = subject.hosts.find((h) => h.value === portal)?.host ?? null;
  const err = signIn.error ?? sendCode.error ?? cancel.error ?? confirm.error;

  if (run?.status === "done") {
    return (
      <div className="space-y-4 text-sm">
        <Notice tone="success" title={t("recipeSignIn.doneTitle", { name: portalName ? `${name} ${portalName}` : name })}>
          <p>{t("recipeSignIn.doneHint")}</p>
        </Notice>
        <Stepper state={run} signInOnly />
        <div className="flex justify-end"><Button variant="primary" onClick={onDone}>{t("facade.done")}</Button></div>
      </div>
    );
  }

  if (run && (running || failed)) {
    return (
      <div className="space-y-4 text-sm">
        <RunStatus
          run={run}
          name={name}
          method={method}
          now={now}
          signInOnly
          codePending={sendCode.pending}
          onCode={(c) => void sendCode.run(c).then((s) => s && setState(s))}
          confirmPending={confirm.pending}
          onConfirm={(accept) => void confirm.run(accept).then((s) => s && setState(s))}
        />
        {err ? <Notice tone="danger">{err.message}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <Button
              loading={cancel.pending || cancelling}
              onClick={async () => {
                setCancelling(true);
                const s = await cancel.run();
                if (s) setState(s);
              }}
            >
              {cancelling ? t("facade.cancelling") : t("facade.cancel")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => { setStarted(false); setState(null); setCancelling(false); signIn.reset(); }}>{t("facade.retry")}</Button>
          )}
        </div>
      </div>
    );
  }

  const portalField = subject.hosts.length > 1 ? (
    <SelectField label={t("recipeSignIn.portal")} hint={t("recipeSignIn.portalHint", { name })} value={portal} onChange={(e) => setPortal(e.target.value)} required>
      <option value="">{t("facade.chooseOption")}</option>
      {subject.hosts.map((h) => <option key={h.value} value={h.value}>{`${h.value} (${h.host})`}</option>)}
    </SelectField>
  ) : null;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">{t("recipeSignIn.intro", { name })}</p>
      <div className="rounded-xl bg-page p-3 text-xs text-muted">
        <p className="font-medium text-ink">{t("facade.promiseTitle")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>{t("facade.promiseTyped", { host: host ?? (subject.hosts.length > 1 ? t("recipeSignIn.portalHost") : (subject.hosts[0]?.host ?? name)) })}</li>
          <li>{t("facade.promiseNever")}</li>
        </ul>
      </div>
      {!subject.available ? <Notice tone="warn">{t("facade.unavailable", { reason: t("recipeSignIn.unavailable") })}</Notice> : null}
      <form
        autoComplete="off"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {portalField}
        <SignInFields info={subject} name={name} method={method} onMethod={setMethodId} email={email} onEmail={setEmail} password={password} onPassword={setPassword} idPrefix="recipe" />
        {err ? <Notice tone="danger">{err.message}</Notice> : null}
        <Button type="submit" variant="primary" loading={signIn.pending} disabled={buttonState === "disabled"}>
          {signIn.pending ? t("facade.starting") : t("recipeSignIn.start")}
        </Button>
      </form>
    </div>
  );
}
