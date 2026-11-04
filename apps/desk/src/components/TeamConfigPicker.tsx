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
  groupRepos,
  initialRepo,
  limitRepos,
  modeAllowed,
  modeStatus,
  neededRightsLine,
  REPO_ROWS,
  unusableReason,
  type BranchDiscovery,
  type DiscoveryProblem,
  type FileDiscovery,
  type ModeAccess,
  type PushStrategy,
  type RepoDiscovery,
  type TeamMode,
  type TeamSelection,
} from "@/lib/team-picker";
import { readyTokenExpiry, type TeamTokenInfo } from "@/lib/team-token";
import { formatDate } from "@/lib/format";
import { Button, Notice, SelectField, TextField } from "./ui";
import { SetupStep } from "./SetupStep";
import { showPermissionWarning, stepperState, type StepId, type StepStatus } from "@/lib/setup-steps";
import { confirmStep, EMPTY_CHOICE, keepChoice, readChoice, withBranch, withFile, withMode, withRepo, writeChoice, type SetupChoice } from "@/lib/setup-choice";
import { TeamTokenControl } from "./TeamTokenControl";

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

/** One short line for transient failures (rate limit, network) with a retry; nothing else to do for the person. */
function ShortNotice({ text, onRetry }: { text: string; onRetry: () => void }) {
  const t = useT();
  return (
    <Notice tone="warn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{text}</span>
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
  // The person's choices (and which steps they confirmed). Kept per viewer: a reload or a refresh of the discovery data must
  // never throw them back to the preselected suggestion. Read after mounting so server and client render the same first.
  const [choice, setChoice] = useState<SetupChoice>(EMPTY_CHOICE);
  const [hydrated, setHydrated] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { repo, branch, file, mode, strategy, confirmed } = choice;
  const [token, setToken] = useState("");
  // Bumped when a team token was created: the mode checks run again with it.
  const [accessNonce, setAccessNonce] = useState(0);
  const tokenInfo = useQuery<TeamTokenInfo>("team-token-info-picker", () => api<TeamTokenInfo>("GET", "team-sync/token"));

  const repos = useQuery<RepoDiscovery>(`team-discovery-repos-${nonce}`, () => api<RepoDiscovery>("GET", "team-sync/discovery/repos"));
  const branches = useQuery<BranchDiscovery>(repo ? `team-discovery-branches-${nonce}-${repo}` : null, () => api<BranchDiscovery>("GET", `team-sync/discovery/branches?repo=${enc(repo)}`));
  const files = useQuery<FileDiscovery>(repo && branch ? `team-discovery-files-${nonce}-${repo}-${branch}` : null, () => api<FileDiscovery>("GET", `team-sync/discovery/files?repo=${enc(repo)}&branch=${enc(branch)}`));

  useEffect(() => {
    setChoice(readChoice());
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) writeChoice(choice);
  }, [hydrated, choice]);

  // Suggestions only fill an empty field and never replace a choice; none of them completes a step (the person confirms).
  // Repository: only an accessible private repository qualifies.
  useEffect(() => {
    if (hydrated && !repo) setChoice((c) => (c.repo ? c : { ...c, repo: initialRepo(repos.data) }));
  }, [hydrated, repos.data, repo]);
  // Default branch of the chosen repository.
  useEffect(() => {
    const suggestion = branches.data?.defaultBranch;
    if (hydrated && suggestion && !branch) setChoice((c) => ({ ...c, branch: keepChoice(c.branch, suggestion) }));
  }, [hydrated, branches.data, branch]);
  // Conventional file, or the create option when none exists.
  useEffect(() => {
    if (!hydrated || !files.data || file) return;
    const suggestion = files.data.preselected ?? (files.data.canCreate ? CREATE_FILE : "");
    if (suggestion) setChoice((c) => ({ ...c, file: keepChoice(c.file, suggestion) }));
  }, [hydrated, files.data, file]);

  const createFile = file === CREATE_FILE;
  const path = createFile ? (files.data?.createPath ?? "") : file;
  const shownMode = effectiveMode(mode, createFile);
  const dataReady = Boolean(repo && branch && path);
  // The access checks need the repository and the file confirmed; the selection goes to the page only after all three steps.
  const ready = dataReady && confirmed.repo && confirmed.file;
  const allConfirmed = ready && confirmed.mode;

  const accessKey = (m: TeamMode) => (ready ? `team-discovery-access-${nonce}-${accessNonce}-${repo}-${branch}-${path}-${m}-${strategy}` : null);
  const accessPath = (m: TeamMode) => `team-sync/discovery/access?repo=${enc(repo)}&branch=${enc(branch)}&path=${enc(path)}&mode=${m}&strategy=${strategy}`;
  const readAccess = useQuery<ModeAccess>(accessKey("pull"), () => api<ModeAccess>("GET", accessPath("pull")));
  const writeAccess = useQuery<ModeAccess>(accessKey("pull-push"), () => api<ModeAccess>("GET", accessPath("pull-push")));
  const current = shownMode === "pull" ? readAccess.data : writeAccess.data;

  useEffect(() => {
    onChange(allConfirmed ? { repo, branch, path, createFile, mode: shownMode, strategy } : null, current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConfirmed, repo, branch, path, createFile, shownMode, strategy, current]);

  const groups = useMemo(() => groupRepos(repos.data?.repos ?? [], search), [repos.data, search]);
  const shown = useMemo(() => limitRepos(groups.usable, REPO_ROWS, repo, showAll || search.trim() !== ""), [groups, repo, showAll, search]);
  const saveToken = useMutation(async () => {
    await api("POST", "connections/team-sync/token", { token });
    setToken("");
    setChoice(EMPTY_CHOICE);
    setNonce((n) => n + 1);
  });
  const retry = () => setNonce((n) => n + 1);
  const problem = repos.data?.problem ?? branches.data?.problem ?? files.data?.problem ?? null;
  const networkError = repos.error ?? branches.error ?? files.error ?? null;

  const tokenAvailable = tokenInfo.data?.available === true;
  const modeOption = (m: TeamMode, access: ModeAccess | undefined, loading: boolean) => {
    const disabledByFile = m === "pull" && createFile;
    const status = modeStatus(access, loading, disabledByFile);
    const tokenExpiry = readyTokenExpiry(access, tokenInfo.data, repo);
    // While a team token can be created, creating it is the fix: no permission warning on the row.
    const warn = status === "needs" && showPermissionWarning(true, tokenAvailable);
    return (
      <label key={m} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm ${shownMode === m ? "border-primary" : "border-line"} ${disabledByFile ? "opacity-60" : ""}`}>
        <input type="radio" name="team-mode" checked={shownMode === m} disabled={disabledByFile} onChange={() => setChoice((c) => withMode(c, m, c.strategy))} />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{t(`teamSync.mode.${m}`)}</span>
          <span className="text-muted-text"> · {t(`teamPicker.mode.${m}.text`)}</span>
        </span>
        <span className={`shrink-0 text-xs ${status === "ready" ? "text-success-text" : warn ? "text-warn-text" : "text-muted-text"}`}>
          {status === "ready" ? `✓ ${tokenExpiry === null ? t("teamPicker.mode.ready") : tokenExpiry ? t("teamToken.ready", { date: formatDate(tokenExpiry) }) : t("teamToken.readyNoDate")}` : null}
          {status === "needs" && !warn ? t("teamPicker.mode.tokenNeeded") : null}
          {warn ? <>{`⚠ ${t("teamPicker.mode.needs", { rights: neededRightsLine(access) || "…" })}`} · <Link href="/connections" className="text-primary underline">{t("teamPicker.mode.fix")}</Link></> : null}
          {status === "checking" ? t("teamPicker.mode.checking") : null}
          {status === "create-needs-write" ? t("teamPicker.mode.createNeedsWrite") : null}
        </span>
      </label>
    );
  };

  const modeDetails = (m: TeamMode, access: ModeAccess | undefined) => {
    const failed = failedChecks(access);
    return (
      <div key={m}>
        <p className="font-medium">{t(`teamSync.mode.${m}`)}</p>
        <p className="text-muted-text">{t("teamPicker.mode.rights", { rights: neededRightsLine(access) || "…" })}</p>
        {failed.length > 0 ? <ul className="mt-1 list-disc space-y-0.5 pl-5">{failed.map((c) => <li key={c.id}>{c.detail ?? c.label}</li>)}</ul> : null}
      </div>
    );
  };

  const steps = stepperState({ repo, branch, path: dataReady ? path : "", modeAllowed: modeAllowed(current), confirmed });
  const statusOf = (id: StepId): StepStatus => steps.find((x) => x.id === id)?.status ?? "todo";
  // The repository list collapses to one line once a repository is chosen; "Change" opens it again.
  const [changingRepo, setChangingRepo] = useState(false);
  const repoListOpen = !repo || !confirmed.repo || changingRepo;

  return (
    <div className="space-y-4">
      {problem?.code === "rate-limit" ? <ShortNotice text={t("teamPicker.problem.rate-limit.title")} onRetry={retry} /> : null}
      {problem && problem.code !== "rate-limit" ? <ProblemNotice problem={problem} onRetry={retry} /> : null}
      {!problem && networkError ? <ShortNotice text={t("teamPicker.problem.network")} onRetry={retry} /> : null}

      <ol className="space-y-4" aria-label={t("teamPicker.stepsLabel")}>
        <SetupStep number={1} title={t("teamPicker.step.repo")} status={statusOf("repo")}>
          {!repoListOpen ? (
            <p className="flex flex-wrap items-center gap-3 text-sm">
              <span className="break-all font-mono">{repo}</span>
              <button type="button" className="text-xs text-primary underline" onClick={() => setChangingRepo(true)}>{t("teamPicker.repo.change")}</button>
            </p>
          ) : (
            <div className="space-y-2">
              <TextField label={t("teamPicker.repo.search")} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="acme-org/team-config" autoComplete="off" disabled={!repos.data || Boolean(repos.data.problem)} />
              {repos.loading ? <p className="text-sm text-muted-text">{t("common.loading")}</p> : null}
              {repos.data && !repos.data.problem && !repo && groups.usable.length > 0 ? <p className="text-sm text-muted-text">{t("teamPicker.repo.choose")}</p> : null}
              {repos.data && !repos.data.problem && groups.usable.length === 0 && groups.unusable.length === 0 ? <p className="text-sm text-muted-text">{t("teamPicker.repo.none")}</p> : null}
              {repos.data && !repos.data.problem && groups.usable.length === 0 && groups.unusable.length > 0 ? <p className="text-sm text-muted-text">{t("teamPicker.repo.noneUsable")}</p> : null}
              <div role="radiogroup" aria-label={t("teamSync.repo")} className="space-y-2">
                {shown.map((r) => (
                  <label key={r.fullName} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm ${repo === r.fullName ? "border-primary" : "border-line"}`}>
                    <input type="radio" name="team-repo" checked={repo === r.fullName} onChange={() => setChoice((c) => withRepo(c, r.fullName))} />
                    <span className="min-w-0 flex-1 break-all font-mono">{r.fullName}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-text">
                      {r.pushedAt ? <span>{t("teamPicker.repo.pushed", { date: r.pushedAt.slice(0, 10) })}</span> : null}
                      <span className="rounded-full border border-line px-2 py-0.5">{t("teamPicker.repo.private")}</span>
                    </span>
                  </label>
                ))}
              </div>
              <Button variant="primary" disabled={!repo} onClick={() => { setChoice((c) => confirmStep(c, "repo")); setChangingRepo(false); }}>{t("teamPicker.repo.use")}</Button>
              {groups.usable.length > REPO_ROWS && !showAll && search.trim() === "" ? (
                <Button onClick={() => setShowAll(true)}>{t("teamPicker.repo.showMore", { count: groups.usable.length - REPO_ROWS })}</Button>
              ) : null}
              {groups.unusable.length > 0 ? (
                <details className="rounded-xl border border-line p-3 text-sm">
                  <summary className="cursor-pointer text-muted-text">{t("teamPicker.repo.unusable", { count: groups.unusable.length })}</summary>
                  <ul className="mt-2 space-y-2">
                    {groups.unusable.map((r) => (
                      <li key={r.fullName} className="text-muted-text opacity-70">
                        <span className="block break-all font-mono">{r.fullName}</span>
                        <span className="block text-xs">{t(`teamPicker.repo.reason.${unusableReason(r)}`)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {repos.data?.truncated ? <p className="text-xs text-muted-text">{t("teamPicker.repo.truncated")}</p> : null}
            </div>
          )}
        </SetupStep>

        <SetupStep number={2} title={t("teamPicker.step.file")} status={statusOf("file")}>
          {confirmed.repo && repo ? (
            <div className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label={t("teamSync.config.branch")} value={branch} onChange={(e) => setChoice((c) => withBranch(c, e.target.value))} disabled={!branches.data || (branches.data.branches.length ?? 0) === 0}>
                  {(branches.data?.branches ?? []).map((b) => <option key={b} value={b}>{b === branches.data?.defaultBranch ? `${b} (${t("teamPicker.branch.default")})` : b}</option>)}
                </SelectField>
                {branch ? (
                  <SelectField label={t("teamSync.config.path")} value={file} onChange={(e) => setChoice((c) => withFile(c, e.target.value))} disabled={!files.data}>
                    {(files.data?.files ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
                    {files.data?.canCreate ? <option value={CREATE_FILE}>{t("teamPicker.file.create", { path: files.data.createPath })}</option> : null}
                  </SelectField>
                ) : null}
              </div>
              {!confirmed.file ? <Button variant="primary" disabled={!dataReady} onClick={() => setChoice((c) => confirmStep(c, "file"))}>{t("teamPicker.file.use")}</Button> : null}
              {createFile ? (
                <details className="text-xs text-muted-text">
                  <summary className="cursor-pointer">{t("teamPicker.file.createShort")}</summary>
                  <p className="mt-1">{t("teamPicker.file.createHint", { path: files.data?.createPath ?? "" })}</p>
                </details>
              ) : null}
            </div>
          ) : null}
        </SetupStep>

        <SetupStep number={3} title={t("teamPicker.step.mode")} status={statusOf("mode")}>
          {ready ? (
            <div className="space-y-2" role="radiogroup" aria-label={t("teamSync.config.mode")}>
              {modeOption("pull", readAccess.data, readAccess.loading)}
              {modeOption("pull-push", writeAccess.data, writeAccess.loading)}
              {shownMode === "pull-push" ? (
                <SelectField label={t("teamSync.config.strategy")} value={strategy} onChange={(e) => setChoice((c) => withMode(c, c.mode, e.target.value as PushStrategy))}>
                  <option value="pull-request">{t("teamSync.config.strategy.pull-request")}</option>
                  <option value="direct">{t("teamSync.config.strategy.direct")}</option>
                </SelectField>
              ) : null}
              {!confirmed.mode ? <Button variant="primary" onClick={() => setChoice((c) => confirmStep(c, "mode"))}>{t("teamPicker.mode.use")}</Button> : null}
            </div>
          ) : null}
        </SetupStep>

        <SetupStep number={4} title={t("teamPicker.step.token")} status={statusOf("token")}>
          {allConfirmed ? <TeamTokenControl repo={repo} branch={branch} mode={shownMode} strategy={strategy} onCreated={() => { setAccessNonce((n) => n + 1); tokenInfo.reload(); }} /> : null}
        </SetupStep>
      </ol>

      {ready ? (
        <details className="rounded-xl border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("teamPicker.mode.details")}</summary>
          <div className="mt-3 space-y-3 text-xs">
            <p className="text-muted-text">{t("teamPicker.mode.detailsText")}</p>
            {modeDetails("pull", readAccess.data)}
            {modeDetails("pull-push", writeAccess.data)}
          </div>
        </details>
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
