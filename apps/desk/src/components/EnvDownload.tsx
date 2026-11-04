"use client";
import { useState } from "react";
import type { EnvExportResult } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Button, Notice, SelectField } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { defaultStageId, labelOf } from "@/lib/stages";
import { useStageDefs } from "@/lib/use-stages";
import { useToast } from "@/lib/toast";

/** Hands the text to the browser as a file download. The text never reaches the DOM. */
function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Export .env": choose stage, scope and format, get a file. No value is shown on screen. */
export function EnvDownload({ repo }: { repo: string }) {
  const t = useT();
  const defs = useStageDefs();
  const toast = useToast();
  const [stage, setStage] = useState("");
  const [include, setInclude] = useState("variables");
  const [format, setFormat] = useState("dotenv");
  const [done, setDone] = useState<{ keys: number; missing: number } | null>(null);
  const stageId = stage || defaultStageId(defs, "dev");
  const run = useMutation(async (body: unknown) => api<EnvExportResult>("POST", "env/export", body));

  const submit = async () => {
    setDone(null);
    const r = await run.run({ repo, stage: stageId, include, format });
    if (!r) return;
    download(r.filename, r.content, r.format === "json" ? "application/json" : "text/plain");
    setDone({ keys: r.keys.length, missing: r.missing.length });
    toast.success(t("dev.exportDownloaded"));
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
      <SelectField label={t("dev.exportStage")} value={stageId} onChange={(e) => setStage(e.target.value)}>
        {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
      </SelectField>
      <SelectField label={t("dev.exportInclude")} hint={t("dev.exportIncludeHint")} value={include} onChange={(e) => setInclude(e.target.value)}>
        <option value="variables">{t("dev.exportIncludeVariables")}</option>
        <option value="all">{t("dev.exportIncludeAll")}</option>
      </SelectField>
      <SelectField label={t("dev.exportFormat")} value={format} onChange={(e) => setFormat(e.target.value)}>
        <option value="dotenv">.env</option>
        <option value="json">JSON</option>
      </SelectField>
      <p className="text-xs text-muted-text">{t("dev.exportNote")}</p>
      {run.error ? <Notice tone="danger">{run.error.message}</Notice> : null}
      {done ? <Notice tone="success">{t("dev.exportResult", { keys: done.keys, missing: done.missing })}</Notice> : null}
      <Button type="submit" variant="primary" loading={run.pending}><Icon name="download" />{t("dev.exportButton")}</Button>
    </form>
  );
}
