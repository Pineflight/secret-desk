"use client";
import { useState } from "react";
import type { ConnectionResources } from "@secret-desk/runtime";
import { Button, Notice } from "@/components/ui";
import { RepoPicker } from "@/components/RepoPicker";
import { SelectBox } from "@/components/SelectBox";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { optionText } from "@/lib/params-form";
import { entriesOfKinds, sameMapKey, useResourceMap } from "@/lib/resource-map";
import { labelOf } from "@/lib/stages";
import { useToast } from "@/lib/toast";
import { useStageDefs } from "@/lib/use-stages";

const kindName = (t: (k: string) => string, kind: string): string => {
  const key = `params.kind.${kind}`;
  const text = t(key);
  return text === key ? kind : text;
};

/** Abschnitt "Zuordnung Repository -> Ressource" einer Integration: bestehende Zuordnungen, Loeschen, Hinzufuegen. Nichts davon ist geheim. */
export function ResourceMapPanel({ data }: { data: ConnectionResources }) {
  const { t } = useI18n();
  const toast = useToast();
  const defs = useStageDefs();
  const map = useResourceMap();
  const kinds = Object.entries(data.resources).filter(([kind]) => map.data?.kinds.includes(kind)).map(([kind]) => kind);
  const [kind, setKind] = useState("");
  const [repo, setRepo] = useState("");
  const [stage, setStage] = useState("");
  const [value, setValue] = useState("");
  const activeKind = kinds.includes(kind) ? kind : (kinds[0] ?? "");
  const options = data.resources[activeKind]?.options ?? [];
  const put = useMutation(async (body: Record<string, unknown>) => api<unknown>("PUT", "resource-map", body));
  const del = useMutation(async (body: Record<string, unknown>) => api<unknown>("DELETE", "resource-map", body));
  if (kinds.length === 0) return null;
  if (map.error) return <Notice tone="warn">{t("params.map.loadError", { error: map.error.message })}</Notice>;
  const entries = entriesOfKinds(map.data?.entries ?? [], kinds);
  const nameOf = (k: string, v: string, fallback?: string) => {
    const found = data.resources[k]?.options.find((o) => String(o.value) === v);
    return found ? optionText(found) : (fallback ?? v);
  };

  const add = async () => {
    const chosen = options.find((o) => String(o.value) === value);
    if (!repo.trim() || !chosen) return;
    const body = { kind: activeKind, repo: repo.trim(), ...(stage ? { stage } : {}), value, label: chosen.label };
    if (await put.run(body)) {
      toast.success(t("params.map.saved"));
      setValue("");
      map.reload();
    }
  };
  const remove = async (e: (typeof entries)[number]) => {
    if (await del.run({ kind: e.kind, repo: e.repo, ...(e.stage ? { stage: e.stage } : {}) })) {
      toast.success(t("params.map.removed"));
      map.reload();
    }
  };
  return (
    <section className="space-y-3" aria-labelledby="resource-map-title">
      <div>
        <h3 id="resource-map-title" className="font-semibold">{t("params.map.title")}</h3>
        <p className="text-xs text-muted">{t("params.map.intro")}</p>
      </div>
      {entries.length === 0 ? <p className="text-xs text-muted">{t("params.map.empty")}</p> : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted"><tr><th className="px-3 py-1.5 font-medium">{t("params.map.colRepo")}</th><th className="px-3 py-1.5 font-medium">{t("params.map.colStage")}</th><th className="px-3 py-1.5 font-medium">{t("params.map.colResource")}</th><th className="px-3 py-1.5"><span className="sr-only">{t("params.map.title")}</span></th></tr></thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => {
                const known = data.resources[e.kind]?.status !== "ok" || data.resources[e.kind]!.options.some((o) => String(o.value) === e.value);
                return (
                  <tr key={`${e.kind}|${e.repo}|${e.stage ?? ""}`}>
                    <td className="px-3 py-1.5 font-medium">{e.repo}<span className="block text-[11px] font-normal text-muted">{kindName(t, e.kind)}</span></td>
                    <td className="px-3 py-1.5">{e.stage ? labelOf(defs, e.stage) : <span className="text-muted-text">{t("params.map.allStages")}</span>}</td>
                    <td className="min-w-0 break-words px-3 py-1.5">{nameOf(e.kind, e.value, e.label)}{known ? null : <span className="block text-xs text-warn-text">{t("params.map.unknownResource")}</span>}</td>
                    <td className="px-3 py-1.5 text-right"><Button variant="ghost" loading={del.pending} aria-label={t("params.map.remove", { repo: e.repo })} onClick={() => void remove(e)}>×</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {kinds.length > 1 ? (
          <label className="block text-xs font-medium">{t("params.map.kind")}
            <SelectBox value={activeKind} onChange={(ev) => { setKind(ev.target.value); setValue(""); }}>{kinds.map((k) => <option key={k} value={k}>{kindName(t, k)}</option>)}</SelectBox>
          </label>
        ) : null}
        <label className="block text-xs font-medium">{t("params.map.repo")}
          <RepoPicker value={repo} onChange={setRepo} ariaLabel={t("params.map.repo")} />
        </label>
        <label className="block text-xs font-medium">{t("params.map.stage")}
          <SelectBox value={stage} onChange={(ev) => setStage(ev.target.value)}>
            <option value="">{t("params.map.allStages")}</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectBox>
        </label>
        <label className="block text-xs font-medium">{t("params.map.resource")}
          <SelectBox value={value} searchable onChange={(ev) => setValue(ev.target.value)}>
            <option value="">{t("params.map.pickResource")}</option>
            {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{optionText(o)}</option>)}
          </SelectBox>
        </label>
      </div>
      {put.error ? <Notice tone="danger">{put.error.message}</Notice> : null}
      {del.error ? <Notice tone="danger">{del.error.message}</Notice> : null}
      <Button loading={put.pending} disabled={!repo.trim() || value === ""} onClick={() => void add()}>{t("params.map.add")}</Button>
    </section>
  );
}

/** Nach der Wahl einer Ressource, die kein Vorschlag war: "Fuer <repo> merken" (optional nur fuer die Stage). */
export function RememberMapping({ kind, repo, stage, value, label, onSaved }: { kind: string; repo: string; stage?: string | undefined; value: string; label: string; onSaved?: (() => void) | undefined }) {
  const { t } = useI18n();
  const toast = useToast();
  const map = useResourceMap();
  const [onlyStage, setOnlyStage] = useState(false);
  const put = useMutation(async (body: Record<string, unknown>) => api<unknown>("PUT", "resource-map", body));
  const data = map.data;
  if (!data || !data.kinds.includes(kind) || repo === "") return null;
  const key = { kind, repo, ...(onlyStage && stage ? { stage } : {}) };
  const stored = data.entries.find((e) => sameMapKey(e, key));
  if (stored?.value === value) return <p className="text-xs text-info-text">{t("params.map.remembered", { repo })}</p>;
  const save = async () => {
    if (await put.run({ ...key, value, label })) {
      toast.success(t("params.map.saved"));
      map.reload();
      onSaved?.();
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <Button className="!px-2.5 !py-1 !text-xs" loading={put.pending} title={t("params.map.rememberHint")} onClick={() => void save()}>{t("params.map.remember", { repo })}</Button>
      {stage ? <label className="inline-flex items-center gap-1.5 text-muted-text"><input type="checkbox" checked={onlyStage} onChange={(e) => setOnlyStage(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--sd-primary)]" />{t("params.map.rememberStage", { stage })}</label> : null}
      {put.error ? <span role="alert" className="font-medium text-danger-text">{put.error.message}</span> : null}
    </div>
  );
}
