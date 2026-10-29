"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { VariableDrift } from "@secret-desk/core";
import type { VariableApplyResult, VariableView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { SourceSection, useVariableSources } from "@/components/VariableSource";
import { Icon } from "@/components/Icons";
import { EditMetaDialog, ExternalLink, MetaFields, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { PlacesEditor } from "@/components/PlacesEditor";
import { Badge, Button, Checkbox, Notice, Pill, SelectField, StageBadge, TextField, inputClass } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { placeText } from "@/lib/format";
import { useMutation } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { classifyVariableError, driftInfo, type DriftState } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { EMPTY_SOURCE, draftOf, fromBody, type SourceDef, type SourceDraft } from "@/lib/variable-source";
import { useStageDefs } from "@/lib/use-stages";
import { prefillRow, type Prefill } from "@/lib/prefill";
import { defaultStageId, environmentOf, labelOf } from "@/lib/stages";

/** Dialogs and forms of variables, used by the combined entries list. */

export type Auto = "apply" | "adopt";

/** Zeigt die Sperre oder die Bestätigungsfrage, je nach Meldung des Servers. */
export function SecretGuard({ error, ack, setAck }: { error: Error | null; ack: boolean; setAck: (v: boolean) => void }) {
  const t = useT();
  if (!error) return null;
  const kind = classifyVariableError(error as { code?: string });
  if (kind === "secret") {
    return (
      <Notice tone="danger" title={t("variables.blockedTitle")}>
        {t("variables.blockedText")} <Link href="/entries?kind=secret&new=1" className="font-medium underline">{t("variables.toSecrets")}</Link>
      </Notice>
    );
  }
  if (kind === "acknowledge") {
    return (
      <div className="space-y-2">
        <Notice tone="warn" title={t("variables.warnTitle")}>{error.message.replace(/\s*Zum Bestätigen acknowledgedPublic setzen\.?|\s*Zum Bestaetigen acknowledgedPublic setzen\.?/, "")} {t("variables.warnSuffix")}</Notice>
        <Checkbox checked={ack} onChange={setAck}>{t("variables.ackPublic")}</Checkbox>
      </div>
    );
  }
  return <Notice tone="danger">{error.message}</Notice>;
}

/** Detail einer Variable: Sollwert, Abgleich je Ziel, Setzen und Uebernehmen samt Geheimnis-Pruefung. */
export function VariableDetail({ v, sources, drift, comparing, compareError, auto, onCompare, onChanged, onEdit, onRemove, onClose }: {
  v: VariableView;
  sources: SourceDef[];
  drift: VariableDrift[] | undefined;
  comparing: boolean;
  compareError: string | undefined;
  auto: Auto | undefined;
  onCompare: () => Promise<boolean>;
  onChanged: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState(v.value ?? "");
  const [ack, setAck] = useState(false);
  const [outcomes, setOutcomes] = useState<{ place: string; outcome: string; error?: string }[] | null>(null);
  const [src, setSrc] = useState<SourceDraft>(draftOf(v.from));
  useEffect(() => setValue(v.value ?? ""), [v.value]);

  const save = useMutation(async () => api<VariableView>("PATCH", `variables/${enc(v.id)}`, { value, ...(ack ? { acknowledgedPublic: true } : {}) }));
  const apply = useMutation(async () => api<VariableApplyResult>("POST", `variables/${enc(v.id)}/apply`, ack ? { acknowledgedPublic: true } : {}));
  const adopt = useMutation(async () => api<VariableView>("POST", `variables/${enc(v.id)}/adopt`));

  const doSave = async () => {
    const r = await save.run();
    if (r) {
      toast.success(t("variables.saved"));
      setAck(false);
      onChanged();
      if (drift) void onCompare();
    }
  };
  const doApply = async () => {
    const r = await apply.run();
    if (!r) return;
    if (r.status === "pending-approval") toast.info(t("variables.approvalNeeded"));
    else {
      setOutcomes(r.outcomes);
      toast.success(t("variables.appliedToGithub"));
      void onCompare();
    }
  };
  const doAdopt = async () => {
    const r = await adopt.run();
    if (r) {
      toast.success(t("variables.adopted"));
      onChanged();
      void onCompare();
    }
  };

  // Zeilenaktionen "In GitHub setzen" und "Aus GitHub uebernehmen" starten hier, damit Sperre und Bestaetigung sichtbar sind.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !auto) return;
    started.current = true;
    if (auto === "apply") void doApply();
    else void doAdopt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const error = save.error ?? apply.error ?? adopt.error;
  const dirty = value !== (v.value ?? "");

  return (
    <Dialog title={v.name} description={`${v.id}${v.product ? ` · ${v.product}` : ""}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><StageBadge stage={v.stage} /></div>
        {v.description ? <p className="text-sm text-muted-text">{v.description}</p> : <p className="text-xs text-muted">{t("variables.noDescription")}</p>}
        {v.owner || v.link ? <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-text">{v.owner ? <span>{t("variables.owner", { name: v.owner })}</span> : null}{v.link ? <ExternalLink href={v.link} /> : null}</p> : null}
        <div className="flex flex-wrap gap-1">{v.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>)}</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <label htmlFor={`val-${v.id}`} className="mb-1 block text-sm font-medium">{t("variables.expected")}</label>
            <input id={`val-${v.id}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("variables.unknownYet")} className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} data-autofocus />
          </div>
          <Button variant="secondary" disabled={!dirty} loading={save.pending} onClick={() => void doSave()}>{t("variables.saveExpected")}</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button loading={comparing} onClick={() => void onCompare()}><Icon name="refresh" />{t("variables.compare")}</Button>
          <Button loading={apply.pending} disabled={v.value === null} onClick={() => void doApply()}><Icon name="upload" />{t("variables.apply")}</Button>
          <Button loading={adopt.pending} onClick={() => void doAdopt()}><Icon name="download" />{t("variables.adopt")}</Button>
          <Button variant="ghost" onClick={onEdit}><Icon name="wrench" />{t("variables.edit")}</Button>
          <Button variant="ghost" onClick={onRemove}><Icon name="trash" />{t("variables.remove")}</Button>
        </div>
        {error ? <SecretGuard error={error} ack={ack} setAck={setAck} /> : null}
        {compareError ? <Notice tone="danger">{compareError}</Notice> : null}
        {drift ? (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {drift.map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1 font-medium">{d.placeLabel}</span>
                <Badge info={driftInfo(d.state as DriftState)} />
                {d.state === "unreachable" ? (
                  <p className="basis-full text-xs text-muted-text">
                    {t(d.errorStatus === 401 ? "variables.unreachable401" : d.errorStatus === 403 ? "variables.unreachable403" : d.errorStatus === 404 ? "variables.unreachable404" : "variables.unreachableOther")}
                    {d.error ? <span className="mt-1 block break-words font-mono text-[11px]">{d.error}</span> : null}
                  </p>
                ) : null}
                {d.state === "different" ? <span className="text-xs text-muted-text">{t("variables.driftExpected")} <span className="font-mono text-ink">{d.expected ?? "–"}</span>, {t("variables.driftActual")} <span className="font-mono text-ink">{d.actual ?? "–"}</span></span> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-muted">{t("variables.notComparedYet")}</p>}
        <SourceSection mode="edit" sources={sources} variableId={v.id} stored={v.from} value={src} onChange={setSrc} onChanged={onChanged} />
        {outcomes ? (
          <ul className="space-y-1 text-sm">
            {outcomes.map((o, i) => <li key={i} className={o.outcome === "failed" ? "text-danger-text" : "text-success-text"}>{o.place}: {o.outcome === "failed" ? `${t("variables.outcomeFailed")}${o.error ? ` (${o.error})` : ""}` : o.outcome === "created" ? t("variables.outcomeCreated") : t("variables.outcomeUpdated")}</li>)}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

export function VariableForm({ sources, initial = null, onClose, onCreated }: { sources: SourceDef[]; initial?: Prefill | null; onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const defs = useStageDefs();
  const toast = useToast();
  const [f, setF] = useState({ id: initial?.id ?? "", name: initial?.name ?? "", stage: initial?.stage ?? "", description: "", product: "", value: "" });
  const [rows, setRows] = useState<PlaceRow[]>([initial ? prefillRow(defs, initial) : emptyPlaceRow()]);
  const [ack, setAck] = useState(false);
  const [src, setSrc] = useState<SourceDraft>(EMPTY_SOURCE);
  const [meta, setMeta] = useState<MetaValues>({ description: initial?.description ?? "", owner: "", link: "", tags: [] });
  const [localError, setLocalError] = useState<string | null>(null);
  const stageId = f.stage || defaultStageId(defs, "test");
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const create = useMutation(async (body: unknown) => api<VariableView>("POST", "variables", body));
  const submit = async () => {
    setLocalError(null);
    const { places, error } = rowsToPlaces(rows, { stage: stageId, environment: environmentOf(defs, stageId) });
    if (error) return setLocalError(error);
    if (places.length === 0) return setLocalError(t("variables.needTarget"));
    const metaError = validateMeta(meta);
    if (metaError) return setLocalError(metaError);
    const res = await create.run({
      id: f.id.trim(),
      name: f.name.trim(),
      stage: stageId,
      places,
      ...metaBody(meta),
      ...(f.product.trim() ? { product: f.product.trim() } : {}),
      ...(f.value !== "" ? { value: f.value } : {}),
      ...(ack ? { acknowledgedPublic: true } : {}),
      ...(fromBody(sources, src) ? { from: fromBody(sources, src) } : {}),
    });
    if (res) {
      toast.success(t("variables.created", { name: res.name }));
      onCreated();
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
      <MetaFields value={meta} onChange={setMeta} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label={t("variables.fieldId")} hint={t("variables.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" data-autofocus />
        <TextField label={t("variables.fieldName")} hint={t("variables.fieldNameHint")} required value={f.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoComplete="off" />
        <SelectField label={t("variables.stage")} value={stageId} onChange={(e) => set("stage", e.target.value)}>
          {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
        </SelectField>
        <TextField label={t("variables.fieldProduct")} value={f.product} onChange={(e) => set("product", e.target.value)} />
        <TextField label={t("variables.fieldValue")} value={f.value} onChange={(e) => set("value", e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      <PlacesEditor rows={rows} onChange={setRows} stage={stageId} />
      <SourceSection mode="create" sources={sources} value={src} onChange={setSrc} repo={rows.map((r) => r.repo.trim()).find(Boolean) ?? ""} stage={stageId} onUseValue={(val) => set("value", val)} />
      {localError ? <Notice tone="danger">{localError}</Notice> : null}
      <SecretGuard error={create.error} ack={ack} setAck={setAck} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("variables.cancel")}</Button>
        <Button type="submit" variant="primary" loading={create.pending}>{t("variables.create")}</Button>
      </div>
    </form>
  );
}

export function RemoveDialog({ v, onClose, onDone }: { v: VariableView; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const del = useMutation(async () => api<{ ok: boolean }>("DELETE", `variables/${enc(v.id)}`));
  return (
    <Dialog title={t("variables.removeTitle")} onClose={onClose}>
      <p className="text-sm">{t("variables.removeText", { name: v.name })}</p>
      {del.error ? <div className="mt-3"><Notice tone="danger">{del.error.message}</Notice></div> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose} data-autofocus>{t("variables.cancel")}</Button>
        <Button variant="danger" loading={del.pending} onClick={async () => { if (await del.run()) { toast.success(t("variables.removed")); onDone(); } }}>{t("variables.remove")}</Button>
      </div>
    </Dialog>
  );
}
