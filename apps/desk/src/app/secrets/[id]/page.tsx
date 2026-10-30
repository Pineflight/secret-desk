"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { VerificationReport } from "@secret-desk/core";
import type { AutomationRunState, IssuanceRequestResult, SecretView } from "@secret-desk/runtime";
import type { EntryPreflight } from "@secret-desk/core";
import { Dialog } from "@/components/Dialog";
import { NameHint } from "@/components/NormalizeDialog";
import { ParamsCard } from "@/components/ParamsCard";
import { EditMetaDialog, ExternalLink, TagPills, metaFrom } from "@/components/Meta";
import { AttachmentThumb, EvidenceImage } from "@/components/Evidence";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Pill, PageHeader, ProviderChip, SectionLabel, Skeleton, StageBadge, StatusBadge } from "@/components/ui";
import { ApiError, api, enc } from "@/lib/api";
import { daysLabel, formatDate, formatDateTime, placeText } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { overallInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { findingsFromError, findingsText, problemsFromError } from "@/lib/params-form";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-text">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

export default function SecretDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const secret = useQuery<SecretView>(`secret:${id}`, () => api<SecretView>("GET", `secrets/${enc(id)}`));
  const evidence = useQuery<VerificationReport[]>(`evidence:${id}`, () => api<VerificationReport[]>("GET", `evidence/${enc(id)}`));
  // Browser-Lauf: Der Zustand liegt in der Runtime. Waehrend des Laufs (und direkt nach dem Klick) alle 2 s abfragen, auch nach einem Neuladen.
  const [starting, setStarting] = useState(false);
  const isBrowser = Boolean(secret.data?.browser);
  const [runActive, setRunActive] = useState(false);
  const run = useQuery<AutomationRunState>(isBrowser ? `run:${id}` : null, () => api<AutomationRunState>("GET", `automation/runs/${enc(id)}`), { refreshMs: starting || runActive ? 2000 : undefined });
  const live = run.data?.status === "running" || run.data?.status === "waiting-human";
  useEffect(() => setRunActive(live), [live]);
  const [manual, setManual] = useState(false);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState<{ places: string[]; automatic: boolean; revokesOld: boolean; ttlDays: number | null; stage: string; provider: string; params?: { ok: boolean; missing: string[]; problems: { message: string }[] }; preflight?: EntryPreflight } | null>(null);
  // Fehlende Parameter: Der Klick fuehrt zur Parameterkarte, die sich dann zum Bearbeiten oeffnet.
  const [paramsFocus, setParamsFocus] = useState(0);
  const [paramsNotice, setParamsNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "warn" | "danger"; title: string; text: string; href?: string; link?: string } | null>(null);

  const paramsBlocked = secret.data ? secret.data.params.status === "missing" || secret.data.params.status === "invalid" : false;
  const blockedText = secret.data ? (secret.data.params.missing.length > 0 ? t("params.card.blocked", { keys: secret.data.params.missing.join(", ") }) : t("params.card.blockedPlain")) : "";
  const goToParams = (text: string) => {
    setParamsNotice(text);
    setParamsFocus((n) => n + 1);
  };

  const startRenewal = async (dryRun: boolean) => {
    if (paramsBlocked) return goToParams(blockedText);
    setNotice(null);
    setPlan(null);
    const browserRun = !dryRun && isBrowser;
    if (browserRun) setStarting(true);
    try {
      const res = await api<IssuanceRequestResult>("POST", "renewal-requests", { secretId: id, ...(dryRun ? { dryRun: true } : {}) });
      if (res.status === "awaiting-review") router.push(`/reviews/${enc(res.issuance.id)}`);
      else if (res.status === "pending-approval") setNotice({ tone: "warn", title: t("secretDetail.approvalTitle"), text: t("secretDetail.approvalText"), href: "/approvals", link: t("secretDetail.toApprovals") });
      else setPlan({ ...(res.plan as never as object), ...(res.preflight ? { preflight: res.preflight } : {}) } as never);
    } catch (e) {
      const problems = problemsFromError(e);
      const findings = findingsFromError(e);
      if (problems.length > 0) goToParams(e instanceof Error ? e.message : t("params.card.blockedPlain"));
      else if (findings.length > 0) setNotice({ tone: "danger", title: t("params.preflight.failedTitle"), text: findingsText(findings) });
      else if (e instanceof ApiError && e.code === "not-connected") setNotice({ tone: "danger", title: t("secretDetail.connMissingTitle"), text: `${e.message}${e.hint ? ` (${e.hint})` : ""}`, href: "/connections", link: t("secretDetail.toConnections") });
      else toast.error(e instanceof Error ? e.message : t("secretDetail.unknownError"));
    } finally {
      if (browserRun) {
        setStarting(false);
        run.reload();
      }
    }
  };

  if (secret.error) return <ErrorState error={secret.error} onRetry={secret.reload} />;
  const s = secret.data;
  if (!s) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-48" /></div>;

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/entries?kind=secret" className="text-primary hover:underline">{t("secretDetail.back")}</Link></p>
      <PageHeader
        title={s.title ?? s.name}
        subtitle={<span className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{s.name}</span><StatusBadge level={s.status} /><StageBadge stage={s.stage} /><ProviderChip automatic={s.automatic} browser={s.browser} /><NameHint entryId={s.id} /></span>}
        actions={
          <>
            {s.automatic ? <Button variant="primary" disabled={starting || live || paramsBlocked} title={paramsBlocked ? t("params.card.fixFirst") : undefined} onClick={() => void startRenewal(false)}><Icon name="bolt" />{t("secretDetail.generate")}</Button> : null}
            <Button variant={s.automatic ? "secondary" : "primary"} onClick={() => setManual(true)}><Icon name="key" />{t("secretDetail.pasteValue")}</Button>
            <Button variant="ghost" onClick={() => void startRenewal(true)}>{t("secretDetail.planOnly")}</Button>
          </>
        }
      />
      {notice ? (
        <div className="mb-6">
          <Notice tone={notice.tone} title={notice.title}>{notice.text} {notice.href ? <Link href={notice.href} className="font-medium underline">{notice.link}</Link> : null}</Notice>
        </div>
      ) : null}
      {paramsBlocked ? (
        <div className="mb-6"><Notice tone="warn" title={t("params.card.title")}>{blockedText} <button type="button" className="font-medium underline" onClick={() => goToParams(blockedText)}>{t("params.card.goTo")}</button></Notice></div>
      ) : null}
      {s.browser ? <BrowserRunPanel secretId={id} state={run.data} starting={starting} onChanged={run.reload} /> : null}
      {plan ? (
        <div className="mb-6">
          <Notice tone="info" title={t("secretDetail.dryRunTitle")}>
            <ul className="list-disc pl-5">
              <li>{plan.automatic ? t("secretDetail.planAuto") : t("secretDetail.planManual")}</li>
              <li>{t("secretDetail.planTargets", { targets: plan.places?.length ? plan.places.join(", ") : t("secretDetail.planNoTargets") })}</li>
              <li>{plan.revokesOld ? t("secretDetail.planRevokes") : t("secretDetail.planKeeps")}</li>
              {plan.ttlDays ? <li>{t("secretDetail.planTtl", { days: plan.ttlDays })}</li> : null}
              {plan.params ? <li>{plan.params.ok ? t("params.plan.paramsOk") : plan.params.missing.length > 0 ? t("params.plan.paramsMissing", { keys: plan.params.missing.join(", ") }) : t("params.plan.paramsInvalid", { text: plan.params.problems.map((p) => p.message).join("; ") })}</li> : null}
              {plan.preflight?.resource ? <li>{t("params.plan.resource", { resource: plan.preflight.resource })}</li> : null}
              {plan.preflight && plan.preflight.findings.length > 0 ? <li>{plan.preflight.findings.map((f) => (f.detail ? `${f.label} (${f.detail})` : f.label)).join("; ")}</li> : null}
            </ul>
          </Notice>
        </div>
      ) : null}

      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>{t("secretDetail.description")}</SectionLabel>
          <Button variant="ghost" onClick={() => setEditing(true)}><Icon name="wrench" />{t("secretDetail.edit")}</Button>
        </div>
        {s.description || s.owner || s.link || s.tags.length > 0 || s.notes ? (
          <div className="mt-3 space-y-3 text-sm">
            {s.description ? <p className="whitespace-pre-line">{s.description}</p> : <p className="text-muted-text">{t("secretDetail.noDescription")}</p>}
            {s.owner ? <dl className="flex gap-3"><dt className="w-28 shrink-0 text-muted-text">{t("secretDetail.owner")}</dt><dd className="font-medium">{s.owner}</dd></dl> : null}
            {s.link ? <dl className="flex gap-3"><dt className="w-28 shrink-0 text-muted-text">{t("secretDetail.link")}</dt><dd><ExternalLink href={s.link} /></dd></dl> : null}
            {s.tags.length > 0 ? <dl className="flex gap-3"><dt className="w-28 shrink-0 text-muted-text">{t("secretDetail.tags")}</dt><dd><TagPills tags={s.tags} /></dd></dl> : null}
            {s.notes ? <dl className="flex gap-3"><dt className="w-28 shrink-0 text-muted-text">{t("secretDetail.notes")}</dt><dd className="whitespace-pre-line">{s.notes}</dd></dl> : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-text">{t("secretDetail.noDescription")}</p>
        )}
      </Card>

      {s.params.status !== "none" ? <ParamsCard secret={s} focusSignal={paramsFocus} notice={paramsNotice} onChanged={() => { setParamsNotice(null); secret.reload(); }} /> : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionLabel>{t("secretDetail.facts")}</SectionLabel>
          <dl className="mt-2 divide-y divide-line">
            <Fact label={t("secretDetail.service")}>{s.service}</Fact>
            <Fact label={t("secretDetail.provider")}>{s.provider}</Fact>
            <Fact label={t("secretDetail.expires")}><span className="tabular">{formatDate(s.expires)}</span> <span className="font-normal text-muted-text">({daysLabel(s.daysLeft)})</span></Fact>
            <Fact label={t("secretDetail.rotatedAt")}><span className="tabular">{formatDate(s.rotatedAt)}</span></Fact>
            <Fact label={t("secretDetail.verifiedAt")}>{s.verifiedAt ? <><span className="tabular">{formatDate(s.verifiedAt)}</span>{s.verifiedBy ? t("secretDetail.verifiedBy", { name: s.verifiedBy }) : ""}</> : t("secretDetail.never")}</Fact>
          </dl>
        </Card>
        <Card>
          <SectionLabel>{t("secretDetail.targets")}</SectionLabel>
          {s.places.length ? <ul className="mt-3 flex flex-wrap gap-2">{s.places.map((p, i) => <li key={i}><Pill>{placeText(p)}</Pill></li>)}</ul> : <p className="mt-3 text-sm text-muted-text">{t("secretDetail.noTargets")}</p>}
        </Card>
      </div>

      <Card>
        <SectionLabel>{t("secretDetail.history")}</SectionLabel>
        <div className="mt-4">
          {evidence.loading && !evidence.data ? <ListSkeleton rows={2} /> : null}
          {evidence.error ? <ErrorState error={evidence.error} onRetry={evidence.reload} /> : null}
          {evidence.data && evidence.data.length === 0 ? <EmptyState title={t("secretDetail.noReviewTitle")} icon="shield">{t("secretDetail.noReviewText")}</EmptyState> : null}
          <ul className="space-y-4">
            {[...(evidence.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => {
              const overall = r.checks.some((c) => c.status === "fail") ? "fail" : r.checks.some((c) => c.status === "warn") ? "warn" : "pass";
              const c = r.confirmation;
              return (
                <li key={r.id} className="flex flex-wrap gap-4 rounded-xl border border-line p-4">
                  <div className="w-56 shrink-0"><EvidenceImage secretId={r.secretId} reportId={r.id} createdAt={r.createdAt} zoomable className="w-full" /></div>
                  <div className="min-w-0 flex-1 space-y-2 text-sm">
                    <p className="flex flex-wrap items-center gap-2"><span className="tabular font-medium">{formatDateTime(r.createdAt)}</span><Badge info={overallInfo(overall)} /></p>
                    <p className="text-muted-text">{c ? (c.decision === "confirmed" ? t("secretDetail.confirmedBy", { by: c.by, date: formatDateTime(c.at) }) : t("secretDetail.rejectedBy", { by: c.by, date: formatDateTime(c.at) })) : t("secretDetail.notConfirmed")}{c?.note ? `: ${c.note}` : ""}</p>
                    <p className="text-xs text-muted">{t("secretDetail.fingerprint")} <span className="font-mono">{r.fingerprint}</span></p>
                    {r.attachments.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-text">{t("secretDetail.attachments")}</p>
                        <div className="flex flex-wrap gap-2">{r.attachments.map((a) => <AttachmentThumb key={a.file} secretId={r.secretId} reportId={r.id} file={a.file} note={a.note} />)}</div>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </Card>

      {editing ? <EditMetaDialog path={`secrets/${enc(s.id)}`} initial={metaFrom(s)} notes={s.notes} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); secret.reload(); }} /> : null}
      {manual ? <ManualValueDialog secret={s} onClose={() => setManual(false)} /> : null}
    </>
  );
}

/** Fortschritt eines Browser-Laufs. Zeigt nie einen Wert: nur Status, Text, Host und Schritt. */
function BrowserRunPanel({ secretId, state, starting, onChanged }: { secretId: string; state: AutomationRunState | undefined; starting: boolean; onChanged: () => void }) {
  const t = useT();
  const cancel = useMutation(async () => api<AutomationRunState>("POST", `automation/runs/${enc(secretId)}/cancel`));
  const status = state?.status ?? "idle";
  const live = status === "running" || status === "waiting-human";
  if (!live && !starting && status === "idle") return <div className="mb-6"><Notice tone="info" title={t("secretDetail.browserTitle")}>{t("secretDetail.browserUnverified")}</Notice></div>;
  const tone = status === "failed" ? "danger" : status === "cancelled" ? "warn" : status === "done" ? "success" : status === "waiting-human" ? "warn" : "info";
  const title =
    status === "waiting-human" ? t("secretDetail.browserWaiting")
    : status === "done" ? t("secretDetail.browserDone")
    : status === "failed" ? t("secretDetail.browserFailed")
    : status === "cancelled" ? t("secretDetail.browserCancelled")
    : starting && !state?.startedAt ? t("secretDetail.browserStarting")
    : t("secretDetail.browserRunning");
  return (
    <div className="mb-6" aria-live="polite">
      <Notice tone={tone} title={`${t("secretDetail.browserTitle")}: ${title}`}>
        <div className="space-y-2">
          {live || starting ? <p>{t("secretDetail.browserIntro")}</p> : null}
          {state?.text && status !== "done" ? <p className="font-medium">{state.text}</p> : null}
          {state?.host ? <p className="text-xs">{t("secretDetail.browserHost", { host: state.host })}</p> : null}
          {live && state?.step ? <p className="tabular text-xs">{t("secretDetail.browserStep", { index: state.step.index, total: state.step.total })}</p> : null}
          {state?.createdName ? <p>{t("secretDetail.browserCreated", { name: state.createdName })}</p> : null}
          <p className="text-xs">{t("secretDetail.browserUnverified")}</p>
          {live ? <p className="text-xs">{t("secretDetail.browserReloadHint")}</p> : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {live ? <Button variant="danger" loading={cancel.pending} onClick={async () => { await cancel.run(); onChanged(); }}>{t("secretDetail.browserCancel")}</Button> : null}
            {status === "done" && state?.issuanceId ? <Link href={`/reviews/${enc(state.issuanceId)}`} className="inline-flex items-center rounded-xl bg-primary px-3 py-2 text-sm font-medium text-white">{t("secretDetail.browserToReview")}</Link> : null}
          </div>
          {cancel.error ? <p className="text-danger-text">{cancel.error.message}</p> : null}
        </div>
      </Notice>
    </div>
  );
}

function ManualValueDialog({ secret, onClose }: { secret: SecretView; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const send = useMutation(async (v: string) => api<{ id: string }>("POST", `secrets/${enc(secret.id)}/manual-value`, { value: v }));
  const submit = async () => {
    const v = value;
    setValue("");
    if (ref.current) ref.current.value = "";
    const res = await send.run(v);
    if (res) router.push(`/reviews/${enc(res.id)}`);
  };
  return (
    <Dialog title={t("secretDetail.manualTitle")} description={t("secretDetail.manualDesc", { name: secret.name })} onClose={onClose}>
      {secret.guide ? (
        <div className="mb-4 rounded-xl bg-page p-4 text-sm">
          <p className="mb-2 font-medium">{t("secretDetail.howToGet")}</p>
          <a href={secret.guide.openUrl} target="_blank" rel="noopener noreferrer" className="mb-2 inline-flex items-center gap-1 text-primary underline">{secret.guide.openUrl !== secret.guide.url ? t("secretDetail.openProviderPrefilled") : t("secretDetail.openProviderGuide")}<Icon name="external" className="h-3.5 w-3.5" /></a>
          {secret.guide.steps.length > 0 ? <ol className="list-decimal space-y-1 pl-5">{secret.guide.steps.map((st, i) => <li key={i}>{st}</li>)}</ol> : null}
        </div>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); if (value) void submit(); }} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="manual-value" className="block text-sm font-medium">{t("secretDetail.newValue")}</label>
          <input id="manual-value" ref={ref} data-autofocus type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className="w-full rounded-xl border border-line bg-card px-3 py-2 font-mono text-sm" />
          <p className="text-xs text-muted">{t("secretDetail.clearedHint")}</p>
        </div>
        {send.error ? <Notice tone="danger">{send.error.message}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("secretDetail.cancel")}</Button>
          <Button type="submit" variant="primary" loading={send.pending} disabled={!value}>{t("secretDetail.check")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
