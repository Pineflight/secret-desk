"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckList } from "@/components/ConnectionCheck";
import { FacadeBrowserOnly } from "@/components/FacadeBrowserOnly";
import { ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { RunStatus, SignInFields, Stepper, useNow } from "@/components/SignInRun";
import { Badge, Button, Card, Notice, SelectField, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { browserSignInOf, chosenMethod, connectButtonState, countsText, dialogView, inputsBody, isFinished, isRunning, signInButtonState, type FacadeInfo, type FacadeState, type SudoMethodId } from "@/lib/facade";
import { outcomeOf, outcomeOfError, outcomeProblem, type CheckOutcome, type CheckResponse } from "@/lib/sign-in-check";
import { useMutation } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";

/**
 * How the dialog asks for the browser sign-in check. The connections page provides its check queue, so the check never overlaps
 * another one in the single remote browser; without a provider the dialog checks directly.
 */
export const FacadeCheckContext = createContext<{ check: (id: string) => Promise<CheckOutcome | undefined> } | null>(null);

/** The way out: paste a key created by hand. Collapsed, never the main path. */
function FallbackBox({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <details className="rounded-xl border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">{t("facade.fallbackTitle")}</summary>
      <p className="mt-2 text-xs text-muted">{t("facade.fallbackHint")}</p>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** Starts and follows one sign-in run. The typed values leave the form state the moment they are sent. */
export function FacadeFlow({ facade, onChanged, onDone, fallback, initialInputs }: { facade: FacadeInfo; onChanged: () => void; onDone: () => void; fallback?: ReactNode; initialInputs?: Record<string, string> }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<FacadeState | null>(null);
  const [started, setStarted] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [project, setProject] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>(initialInputs ?? {});
  const [cancelling, setCancelling] = useState(false);
  const [methodId, setMethodId] = useState("");
  const [pickedUp, setPickedUp] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | undefined>(undefined);
  const [checkRound, setCheckRound] = useState(0);
  const checks = useContext(FacadeCheckContext);
  const notified = useRef(false);
  const base = `facades/${enc(facade.id)}`;

  const signIn = useMutation(async (body: { username: string; password: string; method?: string; projectId?: string; inputs?: Record<string, string> }) => api<FacadeState>("POST", `${base}/sign-in`, body));
  const connect = useMutation(async (projectId: string) => api<FacadeState>("POST", `${base}/connect`, { projectId, inputs: inputsBody(facade.inputs, inputValues) }));
  const sendCode = useMutation(async (c: string) => api<FacadeState>("POST", `${base}/code`, { code: c }));
  const cancel = useMutation(async () => api<FacadeState>("POST", `${base}/cancel`));
  const confirm = useMutation(async (accept: boolean) => api<FacadeState>("POST", `${base}/confirm`, { accept }));
  const sendAccess = useMutation(async (body: { method: SudoMethodId; code?: string; password?: string }) => api<FacadeState>("POST", `${base}/access`, body));

  // Pick up a run that is already going (the page was reloaded).
  useEffect(() => {
    let stop = false;
    api<FacadeState>("GET", `${base}/state`)
      .then((s) => {
        if (stop || !isRunning(s)) return;
        setState(s);
        setStarted(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stop) setPickedUp(true);
      });
    return () => {
      stop = true;
    };
  }, [base]);

  // First thing when the dialog opens (and no run is going): is the browser signed in at the provider?
  useEffect(() => {
    if (!pickedUp || started) return;
    let stop = false;
    setOutcome(undefined);
    if (!facade.available) {
      setOutcome({ signedIn: null, failure: null, error: null });
      return;
    }
    const check = checks ? checks.check(facade.id) : api<CheckResponse>("POST", `${base}/check`).then(outcomeOf, outcomeOfError);
    void check.then((o) => {
      if (!stop) setOutcome(o ?? { signedIn: null, failure: null, error: "" });
    });
    return () => {
      stop = true;
    };
    // `started` is read once: a run that starts later must not trigger another check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedUp, checkRound, facade.id, facade.available, base, checks]);

  // Follow the run once a second until it ends.
  const following = started && !isFinished(state);
  useEffect(() => {
    if (!following) return;
    let stop = false;
    const tick = () =>
      api<FacadeState>("GET", `${base}/state`)
        .then((s) => {
          if (!stop) setState(s);
        })
        .catch(() => undefined);
    const id = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [following, base]);

  useEffect(() => {
    if (state?.status === "done" && !notified.current) {
      notified.current = true;
      onChanged();
    }
  }, [state?.status, onChanged]);

  const now = useNow(started && !isFinished(state));
  const submit = useCallback(async () => {
    if (signInButtonState(facade, email, password, inputValues, false, chosenMethod(facade, methodId)) !== "ready") return;
    // Copy, then clear: the form never keeps the password after sending.
    const body = { username: email.trim(), password, method: chosenMethod(facade, methodId), ...(project.trim() ? { projectId: project.trim() } : {}), ...(facade.inputs.length > 0 ? { inputs: inputsBody(facade.inputs, inputValues) } : {}) };
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
  }, [email, password, project, inputValues, facade, methodId, signIn]);

  const run = state && started ? state : null;
  const running = isRunning(run);
  const failed = run !== null && (run.status === "failed" || run.status === "cancelled");
  const connectedOk = run?.status === "done" && run.result?.connected === true;
  const err = signIn.error ?? connect.error ?? sendCode.error ?? cancel.error ?? confirm.error;

  const reset = () => {
    setStarted(false);
    setState(null);
    setCancelling(false);
    signIn.reset();
    connect.reset();
  };

  if (run?.status === "done" && run.result?.browserOnly === true) return <FacadeBrowserOnly run={run} onDone={onDone} />;

  if (connectedOk && run?.result) {
    const r = run.result;
    const where = t(r.storedIn === "vault" ? "facade.where.vault" : "facade.where.session");
    const counts = countsText(r.counts, t);
    return (
      <div className="space-y-4 text-sm">
        <Notice tone="success" title={t("facade.resultTitle")}>
          {counts ? <p>{counts}</p> : null}
          <p className="text-xs">{t("facade.resultKey", { name: r.keyName, where })}</p>
        </Notice>
        <Stepper state={run} />
        {r.check ? <CheckList result={{ ...r.check, id: r.connectionId ?? facade.connectionId }} /> : null}
        <p className="text-muted">{t("facade.resultNext")}</p>
        {facade.inputs.length === 0 ? <ConnectionResourcesPanel id={facade.connectionId} /> : null}
        <div className="flex justify-end"><Button variant="primary" onClick={onDone}>{t("facade.done")}</Button></div>
      </div>
    );
  }

  if (run && (running || failed)) {
    return (
      <div className="space-y-4 text-sm">
        <RunStatus
          run={run}
          name={facade.label}
          method={chosenMethod(facade, methodId)}
          now={now}
          codePending={sendCode.pending}
          onCode={(c) => void sendCode.run(c).then((s) => s && setState(s))}
          confirmPending={confirm.pending}
          onConfirm={(accept) => void confirm.run(accept).then((s) => s && setState(s))}
          accessPending={sendAccess.pending}
          onAccess={(body) => void sendAccess.run(body).then((s) => s && setState(s))}
        />
        {failed && run.createdName ? <Notice tone="warn">{t("facade.createdKey", { name: run.createdName })}</Notice> : null}
        {failed && run.failure?.code === "project-unknown" ? (
          <form
            className="space-y-2 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!project.trim()) return;
              notified.current = false;
              void connect.run(project.trim()).then((s) => {
                if (s) {
                  setState(s);
                  setStarted(true);
                }
              });
            }}
          >
            <p className="text-muted">{t("facade.projectNeeded")}</p>
            <TextField label={t("facade.projectLabel")} value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
            <Button type="submit" variant="primary" loading={connect.pending} disabled={!project.trim()}>{t("facade.projectConnect")}</Button>
          </form>
        ) : null}
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
            <Button variant="primary" onClick={reset}>{t("facade.retry")}</Button>
          )}
        </div>
        {failed && fallback ? <FallbackBox>{fallback}</FallbackBox> : null}
      </div>
    );
  }

  const browser = browserSignInOf(outcome);
  const view = dialogView(browser, false);
  const method = chosenMethod(facade, methodId);

  const inputFields = facade.inputs.map((i) => {
    const label = locale === "en" ? i.labelEn : i.label;
    const value = inputValues[i.param] ?? "";
    const set = (v: string) => setInputValues((o) => ({ ...o, [i.param]: v }));
    return i.options ? (
      <SelectField key={i.param} label={label} value={value} onChange={(e) => set(e.target.value)} required>
        <option value="">{t("facade.chooseOption")}</option>
        {i.options.map((o) => (
          <option key={o} value={o}>{t(`facade.option.${i.param}.${o}`) === `facade.option.${i.param}.${o}` ? o : t(`facade.option.${i.param}.${o}`)}</option>
        ))}
      </SelectField>
    ) : (
      <TextField key={i.param} label={label} {...(i.help ? { hint: i.help } : {})} value={value} onChange={(e) => set(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
    );
  });
  const projectField = facade.needsProject ? (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-muted">{t("facade.advanced")}</summary>
      <div className="mt-2">
        <TextField label={t("facade.projectLabel")} hint={t("facade.projectHint")} value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
      </div>
    </details>
  ) : null;
  const connectState = connectButtonState(facade, inputValues, connect.pending);
  const signInState = signInButtonState(facade, email, password, inputValues, signIn.pending, method);

  const signInForm = (
    <form
      autoComplete="off"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SignInFields info={facade} name={facade.label} method={method} onMethod={setMethodId} email={email} onEmail={setEmail} password={password} onPassword={setPassword} idPrefix="facade" before={inputFields} />
      {projectField}
      {err ? <Notice tone="danger">{err.message}</Notice> : null}
      <Button type="submit" variant="primary" loading={signIn.pending} disabled={signInState === "disabled"}>
        {signIn.pending ? t("facade.starting") : t("facade.start")}
      </Button>
    </form>
  );

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">{t("facade.intro", { name: facade.label })}</p>
      <div className="rounded-xl bg-page p-3 text-xs text-muted">
        <p className="font-medium text-ink">{t("facade.promiseTitle")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>{t("facade.promiseTyped", { host: facade.host ?? facade.label })}</li>
          <li>{t("facade.promiseNever")}</li>
          {facade.promise ? <li>{t(facade.promise)}</li> : null}
        </ul>
      </div>
      {!facade.available ? <Notice tone="warn">{t("facade.unavailable", { reason: facade.reason ?? "" })}</Notice> : null}
      {view === "checking" ? <p className="text-muted" role="status" aria-live="polite">{t("facade.checkingBrowser")}</p> : null}
      {view === "connect" ? (
        <div className="space-y-3">
          <Notice tone="success">{t("facade.signedInHint", { name: facade.label })}</Notice>
          {inputFields}
          {projectField}
          {err ? <Notice tone="danger">{err.message}</Notice> : null}
          <Button
            variant="primary"
            loading={connect.pending}
            disabled={connectState === "disabled"}
            onClick={() => {
              notified.current = false;
              void connect.run(project.trim()).then((s) => {
                if (s) {
                  setState(s);
                  setStarted(true);
                  setCancelling(false);
                }
              });
            }}
          >
            {connect.pending ? t("facade.starting") : t("facade.connectSignedIn")}
          </Button>
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">{t("facade.otherWay")}</summary>
            <div className="mt-3">{signInForm}</div>
          </details>
        </div>
      ) : null}
      {view === "sign-in" ? (
        <div className="space-y-3">
          {browser === "unknown" ? (
            <Notice tone="info">
              <p>{outcomeProblem(outcome, locale, t) ?? t("facade.checkFailed")}</p>
              <button type="button" className="mt-1 text-xs font-medium underline" onClick={() => setCheckRound((n) => n + 1)}>{t("facade.checkAgain")}</button>
            </Notice>
          ) : (
            <p className="text-muted">{t("facade.signedOutHint", { name: facade.label })}</p>
          )}
          {signInForm}
        </div>
      ) : null}
      {fallback ? <FallbackBox>{fallback}</FallbackBox> : null}
    </div>
  );
}

/** Providers with a guided sign-in: connect, reconnect, check whether the browser is still signed in. */
export function FacadeSection({ facades, onOpen }: { facades: FacadeInfo[]; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [checked, setChecked] = useState<Record<string, { signedIn: boolean } | undefined>>({});
  const check = useMutation(async (id: string) => ({ id, ...(await api<{ signedIn: boolean; checkedAt: string }>("POST", `facades/${enc(id)}/check`)) }));
  if (facades.length === 0) return null;
  return (
    <section className="mb-8" aria-labelledby="facade-title">
      <h2 id="facade-title" className="text-lg font-semibold tracking-tight">{t("facade.sectionTitle")}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{t("facade.sectionHint")}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {facades.map((f) => {
          const c = checked[f.id];
          return (
            <Card key={f.id}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">{f.label}</p>
                <Badge info={f.connected ? { label: t("facade.connected"), tone: "success", icon: "check" } : { label: t("facade.notConnected"), tone: "neutral", icon: "plug" }} />
              </div>
              {f.recipeStatus ? <p className="mt-1 text-xs text-muted">{t("facade.recipeStatus", { status: f.recipeStatus })}</p> : null}
              {!f.available ? <p className="mt-2 text-xs text-warn-text">{t("facade.unavailable", { reason: f.reason ?? "" })}</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" disabled={!f.available} onClick={() => onOpen(f.id)}>{f.connected ? t("facade.reconnect") : t("facade.connectWith")}</Button>
                <Button
                  disabled={!f.available}
                  loading={check.pending}
                  onClick={async () => {
                    const r = await check.run(f.id);
                    if (r) setChecked((o) => ({ ...o, [r.id]: { signedIn: r.signedIn } }));
                  }}
                >
                  {check.pending ? t("facade.checking") : t("facade.checkSignin")}
                </Button>
              </div>
              {c ? <p className="mt-2 text-xs text-muted" role="status">{t(c.signedIn ? "facade.signedInYes" : "facade.signedInNo")}</p> : null}
              {check.error ? <div className="mt-2"><Notice tone="danger">{check.error.message}</Notice></div> : null}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
