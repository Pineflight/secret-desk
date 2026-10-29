"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ConnectionResources, SourceProposal, SourceValue } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Button, Checkbox, EmptyState, ErrorState, ListSkeleton, Notice, SelectField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { optionText, type ResourceState } from "@/lib/params-form";
import { classifyVariableError } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { applyBody, clip, describeFrom, splitSuggestions, type SuggestionRow, EMPTY_SOURCE, fieldAllowed, fieldLabel, findSource, pickKind, retryParams, sourceComplete, sourceLabel, type SourceDef, type SourceDraft, type VariableFrom } from "@/lib/variable-source";

/** Entdeckte Ressourcen einer Quelle. Braucht die Art einen weiteren Parameter, den die Integration als Standardwert kennt (zum Beispiel das Konto), wird er genutzt. */
export function useSourceResources(sources: SourceDef[], kind: string): { state: ResourceState | undefined; params: Record<string, string>; loading: boolean; error: Error | null } {
  const def = findSource(sources, kind);
  const q = useQuery<{ state: ResourceState | undefined; params: Record<string, string> }>(def?.connected ? `src-res:${def.connection}:${kind}` : null, async () => {
    const base = `connections/${enc(def!.connection)}/resources`;
    let res = await api<ConnectionResources>("GET", `${base}?kind=${enc(kind)}`);
    let params: Record<string, string> = {};
    const retry = retryParams(kind, res);
    if (retry) {
      const qs = new URLSearchParams({ kind });
      for (const [k, v] of Object.entries(retry)) qs.set(`param.${k}`, v);
      res = await api<ConnectionResources>("GET", `${base}?${qs}`);
      params = retry;
    }
    return { state: res.resources[kind], params };
  });
  return { state: q.data?.state, params: q.data?.params ?? {}, loading: q.loading, error: q.error };
}

/** Erlaubte Quellen (Allowlist des Servers) mit Verbindungsstand. */
export function useVariableSources(): { sources: SourceDef[]; error: Error | null } {
  const q = useQuery<{ sources: SourceDef[] }>("variable-sources", () => api<{ sources: SourceDef[] }>("GET", "variable-sources"));
  return { sources: q.data?.sources ?? [], error: q.error };
}

interface Shown {
  proposed: string;
  resourceLabel: string;
  current: string | null;
  changed: boolean;
  applied: boolean;
}

/**
 * Optionale Quelle einer Variable: Anbieter-Ressource und Feld waehlen (nur Felder der Allowlist des Servers), Wert lesen und per Klick
 * uebernehmen. Im Anlegedialog fuellt "Als Wert uebernehmen" das Wertfeld; an einer bestehenden Variable schreibt "Uebernehmen" den Sollwert
 * ins Inventar (nicht nach GitHub).
 */
