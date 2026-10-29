"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { LinkResult, RepoList, RepoRow, ScanSuggestion } from "@secret-desk/runtime";
import { Dialog } from "@/components/Dialog";
import { Icon } from "@/components/Icons";
import { RenameRepoDialog } from "@/components/RenameRepoDialog";
import { Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, Pill, SectionLabel, TextField } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { invalidateRepoList } from "@/lib/repo-list";
import { linkState } from "@/lib/repos";
import { useToast } from "@/lib/toast";

type T = ReturnType<typeof useT>;

function StatusCell({ row, t }: { row: RepoRow; t: T }) {
  const s = linkState(row.link);
  if (s === "none") return <span className="text-muted">–</span>;
  const tone = s === "ok" ? "text-success-text" : s === "missing" ? "text-danger-text" : "text-warn-text";
  const label = s === "ok" ? t("repos.statusOk") : s === "missing" ? t("repos.statusMissing") : s === "no-remote" ? t("repos.statusNoRemote") : t("repos.statusMismatch", { remote: row.link?.remote ?? "" });
  return <span className={`inline-flex items-start gap-1.5 text-xs ${tone}`}><Icon name={s === "ok" ? "check" : "alert"} className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="break-all">{label}</span></span>;
}

function LinkDialog({ row, onClose, onChanged }: { row: RepoRow; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const [path, setPath] = useState(row.link?.path ?? "");
  const [warnings, setWarnings] = useState<string[]>([]);
  const save = useMutation((p: string) => api<LinkResult>("PUT", `repos/${enc(row.name)}/link`, { path: p }));
  const remove = useMutation(() => api<{ ok: true }>("DELETE", `repos/${enc(row.name)}/link`));

  const submit = async () => {
    const res = await save.run(path.trim());
    if (!res) return;
    onChanged();
    if (res.warnings.length > 0) {
      setWarnings(res.warnings);
      return;
    }
    toast.success(t("repos.saved"));
    onClose();
  };
  const unlink = async () => {
    if (!(await remove.run())) return;
    onChanged();
    toast.success(t("repos.removed"));
    onClose();
  };

  return (
    <Dialog title={t("repos.dialogTitle", { name: row.name })} description={t("repos.dialogDesc")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <TextField label={t("repos.pathLabel")} hint={t("repos.pathHint")} required data-autofocus value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
        {warnings.length > 0 ? <Notice tone="warn" title={t("repos.warnTitle")}>{warnings.map((w, i) => <p key={i}>{w}</p>)}</Notice> : null}
        {save.error || remove.error ? <Notice tone="danger">{(save.error ?? remove.error)?.message}</Notice> : null}
        <div className="flex flex-wrap justify-between gap-2">
          {row.link ? <Button variant="danger" loading={remove.pending} onClick={() => void unlink()}><Icon name="trash" />{t("repos.remove")}</Button> : <span />}
          <div className="flex gap-2">
            <Button onClick={onClose}>{warnings.length > 0 ? t("repos.close") : t("repos.cancel")}</Button>
            {warnings.length === 0 ? <Button type="submit" variant="primary" loading={save.pending}>{t("repos.save")}</Button> : null}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function ScanResults({ found, onAdopt, onClose }: { found: ScanSuggestion[]; onAdopt: (items: ScanSuggestion[]) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const open = found.filter((f) => !f.linked);
  const run = async (items: ScanSuggestion[]) => {
    setBusy(true);
    try {
      await onAdopt(items);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>{t("repos.scanTitle")}</SectionLabel>
        <div className="flex gap-2">
          {open.length > 1 ? <Button variant="primary" loading={busy} onClick={() => void run(open)}>{t("repos.adoptAll")}</Button> : null}
          <Button onClick={onClose}>{t("repos.close")}</Button>
        </div>
      </div>
      {found.length === 0 ? <p className="mt-3 text-sm text-muted">{t("repos.scanNone")}</p> : <p className="mt-3 text-sm text-muted">{t("repos.scanFound", { count: found.length })}</p>}
      <ul className="mt-3 divide-y divide-line text-sm">
        {found.map((f) => (
          <li key={f.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="font-medium">{f.name}</p>
              <p className="break-all font-mono text-xs text-muted-text">{f.path}</p>
            </div>
            {f.linked ? <Pill>{t("repos.alreadyLinked")}</Pill> : <Button aria-label={t("repos.adoptAria", { name: f.name })} disabled={busy} onClick={() => void run([f])}>{t("repos.adopt")}</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function ReposPage() {
  const t = useT();
  const toast = useToast();
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<RepoRow | null>(null);
  const [renaming, setRenaming] = useState<RepoRow | null>(null);
  const [found, setFound] = useState<ScanSuggestion[] | null>(null);
  const list = useQuery<RepoList>(`repos?live=${live ? 1 : 0}`, () => api<RepoList>("GET", live ? "repos?live=1" : "repos"));
  const scan = useMutation(() => api<ScanSuggestion[]>("POST", "repos/scan"));

  const changed = () => {
    invalidateRepoList();
    list.reload();
  };
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list.data?.repos ?? []).filter((r) => q === "" || r.name.toLowerCase().includes(q));
  }, [list.data, filter]);
  const onlyGithub = (list.data?.repos ?? []).filter((r) => r.github && !r.inInventory).length;

  const runScan = async () => {
    const res = await scan.run();
    if (res) setFound(res);
  };
  const adopt = async (items: ScanSuggestion[]) => {
    let done = 0;
    for (const it of items) {
      try {
        await api<LinkResult>("PUT", `repos/${enc(it.name)}/link`, { path: it.path });
        done += 1;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    if (done > 0) toast.success(t("repos.adopted", { count: done }));
    setFound((f) => (f ?? []).map((x) => (items.some((i) => i.name === x.name) ? { ...x, linked: true } : x)));
    changed();
  };

  return (
    <>
      <PageHeader
        title={t("repos.title")}
        subtitle={t("repos.subtitle")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button loading={scan.pending} onClick={() => void runScan()}><Icon name="search" />{scan.pending ? t("repos.scanning") : t("repos.scan")}</Button>
            <Button loading={live && list.loading} onClick={() => (live ? list.reload() : setLive(true))}><Icon name="refresh" />{live && list.loading ? t("repos.syncing") : t("repos.sync")}</Button>
          </div>
        }
      />
      <div className="space-y-4">
        {scan.error ? <Notice tone="danger">{scan.error.message}</Notice> : null}
        {found ? <ScanResults found={found} onAdopt={adopt} onClose={() => setFound(null)} /> : null}
        {live && list.data?.github === "off" ? <Notice tone="info">{t("repos.githubOff")}</Notice> : null}
        {live && list.data?.github === "unavailable" ? <Notice tone="warn">{t("repos.githubUnavailable")}</Notice> : null}
        {live && list.data?.github === "ok" ? <Notice tone="success">{t("repos.syncDone", { count: onlyGithub })}</Notice> : null}

        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("repos.filter")} aria-label={t("repos.filter")} autoComplete="off" className="w-full max-w-sm rounded-xl border border-line bg-card px-3 py-2 text-sm placeholder:text-muted" />

        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.loading && !list.data ? <ListSkeleton /> : null}
        {list.data && list.data.repos.length === 0 ? <EmptyState title={t("repos.empty")} icon="folder">{t("repos.emptyText")}</EmptyState> : null}
        {list.data && list.data.repos.length > 0 && rows.length === 0 ? <p className="text-sm text-muted">{t("repos.noMatch")}</p> : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">{t("repos.colName")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("repos.colSecrets")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("repos.colVariables")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("repos.colFolder")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("repos.colStatus")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.name} className="align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      <Link href={`/secrets?repo=${enc(r.name)}`} aria-label={t("repos.showSecretsAria", { name: r.name })} className="underline-offset-2 hover:underline">{r.name}</Link>
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] font-normal">
                        {r.github && !r.inInventory ? <span title={t("repos.onlyGithubHint")}><Pill>{t("repos.onlyGithub")}</Pill></span> : null}
                        {r.github?.private ? <Pill>{t("repos.private")}</Pill> : null}
                        {r.github?.archived ? <Pill>{t("repos.archived")}</Pill> : null}
                        {r.renamedTo ? <span title={t("repos.renamedHint")}><Pill>{t("repos.renamedTo", { name: r.renamedTo })}</Pill></span> : null}
                      </div>
                      {r.renamedTo ? (
                        <div className="mt-2">
                          <Button aria-label={t("repos.renameInventoryAria", { from: r.name, to: r.renamedTo })} onClick={() => setRenaming(r)}><Icon name="wrench" />{t("repos.renameInventory")}</Button>
                        </div>
                      ) : null}
                    </th>
                    <td className="tabular px-3 py-2 text-right"><Link href={`/secrets?repo=${enc(r.name)}`} className="hover:underline">{r.secrets}</Link></td>
                    <td className="tabular px-3 py-2 text-right"><Link href={`/variables?repo=${enc(r.name)}`} className="hover:underline">{r.variables}</Link></td>
                    <td className="px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        {r.link ? <span className="break-all font-mono text-xs">{r.link.path}</span> : <span className="text-muted">{t("repos.notLinked")}</span>}
                        <Button aria-label={r.link ? t("repos.editAria", { name: r.name }) : t("repos.linkAria", { name: r.name })} onClick={() => setEditing(r)}>
                          <Icon name={r.link ? "wrench" : "link"} />{r.link ? t("repos.edit") : t("repos.link")}
                        </Button>
                      </div>
                    </td>
                    <td className="px-3 py-2"><StatusCell row={r} t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
      {editing ? <LinkDialog row={editing} onClose={() => setEditing(null)} onChanged={changed} /> : null}
      {renaming?.renamedTo ? <RenameRepoDialog from={renaming.name} to={renaming.renamedTo} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); changed(); }} /> : null}
    </>
  );
}
