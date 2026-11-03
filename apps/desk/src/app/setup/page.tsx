"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { SyncDiff } from "@/components/SyncDiff";
import { TeamConfigPicker } from "@/components/TeamConfigPicker";
import { Button, Card, Notice, PageHeader, SectionLabel } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { refreshCounts } from "@/lib/refresh";
import { loadStages } from "@/lib/use-stages";
import type { BundleDiff, SyncCheck } from "@/lib/team-sync";
import { selectionReady, toTeamSyncConfig, type ModeAccess, type TeamSelection } from "@/lib/team-picker";

export default function SetupPage() {
  const t = useT();
  const [done, setDone] = useState(false);
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
  return (
    <>
      <PageHeader title={t("setup.title")} subtitle={t("setup.subtitle")} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <SectionLabel>{t("setup.github.title")}</SectionLabel>
          <p className="mt-3 text-sm text-muted-text">{t("setup.github.text")}</p>
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); void previewGitHub.run().then((r) => { if (r) setCheck(r); else if (r === null) { setCreated(true); finish(); } }); }}>
            <TeamConfigPicker onChange={onPick} />
            {previewGitHub.error ? <Notice tone="danger">{previewGitHub.error.message}</Notice> : null}
            <Button type="submit" loading={previewGitHub.pending} disabled={!selectionReady(selection, access)}>{selection?.createFile ? t("setup.github.create") : t("setup.github.preview")}</Button>
          </form>
          {check ? (
            <div className="mt-4 space-y-3">
              {check.state === "missing-remote" || !check.diff ? <Notice tone="warn">{t("setup.github.empty")}</Notice> : <SyncDiff diff={check.diff} />}
              {applyGitHub.error ? <Notice tone="danger">{applyGitHub.error.message}</Notice> : null}
              {check.remoteSha && check.diff ? <Button variant="primary" loading={applyGitHub.pending} onClick={() => void applyGitHub.run().then((r) => r && finish())}>{t("setup.github.apply")}</Button> : null}
            </div>
          ) : null}
        </Card>
        <Card>
          <SectionLabel>{t("setup.upload.title")}</SectionLabel>
          <p className="mt-3 text-sm text-muted-text">{t("setup.upload.text")}</p>
          <input ref={fileRef} type="file" accept=".yaml,.yml,text/yaml,text/plain" aria-label={t("setup.upload.title")} className="mt-3 block w-full text-sm" onChange={async () => { const f = fileRef.current?.files?.[0]; if (!f) return; const content = await f.text(); setText(content); setUploadDiff(null); const d = await previewUpload.run(content); if (d) setUploadDiff(d); }} />
          {previewUpload.error ? <div className="mt-3"><Notice tone="danger">{previewUpload.error.message}</Notice></div> : null}
          {uploadDiff ? (
            <div className="mt-4 space-y-3">
              <SyncDiff diff={uploadDiff} />
              {applyUpload.error ? <Notice tone="danger">{applyUpload.error.message}</Notice> : null}
              <Button variant="primary" loading={applyUpload.pending} onClick={() => void applyUpload.run().then((r) => r && finish())}>{t("setup.upload.apply")}</Button>
            </div>
          ) : null}
        </Card>
        <Card>
          <SectionLabel>{t("setup.empty.title")}</SectionLabel>
          <p className="mt-3 text-sm text-muted-text">{t("setup.empty.text")}</p>
          {startEmpty.error ? <div className="mt-3"><Notice tone="danger">{startEmpty.error.message}</Notice></div> : null}
          <Button className="mt-4" loading={startEmpty.pending} onClick={() => void startEmpty.run().then((r) => r && finish())}>{t("setup.empty.start")}</Button>
        </Card>
      </div>
    </>
  );
}
