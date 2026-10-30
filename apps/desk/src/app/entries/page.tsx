"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VariableDrift } from "@secret-desk/core";
import type { SecretView, VariableApplyResult, VariableView } from "@secret-desk/runtime";
import { CompleteParamsDialog } from "@/components/CompleteParamsDialog";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { EditMetaDialog, TagPills, metaFrom } from "@/components/Meta";
import { ACTIONS_CELL_CLASS, ACTIONS_GROUP_CLASS, ActionMenu, FilterRow, LIST_CELL_CLASS, WIDE_CELL_CLASS, LIST_ROW_CLASS, ListTable, MenuItem, RowIconButton, SegmentSwitch, TagFilterChip } from "@/components/ListTable";
import { PageSearch } from "@/components/PageSearch";
import { Marked } from "@/components/Marked";
import { NewEntryDialog } from "@/components/NewEntryDialog";
import { NormalizeDialog, countApplicable, useNormalizationPlan } from "@/components/NormalizeDialog";
import { RemoveDialog, VariableDetail, type Auto } from "@/components/VariableDialogs";
import { SuggestSourcesDialog, useVariableSources } from "@/components/VariableSource";
import { BROWSE_DEFAULT, BrowseControls, GroupHeading, RepoFilter, type BrowseState } from "@/components/BrowseControls";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, Pill, ProviderChip, SelectField, StageBadge, StatusBadge } from "@/components/ui";
import { filterBySearch, highlightTerms } from "@/lib/page-search";
import { usePageSearch } from "@/lib/use-page-search";
import { allRepos, groupItems, repoNames, sortItems, type SortKey } from "@/lib/browse";
import { ApiError, api, enc } from "@/lib/api";
import { daysLabel, formatDate, placeText } from "@/lib/format";
import { truncate } from "@/lib/tags";
import { useQuery } from "@/lib/hooks";
import { summaryInfo } from "@/lib/status";
import { useToast } from "@/lib/toast";
import { useI18n, useT } from "@/lib/i18n";
import { countNeedingParams, needsParams } from "@/lib/params-list";
import { usePersistedState } from "@/lib/persisted-state";
import { useStageDefs } from "@/lib/use-stages";
import { readPrefill, withoutPrefill, type Prefill } from "@/lib/prefill";
import { labelOf, stageOrder } from "@/lib/stages";
import { countDrift, progressText, shortValue, summarizeDrift } from "@/lib/variable-list";
import { describeFrom } from "@/lib/variable-source";
import {
  SECRET_STATUSES, VARIABLE_STATUSES, activeKinds, counts, effectiveFilters, initialNewKind, narrowingFilters, needsComparison, parseKind, secretMatches, variableMatches,
  type EntryFilters, type EntryKind, type EntryRow, type FilterName, type KindFilter, type SecretRow, type VariableRow,
} from "@/lib/entries-list";

type Drifts = Record<string, VariableDrift[]>;

