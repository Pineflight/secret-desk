"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import {
  CREATE_FILE,
  effectiveMode,
  failedChecks,
  filterRepos,
  modeAllowed,
  type BranchDiscovery,
  type DiscoveryProblem,
  type FileDiscovery,
  type ModeAccess,
  type PushStrategy,
  type RepoDiscovery,
  type TeamMode,
  type TeamSelection,
} from "@/lib/team-picker";
import { Button, Notice, SelectField, TextField } from "./ui";

const enc = encodeURIComponent;

interface Props {
  /** Called whenever the selection or the permission check changes. `null` selection = nothing chosen yet. */
  onChange: (selection: TeamSelection | null, access: ModeAccess | undefined) => void;
}

/** Explains why discovery could not run, and where to fix it. Never asks for a token. */
function ProblemNotice({ problem, onRetry }: { problem: DiscoveryProblem; onRetry: () => void }) {
  const t = useT();
  const key = `teamPicker.problem.${problem.code}`;
  return (
    <Notice tone="warn" title={t(`${key}.title`)}>
      <p>{t(`${key}.text`)}</p>
      {problem.code !== "rate-limit" ? <p className="mt-1">{t("teamPicker.problem.rights", { rights: problem.neededRights.join(", ") })}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Link href="/connections" className="text-primary underline">{t("teamPicker.problem.link")}</Link>
        <Button onClick={onRetry}>{t("teamPicker.retry")}</Button>
      </div>
    </Notice>
  );
}

/**
 * Repository, branch, file and mode chosen from lists. The token is the GitHub integration; a manually typed token is only the
 * collapsed fallback. Nothing is saved here: the page uses the selection to save the settings and show the preview.
 */
export function TeamConfigPicker({ onChange }: Props) {
  const t = useT();
  const [nonce, setNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [repo, setRepo] = useState("");
  const [repoTouched, setRepoTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [file, setFile] = useState("");
  const [mode, setMode] = useState<TeamMode>("pull");
  const [strategy, setStrategy] = useState<PushStrategy>("pull-request");
  const [token, setToken] = useState("");

  const repos = useQuery<RepoDiscovery>(`team-discovery-repos-${nonce}`, () => api<RepoDiscovery>("GET", "team-sync/discovery/repos"));
  const branches = useQuery<BranchDiscovery>(repo ? `team-discovery-branches-${nonce}-${repo}` : null, () => api<BranchDiscovery>("GET", `team-sync/discovery/branches?repo=${enc(repo)}`));
  const files = useQuery<FileDiscovery>(repo && branch ? `team-discovery-files-${nonce}-${repo}-${branch}` : null, () => api<FileDiscovery>("GET", `team-sync/discovery/files?repo=${enc(repo)}&branch=${enc(branch)}`));

  // Preselect the repository once the list arrives (unless the person already chose one).
  useEffect(() => {
    if (!repoTouched && repos.data?.preselected && !repo) setRepo(repos.data.preselected);
  }, [repos.data, repoTouched, repo]);
  // Default branch of the chosen repository.
  useEffect(() => {
    setBranch("");
    setFile("");
  }, [repo]);
  useEffect(() => {
    if (branches.data && !branch && branches.data.defaultBranch) setBranch(branches.data.defaultBranch);
  }, [branches.data, branch]);
  // Conventional file, or the create option when none exists.
  useEffect(() => {
    setFile("");
  }, [branch]);
  useEffect(() => {
    if (files.data && !file) setFile(files.data.preselected ?? (files.data.canCreate ? CREATE_FILE : ""));
  }, [files.data, file]);

  const createFile = file === CREATE_FILE;
  const path = createFile ? (files.data?.createPath ?? "") : file;
  const shownMode = effectiveMode(mode, createFile);
  const ready = Boolean(repo && branch && path);

  const accessKey = (m: TeamMode) => (ready ? `team-discovery-access-${nonce}-${repo}-${branch}-${path}-${m}-${strategy}` : null);
  const accessPath = (m: TeamMode) => `team-sync/discovery/access?repo=${enc(repo)}&branch=${enc(branch)}&path=${enc(path)}&mode=${m}&strategy=${strategy}`;
  const readAccess = useQuery<ModeAccess>(accessKey("pull"), () => api<ModeAccess>("GET", accessPath("pull")));
  const writeAccess = useQuery<ModeAccess>(accessKey("pull-push"), () => api<ModeAccess>("GET", accessPath("pull-push")));
  const current = shownMode === "pull" ? readAccess.data : writeAccess.data;

  useEffect(() => {
    onChange(ready ? { repo, branch, path, createFile, mode: shownMode, strategy } : null, current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, repo, branch, path, createFile, shownMode, strategy, current]);

  const shown = useMemo(() => filterRepos(repos.data?.repos ?? [], search), [repos.data, search]);
  const saveToken = useMutation(async () => {
    await api("POST", "connections/team-sync/token", { token });
    setToken("");
    setRepo("");
    setRepoTouched(false);
    setNonce((n) => n + 1);
  });
  const retry = () => setNonce((n) => n + 1);
  const problem = repos.data?.problem ?? branches.data?.problem ?? files.data?.problem ?? null;

  const modeOption = (m: TeamMode, access: ModeAccess | undefined, loading: boolean) => {
    const disabledByFile = m === "pull" && createFile;
    const allowed = modeAllowed(access) && !disabledByFile;
    const failed = failedChecks(access);
    return (
      <label key={m} className={`flex gap-3 rounded-xl border p-3 text-sm ${shownMode === m ? "border-primary" : "border-line"} ${allowed || loading ? "" : "opacity-70"}`}>
        <input type="radio" name="team-mode" className="mt-1" checked={shownMode === m} disabled={disabledByFile} onChange={() => setMode(m)} />
        <span className="space-y-1">
          <span className="block font-medium">{t(`teamSync.mode.${m}`)}</span>
          <span className="block text-xs text-muted-text">{t("teamPicker.mode.needs", { rights: (access?.neededRights ?? []).join(", ") || "…" })}</span>
          {disabledByFile ? <span className="block text-xs text-muted-text">{t("teamPicker.mode.createNeedsWrite")}</span> : null}
          {!disabledByFile && loading ? <span className="block text-xs text-muted-text">{t("teamPicker.mode.checking")}</span> : null}
          {!disabledByFile && !loading && access && allowed ? <span className="block text-xs text-success-text">{t("teamPicker.mode.ok")}</span> : null}
          {!disabledByFile && !loading && access && !allowed ? (
            <span className="block text-xs text-danger-text">
              {t("teamPicker.mode.missing")} {failed.map((c) => c.detail ?? c.label).join(" ")}
            </span>
          ) : null}
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-4">
      {problem ? <ProblemNotice problem={problem} onRetry={retry} /> : null}

      <div className="space-y-2">
        <TextField label={t("teamPicker.repo.search")} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="acme/team-config" autoComplete="off" disabled={!repos.data || Boolean(repos.data.problem)} />
        {repos.loading ? <p className="text-sm text-muted-text">{t("common.loading")}</p> : null}
        {repos.error ? <Notice tone="danger">{repos.error.message}</Notice> : null}
        {repos.data && !repos.data.problem && shown.length === 0 ? <p className="text-sm text-muted-text">{t("teamPicker.repo.none")}</p> : null}
        <div role="radiogroup" aria-label={t("teamSync.repo")} className="max-h-56 space-y-1 overflow-y-auto">
          {shown.map((r) => (
            <label key={r.fullName} className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${repo === r.fullName ? "border-primary" : "border-line"} ${r.selectable ? "cursor-pointer" : "opacity-60"}`}>
              <input type="radio" name="team-repo" checked={repo === r.fullName} disabled={!r.selectable} onChange={() => { setRepo(r.fullName); setRepoTouched(true); }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{r.fullName}</span>
                {r.reason === "public" ? <span className="block text-xs text-danger-text">{t("teamPicker.repo.public")}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted-text">{r.private ? t("teamPicker.repo.private") : t("teamPicker.repo.publicTag")}{r.pushedAt ? ` · ${t("teamPicker.repo.pushed", { date: r.pushedAt.slice(0, 10) })}` : ""}</span>
            </label>
          ))}
        </div>
        {repos.data?.truncated ? <p className="text-xs text-muted-text">{t("teamPicker.repo.truncated")}</p> : null}
      </div>

      {repo ? (
        <SelectField label={t("teamSync.config.branch")} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!branches.data || (branches.data.branches.length ?? 0) === 0}>
          {(branches.data?.branches ?? []).map((b) => <option key={b} value={b}>{b === branches.data?.defaultBranch ? `${b} (${t("teamPicker.branch.default")})` : b}</option>)}
        </SelectField>
      ) : null}

      {repo && branch ? (
        <SelectField label={t("teamSync.config.path")} value={file} onChange={(e) => setFile(e.target.value)} disabled={!files.data} hint={createFile ? t("teamPicker.file.createHint", { path: files.data?.createPath ?? "" }) : undefined}>
          {(files.data?.files ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
          {files.data?.canCreate ? <option value={CREATE_FILE}>{t("teamPicker.file.create", { path: files.data.createPath })}</option> : null}
        </SelectField>
      ) : null}

      {ready ? (
        <div className="space-y-2" role="radiogroup" aria-label={t("teamSync.config.mode")}>
          {modeOption("pull", readAccess.data, readAccess.loading)}
          {modeOption("pull-push", writeAccess.data, writeAccess.loading)}
        </div>
      ) : null}

      {ready && shownMode === "pull-push" ? (
        <SelectField label={t("teamSync.config.strategy")} value={strategy} onChange={(e) => setStrategy(e.target.value as PushStrategy)}>
          <option value="pull-request">{t("teamSync.config.strategy.pull-request")}</option>
          <option value="direct">{t("teamSync.config.strategy.direct")}</option>
        </SelectField>
      ) : null}

      <details className="rounded-xl border border-line p-3 text-sm">
        <summary className="cursor-pointer font-medium">{t("teamPicker.token.summary")}</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-text">{t("teamPicker.token.text")}</p>
          <TextField label={t("teamSync.config.token")} hint={t("teamSync.config.tokenHint")} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          {saveToken.error ? <Notice tone="danger">{saveToken.error.message}</Notice> : null}
          <Button loading={saveToken.pending} disabled={!token.trim()} onClick={() => void saveToken.run()}>{t("teamPicker.token.use")}</Button>
        </div>
      </details>
    </div>
  );
}
