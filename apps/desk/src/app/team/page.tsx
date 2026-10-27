"use client";
import { useRef, useState } from "react";
import { Icon } from "@/components/Icons";
import { Button, Card, Checkbox, Notice, PageHeader, SectionLabel, TextAreaField } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { loadStages } from "@/lib/use-stages";
import { useT } from "@/lib/i18n";

interface ImportResult {
  added: Record<string, number> | string[] | number;
  skipped: Record<string, number> | string[] | number;
}

const count = (v: ImportResult["added"]): string => (typeof v === "number" ? String(v) : Array.isArray(v) ? String(v.length) : Object.entries(v).map(([k, n]) => `${n} ${k}`).join(", ") || "0");

export default function TeamPage() {
  const t = useT();
  const toast = useToast();
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imp = useMutation(async () => api<ImportResult>("POST", "team-import", { text, replace }));

  const readFile = async () => {
    const f = fileRef.current?.files?.[0];
    if (f) setText(await f.text());
  };
  const submit = async () => {
    const r = await imp.run();
    if (r) {
      setResult(r);
      void loadStages(true);
      toast.success(t("team.imported"));
    }
  };

  return (
    <>
      <PageHeader title={t("team.title")} subtitle={t("team.subtitle")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionLabel>{t("team.exportTitle")}</SectionLabel>
          <p className="mt-3 text-sm text-muted-text">{t("team.exportText")}</p>
          <a href="/api/ui/team-export" download className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:brightness-95"><Icon name="download" />{t("team.download")}</a>
        </Card>
        <Card>
          <SectionLabel>{t("team.importTitle")}</SectionLabel>
          <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) void submit(); }} className="mt-3 space-y-3">
            <div className="space-y-1">
              <label htmlFor="team-datei" className="block text-sm font-medium">{t("team.loadFile")}</label>
              <input id="team-datei" ref={fileRef} type="file" accept=".yaml,.yml,text/yaml,text/plain" onChange={() => void readFile()} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-light file:px-3 file:py-1.5 file:text-primary" />
            </div>
            <TextAreaField label={t("team.pasteText")} rows={8} value={text} onChange={(e) => setText(e.target.value)} className="font-mono" spellCheck={false} />
            <Checkbox checked={replace} onChange={setReplace}>{t("team.replace")}</Checkbox>
            {imp.error ? <Notice tone="danger">{imp.error.message}</Notice> : null}
            {result ? <Notice tone="success" title={t("team.importDone")}>{t("team.importSummary", { added: count(result.added), skipped: count(result.skipped) })}</Notice> : null}
            <Button type="submit" variant="primary" loading={imp.pending} disabled={!text.trim()}><Icon name="upload" />{t("team.import")}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
