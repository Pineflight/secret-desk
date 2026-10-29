"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { SyncDiff } from "@/components/SyncDiff";
import { Button, Card, Notice, PageHeader, SectionLabel, SelectField, TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { refreshCounts } from "@/lib/refresh";
import { loadStages } from "@/lib/use-stages";
import type { BundleDiff, SyncCheck } from "@/lib/team-sync";

export default function SetupPage() {
  const t = useT();
  const [done, setDone] = useState(false);
  // GitHub
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("secret-desk.team.yaml");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"pull" | "pull-push">("pull");
  const [strategy, setStrategy] = useState<"pull-request" | "direct">("pull-request");
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
  const previewGitHub = useMutation(async () => {
    // Token nur in die Sitzung; die Konfiguration bekommt nur Repository, Pfad und Zweig.
    await api("POST", "connections/team-sync/token", { token });
    await api("PUT", "team-sync/config", { teamSync: { repo, path, branch, mode, push: { strategy } } });
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
        <Notice tone="success">{t("setup.done")}</Notice>
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
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); void previewGitHub.run().then((r) => r && setCheck(r)); }}>
            <TextField label={t("teamSync.config.repo")} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/team-config" required />
            <TextField label={t("teamSync.config.path")} value={path} onChange={(e) => setPath(e.target.value)} />
            <TextField label={t("teamSync.config.branch")} value={branch} onChange={(e) => setBranch(e.target.value)} />
            <SelectField label={t("teamSync.config.mode")} value={mode} onChange={(e) => setMode(e.target.value as "pull" | "pull-push")}>
              <option value="pull">{t("teamSync.mode.pull")}</option>
              <option value="pull-push">{t("teamSync.mode.pull-push")}</option>
            </SelectField>
            {mode === "pull-push" ? (
              <SelectField label={t("teamSync.config.strategy")} value={strategy} onChange={(e) => setStrategy(e.target.value as "pull-request" | "direct")}>
                <option value="pull-request">{t("teamSync.config.strategy.pull-request")}</option>
                <option value="direct">{t("teamSync.config.strategy.direct")}</option>
              </SelectField>
            ) : null}
            <TextField label={t("teamSync.config.token")} hint={t("teamSync.config.tokenHint")} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
            {previewGitHub.error ? <Notice tone="danger">{previewGitHub.error.message}</Notice> : null}
            <Button type="submit" loading={previewGitHub.pending} disabled={!repo || !token}>{t("setup.github.preview")}</Button>
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
