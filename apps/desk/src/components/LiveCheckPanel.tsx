"use client";
import { useEffect, useId, useState } from "react";
import type { LiveCheckConnection, LiveCheckRecipe, LiveCheckReport } from "@secret-desk/runtime";
import { Icon } from "@/components/Icons";
import { Badge, Button, Card, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMutation, useQuery } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { Info } from "@/lib/status";

/** What `GET live-check` returns: the stored reports (newest first) and where the schedule stands. */
export interface LiveCheckState {
  reports: LiveCheckReport[];
  running: boolean;
  intervalDays: number;
  /** The newest report is older than twice the interval, or there is none while the check is on. */
  stale: boolean;
}

const POLL_MS = 3000;

type Result = LiveCheckConnection["result"] | LiveCheckRecipe["result"];
const RESULT_KEY: Record<Result, string> = {
  ok: "liveCheck.result.ok",
  failed: "liveCheck.result.failed",
  "not-connected": "liveCheck.result.notConnected",
  "needs-sign-in": "liveCheck.result.needsSignIn",
  skipped: "liveCheck.result.skipped",
};
const RESULT_BADGE: Record<Result, Pick<Info, "tone" | "icon">> = {
  ok: { tone: "success", icon: "check" },
  failed: { tone: "danger", icon: "x" },
  "not-connected": { tone: "neutral", icon: "info" },
  "needs-sign-in": { tone: "warn", icon: "clock" },
  skipped: { tone: "neutral", icon: "info" },
};
// Failures first, then what needs a person, then the rest.
const ORDER: Record<Result, number> = { failed: 0, "needs-sign-in": 1, skipped: 2, "not-connected": 3, ok: 4 };

interface Row {
  key: string;
  id: string;
  result: Result;
  text: string;
}

function rowsOf(report: LiveCheckReport): Row[] {
  const rows: Row[] = [
    ...report.connections.map((c) => ({ key: `c:${c.id}`, id: c.id, result: c.result as Result, text: c.detail ?? "" })),
    ...report.recipes.map((r) => ({ key: `r:${r.id}`, id: r.id, result: r.result as Result, text: [r.step, r.kind, r.detail].filter(Boolean).join(" · ") })),
  ];
  return rows.sort((a, b) => ORDER[a.result] - ORDER[b.result]);
}

/** The weekly live check: read-only test of every integration and a dry run of every browser recipe against the real accounts. */
export function LiveCheckPanel() {
  const t = useT();
  const [polling, setPolling] = useState(false);
  // null = follow the data (open on its own when something failed); true/false = the person chose.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const detailsId = useId();
  const q = useQuery<LiveCheckState>("live-check", () => api<LiveCheckState>("GET", "live-check"), polling ? { refreshMs: POLL_MS } : {});
  const start = useMutation(() => api<LiveCheckState>("POST", "live-check"));
  const running = q.data?.running === true;
  // Look again every few seconds while a check runs, so the new report shows up without a reload.
  useEffect(() => setPolling(running), [running]);
  const state = q.data;
  const last = state?.reports[0];
  const onCheck = async () => {
    if (await start.run()) {
      setPolling(true);
      q.reload();
    }
  };
  const busy = start.error instanceof ApiError && start.error.status === 409;
  const status: Info | null = !state
    ? null
    : running
      ? { label: t("liveCheck.state.running"), tone: "info", icon: "clock" }
      : !last
        ? { label: t("liveCheck.state.never"), tone: "warn", icon: "alert" }
        : last.ok
          ? { label: t("liveCheck.state.ok"), tone: "success", icon: "check" }
          : { label: t("liveCheck.state.failed"), tone: "danger", icon: "x" };
  const rows = last ? rowsOf(last) : [];
  const problems = rows.filter((r) => r.result === "failed" || r.result === "needs-sign-in").length;
  const open = chosen ?? problems > 0;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-base font-semibold">{t("liveCheck.title")}</h2>
        {status ? <Badge info={status} /> : null}
        <p className="min-w-0 flex-1 text-sm text-muted">
          {last ? t("liveCheck.lastRun", { when: formatDateTime(last.finishedAt), how: t(last.trigger === "schedule" ? "liveCheck.byTimer" : "liveCheck.byHand") }) : null}
        </p>
        <Button variant="ghost" aria-expanded={open} aria-controls={detailsId} onClick={() => setChosen(!open)}>
          <Icon name="chevron" className={`h-4 w-4 shrink-0 text-muted ${open ? "rotate-90" : ""}`} />{t("liveCheck.details")}
        </Button>
        <Button variant="primary" loading={running || start.pending} disabled={!state} onClick={() => void onCheck()}>{t("liveCheck.run")}</Button>
      </div>
      {q.error ? <div className="mt-3"><Notice tone="warn">{t("liveCheck.loadFailed")} <button type="button" className="underline" onClick={q.reload}>{t("common.retry")}</button></Notice></div> : null}
      {start.error ? <div className="mt-3"><Notice tone="warn">{busy ? t("liveCheck.busy") : t("liveCheck.startFailed")}</Notice></div> : null}
      {state?.stale && last ? <div className="mt-3"><Notice tone="warn">{t("liveCheck.stale", { days: state.intervalDays * 2 })}</Notice></div> : null}
      {last && last.summary.recipes.needsSignIn > 0 ? <div className="mt-3"><Notice tone="warn">{t("liveCheck.needsSignInWarn", { count: last.summary.recipes.needsSignIn })}</Notice></div> : null}
      {/* Open on its own when something failed, so the failing integrations are listed right under the bar. */}
      <div id={detailsId} hidden={!open} className="mt-3">
        <p className="max-w-2xl text-sm text-muted">{t("liveCheck.intro")}</p>
        {state && state.intervalDays === 0 ? <p className="mt-2 text-xs text-muted">{t("liveCheck.off")}</p> : null}
        {last ? (
          <>
            <p className="mt-2 text-xs text-muted">
              {t("liveCheck.summary", { ok: last.summary.connections.ok, failed: last.summary.connections.failed, off: last.summary.connections.notConnected, rOk: last.summary.recipes.ok, rFailed: last.summary.recipes.failed, rSign: last.summary.recipes.needsSignIn, rSkipped: last.summary.recipes.skipped })}
            </p>
            <ul className="mt-2 max-h-[50vh] divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">
              {rows.map((row) => (
                <li key={row.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5">
                  <span className="min-w-0 flex-1 font-medium">{row.id}</span>
                  <Badge info={{ label: t(RESULT_KEY[row.result]), ...RESULT_BADGE[row.result] }} />
                  {row.text ? <span className="basis-full text-xs text-muted">{row.text}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Card>
  );
}
