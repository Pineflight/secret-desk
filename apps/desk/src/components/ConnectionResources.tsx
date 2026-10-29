"use client";
import { useEffect, useState } from "react";
import type { ConnectionResources } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { ParamsForm } from "@/components/ParamsForm";
import { Button, ErrorState, ListSkeleton, Notice } from "@/components/ui";
import { ApiError, api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { buildPut, describeValue, isBlank, optionText, problemMessages, problemsFromError, specLabel, toDraft, validateDraft, type Draft, type ResourceState } from "@/lib/params-form";
import { useToast } from "@/lib/toast";

/** Lesender Abruf: was die verbundene Integration hergibt (Konten, Projekte, Zonen, Domains) und welche Standardwerte sie kennt. */
function useConnectionResources(id: string) {
  return useQuery<ConnectionResources>(`conn-res:${id}`, () => api<ConnectionResources>("GET", `connections/${enc(id)}/resources`));
}

const kindName = (t: (k: string) => string, kind: string): string => {
  const key = `params.kind.${kind}`;
  const text = t(key);
  return text === key ? kind : text;
};

/** Entdeckungen je Standardwert-Parameter (Schluessel = Parameter, nicht Art). */
const byParam = (data: ConnectionResources): Record<string, ResourceState> =>
  Object.fromEntries(data.defaultSpecs.filter((s) => s.discover && data.resources[s.discover]).map((s) => [s.key, data.resources[s.discover!]!]));

/** Standardwerte lesbar auf der Karte, Hinweise zu nicht lesbaren Listen und der Knopf zum Bearbeiten. */
export function ConnectionDefaultsSummary({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const q = useConnectionResources(id);
  const [open, setOpen] = useState(false);
  const data = q.data;
  if (q.error instanceof ApiError && q.error.status >= 400 && q.error.status < 500) return null;
  if (q.error) return <p className="mt-3 text-xs text-muted">{q.error.message}</p>;
  if (!data) return q.loading ? <p className="mt-3 text-xs text-muted">{t("params.conn.loading")}</p> : null;
  const unreadable = Object.entries(data.resources).filter(([, r]) => r.status === "error");
  if (data.defaultSpecs.length === 0 && unreadable.length === 0 && Object.keys(data.resources).length === 0) return null;
  const res = byParam(data);
  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{t("params.conn.defaultsTitle")}</p>
      {data.defaultSpecs.length > 0 ? (
        <dl className="mt-1 divide-y divide-line">
          {data.defaultSpecs.map((s) => (
            <div key={s.key} className="flex flex-wrap justify-between gap-x-3 py-1.5">
              <dt className="text-muted-text">{specLabel(s, locale)}</dt>
              <dd className="min-w-0 break-words text-right font-medium">{isBlank(data.defaults[s.key]) ? <span className="font-normal text-muted-text">{t("params.card.notSet")}</span> : describeValue(s, data.defaults[s.key], res[s.key], locale)}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="mt-1 text-xs text-muted">{t("params.conn.defaultsNone")}</p>}
      {unreadable.length > 0 ? (
        <div className="mt-2"><Notice tone="warn">{t("params.conn.summaryUnreadable", { kinds: unreadable.map(([kind]) => kindName(t, kind)).join(", ") })} {t("params.conn.manualWay")}</Notice></div>
      ) : null}
      <Button className="mt-3" onClick={() => setOpen(true)}>{t("params.conn.edit")}</Button>
      {open ? (
        <Dialog title={t("params.conn.title")} description={t("params.conn.intro")} onClose={() => setOpen(false)} wide>
          <ConnectionResourcesPanel id={id} onSaved={q.reload} />
          <div className="mt-5 flex justify-end"><Button onClick={() => setOpen(false)}>{t("params.conn.done")}</Button></div>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Entdeckte Ressourcen und Eingabe der Standardwerte (accountId bei Cloudflare, baseUrl bei Grafana) mit Auswahl. */
export function ConnectionResourcesPanel({ id, onSaved }: { id: string; onSaved?: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const q = useConnectionResources(id);
  const [draft, setDraft] = useState<Draft>({});
  const data = q.data;
  useEffect(() => {
    if (data) setDraft(toDraft(data.defaultSpecs, data.defaults));
  }, [data]);
  const save = useMutation(async (values: Record<string, unknown>) => api<unknown>("PUT", `connections/${enc(id)}/defaults`, { values }));
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!data) return <ListSkeleton rows={2} />;
  if (!data.connected) return <Notice tone="warn">{t("params.conn.notConnected")}</Notice>;

  const trAny = (k: string, v?: Record<string, string | number>) => t(k, v);
  const issues = validateDraft(data.defaultSpecs.map((s) => ({ ...s, required: false })), draft);
  const put = buildPut(data.defaultSpecs, draft, data.defaults);
  const errors = problemMessages(problemsFromError(save.error), trAny, locale);
  const submit = async () => {
    if (!put.changed) return;
    if (await save.run(put.params)) {
      toast.success(t("params.conn.saved"));
      q.reload();
      onSaved?.();
    }
  };
  const kinds = Object.entries(data.resources).filter(([, r]) => r.status === "ok" || r.status === "error" || r.status === "not-connected");
  return (
    <div className="space-y-5 text-sm">
      {kinds.length > 0 ? (
        <ul className="space-y-2">
          {kinds.map(([kind, r]) => (
            <li key={kind} className="rounded-xl border border-line p-3">
              <p className="font-medium">{kindName(t, kind)}{r.status === "ok" ? <span className="ml-2 text-xs font-normal text-muted">{t("params.conn.count", { count: r.options.length })}</span> : null}</p>
              {r.status === "ok" && r.options.length > 0 ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-primary">{t("params.conn.found")}</summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-muted-text">{r.options.map((o) => <li key={String(o.value)} className="break-words">{optionText(o)}</li>)}</ul>
                </details>
              ) : null}
              {r.status === "error" ? <div className="mt-1"><Notice tone="warn">{r.error ? t("params.conn.readErrorDetail", { kind: kindName(t, kind), error: r.error }) : t("params.conn.readError", { kind: kindName(t, kind) })} {t("params.conn.manualWay")}</Notice></div> : null}
              {r.status === "not-connected" ? <p className="mt-1 text-xs text-muted">{t("params.conn.notConnected")}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.defaultSpecs.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h3 className="font-semibold">{t("params.conn.defaultsTitle")}</h3>
            <p className="text-xs text-muted">{t("params.conn.defaultsHint")}</p>
          </div>
          <ParamsForm specs={data.defaultSpecs.map((s) => ({ ...s, required: false }))} draft={draft} onDraft={setDraft} resources={byParam(data)} connection={id} errors={errors} onReload={q.reload} />
          {save.error && problemsFromError(save.error).length === 0 ? <Notice tone="danger">{save.error.message}</Notice> : null}
          <Button variant="primary" loading={save.pending} disabled={!put.changed || issues.length > 0} onClick={() => void submit()}>{t("params.conn.save")}</Button>
        </section>
      ) : <p className="text-xs text-muted">{t("params.conn.defaultsNone")}</p>}
    </div>
  );
}
