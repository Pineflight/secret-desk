"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VariableDrift } from "@secret-desk/core";
import type { VariableApplyResult, VariableView } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { EditMetaDialog, ExternalLink, MetaFields, TagPills, metaBody, metaFrom, validateMeta, type MetaValues } from "@/components/Meta";
import { FilterRow, LIST_CELL_CLASS, LIST_ROW_CLASS, ListTable, RowIconButton, TagFilterChip } from "@/components/ListTable";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Badge, Button, Checkbox, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, Pill, SelectField, StageBadge, TextField, inputClass } from "@/components/ui";
import { ApiError, api, enc } from "@/lib/api";
import { placeText } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { classifyVariableError, driftInfo, summaryInfo, type DriftState } from "@/lib/status";
import { DRIFT_FILTERS, anyCompared, countDrift, filterByDrift, progressText, shortValue, summarizeDrift } from "@/lib/variable-list";
import { truncate } from "@/lib/tags";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { useStageDefs } from "@/lib/use-stages";
import { defaultStageId, environmentOf, labelOf, stageOrder } from "@/lib/stages";

/** Zeigt die Sperre oder die Bestätigungsfrage, je nach Meldung des Servers. */
function SecretGuard({ error, ack, setAck }: { error: Error | null; ack: boolean; setAck: (v: boolean) => void }) {
  const t = useT();
  if (!error) return null;
  const kind = classifyVariableError(error as { code?: string });
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

type Drifts = Record<string, VariableDrift[]>;
type Auto = "apply" | "adopt";

export default function VariablesPage() {
  const t = useT();
  const toast = useToast();
  const defs = useStageDefs();
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
  const [status, setStatus] = useState("");
  const [browse, setBrowse] = useState<BrowseState>(BROWSE_DEFAULT);
  // Link von der Repositories-Seite: /variablen?repo=<name> setzt den Repository-Filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<VariableView | null>(null);
  const [editing, setEditing] = useState<VariableView | null>(null);
  const [detail, setDetail] = useState<{ id: string; auto?: Auto } | null>(null);
  const [drifts, setDrifts] = useState<Drifts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [comparing, setComparing] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);

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
  const known = anyCompared(drifts, (list.data ?? []).map((v) => v.id));
  const rows = useMemo(
    () => sortItems(filterByDrift((list.data ?? []).filter((v) => browse.repo === "" || repoNames(v.places).includes(browse.repo)), drifts, status), browse.sort, stageOrder(defs)),
    [list.data, browse.repo, browse.sort, defs, drifts, status],
  );
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group, stageOrder(defs), (id) => labelOf(defs, id)) : []), [rows, browse.group, defs]);

  const compareOne = async (id: string): Promise<boolean> => {
    setComparing((s) => new Set(s).add(id));
    try {
      const r = await api<{ drift: VariableDrift[] }>("GET", `variables/${enc(id)}/status`);
      setDrifts((d) => ({ ...d, [id]: r.drift }));
      setErrors((e) => { const { [id]: _drop, ...rest } = e; return rest; });
      return true;
    } catch (e) {
      setErrors((o) => ({ ...o, [id]: e instanceof Error ? e.message : String(e) }));
      return false;
    } finally {
      setComparing((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  /** Seriell, damit GitHub nicht parallel belastet wird. Abbrechen stoppt vor der naechsten Variable. */
  const compareAll = async () => {
    const ids = rows.map((v) => v.id);
    cancelRef.current = false;
    setProgress({ done: 0, total: ids.length });
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      if (cancelRef.current) break;
      if (!(await compareOne(ids[i]!))) failed++;
      setProgress({ done: i + 1, total: ids.length });
    }
    setProgress(null);
    if (failed > 0) toast.error(t("variables.compareAllFailed", { count: failed }));
  };

  const detailVar = detail ? (list.data ?? []).find((v) => v.id === detail.id) : undefined;
  const running = progress !== null;

  return (
    <>
      <PageHeader
        title={t("variables.title")}
        subtitle={t("variables.subtitle")}
        actions={
          <>
            {running ? (
              <Button variant="secondary" onClick={() => { cancelRef.current = true; }}><Icon name="x" />{t("variables.stopCompare")} ({progressText(progress.done, progress.total)})</Button>
            ) : (
              <Button variant="secondary" disabled={rows.length === 0} onClick={() => void compareAll()}><Icon name="refresh" />{t("variables.compareAll")}</Button>
            )}
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" />{t("variables.newVariable")}</Button>
          </>
        }
      />
      <FilterRow>
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("variables.stage")} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t("variables.all")}</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectField>
        </div>
        {known || status ? (
          <div className="w-48">
            <SelectField label={t("variables.compareStatus")} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("variables.all")}</option>
              {DRIFT_FILTERS.map((s) => <option key={s} value={s}>{summaryInfo(s).label}</option>)}
            </SelectField>
          </div>
        ) : null}
        <BrowseControls value={browse} onChange={setBrowse} sorts={["name", "repo", "stage"]} />
      </FilterRow>
      <TagFilterChip tag={tag} label={t("variables.filteredByTag")} removeLabel={t("variables.removeFilter", { tag })} onClear={() => setTag("")} />
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <ListSkeleton rows={6} /> : null}
      {list.data && rows.length === 0 ? <EmptyState title={t("variables.emptyTitle")} icon="sliders">{q || tag || stage || status || browse.repo ? t("variables.emptyFiltered") : t("variables.emptyFirst")}</EmptyState> : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <ListTable columns={[t("variables.colName"), t("variables.colStage"), t("variables.colExpected"), t("variables.colTargets"), t("variables.colCompare"), t("variables.colActions")]}>
            {g.items.map((v) => {
              const d = drifts[v.id];
              const sum = summarizeDrift(d);
              const counts = countDrift(d);
              return (
                <tr key={`${g.key}:${v.id}`} className={`${LIST_ROW_CLASS} cursor-pointer`} onClick={() => setDetail({ id: v.id })}>
                  <td className={LIST_CELL_CLASS}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setDetail({ id: v.id }); }} aria-label={t("variables.openDetails", { name: v.name })} className="rounded font-medium text-primary hover:underline">{v.name}</button>
                    <p className="text-xs text-muted">{v.id}</p>
                    {v.description ? <p className="mt-1 max-w-xs truncate text-xs text-muted-text" title={v.description}>{truncate(v.description, 90)}</p> : null}
                    {v.tags.length > 0 ? <div className="mt-1" onClick={(e) => e.stopPropagation()}><TagPills tags={v.tags} onPick={setTag} active={tag} /></div> : null}
                  </td>
                  <td className={LIST_CELL_CLASS}><StageBadge stage={v.stage} /></td>
                  <td className={LIST_CELL_CLASS}>
                    {v.value === null ? <span className="text-xs text-muted">{t("variables.unknownYet")}</span> : <span className="block max-w-[14rem] truncate font-mono text-xs" title={v.value}>{shortValue(v.value)}</span>}
                  </td>
                  <td className={LIST_CELL_CLASS}>
                    <div className="flex flex-wrap gap-1">{v.places.length ? v.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>
                  </td>
                  <td className={LIST_CELL_CLASS}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span title={d ? t("variables.summaryCount", { ok: counts["in-sync"] ?? 0, total: d.length }) : undefined}><Badge info={summaryInfo(sum)} /></span>
                      {errors[v.id] ? <span className="text-xs text-danger-text" title={errors[v.id]}>{t("variables.compareError")}</span> : null}
                    </div>
                  </td>
                  <td className={LIST_CELL_CLASS} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5">
                      <RowIconButton label={t("variables.compare")} icon="refresh" loading={comparing.has(v.id)} onClick={() => void compareOne(v.id)} />
                      <RowIconButton label={t("variables.apply")} icon="upload" disabled={v.value === null} onClick={() => setDetail({ id: v.id, auto: "apply" })} />
                      <RowIconButton label={t("variables.adopt")} icon="download" onClick={() => setDetail({ id: v.id, auto: "adopt" })} />
                      <RowIconButton label={t("variables.edit")} icon="wrench" onClick={() => setEditing(v)} />
                      <RowIconButton label={t("variables.remove")} icon="trash" danger onClick={() => setRemoving(v)} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </ListTable>
        </div>
      ))}
      {detailVar && detail ? (
        <VariableDetail
          key={detail.id + (detail.auto ?? "")}
          v={detailVar}
          drift={drifts[detailVar.id]}
          comparing={comparing.has(detailVar.id)}
          compareError={errors[detailVar.id]}
          auto={detail.auto}
          onCompare={() => compareOne(detailVar.id)}
          onChanged={list.reload}
          onEdit={() => { setDetail(null); setEditing(detailVar); }}
          onRemove={() => { setDetail(null); setRemoving(detailVar); }}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {editing ? <EditMetaDialog path={`variables/${enc(editing.id)}`} initial={metaFrom(editing)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} /> : null}
      {creating ? <CreateVariableDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); list.reload(); }} /> : null}
      {removing ? <RemoveDialog v={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); list.reload(); }} /> : null}
    </>
  );
}

