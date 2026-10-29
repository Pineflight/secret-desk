"use client";
import { useState } from "react";
import type { EntryPreflight } from "@secret-desk/core";
import type { SecretView } from "@secret-desk/runtime";
import { ParamsForm } from "@/components/ParamsForm";
import { MetaFields, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { PlacesEditor } from "@/components/PlacesEditor";
import { Button, Notice, SelectField, TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { useToast } from "@/lib/toast";
import { useI18n } from "@/lib/i18n";
import { canSave, findingsText, issueMessages, missingKeys, preflightTone, problemMessages, problemsFromError, toParams, validateDraft, type Draft } from "@/lib/params-form";
import { useDraftParams } from "@/lib/use-params";
import { useStageDefs } from "@/lib/use-stages";
import { prefillRow, type Prefill } from "@/lib/prefill";
import { defaultStageId, environmentOf, kindOf, labelOf } from "@/lib/stages";

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  browser?: boolean;
}

/** Form to create a secret entry (metadata only). The surrounding dialog comes from NewEntryDialog. */
export function SecretForm({ initial = null, onClose, onCreated }: { initial?: Prefill | null; onClose: () => void; onCreated: () => void }) {
  const { t, locale } = useI18n();
  const defs = useStageDefs();
  const toast = useToast();
  const providers = useQuery<ProviderRow[]>("providers", () => api<ProviderRow[]>("GET", "providers"));
  const [f, setF] = useState({ id: initial?.id ?? "", name: initial?.name ?? "", title: "", product: "", stage: initial?.stage ?? "", service: initial ? "github-actions" : "", provider: "manual", expiry: "unknown", expires: "", ttlDays: "" });
  const [rows, setRows] = useState<PlaceRow[]>([initial ? prefillRow(defs, initial) : emptyPlaceRow()]);
  const [meta, setMeta] = useState<MetaValues>({ description: initial?.description ?? "", owner: "", link: "", tags: [] });
  const [localError, setLocalError] = useState<string | null>(null);
  const stageId = f.stage || defaultStageId(defs, "test");
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const [paramDraft, setParamDraft] = useState<Draft>({});
  const repo = rows.map((r) => r.repo.trim()).find(Boolean) ?? "";
  const manualProvider = f.provider === "manual";
  const create = useMutation(async (body: unknown) => api<SecretView & { preflight?: EntryPreflight }>("POST", manualProvider ? "secrets" : "secrets?preflight=1", body));
  // Parameter des Anbieters (nur wenn er welche hat): Spezifikation und entdeckte Ressourcen, Listen laden bei abhaengigen Parametern neu.
  const pv = useDraftParams(manualProvider ? null : f.provider, repo, stageId, paramDraft);
  const specs = pv.view?.specs ?? [];
  const issues = validateDraft(specs, paramDraft, pv.view?.defaults ?? {});
  const missing = missingKeys(issues);
  const trAny = (k: string, v?: Record<string, string | number>) => t(k, v);
  const fieldErrors = { ...issueMessages(issues.filter((i) => i.code !== "missing"), specs, trAny, locale), ...problemMessages(problemsFromError(create.error), trAny, locale) };
  const missingText = missing.map((k) => { const sp = specs.find((x) => x.key === k); return sp ? (locale === "en" ? sp.labelEn : sp.label) : k; }).join(", ");

  const submit = async () => {
    setLocalError(null);
    const { places, error } = rowsToPlaces(rows, { stage: stageId, environment: environmentOf(defs, stageId) });
    if (error) return setLocalError(error);
    const metaError = validateMeta(meta);
    if (metaError) return setLocalError(metaError);
    if (kindOf(defs, stageId) !== "dev" && places.length === 0) return setLocalError(t("secrets.needTarget"));
    const ttl = f.ttlDays.trim() ? Number(f.ttlDays) : undefined;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) return setLocalError(t("secrets.ttlInvalid"));
    if (!canSave(specs, paramDraft, pv.view?.defaults ?? {})) return setLocalError(missing.length > 0 ? t("params.create.missing", { keys: missingText }) : t("params.problem.wrong_type", { label: t("params.title") }));
    const params = toParams(specs, paramDraft).params;
    const res = await create.run({
      id: f.id.trim(),
      name: f.name.trim(),
      stage: stageId,
      service: f.service.trim(),
      provider: f.provider,
      expiry: f.expiry,
      ...(f.title.trim() ? { title: f.title.trim() } : {}),
      ...(f.product.trim() ? { product: f.product.trim() } : {}),
      ...(f.expires && f.expiry !== "none" ? { expires: f.expires } : {}),
      ...(ttl !== undefined ? { ttlDays: ttl } : {}),
      places,
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...metaBody(meta),
    });
    if (res) {
      toast.success(t("secrets.created", { name: res.name }));
      // Vorabcheck beim Anbieter (lesend): angelegt ist der Eintrag auch bei Hinweisen und Fehlbefunden.
      const pre = res.preflight;
      const tone = preflightTone(pre);
      if (pre && tone === "success") toast.success(t("params.create.preflightOk", { resource: pre.resource ?? res.name }));
      else if (pre && tone === "info") toast.info(t("params.create.preflightWarn", { text: findingsText(pre.findings) }));
      else if (pre && tone === "error") toast.error(t("params.create.preflightFail", { text: findingsText(pre.findings) }));
      else if (specs.length > 0) toast.info(t("params.create.preflightSkipped"));
      onCreated();
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <MetaFields value={meta} onChange={setMeta} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label={t("secrets.fieldId")} hint={t("secrets.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" data-autofocus />
        <TextField label={t("secrets.fieldName")} hint={t("secrets.fieldNameHint")} required value={f.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoComplete="off" />
        <TextField label={t("secrets.fieldTitle")} value={f.title} onChange={(e) => set("title", e.target.value)} />
        <TextField label={t("secrets.fieldProduct")} value={f.product} onChange={(e) => set("product", e.target.value)} />
        <SelectField label={t("secrets.stage")} value={stageId} onChange={(e) => set("stage", e.target.value)}>
          {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
        </SelectField>
        <TextField label={t("secrets.fieldService")} hint={t("secrets.fieldServiceHint")} required value={f.service} onChange={(e) => set("service", e.target.value)} />
        <SelectField label={t("secrets.provider")} value={f.provider} onChange={(e) => { set("provider", e.target.value); setParamDraft({}); }}>
          <option value="manual">{t("secrets.providerManual")}</option>
          {(providers.data ?? []).filter((p) => p.id !== "manual").map((p) => <option key={p.id} value={p.id}>{p.browser ? p.label : `${p.label} (${p.kind === "automatic" ? t("secrets.providerKindAuto") : t("secrets.providerKindManual")})`}</option>)}
        </SelectField>
        <SelectField label={t("secrets.expiry")} value={f.expiry} onChange={(e) => set("expiry", e.target.value)}>
          <option value="none">{t("secrets.expNone")}</option>
          <option value="possible">{t("secrets.expPossible")}</option>
          <option value="required">{t("secrets.expRequired")}</option>
          <option value="unknown">{t("secrets.expUnknown")}</option>
        </SelectField>
        <TextField label={t("secrets.expiresOn")} type="date" disabled={f.expiry === "none"} value={f.expires} onChange={(e) => set("expires", e.target.value)} />
        <TextField label={t("secrets.ttlDays")} inputMode="numeric" value={f.ttlDays} onChange={(e) => set("ttlDays", e.target.value.replace(/\D/g, ""))} />
      </div>
      <PlacesEditor rows={rows} onChange={setRows} stage={stageId} />
      {!manualProvider && pv.error ? <Notice tone="warn">{t("params.create.loadError", { error: pv.error.message })}</Notice> : null}
      {!manualProvider && specs.length > 0 ? (
        <section aria-labelledby="create-params-title" className="space-y-3 rounded-xl border border-line p-4">
          <div>
            <h3 id="create-params-title" className="text-sm font-semibold">{t("params.create.title", { provider: pv.view?.providerLabel ?? f.provider })}</h3>
            <p className="text-xs text-muted">{t("params.intro", { provider: pv.view?.providerLabel ?? f.provider })}</p>
          </div>
          {repo === "" ? <p className="text-xs text-muted">{t("params.create.noRepo")}</p> : null}
          <ParamsForm specs={specs} draft={paramDraft} onDraft={setParamDraft} resources={pv.view?.resources ?? {}} loading={pv.loading} connection={pv.view?.connection ?? null} defaults={pv.view?.defaults ?? {}} errors={fieldErrors} onReload={pv.reload} remember={repo ? { repo, stage: stageId } : undefined} />
          {missing.length > 0 ? <p className="text-xs font-medium text-warn-text">{t("params.create.missing", { keys: missingText })}</p> : null}
        </section>
      ) : null}
      {kindOf(defs, stageId) === "dev" ? <p className="text-xs text-muted">{t("secrets.devNoTarget")}</p> : null}
      {localError || create.error ? <Notice tone="danger">{localError ?? create.error?.message}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("secrets.cancel")}</Button>
        <Button type="submit" variant="primary" loading={create.pending} disabled={!manualProvider && issues.length > 0}>{t("secrets.create")}</Button>
      </div>
    </form>
  );
}

