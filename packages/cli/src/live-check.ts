import { connect } from "node:net";
import { parseArgs } from "node:util";
import { createRuntime, getLiveCheck, runLiveCheck, type LiveCheckReport } from "@secret-desk/runtime";
import type { Io } from "./index.js";

const tag = (result: string): string => `[${result.padEnd(13)}]`;

/** One line per item that is not simply fine. Ids, results, step labels and sanitized texts only, never a value. */
function problemLines(report: LiveCheckReport): string[] {
  const lines: string[] = [];
  for (const c of report.connections) if (c.result !== "ok") lines.push(`${tag(c.result)} Verbindung ${c.id}${c.detail ? `: ${c.detail}` : ""}`);
  for (const r of report.recipes) {
    if (r.result === "ok") continue;
    const where = [r.step, r.kind].filter(Boolean).join(", ");
    lines.push(`${tag(r.result)} Rezept ${r.id}${where ? ` (${where})` : ""}${r.detail ? `: ${r.detail}` : ""}`);
  }
  return lines;
}

const PORT_PROBE_TIMEOUT_MS = 500;

/** Does something accept connections on this port of the local machine? A short TCP connect; no data is sent. */
function listensOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * `secret-desk live-check --config <file> [--json] [--run] [--strict]`: prints the last live check report. Exit 1 when it failed, when there
 * is none, or when it is older than twice the interval (`automation.liveCheckDays`); 0 otherwise. With `--run` a check runs in this
 * process first. It uses the configured browser, so it is refused while something listens on the portal port of the configuration
 * (a running portal would drive the same browser: use its *Check now* button).
 */
export async function liveCheckCmd(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" }, json: { type: "boolean" }, run: { type: "boolean" }, strict: { type: "boolean" } } });
  if (!values.config) throw new Error("live-check --config <datei> [--json] [--run] [--strict]");
  // The reports live in the data directory next to the sign-in memory, shared with the portal.
  const rt = await createRuntime(values.config, { persistSignIn: true });
  if (values.run) {
    if (await listensOn(rt.config.server.port)) {
      io.err(`live-check --run ist nicht moeglich: auf 127.0.0.1:${rt.config.server.port} laeuft bereits ein Portal. Dort den Knopf "Jetzt pruefen" (Integrationen, Live-Check) benutzen, sonst steuern zwei Laeufe denselben Browser.`);
      return 2;
    }
    await runLiveCheck(rt, { trigger: "manual", log: () => undefined });
    await rt.automation.flushLiveCheck();
  }
  const { reports, stale, intervalDays } = getLiveCheck(rt);
  const last = reports[0];
  // Recipes that need a sign-in could not be checked: the report stays ok, but with --strict this counts as a failure.
  const unchecked = last?.summary.recipes.needsSignIn ?? 0;
  const reason = last === undefined ? "none" : !last.ok ? "failed" : stale ? "stale" : values.strict && unchecked > 0 ? "needs-sign-in" : null;
  if (values.json) {
    io.out(JSON.stringify({ ok: reason === null, reason, intervalDays, needsSignIn: unchecked, report: last ?? null }));
    return reason === null ? 0 : 1;
  }
  if (last === undefined) {
    io.out("Noch kein Live-Check-Bericht. Mit --run oder im Portal (Integrationen, Live-Check) starten.");
    return 1;
  }
  const s = last.summary;
  io.out(`Live-Check ${last.ok ? "in Ordnung" : "FEHLGESCHLAGEN"}: ${last.finishedAt} (${last.trigger === "schedule" ? "automatisch" : "von Hand"})`);
  io.out(`Integrationen: ${s.connections.ok} in Ordnung, ${s.connections.failed} fehlgeschlagen, ${s.connections.notConnected} nicht verbunden`);
  io.out(`Rezepte: ${s.recipes.ok} in Ordnung, ${s.recipes.failed} fehlgeschlagen, ${s.recipes.needsSignIn} brauchen Anmeldung, ${s.recipes.skipped} uebersprungen`);
  for (const l of problemLines(last)) io.out(l);
  if (unchecked > 0) io.out(`WARNUNG: ${unchecked} Rezepte konnten nicht geprueft werden: bitte anmelden.${values.strict || reason !== null ? "" : " (Exit 0; mit --strict ist das ein Fehler.)"}`);
  if (reason === "stale") io.out(`Der letzte Bericht ist aelter als ${intervalDays * 2} Tage (das Doppelte des Intervalls): die geplante Pruefung kommt nicht hinterher.`);
  return reason === null ? 0 : 1;
}
