"use client";
import { useId, useState } from "react";
import type { DevEnvResult } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Checkbox, Notice, PageHeader, SectionLabel, SelectField, StageBadge, TextField, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { Skeleton, EmptyState, ErrorState, Field } from "@/components/ui";
import { RepoPicker } from "@/components/RepoPicker";
import { useRepoList } from "@/lib/repo-list";
import { defaultEnvPath } from "@/lib/repos";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n";
import { useStageDefs } from "@/lib/use-stages";
import { defaultStageId, labelOf } from "@/lib/stages";

const SOURCE_KEYS: Record<string, string> = { default: "dev.srcDefault", generate: "dev.srcGenerate", issue: "dev.srcIssue", prompt: "dev.srcPrompt", variable: "dev.srcVariable" };

/** Einfaches Formular statt Vorlagen-Parser: Es gibt keinen Listen-Endpunkt für die Dev-Vorlagen. */
function FreeExport() {
  const t = useT();
  const defs = useStageDefs();
  const toast = useToast();
  const [f, setF] = useState({ repo: "", path: "", template: "", stage: "" });
  const [overwrite, setOverwrite] = useState(false);
  const [prompts, setPrompts] = useState<{ key: string; value: string }[]>([]);
  const [result, setResult] = useState<DevEnvResult | null>(null);
  const stageId = f.stage || defaultStageId(defs, "dev");
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const repoId = useId();
  const repoList = useRepoList();
  const linked = repoList.data?.repos.find((r) => r.name === f.repo.trim())?.link?.path ?? null;

  const run = useMutation(async (body: unknown) => api<DevEnvResult>("POST", "env-export", body));

  const submit = async () => {
    const filled = prompts.filter((p) => p.key.trim() && p.value !== "");
    const body = {
      repo: f.repo.trim(),
      ...(f.path.trim() ? { path: f.path.trim() } : {}),
      stage: stageId,
      overwrite,
      ...(f.template.trim() ? { template: f.template.trim() } : {}),
      ...(filled.length ? { prompts: Object.fromEntries(filled.map((p) => [p.key.trim(), p.value])) } : {}),
    };
    // Eingegebene Werte sofort aus dem Formular nehmen, bevor die Antwort da ist.
    setPrompts((l) => l.map((p) => ({ ...p, value: "" })));
    const res = await run.run(body);
    if (!res) return;
    setResult(res);
    if (res.status === "needs-input") {
      setPrompts((l) => {
        const have = new Set(l.map((p) => p.key));
        return [...l, ...res.keys.filter((k) => !have.has(k)).map((k) => ({ key: k, value: "" }))];
      });
    } else toast.success(t("dev.fileWritten"));
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionLabel>{t("dev.createFile")}</SectionLabel>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-4 space-y-4">
            <Field label={t("dev.repository")} htmlFor={repoId}>
              <RepoPicker id={repoId} required value={f.repo} onChange={(v) => set("repo", v)} />
            </Field>
            <TextField label={t("dev.filePath")} hint={linked ? t("dev.filePathHintLinked", { folder: linked }) : t("dev.filePathHintFree")} required={!linked} value={f.path} onChange={(e) => set("path", e.target.value)} autoComplete="off" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label={t("dev.stage")} value={stageId} onChange={(e) => set("stage", e.target.value)}>
                {defs.map((d) => <option key={d.id} value={d.id}>{labelOf(defs, d.id)}</option>)}
              </SelectField>
              <TextField label={t("dev.template")} hint={t("dev.templateHint")} value={f.template} onChange={(e) => set("template", e.target.value)} autoComplete="off" />
            </div>
            <Checkbox checked={overwrite} onChange={setOverwrite}>{t("dev.overwrite")}</Checkbox>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("dev.ownInputs")}</legend>
              <p className="text-xs text-muted">{t("dev.ownInputsHint")}</p>
              {prompts.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input aria-label={t("dev.keyAria", { n: i + 1 })} placeholder={t("dev.keyPlaceholder")} value={p.key} onChange={(e) => setPrompts((l) => l.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className={`${inputClass} font-mono`} autoComplete="off" />
                  <input aria-label={t("dev.inputFor", { key: p.key || t("dev.keyAria", { n: i + 1 }) })} type="password" autoComplete="off" spellCheck={false} placeholder={t("dev.valuePlaceholder")} value={p.value} onChange={(e) => setPrompts((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${inputClass} font-mono`} />
                  <button type="button" aria-label={t("dev.inputRemove", { n: i + 1 })} onClick={() => setPrompts((l) => l.filter((_, j) => j !== i))} className="rounded-xl p-2 text-muted hover:bg-page"><Icon name="trash" className="h-4 w-4" /></button>
                </div>
              ))}
              <Button variant="ghost" onClick={() => setPrompts((l) => [...l, { key: "", value: "" }])}><Icon name="plus" />{t("dev.inputAdd")}</Button>
            </fieldset>

            {run.error ? <Notice tone="danger">{run.error.message}</Notice> : null}
            <Button type="submit" variant="primary" loading={run.pending}><Icon name="terminal" />{t("dev.createFile")}</Button>
          </form>
        </Card>

        <div className="space-y-4">
          {result?.status === "needs-input" ? (
            <Notice tone="warn" title={t("dev.missingInputs")}>
              {result.message}
              <ul className="mt-2 flex flex-wrap gap-1">{result.keys.map((k) => <li key={k}><code className="rounded bg-card px-1.5 py-0.5 text-xs">{k}</code></li>)}</ul>
              <p className="mt-2">{t("dev.fieldsShown")}</p>
            </Notice>
          ) : null}
          {result?.status === "written" ? (
            <Card>
              <SectionLabel>{t("dev.result")}</SectionLabel>
              <p className="mt-3 flex items-center gap-2 text-sm font-medium text-success-text"><Icon name="check" />{t("dev.writtenTo")} <span className="break-all font-mono">{result.path}</span></p>
              <ul className="mt-3 divide-y divide-line text-sm">
                {result.keys.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-3 py-2"><code className="text-xs">{k}</code><Badge info={{ label: SOURCE_KEYS[result.sources[k] ?? ""] ? t(SOURCE_KEYS[result.sources[k] ?? ""]!) : (result.sources[k] ?? t("dev.srcUnknown")), tone: "neutral", icon: "dot" }} /></li>
                ))}
              </ul>
              {result.warnings.length > 0 ? <div className="mt-3 space-y-2">{result.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}</div> : null}
            </Card>
          ) : null}
          {!result ? <Notice tone="info" title={t("dev.hint")}>{t("dev.hintText")}</Notice> : null}
        </div>
      </div>
    </>
  );
}

interface TemplateEntry {
  key: string;
  source: "default" | "generate" | "issue" | "prompt" | "variable";
  description: string | null;
  value?: string;
  variable?: string;
  secret?: string;
}
interface Template {
  id: string;
  repo: string;
  stage: string;
  file: string;
  entries: TemplateEntry[];
}

const SOURCE_TONE: Record<TemplateEntry["source"], "neutral" | "primary" | "warn" | "info" | "ki"> = { default: "neutral", generate: "primary", issue: "ki", prompt: "warn", variable: "info" };

function entryDetail(e: TemplateEntry, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (e.source === "default") return t("dev.detailValue", { value: e.value ?? "" });
  if (e.source === "variable") return t("dev.detailVariable", { name: e.variable ?? "?" });
  if (e.source === "issue") return t("dev.detailSecret", { name: e.secret ?? "?" });
  if (e.source === "prompt") return t("dev.detailPrompt");
  return t("dev.detailGenerated");
}

function TemplateCard({ t: tpl }: { t: Template }) {
  const t = useT();
  const toast = useToast();
  const [typed, setTyped] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const repoList = useRepoList();
  // Ist das Repository verknuepft, kommt der Pfad vorbelegt aus dem Ordner. Eigene Eingabe geht vor.
  const folder = repoList.data?.repos.find((r) => r.name === tpl.repo)?.link?.path ?? null;
  const path = typed ?? defaultEnvPath(folder, tpl.file) ?? "";
  const setPath = (v: string) => setTyped(v);
  const promptKeys = tpl.entries.filter((e) => e.source === "prompt").map((e) => e.key);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DevEnvResult | null>(null);
  const run = useMutation(async (body: unknown) => api<DevEnvResult>("POST", "env-export", body));

  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => promptKeys.includes(k) && v !== ""));
    setValues({});
    const res = await run.run({ repo: tpl.repo, stage: tpl.stage, template: tpl.id, path: path.trim(), overwrite, ...(Object.keys(filled).length ? { prompts: filled } : {}) });
    if (!res) return;
    setResult(res);
    if (res.status === "written") toast.success(t("dev.fileWritten"));
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{tpl.repo}</p>
          <p className="text-xs text-muted">{t("dev.templateAndFile", { id: tpl.id, file: tpl.file })}</p>
        </div>
        <StageBadge stage={tpl.stage} />
      </div>
      <ul className="mt-3 divide-y divide-line text-sm">
        {tpl.entries.map((e) => (
          <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <code className="text-xs">{e.key}</code>
              {e.description ? <p className="text-xs text-muted-text">{e.description}</p> : null}
              <p className="text-xs text-muted-text">{entryDetail(e, t)}</p>
            </div>
            <Badge info={{ label: SOURCE_KEYS[e.source] ? t(SOURCE_KEYS[e.source]!) : e.source, tone: SOURCE_TONE[e.source], icon: e.source === "prompt" ? "hand" : "dot" }} />
          </li>
        ))}
      </ul>
      <form onSubmit={(ev) => { ev.preventDefault(); void submit(); }} className="mt-4 space-y-3 border-t border-line pt-4">
        <TextField label={t("dev.filePath")} hint={folder && typed === null ? t("dev.filePathFromLink") : t("dev.filePathHintTpl")} required value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" />
        {promptKeys.map((k) => (
          <div key={k} className="space-y-1">
            <label htmlFor={`p-${tpl.id}-${k}`} className="block text-sm font-medium">{t("dev.promptRequired", { key: k })}</label>
            <input id={`p-${tpl.id}-${k}`} type="password" autoComplete="off" spellCheck={false} value={values[k] ?? ""} onChange={(e) => setValues((o) => ({ ...o, [k]: e.target.value }))} className={`${inputClass} font-mono`} />
          </div>
        ))}
        <Checkbox checked={overwrite} onChange={setOverwrite}>{t("dev.overwrite")}</Checkbox>
        {run.error ? <Notice tone="danger">{run.error.message}</Notice> : null}
        {result?.status === "needs-input" ? <Notice tone="warn" title={t("dev.missingInputs")}>{t("dev.missingList", { message: result.message, keys: result.keys.join(", ") })}</Notice> : null}
        {result?.status === "written" ? (
          <Notice tone="success" title={t("dev.written")}>
            <span className="break-all font-mono">{result.path}</span>
            <span className="block text-xs">{t("dev.keysList", { keys: result.keys.join(", ") })}</span>
            {result.warnings.map((w, i) => <span key={i} className="mt-1 block">{w}</span>)}
          </Notice>
        ) : null}
        <Button type="submit" variant="primary" loading={run.pending}><Icon name="terminal" />{t("dev.createFile")}</Button>
      </form>
    </Card>
  );
}

export default function DevPage() {
  const t = useT();
  const q = useQuery<Template[]>("dev-templates", () => api<Template[]>("GET", "dev-templates"));
  return (
    <>
      <PageHeader title={t("dev.title")} subtitle={t("dev.subtitle")} />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <Skeleton className="h-48" /> : null}
      {q.data && q.data.length === 0 ? <EmptyState title={t("dev.noTemplates")} icon="terminal">{t("dev.noTemplatesText")}</EmptyState> : null}
      <div className="grid gap-6 lg:grid-cols-2">{(q.data ?? []).map((tpl) => <TemplateCard key={tpl.id} t={tpl} />)}</div>
      <details className="mt-8 rounded-2xl border border-line bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">{t("dev.freeExport")}</summary>
        <div className="mt-4"><FreeExport /></div>
      </details>
    </>
  );
}
