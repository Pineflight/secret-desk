"use client";
import { useState } from "react";
import { Button, Pill } from "@/components/ui";
import { CheckList, type CheckResult } from "@/components/ConnectionCheck";
import { api, enc } from "@/lib/api";
import { expiryLevel } from "@/lib/connection-health";
import { clockTime, isLineBusy, lastResult } from "@/lib/card-activity";
import { useCardActivity } from "@/lib/use-card-activity";
import { BusySpinner, ResultMark } from "@/components/ProviderCards";
import { useT } from "@/lib/i18n";
import { capitalized, lineExpiry, type AccountBlock, type AccountLine, type ConnectionLines as Lines } from "@/lib/provider-cards";

const MODE_KEY: Record<string, string> = { sandbox: "providers.mode.sandbox", test: "providers.mode.sandbox", live: "providers.mode.live" };

/**
 * The connections of a vendor with keys per account and mode (Stripe): one block per account with a row for sandbox and one for
 * live. A connected row shows its expiry and Test, Reconnect, Remove; a missing one says so and offers to connect exactly that
 * mode. Older connections are folded under one disclosure with the hint to replace them. A key value is never shown.
 */
export function ConnectionLinesList({ lines, blocks, cardId, onReconnect, onConnectMode, onConnectAnother, onRemove, onOpen, removingId }: { lines: Lines; blocks: AccountBlock[]; cardId: string; onReconnect?: (line: AccountLine) => void; onConnectMode?: (accountId: string, mode: "sandbox" | "live") => void; onConnectAnother?: () => void; onRemove: (id: string) => void | Promise<void>; onOpen: (id: string) => void; removingId: string | null }) {
  const t = useT();
  return (
    <div>
      {blocks.length > 0 ? (
        <ul className="space-y-2">
          {blocks.map((b) => (
            <li key={b.accountId} className="min-w-0 rounded-xl border border-line p-3">
              <p className="text-sm font-medium">{t("providers.account.title", { account: b.account })}</p>
              <p className="text-xs text-muted">{t("providers.account.hint")}</p>
              <ul className="mt-2 space-y-2">
                {(["sandbox", "live"] as const).map((mode) => {
                  const l = b.modes[mode];
                  return l ? (
                    <AccountLineItem key={l.id} cardId={cardId} line={l} {...(onReconnect ? { onReconnect } : {})} onRemove={onRemove} removing={removingId === l.id} />
                  ) : (
                    <li key={mode} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line px-3 py-2">
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        <Pill>{t(MODE_KEY[mode]!)}</Pill>
                        <span className="text-muted">{t("providers.account.missing", { mode: t(MODE_KEY[mode]!) })}</span>
                      </span>
                      {onConnectMode ? <Button aria-label={t("providers.account.connectModeLabel", { account: b.account, mode: t(MODE_KEY[mode]!) })} onClick={() => onConnectMode(b.accountId, mode)}>{t("providers.account.connectMode", { mode: t(MODE_KEY[mode]!) })}</Button> : null}
                    </li>
                  );
                })}
                {b.other.map((l) => <AccountLineItem key={l.id} cardId={cardId} line={l} {...(onReconnect ? { onReconnect } : {})} onRemove={onRemove} removing={removingId === l.id} />)}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {onConnectAnother ? <div className="mt-3 flex flex-wrap gap-2"><Button onClick={onConnectAnother}>{t(blocks.length > 0 ? "providers.line.connectAnother" : "providers.line.connect")}</Button></div> : null}
      {lines.legacy ? (
        <details className="mt-3 rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("providers.account.legacyTitle", { count: lines.legacy.ids.length })}</summary>
          <p className="mt-1 break-words text-xs text-muted">{lines.legacy.labels.join(", ")}</p>
          <p className="mt-1 text-xs text-muted">{t("providers.keys.legacyHint")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => onOpen(lines.legacy!.ids[0]!)}>{t("providers.line.details")}</Button>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function AccountLineItem({ cardId, line, onReconnect, onRemove, removing }: { cardId: string; line: AccountLine; onReconnect?: (line: AccountLine) => void; onRemove: (id: string) => void | Promise<void>; removing: boolean }) {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const activity = useCardActivity();
  const busy = isLineBusy(activity.state, cardId, line.id);
  const last = lastResult(activity.state, cardId, line.id);
  // The expiry the provider reports replaces the stored one while the test result is visible.
  const expires = result && result.expires !== undefined ? result.expires : line.expires;
  const daysLeft = typeof expires === "string" ? Math.ceil((Date.parse(`${expires}T00:00:00Z`) - Date.now()) / 86_400_000) : line.daysLeft;
  const level = result && result.expires !== undefined ? expiryLevel(daysLeft) : line.level;
  const bad = level === "critical" || level === "expired";
  const name = `${line.account}${line.mode ? ` ${MODE_KEY[line.mode] ? t(MODE_KEY[line.mode]!) : capitalized(line.mode)}` : ""}`;
  return (
    <li className="min-w-0 rounded-lg border border-line p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        {line.mode ? <Pill>{MODE_KEY[line.mode] ? t(MODE_KEY[line.mode]!) : capitalized(line.mode)}</Pill> : <span className="min-w-0 break-words">{line.account}</span>}
        <span className="font-normal text-muted">{t("providers.account.keyConnected")}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
        <span className={bad ? "font-medium text-danger" : level === "soon" ? "font-medium text-warn-text" : ""}>{lineExpiry({ expires, daysLeft }, t)}</span>
        {busy ? <BusySpinner label={t("activity.running", { name })} /> : last ? <ResultMark result={last} label={t(last.ok ? "activity.lastOk" : "activity.lastFail", { time: clockTime(last.at) })} /> : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button loading={busy} aria-label={t("providers.line.testLabel", { name })} onClick={() => void activity.track({ card: cardId, kind: "test", line: line.id, name, work: () => api<CheckResult>("POST", `connections/${enc(line.id)}/check`, {}), judge: (r) => ({ ok: r.ok, detail: r.checks.find((c) => c.status === "fail")?.label ?? null }) }).then((r) => { if (r) setResult(r); })}>{t("providers.line.test")}</Button>
        {onReconnect ? <Button aria-label={t("providers.line.reconnectLabel", { name })} onClick={() => onReconnect(line)}>{t("providers.line.reconnect")}</Button> : null}
        <Button loading={removing} aria-label={t("providers.line.removeLabel", { name })} onClick={() => void onRemove(line.id)}>{t("providers.line.remove")}</Button>
      </div>
      {result ? (
        <div className="mt-1">
          <CheckList result={result} />
          <button type="button" className="mt-1 text-xs text-muted underline" onClick={() => setResult(null)}>{t("connections.testClose")}</button>
        </div>
      ) : null}
    </li>
  );
}