export function SourceSection({ mode, sources, sourcesError, variableId, stored, value, onChange, repo, stage, onUseValue, onChanged }: {
  mode: "create" | "edit";
  sources: SourceDef[];
  sourcesError?: Error | null;
  variableId?: string;
  stored?: VariableFrom | null;
  value: SourceDraft;
  onChange: (d: SourceDraft) => void;
  repo?: string;
  stage?: string;
  onUseValue?: (value: string) => void;
  onChanged?: () => void;
}) {
  const { t, locale } = useI18n();
  const def = findSource(sources, value.kind);
  const res = useSourceResources(sources, value.kind);
  const [shown, setShown] = useState<Shown | null>(null);
  const [ack, setAck] = useState(false);
  useEffect(() => setShown(null), [value.kind, value.resource, value.field]);

  const load = useMutation(async (apply: boolean): Promise<Shown> => {
    const body = { kind: value.kind, resource: value.resource, field: value.field, ...(Object.keys(res.params).length > 0 ? { params: res.params } : {}) };
    if (mode === "create") {
      const r = await api<SourceValue>("POST", "variable-sources/value", { ...body, ...(repo ? { repo } : {}), ...(stage ? { stage } : {}) });
      return { proposed: r.value, resourceLabel: r.resourceLabel, current: null, changed: true, applied: false };
    }
    const r = await api<SourceProposal>("POST", `variables/${enc(variableId!)}/load-from-source`, { ...body, ...(apply ? { apply: true, ...(ack ? { acknowledgedPublic: true } : {}) } : {}) });
    return { proposed: r.proposed, resourceLabel: r.resourceLabel, current: r.current, changed: r.changed, applied: r.applied };
  });
  const clear = useMutation(async () => api<unknown>("PATCH", `variables/${enc(variableId!)}`, { from: null }));

  const run = async (apply: boolean) => {
    const r = await load.run(apply);
    if (!r) return;
    setShown(r);
    if (r.applied) {
      setAck(false);
      onChanged?.();
    }
  };
  const ready = sourceComplete(value) && fieldAllowed(sources, value);
  const options = res.state?.status === "ok" ? res.state.options : [];
  const err = load.error;
  const errKind = err ? classifyVariableError(err as { code?: string }) : null;

  return (
    <section aria-labelledby="var-source-title" className="space-y-3 rounded-xl border border-line p-4">
      <div>
        <h3 id="var-source-title" className="text-sm font-semibold">{t("variables.src.title")}</h3>
        <p className="text-xs text-muted">{t("variables.src.hint")}</p>
      </div>
      {mode === "edit" && stored ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-text">
          {t("variables.src.stored", { source: describeFrom(stored, sources, locale) })}
          <button type="button" className="text-primary underline" onClick={async () => { if (await clear.run()) { onChange(EMPTY_SOURCE); onChanged?.(); } }}>{t("variables.src.clear")}</button>
        </p>
      ) : null}
      {sourcesError ? <Notice tone="warn">{t("variables.src.listError", { error: sourcesError.message })}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label={t("variables.src.kind")} value={value.kind} onChange={(e) => onChange(pickKind(sources, e.target.value))}>
          <option value="">{t("variables.src.noneOption")}</option>
          {sources.map((s) => <option key={s.kind} value={s.kind}>{sourceLabel(s, locale)}{s.connected ? "" : ` (${t("variables.src.notConnected")})`}</option>)}
        </SelectField>
        {def && def.connected ? (
          <SelectField label={t("variables.src.field")} value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
            <option value="">{t("params.pick")}</option>
            {def.fields.map((f) => <option key={f.field} value={f.field}>{fieldLabel(f, locale)}</option>)}
          </SelectField>
        ) : null}
      </div>
      {def && !def.connected ? <Notice tone="warn">{t("variables.src.notConnectedHint")} <Link href="/connections" className="font-medium underline">{t("params.toConnections")}</Link></Notice> : null}
      {def && def.connected ? (
        <div className="space-y-2">
          <SelectField label={t("variables.src.resource")} value={value.resource} onChange={(e) => onChange({ ...value, resource: e.target.value })} searchable>
            <option value="">{res.loading ? t("params.loading") : t("params.pick")}</option>
            {value.resource !== "" && !options.some((o) => String(o.value) === value.resource) ? <option value={value.resource}>{value.resource}</option> : null}
            {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{optionText(o)}</option>)}
          </SelectField>
          {res.error ? <Notice tone="warn">{t("variables.src.listError", { error: res.error.message })}</Notice> : null}
          {res.state?.status === "needs-params" ? <Notice tone="warn">{t("variables.src.needsParams")} <Link href="/connections" className="font-medium underline">{t("params.toConnections")}</Link></Notice> : null}
          {res.state?.status === "error" ? <Notice tone="warn">{res.state.error ? t("params.res.error", { error: res.state.error }) : t("params.res.errorPlain")}</Notice> : null}
          {res.state?.status === "ok" && options.length === 0 ? <p className="text-xs text-muted">{t("variables.src.noResources")}</p> : null}
        </div>
      ) : null}
      {def && def.connected ? <Button disabled={!ready} loading={load.pending} onClick={() => void run(false)}>{t("variables.src.load")}</Button> : null}
      {shown ? (
        <div className="space-y-2 rounded-lg bg-page p-3 text-sm" aria-live="polite">
          <p>{t("variables.src.loaded", { resource: shown.resourceLabel, value: clip(shown.proposed, 80) })}</p>
          {mode === "edit" ? <p className="text-xs text-muted">{t("variables.src.current", { current: shown.current === null ? "–" : clip(shown.current, 80) })}</p> : null}
          {shown.applied ? <p className="text-success-text">{t("variables.src.applied")}</p> : null}
          {mode === "edit" && !shown.applied && !shown.changed ? <p className="text-xs text-muted">{t("variables.src.unchanged")}</p> : null}
          <div className="flex flex-wrap gap-2">
            {mode === "create" ? <Button variant="primary" onClick={() => { onUseValue?.(shown.proposed); setShown(null); }}>{t("variables.src.use")}</Button> : null}
            {mode === "edit" && shown.changed && !shown.applied ? <Button variant="primary" loading={load.pending} onClick={() => void run(true)}>{t("variables.src.apply")}</Button> : null}
          </div>
        </div>
      ) : null}
      {errKind === "secret" ? <Notice tone="danger" title={t("variables.blockedTitle")}>{t("variables.blockedText")}</Notice> : null}
      {errKind === "acknowledge" ? (
        <div className="space-y-2">
          <Notice tone="warn" title={t("variables.warnTitle")}>{err?.message} {t("variables.warnSuffix")}</Notice>
          <Checkbox checked={ack} onChange={setAck}>{t("variables.ackPublic")}</Checkbox>
        </div>
      ) : null}
      {err && errKind !== "secret" && errKind !== "acknowledge" ? <Notice tone="danger">{err.message}</Notice> : null}
      {clear.error ? <Notice tone="danger">{clear.error.message}</Notice> : null}
    </section>
  );
}

