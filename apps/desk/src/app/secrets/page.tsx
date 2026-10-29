"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { EntryPreflight } from "@secret-desk/core";
import type { SecretView } from "@secret-desk/runtime";
import { CompleteParamsDialog } from "@/components/CompleteParamsDialog";
import { ParamsForm } from "@/components/ParamsForm";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { MetaFields, TagPills, metaBody, validateMeta, type MetaValues } from "@/components/Meta";
import { FilterRow, LIST_CELL_CLASS, LIST_ROW_CLASS, ListTable, TagFilterChip } from "@/components/ListTable";
import { PageSearch } from "@/components/PageSearch";
import { filterBySearch } from "@/lib/page-search";
import { usePageSearch } from "@/lib/use-page-search";
import { PlacesEditor } from "@/components/PlacesEditor";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { allRepos, groupItems, repoNames, sortItems } from "@/lib/browse";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton, Notice, Pill, PageHeader, ProviderChip, SelectField, StageBadge, StatusBadge, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate, placeText } from "@/lib/format";
import { truncate } from "@/lib/tags";
import { useMutation, useQuery } from "@/lib/hooks";
import { emptyPlaceRow, rowsToPlaces, type PlaceRow } from "@/lib/places";
import { statusInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useI18n, useT } from "@/lib/i18n";
import { countNeedingParams, filterByParams, needsParams } from "@/lib/params-list";
import { canSave, findingsText, issueMessages, missingKeys, preflightTone, problemMessages, problemsFromError, toParams, validateDraft, type Draft } from "@/lib/params-form";
import { useDraftParams } from "@/lib/use-params";
import { usePersistedState } from "@/lib/persisted-state";
import { useStageDefs } from "@/lib/use-stages";
import { prefillRow, readPrefill, withoutPrefill, type Prefill } from "@/lib/prefill";
import { defaultStageId, environmentOf, kindOf, labelOf, stageOrder } from "@/lib/stages";

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  browser?: boolean;
}

const STATUSES = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;

