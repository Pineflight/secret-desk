"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { VariableDrift } from "@secret-desk/core";
import type { VariableApplyResult, VariableView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { EditMetaDialog, ExternalLink, MetaFields, TagPills, metaBody, metaFrom, validateMeta, type MetaValues } from "@/components/Meta";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, Pill, SelectField, StageBadge, TextField, inputClass } from "@/components/ui";
import { ApiError, api, enc } from "@/lib/api";
import { placeText } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { classifyVariableError, driftInfo, type DriftState } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";

/** Zeigt die Sperre oder die Bestätigungsfrage, je nach Meldung des Servers. */
function SecretGuard({ error, ack, setAck }: { error: Error | null; ack: boolean; setAck: (v: boolean) => void }) {
  const t = useT();
  if (!error) return null;
  const kind = classifyVariableError(error.message);
  if (kind === "secret") {
    return (
      <Notice tone="danger" title={t("variables.blockedTitle")}>
        {t("variables.blockedText")} <Link href="/secrets?neu=1" className="font-medium underline">{t("variables.toSecrets")}</Link>
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

export default function VariablesPage() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const setTag = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set("tag", v);
    else next.delete("tag");
    router.replace(next.toString() ? `/variablen?${next}` : "/variablen");
  };
  const [stage, setStage] = useState("");
  const [browse, setBrowse] = useState<BrowseState>(BROWSE_DEFAULT);
  // Link von der Repositories-Seite: /variablen?repo=<name> setzt den Repository-Filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<VariableView | null>(null);

  useEffect(() => {
    if (params.get("neu") === "1") {
      setCreating(true);
      const next = new URLSearchParams(params.toString());
      next.delete("neu");
      router.replace(next.toString() ? `/variablen?${next}` : "/variablen");
    }
  }, [params, router]);

  const qs = new URLSearchParams();
  if (stage) qs.set("stage", stage);
  if (q.trim()) qs.set("q", q.trim());
  if (tag) qs.set("tag", tag);
  const list = useQuery<VariableView[]>(`variables?${qs}`, () => api<VariableView[]>("GET", `variables?${qs}`));
  const repos = useMemo(() => allRepos(list.data ?? []), [list.data]);
  const rows = useMemo(
    () => sortItems((list.data ?? []).filter((v) => (browse.repo === "" || repoNames(v.places).includes(browse.repo))), browse.sort),
    [list.data, browse.repo, browse.sort],
  );
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group) : []), [rows, browse.group]);

  return (
    <>
      <PageHeader
        title={t("variables.title")}
        subtitle={t("variables.subtitle")}
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" />{t("variables.newVariable")}</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("variables.stage")} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t("variables.all")}</option>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
        </div>
        <BrowseControls value={browse} onChange={setBrowse} sorts={["name", "repo", "stage"]} />
      </div>
      {tag ? (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-muted-text">{t("variables.filteredByTag")}</span>
          <button type="button" onClick={() => setTag("")} aria-label={t("variables.removeFilter", { tag })} className="inline-flex items-center gap-1 rounded-full bg-primary-light px-2.5 py-0.5 text-xs font-medium text-primary">#{tag}<Icon name="x" className="h-3 w-3" /></button>
        </div>
      ) : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <ListSkeleton rows={5} /> : null}
      {list.data && rows.length === 0 ? <EmptyState title={t("variables.emptyTitle")} icon="sliders">{q || tag || stage || browse.repo ? t("variables.emptyFiltered") : t("variables.emptyFirst")}</EmptyState> : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <div className="space-y-4">
            {g.items.map((v) => <VariableCard key={`${g.key}:${v.id}`} v={v} tag={tag} onTag={setTag} onChanged={list.reload} onRemove={() => setRemoving(v)} />)}
          </div>
        </div>
      ))}
      {creating ? <CreateVariableDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); list.reload(); }} /> : null}
      {removing ? <RemoveDialog v={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); list.reload(); }} /> : null}
    </>
  );
}