interface RowResult {
  state: "applied" | "error";
  error?: string;
  needsAck?: boolean;
}

/** Vorschlaege fuer alle Variablen mit Quelle: was der Anbieter jetzt nennt gegen den Sollwert im Inventar. Uebernommen wird nur per Klick, nur ins Inventar. */
export function SuggestSourcesDialog({ names, onClose, onChanged }: { names: Record<string, string>; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const q = useQuery<{ suggestions: SuggestionRow[] }>("variables-suggest-all", () => api<{ suggestions: SuggestionRow[] }>("POST", "variables/suggest-all"));
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const split = splitSuggestions(q.data?.suggestions ?? []);
  const apply = async (row: Extract<SuggestionRow, { status: "ok" }>) => {
    setBusy((b) => new Set(b).add(row.variableId));
    try {
      await api<unknown>("POST", `variables/${enc(row.variableId)}/load-from-source`, applyBody(row.from, Boolean(ack[row.variableId])));
      setResults((r) => ({ ...r, [row.variableId]: { state: "applied" } }));
      toast.success(t("variables.src.suggestAppliedOne", { name: names[row.variableId] ?? row.variableId }));
      onChanged();
    } catch (e) {
      setResults((r) => ({ ...r, [row.variableId]: { state: "error", error: e instanceof Error ? e.message : String(e), needsAck: classifyVariableError(e as { code?: string }) === "acknowledge" } }));
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(row.variableId); return n; });
    }
  };
  return (
    <Dialog title={t("variables.src.suggestTitle")} description={t("variables.src.suggestDesc")} onClose={onClose} wide>
      {q.loading && !q.data ? <><p className="mb-3 text-sm text-muted">{t("variables.src.suggestLoading")}</p><ListSkeleton rows={3} /></> : null}
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.data && q.data.suggestions.length === 0 ? <EmptyState title={t("variables.src.suggestEmpty")} icon="sliders" /> : null}
      {split.changed.length > 0 ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {split.changed.map((row) => {
            const res = results[row.variableId];
            return (
              <li key={row.variableId} className="space-y-1.5 px-4 py-3 text-sm">
                <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{names[row.variableId] ?? row.variableId}</span><span className="font-mono text-xs text-muted">{row.variableId}</span></p>
                <p className="text-xs text-muted-text">{t("variables.src.suggestNow")}: <span className="font-mono text-ink">{row.current === null ? "–" : clip(row.current, 70)}</span></p>
                <p className="text-xs text-muted-text">{t("variables.src.suggestNew")} ({row.resourceLabel}): <span className="font-mono text-ink">{clip(row.proposed, 70)}</span></p>
                {res?.state === "applied" ? <p className="text-success-text">{t("variables.src.applied")}</p> : null}
                {res?.state === "error" ? <Notice tone="danger">{res.error}</Notice> : null}
                {res?.needsAck ? <Checkbox checked={Boolean(ack[row.variableId])} onChange={(v) => setAck((a) => ({ ...a, [row.variableId]: v }))}>{t("variables.ackPublic")}</Checkbox> : null}
                {res?.state !== "applied" ? <Button variant="primary" loading={busy.has(row.variableId)} onClick={() => void apply(row)}>{t("variables.src.apply")}</Button> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {split.same.length > 0 ? <p className="mt-3 text-xs text-muted">{t("variables.src.suggestSame", { count: split.same.length })}</p> : null}
      {split.failed.length > 0 ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-muted-text">{t("variables.src.suggestFailed")}</p>
          <ul className="space-y-1">{split.failed.map((row) => <li key={row.variableId}><Notice tone="warn"><span className="font-medium">{names[row.variableId] ?? row.variableId}</span>: {row.error}</Notice></li>)}</ul>
        </div>
      ) : null}
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>{t("params.complete.close")}</Button></div>
    </Dialog>
  );
}
