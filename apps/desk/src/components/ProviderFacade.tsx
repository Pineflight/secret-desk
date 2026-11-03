"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckList } from "@/components/ConnectionCheck";
import { ConnectionResourcesPanel } from "@/components/ConnectionResources";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Notice, SelectField, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { clock, codeValid, countsText, elapsedSeconds, failureText, inputsBody, inputsValid, isFinished, isRunning, remainingSeconds, signInValid, stepsOf, type FacadeInfo, type FacadeState, type StepState } from "@/lib/facade";
import { useMutation } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";

/** A ticking clock (once a second) while `active`, for elapsed time and the time limit. */
function useNow(active: boolean): number {
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

/** The steps of a run, live: what was done, what happens now, what comes next. */
function Stepper({ state }: { state: FacadeState | null }) {
  const { t } = useI18n();
  return (
    <ol className="space-y-1.5 text-sm" aria-label={t("facade.stepsLabel")}>
      {stepsOf(state).map((s) => {
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
export function FacadeFlow({ facade, onChanged, onDone, fallback }: { facade: FacadeInfo; onChanged: () => void; onDone: () => void; fallback?: ReactNode }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<FacadeState | null>(null);
  const [started, setStarted] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [project, setProject] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const notified = useRef(false);
  const base = `facades/${enc(facade.id)}`;

  const signIn = useMutation(async (body: { username: string; password: string; projectId?: string; inputs?: Record<string, string> }) => api<FacadeState>("POST", `${base}/sign-in`, body));
  const connect = useMutation(async (projectId: string) => api<FacadeState>("POST", `${base}/connect`, { projectId, inputs: inputsBody(facade.inputs, inputValues) }));
  const sendCode = useMutation(async (c: string) => api<FacadeState>("POST", `${base}/code`, { code: c }));
  const cancel = useMutation(async () => api<FacadeState>("POST", `${base}/cancel`));

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
    if (!signInValid(email, password) || !inputsValid(facade.inputs, inputValues)) return;
    // Copy, then clear: the form never keeps the password after sending.
    const body = { username: email.trim(), password, ...(project.trim() ? { projectId: project.trim() } : {}), ...(facade.inputs.length > 0 ? { inputs: inputsBody(facade.inputs, inputValues) } : {}) };
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
  }, [email, password, project, inputValues, facade.inputs, signIn]);

  const run = state && started ? state : null;
  const running = isRunning(run);
  const failed = run !== null && (run.status === "failed" || run.status === "cancelled");
  const connectedOk = run?.status === "done" && run.result?.connected === true;
  const err = signIn.error ?? connect.error ?? sendCode.error ?? cancel.error;

  const reset = () => {
    setStarted(false);
    setState(null);
    setCode("");
    setCancelling(false);
    signIn.reset();
    connect.reset();
  };

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
    const remaining = remainingSeconds(run.timeoutAt, now);
    return (
      <div className="space-y-4 text-sm">
        <Stepper state={run} />
        <p className="text-xs text-muted" aria-live="polite">
          {t("facade.elapsed", { elapsed: clock(elapsedSeconds(run.startedAt, now)) })}
          {running && remaining !== null ? ` · ${t("facade.remaining", { remaining: clock(remaining) })}` : ""}
        </p>
        {running && run.needs === "mfa-code" ? (
          <form
            className="space-y-2 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!codeValid(code)) return;
              const c = code;
              setCode("");
              void sendCode.run(c).then((s) => s && setState(s));
            }}
          >
            <p className="font-medium">{t("facade.codeTitle")}</p>
            <p className="text-xs text-muted">{t("facade.codeHint", { name: facade.label })}</p>
            <label htmlFor="facade-code" className="block text-sm font-medium">{t("facade.codeLabel")}</label>
            <input id="facade-code" data-autofocus type="text" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className={`${inputClass} font-mono`} />
            <Button type="submit" variant="primary" loading={sendCode.pending} disabled={!codeValid(code)}>{t("facade.codeSend")}</Button>
          </form>
        ) : null}
        {running && run.needs === "approval" ? <Notice tone="info" title={t("facade.approvalTitle")}>{t("facade.approvalHint", { name: facade.label })}</Notice> : null}
        {running && run.needs === "captcha" ? (
          <Notice tone="warn" title={t("facade.captchaTitle")}>
            <p>{t("facade.captchaHint", { name: facade.label })}</p>
            {facade.viewerUrl ? (
              <a className="mt-2 inline-flex items-center gap-1 font-medium underline" href={facade.viewerUrl} target="_blank" rel="noopener noreferrer">
                {t("facade.openBrowser")}
                <Icon name="external" className="h-3.5 w-3.5" />
              </a>
            ) : (
              <p className="mt-1 text-xs">{t("facade.noViewer")}</p>
            )}
          </Notice>
        ) : null}
        {failed && run.failure ? (
          <Notice tone={run.status === "cancelled" ? "info" : "danger"} {...(run.status === "cancelled" ? {} : { title: t("facade.failedTitle") })}>
            {failureText(run.failure, locale, t)}
          </Notice>
        ) : null}
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

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">{t("facade.intro", { name: facade.label })}</p>
      <div className="rounded-xl bg-page p-3 text-xs text-muted">
        <p className="font-medium text-ink">{t("facade.promiseTitle")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>{t("facade.promiseTyped", { host: facade.host ?? facade.label })}</li>
          <li>{t("facade.promiseNever")}</li>
          <li>{t(facade.inputs.length > 0 ? "facade.promiseKeyScoped" : "facade.promiseKey")}</li>
        </ul>
      </div>
      {!facade.available ? <Notice tone="warn">{t("facade.unavailable", { reason: facade.reason ?? "" })}</Notice> : null}
      <form
        autoComplete="off"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {facade.inputs.map((i) => {
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
        })}
        <TextField label={t("facade.email", { name: facade.label })} type="email" name="facade-email" autoComplete="off" spellCheck={false} data-autofocus data-1p-ignore data-lpignore="true" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label={t("facade.password", { name: facade.label })} type="password" name="facade-password" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={password} onChange={(e) => setPassword(e.target.value)} />
        {facade.needsProject ? (
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted">{t("facade.advanced")}</summary>
            <div className="mt-2">
              <TextField label={t("facade.projectLabel")} hint={t("facade.projectHint")} value={project} onChange={(e) => setProject(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
            </div>
          </details>
        ) : null}
        {err ? <Notice tone="danger">{err.message}</Notice> : null}
        <Button type="submit" variant="primary" loading={signIn.pending} disabled={!facade.available || !signInValid(email, password) || !inputsValid(facade.inputs, inputValues)}>
          {signIn.pending ? t("facade.starting") : t("facade.start")}
        </Button>
      </form>
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
