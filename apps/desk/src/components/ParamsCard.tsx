"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ParamsView, SecretView } from "@secret-desk/runtime";
import { ParamsForm } from "@/components/ParamsForm";
import { Badge, Button, Card, ErrorState, Notice, SectionLabel, Skeleton } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { buildPut, describeValue, isBlank, isRequiredNow, effectiveValues, issueMessages, problemMessages, problemsFromError, specLabel, toDraft, validateDraft, type Draft } from "@/lib/params-form";
import { useDraftParams } from "@/lib/use-params";
import { useToast } from "@/lib/toast";

/** Karte "Parameter" eines Secrets: lesbare Anzeige mit Ressource und Vorabcheck, Bearbeiten ueber dieselben Felder wie im Anlegedialog. */
export function ParamsCard({ secret, focusSignal, notice, onChanged }: { secret: SecretView; focusSignal: number; notice: string | null; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const base = useQuery<ParamsView>(`secret-params:${secret.id}`, () => api<ParamsView>("GET", `secrets/${enc(secret.id)}/params`));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const repo = secret.places[0]?.repo ?? "";
  const pv = useDraftParams(editing ? (base.data?.provider ?? null) : null, repo, secret.stage, draft);
  const save = useMutation(async (params: Record<string, unknown>) => api<ParamsView>("PUT", `secrets/${enc(secret.id)}/params`, { params }));
  const data = base.data;

  const startEdit = () => {
    if (!data) return;
    setDraft(toDraft(data.specs, data.values));
    save.reset();
    setEditing(true);
  };
  // Ein Klick auf "Nur Plan zeigen" bei fehlenden Parametern fuehrt hierher.
  useEffect(() => {
    if (focusSignal === 0 || !data) return;
    if (!editing) startEdit();
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal, data !== undefined]);

  if (base.error) return <div className="mb-6"><ErrorState error={base.error} onRetry={base.reload} /></div>;
  if (!data) return <Card className="mb-6"><Skeleton className="h-24" /></Card>;
  if (data.specs.length === 0) return null;

  const trAny = (k: string, v?: Record<string, string | number>) => t(k, v);
  const view = editing ? (pv.view ?? data) : data;
  const issues = validateDraft(data.specs, draft, data.defaults);
  const errors = { ...issueMessages(issues.filter((i) => i.code !== "missing"), data.specs, trAny, locale), ...problemMessages(problemsFromError(save.error), trAny, locale) };
  const put = buildPut(data.specs, draft, data.values);
  const blocking = issues.some((i) => i.code !== "missing");
  const keyLabels = (keys: string[]) => keys.map((k) => { const s = data.specs.find((x) => x.key === k); return s ? specLabel(s, locale) : k; }).join(", ");
  const missing = data.problems.filter((p) => p.code === "missing").map((p) => p.key);
  const statusBadge = data.complete
    ? { label: t("params.card.statusOk"), tone: "success" as const, icon: "check" as const }
    : { label: missing.length > 0 ? t("params.card.statusMissing", { keys: keyLabels(missing) }) : t("params.card.statusInvalid"), tone: "warn" as const, icon: "alert" as const };
  const pre = data.preflight;
  const effective = effectiveValues(data.specs, data.values, data.defaults);

  const submit = async () => {
    if (!put.changed) return setEditing(false);
    const res = await save.run(put.params);
    if (res) {
      toast.success(t("params.card.saved"));
      setEditing(false);
      base.reload();
      onChanged();
    }
  };

  return (
    <div ref={ref} id="params-card" className="mb-6 scroll-mt-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel>{t("params.card.title")}</SectionLabel>
            <Badge info={statusBadge} />
          </div>
          {!editing ? <Button variant="ghost" onClick={startEdit}>{t("params.card.edit")}</Button> : null}
        </div>
        {notice ? <div className="mt-3"><Notice tone="warn">{notice}</Notice></div> : null}
        {data.connected === false ? (
          <div className="mt-3"><Notice tone="warn">{t("params.res.notConnected", { connection: data.connection ?? "?" })} <Link href="/connections" className="font-medium underline">{t("params.toConnections")}</Link></Notice></div>
        ) : null}
        {editing ? (
          <div className="mt-4 space-y-4">
            <ParamsForm specs={data.specs} draft={draft} onDraft={setDraft} resources={view.resources} loading={pv.loading} connection={data.connection} defaults={data.defaults} errors={errors} onReload={pv.reload} />
            {save.error && problemsFromError(save.error).length === 0 ? <Notice tone="danger">{save.error.message}</Notice> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => { setEditing(false); save.reset(); }}>{t("params.card.cancel")}</Button>
              <Button variant="primary" loading={save.pending} disabled={blocking} onClick={() => void submit()}>{t("params.card.save")}</Button>
            </div>
          </div>
        ) : (
          <>
            {pre?.resource ? <p className="mt-3 text-sm"><span className="text-muted-text">{t("params.card.resource")}: </span><span className="font-medium">{pre.resource}</span></p> : null}
            <dl className="mt-2 divide-y divide-line">
              {data.specs.map((s) => {
                const own = data.values[s.key];
                const fromDefault = isBlank(own) && !isBlank(effective[s.key]);
                const shown = isBlank(effective[s.key]) ? "" : describeValue(s, effective[s.key], data.resources[s.key], locale);
                const required = isRequiredNow(s, data.specs, effective);
                return (
                  <div key={s.key} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2 text-sm">
                    <dt className="text-muted-text">{specLabel(s, locale)} <span className="font-mono text-[11px] text-muted">{s.key}</span></dt>
                    <dd className="min-w-0 break-words text-right font-medium">
                      {shown ? shown : <span className={required ? "text-warn-text" : "text-muted-text"}>{t("params.card.notSet")}</span>}
                      {fromDefault && shown ? <span className="ml-2 text-xs font-normal text-muted">({t("params.fromDefault")})</span> : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {Object.keys(data.unknown).length > 0 ? <p className="mt-2 text-xs text-muted">{t("params.card.unknown", { keys: Object.keys(data.unknown).join(", ") })}</p> : null}
            {pre ? (
              <div className="mt-3 space-y-1 text-sm">
                <p className="text-xs font-medium text-muted-text">{preflightTitle(pre, t)}</p>
                {pre.findings.length > 0 ? (
                  <ul className="space-y-1">
                    {pre.findings.map((f) => (
                      <li key={f.id} className={f.level === "fail" ? "text-danger-text" : f.level === "warn" ? "text-warn-text" : "text-success-text"}>{f.label}{f.detail ? <span className="text-muted-text"> ({f.detail})</span> : null}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

function preflightTitle(pre: NonNullable<ParamsView["preflight"]>, t: (k: string) => string): string {
  if (pre.status === "ok") return t("params.preflight.ok");
  if (pre.status === "warn") return t("params.preflight.warn");
  if (pre.status === "fail") return t("params.preflight.fail");
  if (pre.skippedReason === "params") return t("params.preflight.skippedParams");
  if (pre.skippedReason === "not-connected" || pre.status === "not-connected") return t("params.preflight.skippedConn");
  return t("params.preflight.skippedNone");
}