function VariableCard({ v, tag, onTag, onChanged, onRemove }: { v: VariableView; tag: string; onTag: (t: string) => void; onChanged: () => void; onRemove: () => void }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState(v.value ?? "");
  const [ack, setAck] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drift, setDrift] = useState<VariableDrift[] | null>(null);
  const [outcomes, setOutcomes] = useState<{ place: string; outcome: string; error?: string }[] | null>(null);
  useEffect(() => setValue(v.value ?? ""), [v.value]);

  const compare = useMutation(async () => api<{ drift: VariableDrift[] }>("GET", `variables/${enc(v.id)}/status`));
  const save = useMutation(async () => api<VariableView>("PATCH", `variables/${enc(v.id)}`, { value, ...(ack ? { acknowledgedPublic: true } : {}) }));
  const apply = useMutation(async () => api<VariableApplyResult>("POST", `variables/${enc(v.id)}/apply`, ack ? { acknowledgedPublic: true } : {}));
  const adopt = useMutation(async () => api<VariableView>("POST", `variables/${enc(v.id)}/adopt`));

  const doCompare = async () => {
    const r = await compare.run();
    if (r) setDrift(r.drift);
  };
  const doSave = async () => {
    const r = await save.run();
    if (r) {
      toast.success(t("variables.saved"));
      setAck(false);
      onChanged();
      if (drift) void doCompare();
    }
  };
  const doApply = async () => {
    const r = await apply.run();
    if (!r) return;
    if (r.status === "pending-approval") toast.info(t("variables.approvalNeeded"));
    else {
      setOutcomes(r.outcomes);
      toast.success(t("variables.appliedToGithub"));
      void doCompare();
    }
  };
  const doAdopt = async () => {
    const r = await adopt.run();
    if (r) {
      toast.success(t("variables.adopted"));
      onChanged();
      void doCompare();
    }
  };

  const error = save.error ?? apply.error ?? adopt.error ?? compare.error;
  const dirty = value !== (v.value ?? "");

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{v.name}</p>
          <p className="text-xs text-muted">{v.id}{v.product ? ` · ${v.product}` : ""}</p>
          {v.description ? <p className="mt-1 text-sm text-muted-text">{v.description}</p> : <p className="mt-1 text-xs text-muted">{t("variables.noDescription")}</p>}
          {v.owner || v.link ? <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-text">{v.owner ? <span>{t("variables.owner", { name: v.owner })}</span> : null}{v.link ? <ExternalLink href={v.link} /> : null}</p> : null}
          {v.tags.length > 0 ? <div className="mt-2"><TagPills tags={v.tags} onPick={onTag} active={tag} /></div> : null}
        </div>
        <StageBadge stage={v.stage} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1">{v.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>)}</div>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor={`val-${v.id}`} className="mb-1 block text-sm font-medium">{t("variables.expected")}</label>
          <input id={`val-${v.id}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("variables.unknownYet")} className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} />
        </div>
        <Button variant="secondary" disabled={!dirty} loading={save.pending} onClick={() => void doSave()}>{t("variables.saveExpected")}</Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button loading={compare.pending} onClick={() => void doCompare()}><Icon name="refresh" />{t("variables.compare")}</Button>
        <Button loading={apply.pending} disabled={v.value === null} onClick={() => void doApply()}><Icon name="upload" />{t("variables.apply")}</Button>
        <Button loading={adopt.pending} onClick={() => void doAdopt()}><Icon name="download" />{t("variables.adopt")}</Button>
        <Button variant="ghost" onClick={() => setEditing(true)}><Icon name="wrench" />{t("variables.edit")}</Button>
        <Button variant="ghost" onClick={onRemove}><Icon name="trash" />{t("variables.remove")}</Button>
      </div>
      {error ? <div className="mt-3"><SecretGuard error={error instanceof ApiError || error instanceof Error ? error : null} ack={ack} setAck={setAck} /></div> : null}
      {drift ? (
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
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
      ) : null}
      {outcomes ? (
        <ul className="mt-3 space-y-1 text-sm">
          {outcomes.map((o, i) => <li key={i} className={o.outcome === "failed" ? "text-danger-text" : "text-success-text"}>{o.place}: {o.outcome === "failed" ? `${t("variables.outcomeFailed")}${o.error ? ` (${o.error})` : ""}` : o.outcome === "created" ? t("variables.outcomeCreated") : t("variables.outcomeUpdated")}</li>)}
        </ul>
      ) : null}
      {editing ? <EditMetaDialog path={`variables/${enc(v.id)}`} initial={metaFrom(v)} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} /> : null}
    </Card>
  );
}

function CreateVariableDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const toast = useToast();
  const [f, setF] = useState({ id: "", name: "", stage: "staging", description: "", product: "", value: "" });
  const [rows, setRows] = useState<PlaceRow[]>([emptyPlaceRow()]);
  const [ack, setAck] = useState(false);
  const [meta, setMeta] = useState<MetaValues>({ description: "", owner: "", link: "", tags: [] });
  const [localError, setLocalError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const create = useMutation(async (body: unknown) => api<VariableView>("POST", "variables", body));
  const submit = async () => {
    setLocalError(null);
    const { places, error } = rowsToPlaces(rows);
    if (error) return setLocalError(error);
    if (places.length === 0) return setLocalError(t("variables.needTarget"));
    const metaError = validateMeta(meta);
    if (metaError) return setLocalError(metaError);
    const res = await create.run({
      id: f.id.trim(),
      name: f.name.trim(),
      stage: f.stage,
      places,
      ...metaBody(meta),
      ...(f.product.trim() ? { product: f.product.trim() } : {}),
      ...(f.value !== "" ? { value: f.value } : {}),
      ...(ack ? { acknowledgedPublic: true } : {}),
    });
    if (res) {
      toast.success(t("variables.created", { name: res.name }));
      onCreated();
    }
  };
  return (
    <Dialog title={t("variables.newTitle")} description={t("variables.newDesc")} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <MetaFields value={meta} onChange={setMeta} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t("variables.fieldId")} hint={t("variables.fieldIdHint")} required value={f.id} onChange={(e) => set("id", e.target.value)} autoComplete="off" data-autofocus />
          <TextField label={t("variables.fieldName")} hint={t("variables.fieldNameHint")} required value={f.name} onChange={(e) => set("name", e.target.value.toUpperCase())} autoComplete="off" />
          <SelectField label={t("variables.stage")} value={f.stage} onChange={(e) => set("stage", e.target.value)}>
            {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectField>
          <TextField label={t("variables.fieldProduct")} value={f.product} onChange={(e) => set("product", e.target.value)} />
          <TextField label={t("variables.fieldValue")} value={f.value} onChange={(e) => set("value", e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <PlacesEditor rows={rows} onChange={setRows} />
        {localError ? <Notice tone="danger">{localError}</Notice> : null}
        <SecretGuard error={create.error} ack={ack} setAck={setAck} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("variables.cancel")}</Button>
          <Button type="submit" variant="primary" loading={create.pending}>{t("variables.create")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ v, onClose, onDone }: { v: VariableView; onClose: () => void; onDone: () => void }) {
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