/** Secrets and variables in one list. The kind filter lives in the URL (?kind=secret|variable), like stage and status. */
export default function EntriesPage() {
  const t = useT();
  const toast = useToast();
  const defs = useStageDefs();
  const params = useSearchParams();
  const router = useRouter();
  const { locale } = useI18n();
  const { text: q, setText: setQ } = usePageSearch("/entries");
  const kind: KindFilter = parseKind(params.get("kind"));
  const stage = params.get("stage") ?? "";
  const status = params.get("status") ?? "";
  const tag = params.get("tag") ?? "";
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(next.toString() ? `/entries?${next}` : "/entries");
  };
  const setTag = (v: string) => setParam("tag", v);
  // Filters only one kind has stay in the browser session; the URL carries kind, stage, status, tag, repo and search.
  const [provider, setProvider] = usePersistedState("entries.provider", "");
  const [paramsFilter, setParamsFilter] = usePersistedState("entries.params", "");
  const [browse, setBrowse] = usePersistedState<BrowseState>("entries.browse", BROWSE_DEFAULT);
  // Link from the repositories page: /entries?repo=<name> sets the repository filter.
  const repoParam = params.get("repo") ?? "";
  useEffect(() => {
    if (repoParam) setBrowse((b) => (b.repo === repoParam ? b : { ...b, repo: repoParam }));
  }, [repoParam]);
  const [live, setLive] = useState(false);
  const [creating, setCreating] = useState<EntryKind | null>(null);
  const [completing, setCompleting] = useState(false);
  const [normalizing, setNormalizing] = useState(false);
  const normalization = useNormalizationPlan();
  const normalizeCount = countApplicable(normalization.data?.changes ?? []);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const { sources } = useVariableSources();
  const [removing, setRemoving] = useState<VariableView | null>(null);
  const [editing, setEditing] = useState<VariableView | null>(null);
  const [editingSecret, setEditingSecret] = useState<SecretView | null>(null);
  const [detail, setDetail] = useState<{ id: string; auto?: Auto } | null>(null);
  const [drifts, setDrifts] = useState<Drifts>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [comparing, setComparing] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);
  const [confirmAdoptAll, setConfirmAdoptAll] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // ?new=secret|variable|1 opens the dialog (1: kind from the kind filter), ?neu=1 is the old spelling.
  useEffect(() => {
    const flag = params.get("new") ?? (params.get("neu") === "1" ? "1" : null);
    if (flag === "1" || flag === "secret" || flag === "variable") {
      setPrefill(readPrefill(params));
      setCreating(initialNewKind(flag, kind));
      const next = withoutPrefill(params);
      router.replace(next.toString() ? `/entries?${next}` : "/entries");
    }
  }, [params, router]);

  const qs = new URLSearchParams();
  if (stage) qs.set("stage", stage);
  if (tag) qs.set("tag", tag);
  const secretQs = new URLSearchParams(qs);
  if (live) secretQs.set("live", "1");
  const secrets = useQuery<SecretView[]>(`secrets?${secretQs}`, () => api<SecretView[]>("GET", `secrets?${secretQs}`));
  const variables = useQuery<VariableView[]>(`variables?${qs}`, () => api<VariableView[]>("GET", `variables?${qs}`));

  const filters: EntryFilters = { kind, status, provider, params: paramsFilter };
  const eff = effectiveFilters(filters);
  const kindsOn = activeKinds({ ...eff, kind: "" });
  const terms = useMemo(() => highlightTerms(q), [q]);
  const inRepo = (places: { repo: string }[]) => browse.repo === "" || repoNames(places as VariableView["places"]).includes(browse.repo);
  const secretsSearched = useMemo(() => filterBySearch(secrets.data ?? [], q).filter((s) => inRepo(s.places)), [secrets.data, q, browse.repo]);
  const variablesSearched = useMemo(() => filterBySearch(variables.data ?? [], q).filter((v) => inRepo(v.places)), [variables.data, q, browse.repo]);
  const secretsMatch = useMemo(() => (kindsOn.includes("secret") ? secretsSearched.filter((s) => secretMatches(s, eff)) : []), [secretsSearched, kindsOn.join(), eff.status, eff.provider, eff.params]);
  const variablesMatch = useMemo(() => (kindsOn.includes("variable") ? variablesSearched.filter((v) => variableMatches(v, eff, drifts)) : []), [variablesSearched, kindsOn.join(), eff.status, drifts]);
  const switchCounts = { all: secretsMatch.length + variablesMatch.length, secret: secretsMatch.length, variable: variablesMatch.length };

  const rows: EntryRow[] = useMemo(() => {
    const sec: SecretRow[] = kind === "variable" ? [] : secretsMatch.map((s) => ({ ...s, entryKind: "secret" as const }));
    const vars: VariableRow[] = kind === "secret" ? [] : variablesMatch.map((v) => ({ ...v, entryKind: "variable" as const }));
    return sortItems<EntryRow>([...sec, ...vars], browse.sort, stageOrder(defs));
  }, [secretsMatch, variablesMatch, kind, browse.sort, defs]);
  const groups = useMemo(() => (rows.length ? groupItems(rows, browse.group, stageOrder(defs), (id) => labelOf(defs, id)) : []), [rows, browse.group, defs]);
  const shown = counts(rows);
  const varRows = rows.filter((r): r is VariableRow => r.entryKind === "variable");
  const repos = useMemo(() => allRepos([...(secrets.data ?? []), ...(variables.data ?? [])]), [secrets.data, variables.data]);
  const missingParams = useMemo(() => countNeedingParams(secrets.data ?? []), [secrets.data]);
  const showSecretFilters = kind !== "variable";

  // Variables whose comparison state the status filter needs but nobody has fetched yet.
  const uncompared = needsComparison(status) && kind !== "secret" && kindsOn.includes("variable") ? variablesSearched.filter((v) => !drifts[v.id]) : [];

  // Filters that do not exist for a kind: never applied silently, named in a notice.
  const filterLabel: Record<FilterName, string> = { status: t("entries.status"), provider: t("entries.provider"), params: t("params.list.filter") };
  const kindLabel = (k: EntryKind) => (k === "secret" ? t("entries.kindSecrets") : t("entries.kindVariables"));
  const narrowNotices = (["secret", "variable"] as const)
    .filter((k) => kind === "" || kind === k)
    .map((k) => ({ k, names: narrowingFilters(filters, k) }))
    .filter((n) => n.names.length > 0);

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

  /** One after the other so GitHub is not hit in parallel. Cancel stops before the next variable. */
  const compareIds = async (ids: string[]) => {
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

  /** Row action without a dialog: run at once, result as a message. Only the secret guard opens the detail. */
  const quick = async (v: VariableView, mode: Auto) => {
    setBusy((s) => new Set(s).add(v.id));
    try {
      if (mode === "adopt") {
        await api<VariableView>("POST", `variables/${enc(v.id)}/adopt`);
        toast.success(t("variables.adoptedOne", { name: v.name }));
        variables.reload();
      } else {
        const r = await api<VariableApplyResult>("POST", `variables/${enc(v.id)}/apply`, {});
        if (r.status === "pending-approval") toast.info(t("variables.approvalNeeded"));
        else if (r.outcomes.some((o) => o.outcome === "failed")) toast.error(t("variables.appliedFailed", { name: v.name }));
        else toast.success(t("variables.appliedOne", { name: v.name }));
      }
      await compareOne(v.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === "secret-blocked" || code === "secret-ack") setDetail({ id: v.id, auto: mode });
      else toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(v.id); return n; });
    }
  };

  /** All visible variables, one after the other: target value in the inventory = value in GitHub. */
  const adoptAll = async () => {
    setConfirmAdoptAll(false);
    const targets = varRows.slice();
    cancelRef.current = false;
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (cancelRef.current) break;
      try {
        await api<VariableView>("POST", `variables/${enc(targets[i]!.id)}/adopt`);
        ok++;
      } catch {
        failed++;
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    variables.reload();
    if (failed > 0) toast.error(t("variables.adoptAllDone", { ok, failed }));
    else toast.success(t("variables.adoptAllDoneOk", { ok }));
    for (const v of targets) if (!cancelRef.current) await compareOne(v.id);
  };

  const detailVar = detail ? (variables.data ?? []).find((v) => v.id === detail.id) : undefined;
  const running = progress !== null;
  const reloadAll = () => { secrets.reload(); variables.reload(); };
  const anyFilter = q.trim() || tag || stage || status || (showSecretFilters && (provider || paramsFilter)) || browse.repo;

  // Status options: shared words first; with "All" the kind-specific ones are marked, with one kind only that kind's states.
  const statusOptions = useMemo(() => {
    const secretLabel = (s: string) => t(`common.status.${s}`);
    const variableLabel = (s: string) => (s === "not-compared" ? t("variables.notCompared") : t(`common.drift.${s}`));
    const out: { id: string; label: string }[] = [];
    if (kind === "secret") out.push(...SECRET_STATUSES.map((s) => ({ id: s, label: secretLabel(s) })));
    else if (kind === "variable") out.push(...VARIABLE_STATUSES.map((s) => ({ id: s, label: variableLabel(s) })));
    else {
      out.push({ id: "ok", label: secretLabel("ok") }, { id: "missing", label: secretLabel("missing") });
      out.push(...SECRET_STATUSES.filter((s) => s !== "ok" && s !== "missing").map((s) => ({ id: s, label: `${secretLabel(s)} · ${t("entries.onlySecrets")}` })));
      out.push(...VARIABLE_STATUSES.filter((s) => s !== "missing" && s !== "in-sync").map((s) => ({ id: s, label: `${variableLabel(s)} · ${t("entries.onlyVariables")}` })));
    }
    if (status && !out.some((o) => o.id === status)) out.push({ id: status, label: status });
    return out;
  }, [kind, status, t]);

  const kindOptions: { id: KindFilter; label: string; count: number }[] = [
    { id: "", label: t("entries.kindAll"), count: switchCounts.all },
    { id: "secret", label: t("entries.kindSecrets"), count: switchCounts.secret },
    { id: "variable", label: t("entries.kindVariables"), count: switchCounts.variable },
  ];
  const loadingFirst = (secrets.loading && !secrets.data) || (variables.loading && !variables.data);
  const loaded = secrets.data && variables.data;
  const TABLE_COLUMN_CLASSES = ["", "max-xl:hidden", "max-xl:hidden", "max-xl:hidden", "max-xl:hidden", "max-sm:hidden", "w-px max-sm:hidden"];
  const tableColumns = [t("entries.colName"), t("entries.colKind"), t("entries.colStage"), t("entries.colValue"), t("entries.colTargets"), t("entries.colStatus"), t("entries.colActions")];

  return (
    <>
      <PageHeader
        title={t("entries.title")}
        subtitle={<>{t("entries.subtitle")}<span className="tabular mt-1 block font-medium text-ink" data-testid="entries-counts">{loaded ? t("entries.counts", { secrets: shown.secret, variables: shown.variable }) : ""}</span></>}
        actions={
          <>
            {running ? (
              <Button variant="secondary" onClick={() => { cancelRef.current = true; }}><Icon name="x" />{t("variables.stopCompare")} ({progressText(progress.done, progress.total)})</Button>
            ) : (
              <ActionMenu label={t("entries.moreActions")}>
                {kind !== "variable" ? <MenuItem icon="refresh" onClick={() => (live ? secrets.reload() : setLive(true))}>{t("entries.syncGithub")}</MenuItem> : null}
                {kind !== "variable" && missingParams > 0 ? <MenuItem icon="wrench" onClick={() => setCompleting(true)}>{t("params.list.complete")} ({missingParams})</MenuItem> : null}
                {kind !== "secret" ? (
                  <>
                    <MenuItem icon="refresh" disabled={varRows.length === 0} onClick={() => void compareIds(varRows.map((v) => v.id))}>{t("variables.compareAll")}</MenuItem>
                    <MenuItem icon="download" disabled={varRows.length === 0} onClick={() => setConfirmAdoptAll(true)}>{t("variables.adoptAll")}</MenuItem>
                    <MenuItem icon="link" disabled={!(variables.data ?? []).some((v) => v.from)} onClick={() => setSuggesting(true)}>{t("variables.src.suggestAll")}</MenuItem>
                  </>
                ) : null}
              </ActionMenu>
            )}
            <Button onClick={() => setNormalizing(true)} data-testid="normalize-open"><Icon name="wrench" />{t("normalize.button")}{normalizeCount > 0 ? <Pill>{normalizeCount}</Pill> : null}</Button>
            <Button variant="primary" onClick={() => setCreating(initialNewKind(null, kind))}><Icon name="plus" />{t("entries.new")}</Button>
          </>
        }
      />
      {live ? <div className="mb-4"><Notice tone="info">{t("secrets.liveNotice")}</Notice></div> : null}

      <PageSearch value={q} onChange={setQ} count={loaded ? rows.length : null} total={loaded ? (secrets.data!.length + variables.data!.length) : null} />
      <FilterRow>
        <SegmentSwitch label={t("entries.kind")} value={kind} options={kindOptions} onChange={(v) => setParam("kind", v)} />
        <RepoFilter value={browse} onChange={setBrowse} repos={repos} />
        <div className="w-40">
          <SelectField label={t("entries.stage")} value={stage} onChange={(e) => setParam("stage", e.target.value)}>
            <option value="">{t("entries.all")}</option>
            {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
          </SelectField>
        </div>
        <div className="w-56">
          <SelectField label={t("entries.status")} value={status} onChange={(e) => setParam("status", e.target.value)}>
            <option value="">{t("entries.all")}</option>
            {statusOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </SelectField>
        </div>
        {showSecretFilters ? (
          <>
            <div className="w-44">
              <SelectField label={kind === "" ? `${t("entries.provider")} · ${t("entries.onlySecrets")}` : t("entries.provider")} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">{t("entries.all")}</option>
                <option value="auto">{t("secrets.automatic")}</option>
                <option value="manual">{t("secrets.manual")}</option>
              </SelectField>
            </div>
            <div className="w-44">
              <SelectField label={kind === "" ? `${t("params.list.filter")} · ${t("entries.onlySecrets")}` : t("params.list.filter")} value={paramsFilter} onChange={(e) => setParamsFilter(e.target.value)}>
                <option value="">{t("params.list.filterAll")}</option>
                <option value="missing">{t("params.list.filterMissing")}</option>
              </SelectField>
            </div>
          </>
        ) : null}
        <BrowseControls value={browse} onChange={setBrowse} sorts={kind === "variable" ? ["name", "repo", "stage"] : ["name", "expires", "repo", "stage"]} />
      </FilterRow>

      <TagFilterChip tag={tag} label={t("secrets.filteredByTag")} removeLabel={t("secrets.removeFilter", { tag })} onClear={() => setTag("")} />
      {narrowNotices.map((n) => (
        <div key={n.k} className="mb-4"><Notice tone="warn">{t("entries.narrowed", { filters: n.names.map((x) => filterLabel[x]).join(", "), kind: kindLabel(n.k) })}</Notice></div>
      ))}
      {uncompared.length > 0 && !running ? (
        <div className="mb-4">
          <Notice tone="info">
            <span className="flex flex-wrap items-center gap-3">
              <span>{t("entries.uncompared", { count: uncompared.length })}</span>
              <Button variant="secondary" onClick={() => void compareIds(uncompared.map((v) => v.id))}><Icon name="refresh" />{t("entries.compareNow")}</Button>
            </span>
          </Notice>
        </div>
      ) : null}
      {secrets.error ? <ErrorState error={secrets.error} onRetry={secrets.reload} /> : null}
      {variables.error ? <ErrorState error={variables.error} onRetry={variables.reload} /> : null}
      {loadingFirst ? <ListSkeleton rows={6} /> : null}
      {loaded && rows.length === 0 ? (
        <EmptyState title={t("entries.emptyTitle")} icon="key">{anyFilter || kind ? t("entries.emptyFiltered") : t("entries.emptyFirst")}</EmptyState>
      ) : null}
      {groups.map((g) => (
        <div key={g.key}>
          {browse.group !== "none" ? <GroupHeading label={g.label} count={g.items.length} /> : null}
          <ListTable minWidth={0} columns={tableColumns} columnClasses={TABLE_COLUMN_CLASSES}>
            {g.items.map((e) => (e.entryKind === "secret" ? (
              <SecretRowView key={`${g.key}:secret:${e.id}`} s={e} terms={terms} tag={tag} setTag={setTag} onEdit={() => setEditingSecret(e)} />
            ) : (
              <VariableRowView
                key={`${g.key}:variable:${e.id}`}
                v={e}
                terms={terms}
                tag={tag}
                setTag={setTag}
                drift={drifts[e.id]}
                error={errors[e.id]}
                comparing={comparing.has(e.id)}
                busy={busy.has(e.id)}
                sourceText={e.from ? describeFrom(e.from, sources, locale) : null}
                onOpen={() => setDetail({ id: e.id })}
                onCompare={() => void compareOne(e.id)}
                onQuick={(mode) => void quick(e, mode)}
                onEdit={() => setEditing(e)}
                onRemove={() => setRemoving(e)}
              />
            )))}
          </ListTable>
        </div>
      ))}

      {detailVar && detail ? (
        <VariableDetail
          key={detail.id + (detail.auto ?? "")}
          v={detailVar}
          sources={sources}
          drift={drifts[detailVar.id]}
          comparing={comparing.has(detailVar.id)}
          compareError={errors[detailVar.id]}
          auto={detail.auto}
          onCompare={() => compareOne(detailVar.id)}
          onChanged={variables.reload}
          onEdit={() => { setDetail(null); setEditing(detailVar); }}
          onRemove={() => { setDetail(null); setRemoving(detailVar); }}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {confirmAdoptAll ? (
        <Dialog title={t("variables.adoptAllTitle")} description={t("variables.adoptAllText", { count: varRows.length })} onClose={() => setConfirmAdoptAll(false)}>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmAdoptAll(false)} data-autofocus>{t("variables.cancel")}</Button>
            <Button variant="primary" onClick={() => void adoptAll()}><Icon name="download" />{t("variables.adoptAllConfirm", { count: varRows.length })}</Button>
          </div>
        </Dialog>
      ) : null}
      {suggesting ? <SuggestSourcesDialog names={Object.fromEntries((variables.data ?? []).map((v) => [v.id, v.name]))} onClose={() => setSuggesting(false)} onChanged={variables.reload} /> : null}
      {editing ? <EditMetaDialog path={`variables/${enc(editing.id)}`} initial={metaFrom(editing)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); variables.reload(); }} /> : null}
      {editingSecret ? <EditMetaDialog path={`secrets/${enc(editingSecret.id)}`} initial={metaFrom(editingSecret)} notes={editingSecret.notes} onClose={() => setEditingSecret(null)} onSaved={() => { setEditingSecret(null); secrets.reload(); }} /> : null}
      {removing ? <RemoveDialog v={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); variables.reload(); }} /> : null}
      {normalizing ? <NormalizeDialog onClose={() => setNormalizing(false)} onChanged={() => { secrets.reload(); variables.reload(); normalization.reload(); }} onCompleteParams={() => { setNormalizing(false); setCompleting(true); }} /> : null}
      {completing ? <CompleteParamsDialog secrets={secrets.data ?? []} onClose={() => setCompleting(false)} onChanged={secrets.reload} /> : null}
      {creating ? <NewEntryDialog initialKind={creating} sources={sources} prefill={prefill} onClose={() => { setCreating(null); setPrefill(null); }} onCreated={() => { setCreating(null); setPrefill(null); reloadAll(); }} /> : null}
    </>
  );
}

