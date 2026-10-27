"use client";
import { useState } from "react";
import type { DevEnvResult } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Checkbox, Notice, PageHeader, SectionLabel, SelectField, StageBadge, TextField, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { useMutation, useQuery } from "@/lib/hooks";
import { Skeleton, EmptyState, ErrorState } from "@/components/ui";
import { useToast } from "@/lib/toast";

const SOURCE: Record<string, string> = { default: "Standardwert", generate: "zufällig erzeugt", issue: "aus Secret", prompt: "von dir eingegeben", variable: "aus Variable" };

/** Einfaches Formular statt Vorlagen-Parser: Es gibt keinen Listen-Endpunkt für die Dev-Vorlagen. */
function FreeExport() {
  const toast = useToast();
  const [f, setF] = useState({ repo: "", path: "", template: "", stage: "dev" });
  const [overwrite, setOverwrite] = useState(false);
  const [prompts, setPrompts] = useState<{ key: string; value: string }[]>([]);
  const [result, setResult] = useState<DevEnvResult | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  const run = useMutation(async (body: unknown) => api<DevEnvResult>("POST", "env-export", body));

  const submit = async () => {
    const filled = prompts.filter((p) => p.key.trim() && p.value !== "");
    const body = {
      repo: f.repo.trim(),
      path: f.path.trim(),
      stage: f.stage,
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
    } else toast.success("Datei geschrieben.");
  };

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionLabel>Datei erzeugen</SectionLabel>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-4 space-y-4">
            <TextField label="Repository" required value={f.repo} onChange={(e) => set("repo", e.target.value)} autoComplete="off" />
            <TextField label="Pfad der Datei" hint="Absoluter Pfad, zum Beispiel /Users/du/projekte/web-studio/.env.local" required value={f.path} onChange={(e) => set("path", e.target.value)} autoComplete="off" />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Stage" value={f.stage} onChange={(e) => set("stage", e.target.value)}>
                {["dev", "staging", "production", "shared"].map((s) => <option key={s} value={s}>{s}</option>)}
              </SelectField>
              <TextField label="Vorlage (optional)" hint="Kennung der Vorlage, sonst die erste des Repos" value={f.template} onChange={(e) => set("template", e.target.value)} autoComplete="off" />
            </div>
            <Checkbox checked={overwrite} onChange={setOverwrite}>Vorhandene Datei überschreiben</Checkbox>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Eigene Eingaben (optional)</legend>
              <p className="text-xs text-muted">Für Schlüssel, die du selbst angeben musst. Die Werte werden nach dem Absenden aus dem Formular gelöscht.</p>
              {prompts.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input aria-label={`Schlüssel ${i + 1}`} placeholder="SCHLUESSEL_NAME" value={p.key} onChange={(e) => setPrompts((l) => l.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className={`${inputClass} font-mono`} autoComplete="off" />
                  <input aria-label={`Eingabe für ${p.key || `Schlüssel ${i + 1}`}`} type="password" autoComplete="off" spellCheck={false} placeholder="Wert" value={p.value} onChange={(e) => setPrompts((l) => l.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${inputClass} font-mono`} />
                  <button type="button" aria-label={`Eingabe ${i + 1} entfernen`} onClick={() => setPrompts((l) => l.filter((_, j) => j !== i))} className="rounded-xl p-2 text-muted hover:bg-page"><Icon name="trash" className="h-4 w-4" /></button>
                </div>
              ))}
              <Button variant="ghost" onClick={() => setPrompts((l) => [...l, { key: "", value: "" }])}><Icon name="plus" />Eingabe hinzufügen</Button>
            </fieldset>

            {run.error ? <Notice tone="danger">{run.error.message}</Notice> : null}
            <Button type="submit" variant="primary" loading={run.pending}><Icon name="terminal" />Datei erzeugen</Button>
          </form>
        </Card>

        <div className="space-y-4">
          {result?.status === "needs-input" ? (
            <Notice tone="warn" title="Es fehlen Eingaben">
              {result.message}
              <ul className="mt-2 flex flex-wrap gap-1">{result.keys.map((k) => <li key={k}><code className="rounded bg-card px-1.5 py-0.5 text-xs">{k}</code></li>)}</ul>
              <p className="mt-2">Dafür sind links Felder eingeblendet. Fülle sie aus und erzeuge die Datei erneut.</p>
            </Notice>
          ) : null}
          {result?.status === "written" ? (
            <Card>
              <SectionLabel>Ergebnis</SectionLabel>
              <p className="mt-3 flex items-center gap-2 text-sm font-medium text-success-text"><Icon name="check" />Geschrieben nach <span className="break-all font-mono">{result.path}</span></p>
              <ul className="mt-3 divide-y divide-line text-sm">
                {result.keys.map((k) => (
                  <li key={k} className="flex items-center justify-between gap-3 py-2"><code className="text-xs">{k}</code><Badge info={{ label: SOURCE[result.sources[k] ?? ""] ?? result.sources[k] ?? "unbekannt", tone: "neutral", icon: "dot" }} /></li>
                ))}
              </ul>
              {result.warnings.length > 0 ? <div className="mt-3 space-y-2">{result.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}</div> : null}
            </Card>
          ) : null}
          {!result ? <Notice tone="info" title="Hinweis">Die Datei bekommt den Modus 600 und ist nur für dich lesbar. Prüfe, dass sie in der .gitignore steht.</Notice> : null}
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

function entryDetail(e: TemplateEntry): string {
  if (e.source === "default") return `Wert: ${e.value ?? ""}`;
  if (e.source === "variable") return `Variable: ${e.variable ?? "?"}`;
  if (e.source === "issue") return `Secret: ${e.secret ?? "?"}`;
  if (e.source === "prompt") return "Eingabe nötig";
  return "wird zufällig erzeugt";
}

function TemplateCard({ t }: { t: Template }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const promptKeys = t.entries.filter((e) => e.source === "prompt").map((e) => e.key);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DevEnvResult | null>(null);
  const run = useMutation(async (body: unknown) => api<DevEnvResult>("POST", "env-export", body));

  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => promptKeys.includes(k) && v !== ""));
    setValues({});
    const res = await run.run({ repo: t.repo, stage: t.stage, template: t.id, path: path.trim(), overwrite, ...(Object.keys(filled).length ? { prompts: filled } : {}) });
    if (!res) return;
    setResult(res);
    if (res.status === "written") toast.success("Datei geschrieben.");
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t.repo}</p>
          <p className="text-xs text-muted">Vorlage {t.id} · Datei {t.file}</p>
        </div>
        <StageBadge stage={t.stage} />
      </div>
      <ul className="mt-3 divide-y divide-line text-sm">
        {t.entries.map((e) => (
          <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <code className="text-xs">{e.key}</code>
              {e.description ? <p className="text-xs text-muted-text">{e.description}</p> : null}
              <p className="text-xs text-muted-text">{entryDetail(e)}</p>
            </div>
            <Badge info={{ label: SOURCE[e.source] ?? e.source, tone: SOURCE_TONE[e.source], icon: e.source === "prompt" ? "hand" : "dot" }} />
          </li>
        ))}
      </ul>
      <form onSubmit={(ev) => { ev.preventDefault(); void submit(); }} className="mt-4 space-y-3 border-t border-line pt-4">
        <TextField label="Pfad der Datei" hint="Absoluter Pfad, zum Beispiel /Users/du/projekte/repo/.env.local" required value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" />
        {promptKeys.map((k) => (
          <div key={k} className="space-y-1">
            <label htmlFor={`p-${t.id}-${k}`} className="block text-sm font-medium">{k} (Eingabe nötig)</label>
            <input id={`p-${t.id}-${k}`} type="password" autoComplete="off" spellCheck={false} value={values[k] ?? ""} onChange={(e) => setValues((o) => ({ ...o, [k]: e.target.value }))} className={`${inputClass} font-mono`} />
          </div>
        ))}
        <Checkbox checked={overwrite} onChange={setOverwrite}>Vorhandene Datei überschreiben</Checkbox>
        {run.error ? <Notice tone="danger">{run.error.message}</Notice> : null}
        {result?.status === "needs-input" ? <Notice tone="warn" title="Es fehlen Eingaben">{result.message} Fehlend: {result.keys.join(", ")}</Notice> : null}
        {result?.status === "written" ? (
          <Notice tone="success" title="Geschrieben">
            <span className="break-all font-mono">{result.path}</span>
            <span className="block text-xs">Schlüssel: {result.keys.join(", ")}</span>
            {result.warnings.map((w, i) => <span key={i} className="mt-1 block">{w}</span>)}
          </Notice>
        ) : null}
        <Button type="submit" variant="primary" loading={run.pending}><Icon name="terminal" />Datei erzeugen</Button>
      </form>
    </Card>
  );
}

export default function DevPage() {
  const q = useQuery<Template[]>("dev-templates", () => api<Template[]>("GET", "dev-templates"));
  return (
    <>
      <PageHeader title="Dev-Umgebung" subtitle="Erzeugt eine lokale .env-Datei aus der Vorlage eines Repos. Angezeigt werden nur Pfad und Schlüsselnamen, nie Werte." />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <Skeleton className="h-48" /> : null}
      {q.data && q.data.length === 0 ? <EmptyState title="Keine Vorlagen" icon="terminal">Es gibt noch keine Dev-Vorlage. Nutze unten den freien Export.</EmptyState> : null}
      <div className="grid gap-6 lg:grid-cols-2">{(q.data ?? []).map((t) => <TemplateCard key={t.id} t={t} />)}</div>
      <details className="mt-8 rounded-2xl border border-line bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">Andere Vorlage / freier Export</summary>
        <div className="mt-4"><FreeExport /></div>
      </details>
    </>
  );
}
