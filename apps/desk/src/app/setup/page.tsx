"use client";
import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { TeamConfigPicker } from "@/components/TeamConfigPicker";
import { Button, Card, Notice, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { refreshCounts } from "@/lib/refresh";
import { loadStages } from "@/lib/use-stages";
import type { BundleDiff, SyncCheck } from "@/lib/team-sync";
import { selectionReady, toTeamSyncConfig, type ModeAccess, type TeamSelection } from "@/lib/team-picker";

// The preview comes after the form: its own chunk.
const SyncDiff = dynamic(() => import("@/components/SyncDiff").then((m) => m.SyncDiff), { ssr: false });

type Choice = "github" | "upload" | "empty";

export default function SetupPage() {
  const t = useT();
  const [done, setDone] = useState(false);
  const [choice, setChoice] = useState<Choice>("github");
  // GitHub: the pickers report the selection; the token is the GitHub integration.
  const [selection, setSelection] = useState<TeamSelection | null>(null);
  const [access, setAccess] = useState<ModeAccess | undefined>(undefined);
  const [created, setCreated] = useState(false);
  const [check, setCheck] = useState<SyncCheck | null>(null);
  // Upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [uploadDiff, setUploadDiff] = useState<BundleDiff | null>(null);

  const finish = () => {
    setDone(true);
    void loadStages(true);
    refreshCounts();
  };
  const onPick = (sel: TeamSelection | null, acc: ModeAccess | undefined) => {
    setSelection(sel);
    setAccess(acc);
    setCheck(null);
    setCreated(false);
  };
  const previewGitHub = useMutation(async () => {
    // The button is disabled without a ready selection; this guard only narrows the type.
    /* v8 ignore next -- @preserve */
    if (!selection) throw new Error(t("teamPicker.mode.checking"));
    // The configuration gets only repository, path, branch, mode and push strategy; the token is the integration (or the session token).
    await api("PUT", "team-sync/config", { teamSync: toTeamSyncConfig(selection) });
    // A file that does not exist yet is created by the first push: nothing to preview.
    if (selection.createFile) return null;
    return api<SyncCheck>("POST", "team-sync/check");
  });
  const applyGitHub = useMutation(async () => api("POST", "team-sync/apply", { expectSha: check?.remoteSha, resolution: "merge" }));
  const previewUpload = useMutation(async (content: string) => api<BundleDiff>("POST", "team-sync/preview-text", { text: content }));
  const applyUpload = useMutation(async () => {
    await api("POST", "team-import", { text });
    return api("POST", "team-sync/dismiss-setup");
  });
  const startEmpty = useMutation(async () => api("POST", "team-sync/dismiss-setup"));

  if (done) {
    return (
      <>
        <PageHeader title={t("setup.title")} />
        <Notice tone="success">{created ? t("setup.github.created") : t("setup.done")}</Notice>
        <Link href="/" className="mt-4 inline-block text-primary underline">{t("setup.continue")}</Link>
      </>
    );
  }
  const choices: { id: Choice; label: string }[] = [
    { id: "github", label: t("setup.choice.github") },
    { id: "upload", label: t("setup.choice.upload") },
    { id: "empty", label: t("setup.choice.empty") },
  ];
  // Radio group keys: arrows move and select (wrapping), Home and End jump to the ends; only the checked radio is in the Tab order.
  const onChoiceKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = choices.findIndex((c) => c.id === choice);
    const target = e.key === "ArrowRight" || e.key === "ArrowDown" ? (at + 1) % choices.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (at + choices.length - 1) % choices.length : e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1 : -1;
    if (target < 0) return;
    e.preventDefault();
    const next = choices[target]!.id;
    setChoice(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
  };
  return (
    <>
      <PageHeader title={t("setup.title")} subtitle={t("setup.subtitle")} />
      <div className="mx-auto max-w-[880px] space-y-4">
        <div role="radiogroup" aria-label={t("setup.choice.label")} className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-card p-1" onKeyDown={onChoiceKey}>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={choice === c.id}
              tabIndex={choice === c.id ? 0 : -1}
              data-choice={c.id}
              onClick={() => setChoice(c.id)}
              className={`min-h-10 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${choice === c.id ? "bg-primary text-white" : "text-muted-text hover:bg-page"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {choice === "github" ? (
          <Card>
            {/* Deliberately no form element: the picker holds its own forms (sign-in, "Confirm access"), and nested forms submit each other. */}
            <div className="space-y-3">
              <TeamConfigPicker onChange={onPick} />
              {previewGitHub.error ? <Notice tone="danger">{previewGitHub.error.message}</Notice> : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant={check ? "secondary" : "primary"} className="min-h-10" loading={previewGitHub.pending} disabled={!selectionReady(selection, access)} onClick={() => void previewGitHub.run().then((r) => { if (r) setCheck(r); else if (r === null) { setCreated(true); finish(); } })}>{selection?.createFile ? t("setup.github.create") : t("setup.github.preview")}</Button>
                <p className="min-w-0 flex-1 basis-64 text-xs text-muted">{t("setup.github.text")}</p>
              </div>
            </div>
            {check ? (
              <div className="mt-4 space-y-3">
                {applyGitHub.error ? <Notice tone="danger">{applyGitHub.error.message}</Notice> : null}
                {check.remoteSha && check.diff ? <Button variant="primary" className="min-h-10" loading={applyGitHub.pending} onClick={() => void applyGitHub.run().then((r) => r && finish())}>{t("setup.github.apply")}</Button> : null}
                {check.state === "missing-remote" || !check.diff ? <Notice tone="warn">{t("setup.github.empty")}</Notice> : <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-line p-3"><SyncDiff diff={check.diff} /></div>}
              </div>
            ) : null}
          </Card>
        ) : null}
        {choice === "upload" ? (
          <Card>
            <p className="text-sm text-muted-text">{t("setup.upload.text")}</p>
            <input ref={fileRef} type="file" accept=".yaml,.yml,text/yaml,text/plain" aria-label={t("setup.upload.title")} className="mt-3 block w-full text-sm" onChange={async () => { const f = fileRef.current?.files?.[0]; if (!f) return; const content = await f.text(); setText(content); setUploadDiff(null); const d = await previewUpload.run(content); if (d) setUploadDiff(d); }} />
            {previewUpload.error ? <div className="mt-3"><Notice tone="danger">{previewUpload.error.message}</Notice></div> : null}
            {uploadDiff ? (
              <div className="mt-4 space-y-3">
                {applyUpload.error ? <Notice tone="danger">{applyUpload.error.message}</Notice> : null}
                <Button variant="primary" className="min-h-10" loading={applyUpload.pending} onClick={() => void applyUpload.run().then((r) => r && finish())}>{t("setup.upload.apply")}</Button>
                <div className="max-h-[40vh] overflow-y-auto rounded-xl border border-line p-3"><SyncDiff diff={uploadDiff} /></div>
              </div>
            ) : null}
          </Card>
        ) : null}
        {choice === "empty" ? (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-text">{t("setup.empty.text")}</p>
              </div>
              <Button variant="primary" className="min-h-10" loading={startEmpty.pending} onClick={() => void startEmpty.run().then((r) => r && finish())}>{t("setup.empty.start")}</Button>
            </div>
            {startEmpty.error ? <div className="mt-3"><Notice tone="danger">{startEmpty.error.message}</Notice></div> : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
