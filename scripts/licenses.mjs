#!/usr/bin/env node
// Erzeugt THIRD-PARTY-NOTICES.md und apps/desk/third-party.json aus den installierten Produktionsabhaengigkeiten (ohne Netz).
//   node scripts/licenses.mjs           schreiben
//   node scripts/licenses.mjs --check   nichts schreiben: Lizenzrichtlinie pruefen (Exit 1 bei verbotener/unbekannter Lizenz, Warnung bei Abweichungen)
//                                       und pruefen, dass die erzeugten Dateien aktuell sind
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, policyReport, renderJson, renderNotices } from "./licenses-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = collect(root);
const entries = data.entries;
const notices = renderNotices(data);
const json = renderJson(data);
const report = policyReport(data);
for (const e of report.warn) console.warn(`warnung: ${e.name}@${e.version} hat die Lizenz ${e.license} (${e.status}): bitte pruefen`);
for (const e of report.fail) console.error(`FEHLER: ${e.name}@${e.version} hat eine verbotene oder unbekannte Lizenz: ${e.license}`);

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [file, text] of [["THIRD-PARTY-NOTICES.md", notices], ["apps/desk/third-party.json", json]]) {
    let current = "";
    try { current = readFileSync(join(root, file), "utf8"); } catch { /* fehlt */ }
    if (current !== text) { console.error(`FEHLER: ${file} ist nicht aktuell. Mit "node scripts/licenses.mjs" neu erzeugen.`); stale = true; }
  }
  process.exit(report.ok && !stale ? 0 : 1);
}
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), notices);
writeFileSync(join(root, "apps/desk/third-party.json"), json);
console.log(`${entries.length} Komponenten, ${report.warn.length} Warnungen, ${report.fail.length} Fehler`);
process.exit(report.ok ? 0 : 1);