/** Detail einer Variable: Sollwert, Abgleich je Ziel, Setzen und Uebernehmen samt Geheimnis-Pruefung. */
function VariableDetail({ v, drift, comparing, compareError, auto, onCompare, onChanged, onEdit, onRemove, onClose }: {
  v: VariableView;
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
        {outcomes ? (
          <ul className="space-y-1 text-sm">
            {outcomes.map((o, i) => <li key={i} className={o.outcome === "failed" ? "text-danger-text" : "text-success-text"}>{o.place}: {o.outcome === "failed" ? `${t("variables.outcomeFailed")}${o.error ? ` (${o.error})` : ""}` : o.outcome === "created" ? t("variables.outcomeCreated") : t("variables.outcomeUpdated")}</li>)}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

function CreateVariableDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const defs = useStageDefs();
  const toast = useToast();
  const [f, setF] = useState({ id: "", name: "", stage: "", description: "", product: "", value: "" });
  const [rows, setRows] = useState<PlaceRow[]>([emptyPlaceRow()]);
  const [ack, setAck] = useState(false);
  const [meta, setMeta] = useState<MetaValues>({ description: "", owner: "", link: "", tags: [] });
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
          <SelectField label={t("variables.stage")} value={stageId} onChange={(e) => set("stage", e.target.value)}>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectField>
          <TextField label={t("variables.fieldProduct")} value={f.product} onChange={(e) => set("product", e.target.value)} />
          <TextField label={t("variables.fieldValue")} value={f.value} onChange={(e) => set("value", e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <PlacesEditor rows={rows} onChange={setRows} stage={stageId} />
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
