"use client";
import { useState, type FormEvent } from "react";
import { ApiError, ensureSession, type SessionInfo } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { parseLaunchInput } from "@/lib/launch";
import { Button, Notice, TextField } from "./ui";

/** Eingabe der Startadresse auf der Startseite: niemand muss ?launch= von Hand an die Adresse haengen. Der Wert bleibt nur im Speicher. */
export function LaunchForm({ onSession }: { onSession: (s: SessionInfo) => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const launch = parseLaunchInput(input);
    if (!launch) {
      setError(t("common.launch.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await ensureSession(true, launch);
      setInput("");
      onSession(s);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "launch-required" ? t("common.launch.wrong") : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Notice tone="warn" title={t("common.err.launchTitle")}>
      <p>{t("common.err.launch")}</p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <TextField label={t("common.launch.label")} placeholder={t("common.launch.placeholder")} value={input} onChange={(e) => setInput(e.target.value)} type="password" autoComplete="off" spellCheck={false} autoFocus />
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!input.trim()}>{t("common.launch.submit")}</Button>
      </form>
      {error ? <p role="alert" className="mt-3 text-danger-text">{error}</p> : null}
    </Notice>
  );
}