export default function SecretsPage() {
  const t = useT();
  const defs = useStageDefs();
  const params = useSearchParams();
  const router = useRouter();
  const { text: q, setText: setQ } = usePageSearch("/secrets");
  const tag = params.get("tag") ?? "";
  const setTag = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set("tag", v);
    else next.delete("tag");
    router.replace(next.toString() ? `/secrets?${next}` : "/secrets");
  };
  // Filter bleiben beim Wechsel in einen Eintrag und zurueck erhalten (Browser-Sitzung).
  const [stage, setStage] = usePersistedState("secrets.stage", "");
  const [status, setStatus] = usePersistedState("secrets.status", "");
  const [kind, setKind] = usePersistedState("secrets.kind", "");
  const [paramsFilter, setParamsFilter] = usePersistedState("secrets.params", "");
  const [browse, setBrowse] = usePersistedState<BrowseState>("secrets.browse", BROWSE_DEFAULT);
  // Link von der Repositories-Seite: /secrets?repo=<name> setzt den Repository-Filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
  const [live, setLive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  useEffect(() => {
    if (params.get("new") === "1" || params.get("neu") === "1") {
      setPrefill(readPrefill(params));
      setCreating(true);
      const next = withoutPrefill(params);
      router.replace(next.toString() ? `/secrets?${next}` : "/secrets");
    }
  }, [params, router]);

  const qs = new URLSearchParams();
  if (stage) qs.set("stage", stage);
  if (status) qs.set("status", status);
  if (live) qs.set("live", "1");
  if (tag) qs.set("tag", tag);
  const secrets = useQuery<SecretView[]>(`secrets?${qs}`, () => api<SecretView[]>("GET", `secrets?${qs}`));

  const repos = useMemo(() => allRepos(secrets.data ?? []), [secrets.data]);
  const searched = useMemo(() => filterBySearch(secrets.data ?? [], q), [secrets.data, q]);
  const rows = useMemo(
    () => sortItems(filterByParams(searched.filter((s) => (kind === "" || (kind === "auto" ? s.automatic : !s.automatic)) && (browse.repo === "" || repoNames(s.places).includes(browse.repo))), paramsFilter), browse.sort, stageOrder(defs)),
    [searched, kind, paramsFilter, browse.repo, browse.sort, defs],
  );
  const missingParams = useMemo(() => countNeedingParams(secrets.data ?? []), [secrets.data]);
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group, stageOrder(defs), (id) => labelOf(defs, id)) : []), [rows, browse.group, defs]);

  return (
    <>
      <PageHeader
        title={t("secrets.title")}
        subtitle={t("secrets.subtitle")}
        actions={
          <>
            <Button variant="secondary" loading={secrets.loading && live} onClick={() => (live ? secrets.reload() : setLive(true))}>
              <Icon name="refresh" />{t("secrets.syncGithub")}
            </Button>
            {missingParams > 0 ? <Button variant="secondary" onClick={() => setCompleting(true)}><Icon name="wrench" />{t("params.list.complete")} ({missingParams})</Button> : null}
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" />{t("secrets.newEntry")}</Button>
          </>
        }
      />
      {live ? <div className="mb-4"><Notice tone="info">{t("secrets.liveNotice")}</Notice></div> : null}

      <PageSearch value={q} onChange={setQ} count={secrets.data ? rows.length : null} total={secrets.data ? secrets.data.length : null} />
      <FilterRow>
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("secrets.stage")} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectField>
        </div>
        <div className="w-48">
          <SelectField label={t("secrets.status")} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusInfo(s).label}</option>)}
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField label={t("secrets.provider")} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t("secrets.all")}</option>
            <option value="auto">{t("secrets.automatic")}</option>
            <option value="manual">{t("secrets.manual")}</option>
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField label={t("params.list.filter")} value={paramsFilter} onChange={(e) => setParamsFilter(e.target.value)}>
            <option value="">{t("params.list.filterAll")}</option>
            <option value="missing">{t("params.list.filterMissing")}</option>
          </SelectField>
        </div>
        <BrowseControls value={browse} onChange={setBrowse} />
      </FilterRow>

      <TagFilterChip tag={tag} label={t("secrets.filteredByTag")} removeLabel={t("secrets.removeFilter", { tag })} onClear={() => setTag("")} />
      {secrets.error ? <ErrorState error={secrets.error} onRetry={secrets.reload} /> : null}
      {secrets.loading && !secrets.data ? <ListSkeleton rows={6} /> : null}
      {secrets.data && rows.length === 0 ? (
        <EmptyState title={t("secrets.emptyTitle")} icon="key">{q.trim() || tag || stage || status || kind || paramsFilter || browse.repo ? t("secrets.emptyFiltered") : t("secrets.emptyFirst")}</EmptyState>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <ListTable columns={[t("secrets.colName"), t("secrets.colStage"), t("secrets.colProvider"), t("secrets.colExpiry"), t("secrets.colTargets"), t("secrets.colConfirmed")]}>
                {g.items.map((s) => (
                  <tr key={s.id} className={LIST_ROW_CLASS}>
                    <td className={LIST_CELL_CLASS}>
                      <Link href={`/secrets/${enc(s.id)}`} className="font-medium text-primary hover:underline">{s.name}</Link>
                      <p className="text-xs text-muted">{s.id}</p>
                      {s.description ? <p className="mt-1 max-w-xs truncate text-xs text-muted-text" title={s.description}>{truncate(s.description, 90)}</p> : null}
                      {s.tags.length > 0 ? <div className="mt-1"><TagPills tags={s.tags} onPick={setTag} active={tag} /></div> : null}
                      {needsParams(s) ? (
                        <div className="mt-1" title={s.params.missing.join(", ")}>
                          <Badge info={{ label: s.params.status === "invalid" && s.params.missing.length === 0 ? t("params.list.badgeInvalid") : t("params.list.badge"), tone: "warn", icon: "alert" }} />
                        </div>
                      ) : null}
                    </td>
                    <td className={LIST_CELL_CLASS}><StageBadge stage={s.stage} /></td>
                    <td className={LIST_CELL_CLASS}><ProviderChip automatic={s.automatic} browser={s.browser} /></td>
                    <td className={LIST_CELL_CLASS}>
                      <div className="tabular">{formatDate(s.expires)}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge level={s.status} /><span className="tabular text-xs text-muted-text">{daysLabel(s.daysLeft)}</span></div>
                    </td>
                    <td className={LIST_CELL_CLASS}>
                      <div className="flex flex-wrap gap-1">{s.places.length ? s.places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>
                    </td>
                    <td className={`${LIST_CELL_CLASS} text-xs text-muted-text`}>{s.verifiedAt ? <><span className="tabular">{formatDate(s.verifiedAt)}</span><br />{s.verifiedBy ?? ""}</> : t("secrets.never")}</td>
                  </tr>
                ))}
          </ListTable>
        </div>
      ))}

      {completing ? <CompleteParamsDialog secrets={secrets.data ?? []} onClose={() => setCompleting(false)} onChanged={secrets.reload} /> : null}
      {creating ? <CreateSecretDialog initial={prefill} onClose={() => { setCreating(false); setPrefill(null); }} onCreated={() => { setCreating(false); setPrefill(null); secrets.reload(); }} /> : null}
    </>
  );
}

function CreateSecretDialog({ initial = null, onClose, onCreated }: { initial?: Prefill | null; onClose: () => void; onCreated: () => void }) {
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
    <Dialog title={t("secrets.dialogTitle")} description={t("secrets.dialogDesc")} onClose={onClose} wide>
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
    </Dialog>
  );
}