function KindBadge({ kind }: { kind: EntryKind }) {
  const t = useT();
  return <Badge info={kind === "secret" ? { label: t("entries.kindSecret"), tone: "primary", icon: "key" } : { label: t("entries.kindVariable"), tone: "info", icon: "dot" }} />;
}

function Targets({ places }: { places: SecretView["places"] }) {
  return <div className="flex min-w-0 flex-wrap gap-1 [&>span]:max-w-full [&>span]:break-words [&>span]:whitespace-normal">{places.length ? places.map((p, i) => <Pill key={i}>{placeText(p)}</Pill>) : <span className="text-muted-text">–</span>}</div>;
}

function SecretRowView({ s, terms, tag, setTag, onEdit }: { s: SecretRow; terms: string[]; tag: string; setTag: (v: string) => void; onEdit: () => void }) {
  const t = useT();
  const router = useRouter();
  const actions = (
    <div className={ACTIONS_GROUP_CLASS}>
      <RowIconButton label={t("variables.edit")} icon="wrench" onClick={onEdit} />
      <RowIconButton label={t("entries.openSecret", { name: s.name })} icon="chevron" onClick={() => router.push(`/secrets/${enc(s.id)}`)} />
    </div>
  );
  const status = (
    <>
      <div className="flex flex-wrap items-center gap-1.5"><StatusBadge level={s.status} /><ProviderChip automatic={s.automatic} browser={s.browser} /></div>
      <p className="mt-1 text-xs text-muted-text">{s.verifiedAt ? <>{t("entries.confirmed")} <span className="tabular">{formatDate(s.verifiedAt)}</span>{s.verifiedBy ? ` · ${s.verifiedBy}` : ""}</> : `${t("entries.confirmed")}: ${t("secrets.never")}`}</p>
    </>
  );
  return (
    <tr className={LIST_ROW_CLASS} data-kind="secret">
      <td className={LIST_CELL_CLASS}>
        <Link href={`/secrets/${enc(s.id)}`} className="break-words font-medium text-primary hover:underline"><Marked text={s.name} terms={terms} /></Link>
        <p className="break-all text-xs text-muted"><Marked text={s.id} terms={terms} /></p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 xl:hidden"><KindBadge kind="secret" /><StageBadge stage={s.stage} /><span className="tabular text-xs text-muted-text">{formatDate(s.expires)} · {daysLabel(s.daysLeft)}</span></div>
        {s.description ? <p className="mt-1 line-clamp-2 max-w-[16rem] break-words text-xs text-muted-text" title={s.description}>{truncate(s.description, 90)}</p> : null}
        {s.tags.length > 0 ? <div className="mt-1"><TagPills tags={s.tags} onPick={setTag} active={tag} /></div> : null}
        {needsParams(s) ? (
          <div className="mt-1" title={s.params.missing.join(", ")}>
            <Badge info={{ label: s.params.status === "invalid" && s.params.missing.length === 0 ? t("params.list.badgeInvalid") : t("params.list.badge"), tone: "warn", icon: "alert" }} />
          </div>
        ) : null}
        <div className="mt-1 xl:hidden"><Targets places={s.places} /></div>
        <div className="mt-2 sm:hidden">{status}</div>
        <div className="mt-2 sm:hidden">{actions}</div>
      </td>
      <td className={WIDE_CELL_CLASS}><KindBadge kind="secret" /></td>
      <td className={WIDE_CELL_CLASS}><StageBadge stage={s.stage} /></td>
      <td className={WIDE_CELL_CLASS}>
        <div className="tabular">{formatDate(s.expires)}</div>
        <div className="tabular text-xs text-muted-text">{daysLabel(s.daysLeft)}</div>
      </td>
      <td className={WIDE_CELL_CLASS}><Targets places={s.places} /></td>
      <td className={`${LIST_CELL_CLASS} max-sm:hidden`}>{status}</td>
      <td className={ACTIONS_CELL_CLASS}>{actions}</td>
    </tr>
  );
}

