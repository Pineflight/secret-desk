"use client";
import { useState } from "react";
import { Button, Notice, TextField, inputClass } from "@/components/ui";
import { codeValid, consentItems, type FacadeMethod, type SudoMethodId } from "@/lib/facade";
import { useI18n } from "@/lib/i18n";

/**
 * The questions a browser run asks the human, shared by the provider sign-in dialog and the team token. Typed values leave the
 * component state the moment they are sent.
 */

/** The one-time code of a sign-in. */
export function CodePrompt({ name, pending, onSend }: { name: string; pending: boolean; onSend: (code: string) => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  return (
    <form
      className="space-y-2 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!codeValid(code)) return;
        const c = code;
        setCode("");
        onSend(c);
      }}
    >
      <p className="font-medium">{t("facade.codeTitle")}</p>
      <p className="text-xs text-muted">{t("facade.codeHint", { name })}</p>
      <label htmlFor="facade-code" className="block text-sm font-medium">{t("facade.codeLabel")}</label>
      <input id="facade-code" data-autofocus type="text" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className={`${inputClass} font-mono`} />
      <Button type="submit" variant="primary" loading={pending} disabled={!codeValid(code)}>{t("facade.codeSend")}</Button>
    </form>
  );
}

/** "Approve on your device", with the number the page shows. */
export function ApprovalNotice({ name, number }: { name: string; number?: string | undefined }) {
  const { t } = useI18n();
  return (
    <Notice tone="info" title={t("facade.approvalTitle")}>
      <p>{t("facade.approvalHint", { name })}</p>
      {number ? <p className="mt-1 font-medium">{t("facade.approvalNumber", { number })}</p> : null}
    </Notice>
  );
}

/** The first-use authorization of an identity provider: shown here, confirmed here. */
export function ConsentPrompt({ idp, name, scopes, pending, onAnswer }: { idp: string; name: string; scopes: string | undefined; pending: boolean; onAnswer: (accept: boolean) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <p className="font-medium">{t("facade.consentTitle")}</p>
      <p className="text-xs text-muted">{t("facade.consentHint", { idp, name })}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {consentItems(scopes).map((item) => <li key={item}>{item}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={pending} onClick={() => onAnswer(true)}>{t("facade.consentAccept")}</Button>
        <Button disabled={pending} onClick={() => onAnswer(false)}>{t("facade.consentDecline")}</Button>
      </div>
    </div>
  );
}

/** Sign-in method, email and password for one run. */
export function CredentialsPrompt({ name, methods, pending, onSend }: { name: string; methods: FacadeMethod[]; pending: boolean; onSend: (body: { method: string; username: string; password: string }) => void }) {
  const { t, locale } = useI18n();
  const [method, setMethod] = useState(methods[0]?.id ?? "email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const ready = email.trim().length > 0 && email.trim().length <= 254 && password.length > 0 && password.length <= 1024;
  return (
    <form
      autoComplete="off"
      className="space-y-3 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        const body = { method, username: email.trim(), password };
        setEmail("");
        setPassword("");
        onSend(body);
      }}
    >
      <p className="font-medium">{t("run.signInTitle", { name })}</p>
      <p className="text-xs text-muted">{t("run.signInHint", { name })}</p>
      {methods.length > 1 ? (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{t("facade.chooseMethod", { name })}</legend>
          {methods.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="radio" name="run-method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} />
              <span>{m.label && locale === "de" ? m.label : m.labelEn && locale === "en" ? m.labelEn : t(`facade.method.${m.id}`)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <TextField label={t(`facade.methodEmail.${method}`, { name })} type="email" name="run-email" autoComplete="off" spellCheck={false} data-autofocus data-1p-ignore data-lpignore="true" value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label={t(`facade.methodPassword.${method}`, { name })} type="password" name="run-password" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" variant="primary" loading={pending} disabled={!ready}>{t("run.signInSend")}</Button>
    </form>
  );
}

/** "Confirm access": choose how (GitHub Mobile by default), then the number to tap, a code or the password. */
export function AccessPrompt({ name, ask, pending, onSend }: { name: string; ask: Extract<import("@/lib/facade").RunAsk, { type: "access" }>; pending: boolean; onSend: (body: { method: SudoMethodId; code?: string; password?: string }) => void }) {
  const { t } = useI18n();
  const [method, setMethod] = useState<SudoMethodId>("mobile");
  const [value, setValue] = useState("");
  if (ask.stage === "mobile") {
    return (
      <Notice tone="info" title={t("run.access.mobileTitle")}>
        <p>{ask.number ? t("run.access.mobileNumber", { number: ask.number }) : t("run.access.mobileNoNumber")}</p>
        <p className="mt-1 text-xs">{t("run.access.mobileWait")}</p>
      </Notice>
    );
  }
  if (ask.stage === "checking") return <Notice tone="info"><p>{t("run.access.checking")}</p></Notice>;
  const chosen = ask.methods.includes(method) ? method : (ask.methods[0] ?? "mobile");
  const needsValue = chosen !== "mobile";
  const valid = chosen === "mobile" || (chosen === "code" ? codeValid(value) : value.length > 0 && value.length <= 1024);
  return (
    <form
      autoComplete="off"
      className="space-y-3 rounded-xl border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const v = value;
        setValue("");
        onSend(chosen === "mobile" ? { method: chosen } : chosen === "code" ? { method: chosen, code: v } : { method: chosen, password: v });
      }}
    >
      <p className="font-medium">{t("run.access.title", { name })}</p>
      {ask.problem ? <Notice tone="warn">{t(`run.access.problem.${ask.problem}`)}</Notice> : <p className="text-xs text-muted">{t("run.access.hint", { name })}</p>}
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t("run.access.choose")}</legend>
        {ask.methods.map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input type="radio" name="run-access" value={m} checked={chosen === m} onChange={() => { setMethod(m); setValue(""); }} />
            <span>{t(`run.access.method.${m}`)}</span>
          </label>
        ))}
      </fieldset>
      {needsValue ? (
        <div>
          <label htmlFor="run-access-value" className="block text-sm font-medium">{t(chosen === "code" ? "run.access.codeLabel" : "run.access.passwordLabel")}</label>
          <input id="run-access-value" data-autofocus type={chosen === "code" ? "text" : "password"} name="run-access-value" autoComplete={chosen === "code" ? "off" : "new-password"} spellCheck={false} data-1p-ignore data-lpignore="true" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputClass} font-mono`} />
        </div>
      ) : null}
      <p className="text-xs text-muted">{ask.attempt > 1 ? t("run.access.attempt", { n: ask.attempt, max: ask.maxAttempts }) : ""}</p>
      <Button type="submit" variant="primary" loading={pending} disabled={!valid}>{ask.problem ? t("run.access.retry") : t("run.access.send")}</Button>
    </form>
  );
}
