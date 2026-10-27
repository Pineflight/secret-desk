"use client";
import { useState } from "react";
import { Badge, Button, Checkbox, Notice } from "@/components/ui";
import { api, enc } from "@/lib/api";
import { daysLabel, formatDate } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { checkInfo } from "@/lib/status";

export interface CheckItem {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail?: string;
}
export interface CheckResult {
  id: string;
  ok: boolean;
  checks: CheckItem[];
  expires?: string | null;
  scopes?: string[];
}
interface WriteTarget {
  id: string;
  repo: string;
  scope: string;
  environment: string | null;
  live: boolean;
  stages: string[];
}

const daysLeft = (day: string): number => Math.ceil((Date.parse(`${day}T00:00:00Z`) - Date.now()) / 86_400_000);

/** Knopf "Verbindung testen" mit Ergebnisliste. Meldet das vom Anbieter genannte Ablaufdatum an die Karte. */
export function ConnectionCheckPanel({ id, onResult }: { id: string; onResult: (r: CheckResult | null) => void }) {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const run = useMutation(async (body: { deep?: boolean; targets?: string[] }) => api<CheckResult>("POST", `connections/${enc(id)}/check`, body));
  const exec = async (body: { deep?: boolean; targets?: string[] }) => {
    const r = await run.run(body);
    if (r) {
      setResult(r);
      onResult(r);
    }
  };
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={run.pending} onClick={() => void exec({})}>{run.pending ? t("connections.testRunning") : t("connections.test")}</Button>
        {result ? <button type="button" className="text-xs text-muted underline" onClick={() => { setResult(null); onResult(null); }}>{t("connections.testClose")}</button> : null}
      </div>
      {run.error ? <div className="mt-3"><Notice tone="danger">{run.error.message}</Notice></div> : null}
      {result ? <CheckList result={result} /> : null}
      {id === "github" ? <WriteTest busy={run.pending} onRun={(targets) => exec({ deep: true, targets })} /> : null}
    </div>
  );
}

function CheckList({ result }: { result: CheckResult }) {
  const t = useT();
  return (
    <div className="mt-3 text-sm" role="status">
      <Notice tone={result.ok ? "success" : "danger"}>{result.ok ? t("connections.testOk") : t("connections.testProblems")}</Notice>
      <ul className="mt-2 divide-y divide-line">
        {result.checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
            <Badge info={{ ...checkInfo(c.status) }} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.label}</p>
              {c.detail ? <p className="break-words text-xs text-muted">{c.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {result.expires !== undefined ? (
        <p className="mt-2 text-xs text-muted">{result.expires === null ? t("connections.testNoExpiry") : t("connections.testExpires", { date: formatDate(result.expires), days: daysLabel(daysLeft(result.expires)) })}</p>
      ) : null}
      {result.scopes && result.scopes.length > 0 ? <p className="mt-1 break-words text-xs text-muted">{t("connections.testScopes", { scopes: result.scopes.join(", ") })}</p> : null}
    </div>
  );
}

/** Aufklappbarer Schreibtest: Ziele aus dem Inventar, Live-Ziele nie vorausgewaehlt. */
function WriteTest({ busy, onRun }: { busy: boolean; onRun: (targets: string[]) => Promise<void> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);
  const targets = useQuery<WriteTarget[]>(open ? "github-write-targets" : null, () => api<WriteTarget[]>("GET", "connections/github/write-targets"));
  const list = targets.data ?? [];
  const sel = picked ?? Object.fromEntries(list.map((x) => [x.id, !x.live]));
  const chosen = list.filter((x) => sel[x.id]).map((x) => x.id);
  return (
    <details className="mt-3 rounded-xl border border-line p-3" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm font-medium">{t("connections.writeTitle")}</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-muted">{t("connections.writeIntro")}</p>
        {targets.error ? <Notice tone="danger">{targets.error.message}</Notice> : null}
        {open && targets.data && list.length === 0 ? <p className="text-muted">{t("connections.writeNone")}</p> : null}
        {list.length > 0 ? (
          <ul className="space-y-2">
            {list.map((x) => (
              <li key={x.id}>
                <Checkbox checked={Boolean(sel[x.id])} onChange={(v) => setPicked({ ...sel, [x.id]: v })}>
                  <span className="font-mono text-xs">{x.id}</span>
                  {x.live ? <span className="ml-2 inline-block rounded-full bg-danger-light px-2 py-0.5 text-xs font-medium text-danger-text">{t("connections.writeLive")}</span> : null}
                </Checkbox>
              </li>
            ))}
          </ul>
        ) : null}
        {list.some((x) => x.live) ? <Notice tone="warn">{t("connections.writeLiveWarn")}</Notice> : null}
        <p className="text-xs text-muted">{t("connections.writeHint")}</p>
        {list.length > 0 && chosen.length === 0 ? <p className="text-xs text-muted">{t("connections.writeSelect")}</p> : null}
        <Button variant="primary" loading={busy} disabled={chosen.length === 0} onClick={() => void onRun(chosen)}>{t("connections.writeRun")}</Button>
      </div>
    </details>
  );
}
