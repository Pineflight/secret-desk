"use client";
import { useState } from "react";
import { Button, Notice, Pill } from "@/components/ui";
import { CheckList, type CheckResult } from "@/components/ConnectionCheck";
import { api, enc } from "@/lib/api";
import { expiryLevel } from "@/lib/connection-health";
import { useMutation } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { capitalized, lineExpiry, type AccountLine, type ConnectionLines as Lines } from "@/lib/provider-cards";

const MODE_KEY: Record<string, string> = { sandbox: "providers.mode.sandbox", test: "providers.mode.sandbox", live: "providers.mode.live" };

/**
 * The connections of a vendor with several accounts, one compact line each: account, mode, state and the actions Test, Reconnect
 * and Remove. Older connections are one line with the hint to replace them. A key value is never shown.
 */
export function ConnectionLinesList({ lines, onReconnect, onConnectAnother, onRemove, onOpen, removingId }: { lines: Lines; onReconnect?: (line: AccountLine) => void; onConnectAnother?: () => void; onRemove: (id: string) => void | Promise<void>; onOpen: (id: string) => void; removingId: string | null }) {
  const t = useT();
  return (
    <div>
      {lines.accounts.length > 0 || lines.legacy ? (
        <ul className="space-y-2">
          {lines.accounts.map((l) => <AccountLineItem key={l.id} line={l} {...(onReconnect ? { onReconnect } : {})} onRemove={onRemove} removing={removingId === l.id} />)}
          {lines.legacy ? (
            <li className="min-w-0 rounded-xl border border-line p-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                <Pill>{t("providers.keys.legacy")}</Pill>
                <span className="min-w-0 break-words">{lines.legacy.labels.join(", ")}</span>
              </p>
              <p className="mt-1 text-xs text-muted">{t("providers.keys.legacyHint")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => onOpen(lines.legacy!.ids[0]!)}>{t("providers.line.details")}</Button>
              </div>
            </li>
          ) : null}
        </ul>
      ) : null}
      {onConnectAnother ? <div className="mt-3 flex flex-wrap gap-2"><Button onClick={onConnectAnother}>{t(lines.accounts.length > 0 ? "providers.line.connectAnother" : "providers.line.connect")}</Button></div> : null}
    </div>
  );
}

function AccountLineItem({ line, onReconnect, onRemove, removing }: { line: AccountLine; onReconnect?: (line: AccountLine) => void; onRemove: (id: string) => void | Promise<void>; removing: boolean }) {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const run = useMutation(async () => api<CheckResult>("POST", `connections/${enc(line.id)}/check`, {}));
  // The expiry the provider reports replaces the stored one while the test result is visible.
  const expires = result && result.expires !== undefined ? result.expires : line.expires;
  const daysLeft = typeof expires === "string" ? Math.ceil((Date.parse(`${expires}T00:00:00Z`) - Date.now()) / 86_400_000) : line.daysLeft;
  const level = result && result.expires !== undefined ? expiryLevel(daysLeft) : line.level;
  const bad = level === "critical" || level === "expired";
  const name = `${line.account}${line.mode ? ` ${MODE_KEY[line.mode] ? t(MODE_KEY[line.mode]!) : capitalized(line.mode)}` : ""}`;
  return (
    <li className="min-w-0 rounded-xl border border-line p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <span className="min-w-0 break-words">{line.account}</span>
        {line.mode ? <Pill>{MODE_KEY[line.mode] ? t(MODE_KEY[line.mode]!) : capitalized(line.mode)}</Pill> : null}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
        <span>{t("providers.line.connected")}</span>
        <span className={bad ? "font-medium text-danger" : level === "soon" ? "font-medium text-warn-text" : ""}>{lineExpiry({ expires, daysLeft }, t)}</span>
        {result ? <span role="status">{t(result.ok ? "providers.line.testOk" : "providers.line.testProblems")}</span> : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button loading={run.pending} aria-label={t("providers.line.testLabel", { name })} onClick={() => void run.run().then((r) => { if (r) setResult(r); })}>{t("providers.line.test")}</Button>
        {onReconnect ? <Button aria-label={t("providers.line.reconnectLabel", { name })} onClick={() => onReconnect(line)}>{t("providers.line.reconnect")}</Button> : null}
        <Button loading={removing} aria-label={t("providers.line.removeLabel", { name })} onClick={() => void onRemove(line.id)}>{t("providers.line.remove")}</Button>
      </div>
      {run.error ? <div className="mt-2"><Notice tone="danger">{run.error.message}</Notice></div> : null}
      {result ? (
        <div className="mt-1">
          <CheckList result={result} />
          <button type="button" className="mt-1 text-xs text-muted underline" onClick={() => setResult(null)}>{t("connections.testClose")}</button>
        </div>
      ) : null}
    </li>
  );
}