function VariableRowView({ v, terms, tag, setTag, drift, error, comparing, busy, sourceText, onOpen, onCompare, onQuick, onEdit, onRemove }: {
  v: VariableRow;
  terms: string[];
  tag: string;
  setTag: (v: string) => void;
  drift: VariableDrift[] | undefined;
  error: string | undefined;
  comparing: boolean;
  busy: boolean;
  sourceText: string | null;
  onOpen: () => void;
  onCompare: () => void;
  onQuick: (mode: Auto) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const sum = summarizeDrift(drift);
  const c = countDrift(drift);
  const actions = (
    <div className={ACTIONS_GROUP_CLASS} onClick={(e) => e.stopPropagation()}>
      <RowIconButton label={t("variables.compare")} icon="refresh" loading={comparing} onClick={onCompare} />
      <RowIconButton label={t("variables.apply")} icon="upload" disabled={v.value === null} loading={busy} onClick={() => onQuick("apply")} />
      <RowIconButton label={t("variables.adopt")} icon="download" loading={busy} onClick={() => onQuick("adopt")} />
      <RowIconButton label={t("variables.edit")} icon="wrench" onClick={onEdit} />
      <RowIconButton label={t("variables.remove")} icon="trash" danger onClick={onRemove} />
    </div>
  );
  const status = (
    <div className="flex flex-wrap items-center gap-2">
      <span title={drift ? t("variables.summaryCount", { ok: c["in-sync"] ?? 0, total: drift.length }) : undefined}><Badge info={summaryInfo(sum)} /></span>
      {error ? <span className="text-xs text-danger-text" title={error}>{t("variables.compareError")}</span> : null}
    </div>
  );
  const value = v.value === null ? <span className="text-xs text-muted">{t("variables.unknownYet")}</span> : <span className="block max-w-[8rem] truncate font-mono text-xs" title={v.value}>{shortValue(v.value)}</span>;
  return (
    <tr className={`${LIST_ROW_CLASS} cursor-pointer`} data-kind="variable" onClick={onOpen}>
      <td className={LIST_CELL_CLASS}>
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} aria-label={t("variables.openDetails", { name: v.name })} className="break-words rounded text-left font-medium text-primary hover:underline"><Marked text={v.name} terms={terms} /></button>
        <p className="break-all text-xs text-muted"><Marked text={v.id} terms={terms} /></p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 xl:hidden"><KindBadge kind="variable" /><StageBadge stage={v.stage} />{value}</div>
        {v.description ? <p className="mt-1 line-clamp-2 max-w-[16rem] break-words text-xs text-muted-text" title={v.description}>{truncate(v.description, 90)}</p> : null}
        {v.tags.length > 0 ? <div className="mt-1" onClick={(e) => e.stopPropagation()}><TagPills tags={v.tags} onPick={setTag} active={tag} /></div> : null}
        {sourceText ? <div className="mt-1"><Pill>{t("variables.src.badge", { source: sourceText })}</Pill></div> : null}
        <div className="mt-1 xl:hidden"><Targets places={v.places} /></div>
        <div className="mt-2 sm:hidden">{status}</div>
        <div className="mt-2 sm:hidden" onClick={(e) => e.stopPropagation()}>{actions}</div>
      </td>
      <td className={WIDE_CELL_CLASS}><KindBadge kind="variable" /></td>
      <td className={WIDE_CELL_CLASS}><StageBadge stage={v.stage} /></td>
      <td className={WIDE_CELL_CLASS}>{value}</td>
      <td className={WIDE_CELL_CLASS}><Targets places={v.places} /></td>
      <td className={`${LIST_CELL_CLASS} max-sm:hidden`}>{status}</td>
      <td className={ACTIONS_CELL_CLASS} onClick={(e) => e.stopPropagation()}>{actions}</td>
    </tr>
  );
}
