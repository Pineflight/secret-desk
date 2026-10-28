"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { CompareCell, CompareRepo, CompareResult, RepoNote } from "@secret-desk/core";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { RenameRepoDialog } from "@/components/RenameRepoDialog";
import { FilterRow, LIST_CELL_CLASS, LIST_ROW_CLASS, ListTable } from "@/components/ListTable";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, SectionLabel, SelectField, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import {
  COMPARE_FILTERS_DEFAULT,
  adoptCandidates,
  adoptLink,
  adoptRequest,
  cellLook,
  defaultCompared,
  effectiveCompared,
  filterRows,
  groupByRepo,
  missingOnGitHub,
  needFiles,
  repoList,
  reposWithoutEntries,
  sortRows,
  stageTotals,
  toMarkdown,
  viewRows,
  type AdoptCandidate,
  type CompareFilters,
  type ViewRow,
} from "@/lib/compare-view";
import { useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { usePersistedState } from "@/lib/persisted-state";
import { useToast } from "@/lib/toast";
import { useStageDefs } from "@/lib/use-stages";
import { stageOrder } from "@/lib/stages";

type T = ReturnType<typeof useT>;

/** Zelle als Badge (Icon + Kurztext, nie nur Farbe) oder als stiller Strich. */
function CellView({ cell, t }: { cell: CompareCell; t: T }) {
  const look = cellLook(cell.state);
  const long = t(`compare.stateLong.${cell.state}`);
  if (look.quiet) {
    return (
      <span title={long}>
        <span aria-hidden="true" className="text-muted-text">–</span>
        <span className="sr-only">{long}</span>
      </span>
    );
  }
  return <Badge info={{ label: t(`compare.state.${cell.state}`), tone: look.tone, icon: look.icon }} />;
}

/** Text eines Repository-Hinweises. */
function noteText(t: T, n: RepoNote): string {
  return t(`compare.note.${n.code}`, { file: n.file ?? "", target: n.target ?? "" });
}

/** Beschreibung fuer neue Eintraege: "Von deploy.yml benoetigt". */
const adoptDescription = (t: T, files: string[]): string => t("compare.adoptDescription", { files: files.join(", ") || "Workflow" });

function ParityBadge({ row, t, label }: { row: ViewRow; t: T; label: (id: string) => string }) {
  if (row.parity === "consistent") return <Badge info={{ label: t("compare.parityConsistent"), tone: "success", icon: "check" }} />;
  if (row.parity === "gap") return <Badge info={{ label: t("compare.parityGap", { stages: row.missingIn.map(label).join(", ") }), tone: "danger", icon: "alert" }} />;
  return <span className="text-xs text-muted-text" title={t("compare.parityNa")}>–</span>;
}

export default function ComparePage() {
  const t = useT();
  const toast = useToast();
  const defs = useStageDefs();
  const [filters, setFilters] = usePersistedState<CompareFilters>("compare.filters", COMPARE_FILTERS_DEFAULT);
  const [gapsFirst, setGapsFirst] = usePersistedState("compare.gapsFirst", true);
  const [normalize, setNormalize] = usePersistedState("compare.normalize", false);
  const [chosen, setChosen] = usePersistedState<string[]>("compare.stages", []);
  // Nie automatisch beim Oeffnen: GitHub wird erst nach ausdruecklicher Wahl gelesen.
  const [live, setLive] = useState(false);
  // Mit Live sind beide standardmaessig an; ohne Live gelten sie nicht (Workflows nur aus lokalen Ordnern, Repositories gar nicht).
  const [allRepos, setAllRepos] = useState(true);
  const [workflows, setWorkflows] = useState(true);
  const [adoptAll, setAdoptAll] = useState(false);
  const [renaming, setRenaming] = useState<CompareRepo | null>(null);
  const [detail, setDetail] = useState<{ row: ViewRow; stage: string } | null>(null);
  const set = <K extends keyof CompareFilters>(k: K, v: CompareFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const qs = new URLSearchParams();
  if (live) qs.set("live", "1");
  if (live && allRepos) qs.set("all", "1");
  if (live && workflows) qs.set("workflows", "1");
  if (normalize) qs.set("normalize", "1");
  const key = `compare?${qs}`;
  const result = useQuery<CompareResult>(key, () => api<CompareResult>("GET", key));

  const data = result.data;
  const stages = data?.stages ?? defs.map((d) => ({ id: d.id, kind: d.kind, label: d.label ?? d.id }));
  const order = useMemo(() => stageOrder(stages), [stages]);
  const orderedStages = order.map((id) => stages.find((s) => s.id === id)!).filter(Boolean);
  const labelOf = (id: string): string => stages.find((s) => s.id === id)?.label ?? id;
  const compared = effectiveCompared(stages, chosen);

  const all = useMemo(() => (data ? viewRows(data, compared) : []), [data, compared.join(",")]);
  const repos = useMemo(() => repoList(all, data?.repos ?? []), [all, data]);
  const emptyRepos = useMemo(() => reposWithoutEntries(data?.repos ?? [], filters), [data, filters.repo, filters.q]);
  const goneRepos = useMemo(() => missingOnGitHub(data?.repos ?? []), [data]);
  const repoNotes = useMemo(() => (data?.repos ?? []).filter((r) => r.notes.length > 0 && (!filters.repo || r.name === filters.repo)), [data, filters.repo]);
  const visible = useMemo(() => sortRows(filterRows(all, filters), gapsFirst), [all, filters, gapsFirst]);
  const groups = useMemo(() => groupByRepo(visible), [visible]);
  const candidates = useMemo(() => adoptCandidates(visible), [visible]);
  const neededRows = visible.filter((r) => r.neededMissing).length;
  const effectiveWorkflows = live ? workflows : false;
  const totals = useMemo(() => stageTotals(filterRows(all, { ...filters, onlyDeviations: false }), order), [all, filters, order.join(",")]);
  const gapCount = visible.filter((r) => r.parity === "gap").length;
  const orphanCount = visible.filter((r) => r.ids.length === 0).length;

  const toggleStage = (id: string) => {
    const base = chosen.length > 0 ? effectiveCompared(stages, chosen) : defaultCompared(stages);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    setChosen(order.filter((x) => next.includes(x)));
  };

  const copy = async () => {
    if (!visible.some((r) => r.deviation)) return toast.info(t("compare.nothingToCopy"));
    const text = toMarkdown(visible, order, {
      repo: t("compare.colRepo"),
      name: t("compare.colName"),
      kind: t("compare.kind"),
      parity: t("compare.colParity"),
      cell: (c) => (cellLook(c.state).quiet ? "–" : t(`compare.state.${c.state}`)),
      kindText: (k) => t(k === "secret" ? "compare.kindSecretOne" : "compare.kindVariableOne"),
      parityText: (r) => (r.parity === "gap" ? t("compare.parityGap", { stages: r.missingIn.map(labelOf).join(", ") }) : r.parity === "consistent" ? t("compare.parityConsistent") : "–"),
      stageLabel: labelOf,
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("compare.copied"));
    } catch {
      toast.error(t("compare.copyFailed"));
    }
  };

  return (
    <>
      <PageHeader
        title={t("compare.title")}
        subtitle={t("compare.subtitle")}
        actions={
          <>
            {live ? (
              <Button variant="secondary" loading={result.loading} onClick={result.reload}><Icon name="refresh" />{t("compare.refresh")}</Button>
            ) : null}
            <Button variant="secondary" onClick={() => void copy()} disabled={!data}><Icon name="download" />{t("compare.copyMd")}</Button>
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <Checkbox checked={live} onChange={setLive}>
          <span className="font-medium">{t("compare.live")}</span>
          <span className="block text-xs text-muted">{t("compare.liveHint")}</span>
        </Checkbox>
        {live ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Checkbox checked={allRepos} onChange={setAllRepos}>
              <span className="font-medium">{t("compare.allRepos")}</span>
              <span className="block text-xs text-muted">{t("compare.allReposHint")}</span>
            </Checkbox>
            <Checkbox checked={workflows} onChange={setWorkflows}>
              <span className="font-medium">{t("compare.workflows")}</span>
              <span className="block text-xs text-muted">{t("compare.workflowsHint")}</span>
            </Checkbox>
          </div>
        ) : null}
        <Notice tone="info">{live ? (result.loading ? t("compare.liveLoading") : t("compare.liveNotice")) : t("compare.offlineNotice")}</Notice>
        {data && data.errors.length > 0 ? (
          <Notice tone="warn" title={t("compare.errorsTitle")}>
            <p>{t("compare.errorsText")}</p>
            <ul className="mt-1 list-disc pl-5 text-xs">{data.errors.slice(0, 6).map((e, i) => <li key={i}><span className="font-medium">{e.target}</span>: {e.message}</li>)}</ul>
          </Notice>
        ) : null}
      </div>

      <FilterRow>
        <div className="w-52">
          <SelectField label={t("compare.filterRepo")} value={filters.repo} onChange={(e) => set("repo", e.target.value)}>
            <option value="">{t("compare.all")}</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </SelectField>
        </div>
        <div className="w-44">
          <SelectField label={t("compare.kind")} value={filters.kind} onChange={(e) => set("kind", e.target.value as CompareFilters["kind"])}>
            <option value="">{t("compare.all")}</option>
            <option value="secret">{t("compare.kindSecret")}</option>
            <option value="variable">{t("compare.kindVariable")}</option>
          </SelectField>
        </div>
        <div className="w-56">
          <TextField label={t("compare.search")} value={filters.q} onChange={(e) => set("q", e.target.value)} autoComplete="off" />
        </div>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <Checkbox checked={filters.onlyDeviations} onChange={(v) => set("onlyDeviations", v)}>{t("compare.onlyDeviations")}</Checkbox>
          <Checkbox checked={gapsFirst} onChange={setGapsFirst}>{t("compare.gapsFirst")}</Checkbox>
          {effectiveWorkflows || (data?.rows ?? []).some((r) => r.needs) ? <Checkbox checked={filters.onlyNeeded === true} onChange={(v) => set("onlyNeeded", v)}>{t("compare.onlyNeeded")}</Checkbox> : null}
        </div>
        <div className="flex max-w-xs flex-col justify-end pb-1">
          <Checkbox checked={normalize} onChange={setNormalize}>
            <span>{t("compare.normalize")}</span>
            <span className="block text-xs text-muted">{t("compare.normalizeHint")}</span>
          </Checkbox>
        </div>
      </FilterRow>

      <div className="mb-5" role="group" aria-label={t("compare.stagesLabel")}>
        <SectionLabel>{t("compare.stagesLabel")}</SectionLabel>
        <div className="mt-2 flex flex-wrap gap-2">
          {orderedStages.map((s) => {
            const on = compared.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStage(s.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-primary bg-primary-light text-primary" : "border-line bg-card text-muted-text hover:bg-page"}`}
              >
                {on ? <Icon name="check" className="h-3 w-3" /> : null}{s.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-muted">{t("compare.stagesHint")}</p>
      </div>

      {data ? (
        <section aria-label={t("compare.sumTitle")} className="mb-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {orderedStages.map((s) => {
              const n = totals[s.id];
              return (
                <Card key={s.id} className={`!p-4 ${compared.includes(s.id) ? "ring-1 ring-primary/30" : ""}`}>
                  <SectionLabel>{s.label}</SectionLabel>
                  {n ? (
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-text">{t("compare.sumExpected")}</dt><dd className="tabular text-right font-semibold">{n.expected}</dd>
                      <dt className="text-muted-text">{t("compare.sumPresent")}</dt><dd className="tabular text-right font-semibold">{data.live ? n.present : "–"}</dd>
                      <dt className="text-muted-text">{t("compare.sumMissing")}</dt><dd className={`tabular text-right font-semibold ${data.live && n.missing ? "text-danger-text" : ""}`}>{data.live ? n.missing : "–"}</dd>
                      <dt className="text-muted-text">{t("compare.sumUnexpected")}</dt><dd className={`tabular text-right font-semibold ${data.live && n.unexpected ? "text-warn-text" : ""}`}>{data.live ? n.unexpected : "–"}</dd>
                      {data.live && n.error ? <><dt className="text-muted-text">{t("compare.sumError")}</dt><dd className="tabular text-right font-semibold text-danger-text">{n.error}</dd></> : null}
                      {n.needed ? <><dt className="text-muted-text">{t("compare.sumNeeded")}</dt><dd className="tabular text-right font-semibold text-warn-text">{n.needed}</dd></> : null}
                    </dl>
                  ) : null}
                </Card>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">
            {t("compare.sumRows", { rows: visible.length, gaps: gapCount, orphans: orphanCount })}
            {data.live ? "" : ` ${t("compare.sumOffline")}`}
            {neededRows > 0 ? ` ${t("compare.sumNeededRows", { count: neededRows })}.` : ""}
          </p>
          {candidates.length > 0 ? (
            <div className="mt-3"><Button variant="secondary" onClick={() => setAdoptAll(true)}><Icon name="plus" />{t("compare.adoptAll", { count: candidates.length })}</Button></div>
          ) : null}
        </section>
      ) : null}

      {goneRepos.length > 0 ? (
        <div className="mb-4 space-y-2">
          {goneRepos.map((r) => (
            <Notice key={r.name} tone="warn" title={r.name}>
              <p className="flex flex-wrap items-center gap-2">
                <span>{r.renamedTo ? t("compare.repoRenamed", { name: r.renamedTo }) : t("compare.repoGone")}</span>
                {r.renamedTo ? <Button aria-label={t("repos.renameInventoryAria", { from: r.name, to: r.renamedTo })} onClick={() => setRenaming(r)}><Icon name="wrench" />{t("compare.renameInventory")}</Button> : null}
              </p>
            </Notice>
          ))}
        </div>
      ) : null}

      {data && data.live && allRepos ? (
        <details className="mb-4 rounded-2xl border border-line bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">{t("compare.emptyReposTitle")} <span className="font-normal text-muted">({emptyRepos.length})</span></summary>
          <p className="mt-2 text-xs text-muted">{t("compare.emptyReposHint")}</p>
          {emptyRepos.length === 0 ? <p className="mt-2 text-sm text-muted-text">{t("compare.emptyReposNone")}</p> : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("compare.repoColName")}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("compare.repoColVisibility")}</th>
                    <th scope="col" className="py-2 pr-3 font-medium">{t("compare.repoColPush")}</th>
                    <th scope="col" className="py-2 font-medium">{t("compare.repoColFound")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {emptyRepos.map((r) => (
                    <tr key={r.name}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium">{r.name}</th>
                      <td className="py-2 pr-3">{r.private === null ? "–" : r.private ? t("compare.repoPrivate") : t("compare.repoPublic")}</td>
                      <td className="tabular py-2 pr-3">{r.pushedAt ? r.pushedAt.slice(0, 10) : "–"}</td>
                      <td className="tabular py-2 text-xs text-muted-text">{t("compare.repoFound", { secrets: r.found.secrets, variables: r.found.variables, needed: r.needed })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ) : null}

      {repoNotes.length > 0 ? (
        <details className="mb-4 rounded-2xl border border-line bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">{t("compare.notesTitle")} <span className="font-normal text-muted">({repoNotes.length})</span></summary>
          <ul className="mt-2 space-y-2 text-xs">
            {repoNotes.map((r) => (
              <li key={r.name}>
                <span className="font-medium">{r.name}</span>
                <ul className="list-disc pl-5 text-muted-text">{r.notes.map((n, i) => <li key={i} title={n.message}>{noteText(t, n)}</li>)}</ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {result.error ? <ErrorState error={result.error} onRetry={result.reload} /> : null}
      {result.loading && !data ? <ListSkeleton rows={6} /> : null}
      {data && all.length === 0 ? <EmptyState title={t("compare.emptyTitle")} icon="key">{t("compare.emptyFirst")}</EmptyState> : null}
      {data && all.length > 0 && visible.length === 0 ? (
        <EmptyState title={t("compare.emptyTitle")} icon="check">{filters.onlyDeviations && !filters.q && !filters.repo && !filters.kind ? t("compare.noDeviations") : t("compare.emptyFiltered")}</EmptyState>
      ) : null}

      {groups.map((g) => {
        const hasOther = g.rows.some((r) => r.other);
        const repoInfo = data?.repos.find((x) => x.name === g.repo);
        return (
        <div key={g.repo}>
          <p className="mb-2 mt-6 flex flex-wrap items-baseline gap-2 text-sm font-semibold first:mt-0">
            {g.repo}
            <span className="text-xs font-normal text-muted">{g.rows.length}</span>
            {g.gaps > 0 ? <span className="text-xs font-medium text-danger-text">{t("compare.groupGaps", { count: g.gaps })}</span> : null}
            {repoInfo && !repoInfo.inInventory ? <span className="text-xs font-normal text-warn-text">{t("compare.repoOnlyGithub")}</span> : null}
          </p>
          <ListTable minWidth={420 + orderedStages.length * 130 + (hasOther ? 160 : 0)} columns={[t("compare.colName"), ...orderedStages.map((s) => s.label), ...(hasOther ? [t("compare.colOther")] : []), t("compare.colParity")]}>
            {g.rows.map((r) => (
              <tr key={`${r.kind}:${r.name}`} className={LIST_ROW_CLASS}>
                <td className={LIST_CELL_CLASS}>
                  <button type="button" onClick={() => setDetail({ row: r, stage: "" })} aria-label={t("compare.rowAria", { name: r.name })} className="text-left font-medium text-primary hover:underline">{r.name}</button>
                  <p className="text-xs text-muted">
                    {t(r.kind === "secret" ? "compare.kindSecretOne" : "compare.kindVariableOne")}
                    {r.ids.length === 0 ? null : ` · ${r.ids.slice(0, 2).join(", ")}${r.ids.length > 2 ? " …" : ""}`}
                  </p>
                  {r.names ? <p className="max-w-xs truncate text-xs text-muted-text" title={r.names.join(", ")}>{r.names.join(", ")}</p> : null}
                  {r.needs && r.needs.length > 0 ? (
                    <p className="mt-1" title={r.needs.map((n) => (n.environment ? t("compare.needsEnv", { file: n.file, env: n.environment }) : n.file)).join(", ")}>
                      <Badge info={{ label: t("compare.needsBadge", { files: needFiles(r).join(", ") }), tone: r.neededMissing ? "warn-strong" : "neutral", icon: r.neededMissing ? "alert" : "check" }} />
                    </p>
                  ) : null}
                  {r.neededMissing ? <AdoptLinks row={r} stages={orderedStages} t={t} /> : null}
                </td>
                {orderedStages.map((s) => {
                  const cell = r.cells[s.id];
                  if (!cell) return <td key={s.id} className={LIST_CELL_CLASS}>–</td>;
                  const err = cell.detail?.error?.message;
                  return (
                    <td key={s.id} className={LIST_CELL_CLASS}>
                      <button
                        type="button"
                        onClick={() => setDetail({ row: r, stage: s.id })}
                        aria-label={t("compare.cellAria", { name: r.name, stage: s.label, state: t(`compare.stateLong.${cell.state}`) })}
                        title={err ?? t(`compare.stateLong.${cell.state}`)}
                        className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        <CellView cell={cell} t={t} />
                      </button>
                    </td>
                  );
                })}
                {hasOther ? (
                  <td className={`${LIST_CELL_CLASS} text-xs`}>
                    {r.other?.present.length ? <p>{t("compare.otherPresent", { envs: r.other.present.join(", ") })}</p> : null}
                    {r.other?.needed.length ? <p className="text-warn-text">{t("compare.otherNeeded", { envs: r.other.needed.map((e) => e || t("compare.repoLevelName")).join(", ") })}</p> : null}
                    {!r.other ? "–" : null}
                  </td>
                ) : null}
                <td className={LIST_CELL_CLASS}><ParityBadge row={r} t={t} label={labelOf} /></td>
              </tr>
            ))}
          </ListTable>
        </div>
        );
      })}

      {renaming?.renamedTo ? <RenameRepoDialog from={renaming.name} to={renaming.renamedTo} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); result.reload(); }} /> : null}
      {adoptAll ? <AdoptAllDialog candidates={candidates} stages={orderedStages} environmentOf={(id) => data?.stages.find((x) => x.id === id)?.environment ?? null} onClose={() => setAdoptAll(false)} onDone={() => { setAdoptAll(false); result.reload(); }} t={t} /> : null}
      {detail ? <DetailDialog row={detail.row} stage={detail.stage} stages={orderedStages} live={Boolean(data?.live)} onClose={() => setDetail(null)} t={t} label={labelOf} /> : null}
    </>
  );
}

function DetailDialog({ row, stage, stages, live, onClose, t, label }: { row: ViewRow; stage: string; stages: { id: string; label: string }[]; live: boolean; onClose: () => void; t: T; label: (id: string) => string }) {
  return (
    <Dialog title={t("compare.detailTitle", { name: row.name, repo: row.repo })} description={t("compare.detailDesc")} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-text">{t("compare.detailKind")}</dt>
          <dd>{t(row.kind === "secret" ? "compare.kindSecretOne" : "compare.kindVariableOne")}</dd>
          <dt className="text-muted-text">{t("compare.detailParity")}</dt>
          <dd><ParityBadge row={row} t={t} label={label} /></dd>
        </dl>

        <ul className="space-y-3">
          {stages.map((s) => {
            const c = row.cells[s.id];
            if (!c) return null;
            const d = c.detail;
            const hint = t(`compare.hint.${c.state}`);
            return (
              <li key={s.id} className={`rounded-xl border p-3 ${s.id === stage ? "border-primary bg-primary-light/40" : "border-line"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.label}</span>
                  <CellView cell={c} t={t} />
                  <span className="text-xs text-muted-text">{t(`compare.stateLong.${c.state}`)}</span>
                </div>
                {d ? (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    {d.targets.length > 0 ? <><dt className="text-muted-text">{t("compare.detailTargets")}</dt><dd>{d.targets.join(", ")}</dd></> : null}
                    {d.missingAt && d.missingAt.length > 0 ? <><dt className="text-muted-text">{t("compare.detailMissingAt")}</dt><dd>{d.missingAt.join(", ")}</dd></> : null}
                    {d.notFound && d.notFound.length > 0 ? <><dt className="text-muted-text" /><dd>{t("compare.detailNotFound", { envs: d.notFound.join(", ") })}</dd></> : null}
                    {d.actualNames && d.actualNames.length > 0 ? <><dt className="text-muted-text">{t("compare.detailActualNames")}</dt><dd>{d.actualNames.join(", ")}</dd></> : null}
                    {d.expectedValues && d.expectedValues.length > 0 ? <><dt className="text-muted-text">{t("compare.detailExpectedValue")}</dt><dd className="break-all">{d.expectedValues.join(", ")}</dd></> : null}
                    {d.actualValues && d.actualValues.length > 0 ? <><dt className="text-muted-text">{t("compare.detailActualValue")}</dt><dd className="break-all">{d.actualValues.join(", ")}</dd></> : null}
                    {d.neededBy && d.neededBy.length > 0 ? <><dt className="text-muted-text">{t("compare.detailNeededBy")}</dt><dd>{d.neededBy.join(", ")}</dd></> : null}
                    {d.error ? <><dt className="text-muted-text">{t("compare.detailError")}</dt><dd className="break-words text-danger-text">{d.error.message}</dd></> : null}
                  </dl>
                ) : null}
                {c.state === "needed" ? <AdoptLinks row={row} stages={stages.filter((x) => x.id === s.id)} t={t} /> : null}
                {(c.state === "missing" || c.state === "unexpected" || c.state === "different" || c.state === "error" || (c.state === "unknown" && !live)) ? (
                  <p className="mt-2 text-xs"><span className="font-medium">{t("compare.detailFix")}: </span>{hint}</p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div>
          <SectionLabel>{t("compare.detailInventory")}</SectionLabel>
          {row.ids.length === 0 ? (
            <p className="mt-1 text-muted-text">{t("compare.detailNone")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {row.ids.map((id) => (
                <li key={id}>
                  <Link href={row.kind === "secret" ? `/secrets/${enc(id)}` : `/variablen?q=${enc(id)}`} className="font-medium text-primary hover:underline">
                    {t(row.kind === "secret" ? "compare.openSecret" : "compare.openVariable", { id })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end"><Button onClick={onClose}>{t("compare.close")}</Button></div>
      </div>
    </Dialog>
  );
}

/** Links "Ins Inventar aufnehmen": oeffnen den Neu-Dialog von Secrets bzw. Variablen vorausgefuellt. */
function AdoptLinks({ row, stages, t }: { row: ViewRow; stages: { id: string; label: string }[]; t: T }) {
  const items = adoptCandidates([row]).filter((c) => stages.some((s) => s.id === c.stage));
  if (items.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
      {items.map((c) => (
        <Link key={c.key} href={adoptLink(c, adoptDescription(t, c.files))} className="font-medium text-primary hover:underline">
          {items.length > 1 ? t("compare.adoptStage", { stage: stages.find((s) => s.id === c.stage)?.label ?? c.stage }) : t("compare.adopt")}
        </Link>
      ))}
    </p>
  );
}

/** Sammelaktion: nur Metadaten, nie Werte. Auswahl und Stage je Eintrag aenderbar. */
function AdoptAllDialog({ candidates, stages, environmentOf, onClose, onDone, t }: { candidates: AdoptCandidate[]; stages: { id: string; label: string }[]; environmentOf: (stage: string) => string | null; onClose: () => void; onDone: () => void; t: T }) {
  const toast = useToast();
  const [items, setItems] = useState(() => candidates.map((c) => ({ ...c, on: !c.invalidName })));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const chosen = items.filter((i) => i.on);
  const patch = (key: string, p: Partial<(typeof items)[number]>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const run = async () => {
    if (chosen.length === 0) return toast.info(t("compare.adoptNone"));
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    let done = 0;
    for (const c of chosen) {
      const req = adoptRequest(c, { environment: environmentOf(c.stage), description: adoptDescription(t, c.files) });
      try {
        await api("POST", req.path, req.body);
        done += 1;
      } catch (e) {
        failed.push(t("compare.adoptFailed", { name: `${c.repo}/${c.name}`, message: e instanceof Error ? e.message : String(e) }));
      }
    }
    setBusy(false);
    if (done > 0) toast.success(t("compare.adoptDone", { count: done }));
    if (failed.length > 0) setErrors(failed);
    else onDone();
    if (done > 0 && failed.length > 0) setItems((xs) => xs.filter((x) => !x.on));
  };
  return (
    <Dialog title={t("compare.adoptAllTitle")} description={t("compare.adoptAllText")} onClose={onClose} wide>
      <div className="space-y-4">
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {items.map((c) => (
            <li key={c.key} className="grid items-center gap-2 rounded-xl border border-line p-2 sm:grid-cols-[auto_1fr_auto]">
              <Checkbox checked={c.on} onChange={(v) => patch(c.key, { on: v })}><span className="sr-only">{t("compare.adoptInclude")}</span></Checkbox>
              <div className="min-w-0 text-sm">
                <p className="break-all font-medium">{c.name} <span className="text-xs font-normal text-muted">{t(c.kind === "secret" ? "compare.kindSecretOne" : "compare.kindVariableOne")} · {c.repo}</span></p>
                <p className="text-xs text-muted">{adoptDescription(t, c.files)}</p>
                {c.invalidName ? <p className="text-xs text-warn-text">{t("compare.adoptInvalid")}</p> : null}
              </div>
              <SelectField label={t("compare.adoptStageLabel")} value={c.stage} onChange={(e) => patch(c.key, { stage: e.target.value })}>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </SelectField>
            </li>
          ))}
        </ul>
        {errors.length > 0 ? <Notice tone="danger"><ul className="list-disc pl-5 text-xs">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Notice> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("compare.cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>{t("compare.adoptConfirm", { count: chosen.length })}</Button>
        </div>
      </div>
    </Dialog>
  );
}
