// Drittlizenzen: sammelt die Produktionsabhaengigkeiten (pnpm, ohne Netz), bewertet ihre Lizenzen gegen eine Allow-Liste
// und erzeugt THIRD-PARTY-NOTICES.md sowie apps/desk/third-party.json (fuer die Seite /about). Deterministisch: sortiert, ohne Pfade, ohne Zeitstempel.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Erlaubt: passt zur MIT-Veroeffentlichung ohne Auflagen ueber die Namensnennung hinaus. */
export const ALLOWED = ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Python-2.0", "Unlicense"];
/** Nur Warnung (Pflichten oder Pruefbedarf): schwaches Copyleft auf Dateiebene. */
export const WARN = ["MPL-2.0"];
/** Verboten: starkes Copyleft oder nicht frei. */
const DENIED = /^(A?GPL|SSPL|BUSL|Commons-Clause|CC-BY-NC|Elastic)/i;

/** Normalisiert die Lizenzangabe einer package.json zu einem SPDX-Ausdruck ("UNKNOWN", wenn keine da ist). */
export function normalizeLicense(pj) {
  const l = pj.license;
  if (typeof l === "string" && l.trim()) return l.trim().replace(/^\((.*)\)$/, "$1");
  if (l && typeof l === "object" && typeof l.type === "string") return l.type;
  if (Array.isArray(pj.licenses) && pj.licenses.length) return pj.licenses.map((x) => (typeof x === "string" ? x : x.type)).filter(Boolean).join(" OR ") || "UNKNOWN";
  return "UNKNOWN";
}

/** Zerlegt "A OR (B AND C)" in einen Baum und bewertet ihn: allowed < warn < review < denied/unknown. Bei OR zaehlt die beste Alternative, bei AND die schlechteste. */
const RANK = { allowed: 0, warn: 1, review: 2, denied: 3, unknown: 3 };
export function classify(expression) {
  const tokens = expression.replace(/[()]/g, " $& ").split(/\s+/).filter(Boolean);
  let i = 0;
  const parseOr = () => {
    let best = parseAnd();
    while (tokens[i] === "OR") {
      i++;
      const r = parseAnd();
      best = RANK[r] < RANK[best] ? r : best;
    }
    return best;
  };
  const parseAnd = () => {
    let worst = parseAtom();
    while (tokens[i] === "AND") {
      i++;
      const r = parseAtom();
      worst = RANK[r] > RANK[worst] ? r : worst;
    }
    return worst;
  };
  const parseAtom = () => {
    const t = tokens[i++];
    if (t === "(") {
      const r = parseOr();
      if (tokens[i] === ")") i++;
      return r;
    }
    if (!t || t === "UNKNOWN" || t === "SEE" || /^unlicensed$/i.test(t)) return "unknown";
    const id = t.replace(/\+$/, "");
    if (ALLOWED.includes(id)) return "allowed";
    if (WARN.includes(id)) return "warn";
    if (DENIED.test(id) && !/^LGPL/i.test(id)) return "denied";
    return "review";
  };
  return parseOr();
}

const PLATFORM = /-(darwin|linux|linuxmusl|win32|freebsd|android|openbsd|netbsd|sunos|wasm32|webcontainers|aix)(-|$)/;

/** Familienname einer plattformspezifischen Binaerabhaengigkeit: "@next/swc-darwin-arm64" -> "@next/swc-*". */
export function platformFamily(name) {
  const m = PLATFORM.exec(name);
  return m ? `${name.slice(0, m.index)}-*` : null;
}

function walk(deps, seen) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    const key = `${name}@${d.version}`;
    if (d.path && !seen.has(key)) seen.set(key, { name, version: d.version, path: d.path });
    walk(d.dependencies, seen);
  }
}

/**
 * Liest alle Produktionsabhaengigkeiten der Workspace-Pakete. pnpm listet auch Pakete, die es nur auf anderen Systemen installiert
 * (plattformspezifische Binaerpakete von Next.js SWC und sharp, optionale Laufzeiten). Sie stehen als Familie (nur Name) im Ergebnis,
 * damit die Dateien auf jedem System gleich sind; die hier gelesenen Lizenzen der Familie dienen nur der Warnung in der Ausgabe.
 * Ein nicht installiertes Paket ohne Plattformsuffix gilt als Familie mit eigenem Namen.
 */
export function collect(root, listJson) {
  const out = listJson ?? JSON.parse(execFileSync("pnpm", ["-r", "list", "--prod", "--depth", "Infinity", "--json"], { cwd: root, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString());
  const seen = new Map();
  for (const p of out) walk(p.dependencies, seen);
  const entries = [];
  const families = new Map();
  const family = (name) => families.get(name) ?? families.set(name, new Set()).get(name);
  for (const { name, version, path } of seen.values()) {
    if (name.startsWith("@secret-desk/")) continue;
    const file = join(path, "package.json");
    const fam = platformFamily(name);
    const installed = existsSync(file);
    const pj = installed ? JSON.parse(readFileSync(file, "utf8")) : null;
    // Pakete mit os/cpu-Einschraenkung sind plattformspezifisch, auch ohne erkennbaren Namenssuffix.
    if (fam || !installed || (pj && (pj.os || pj.cpu))) {
      const set = family(fam ?? name);
      if (pj) set.add(normalizeLicense(pj));
      continue;
    }
    const license = normalizeLicense(pj);
    const repo = typeof pj.repository === "string" ? pj.repository : pj.repository?.url ?? pj.homepage ?? "";
    entries.push({ name, version, license, source: String(repo).replace(/^git\+/, "").replace(/\.git$/, "").replace(/^github:/, "https://github.com/") });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, "en", { numeric: true }));
  const fams = [...families].map(([name, set]) => ({ name, licenses: [...set].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  return { entries: entries.map((e) => ({ ...e, status: classify(e.license) })), families: fams };
}

export function summarize(entries) {
  const by = { allowed: [], warn: [], review: [], denied: [], unknown: [] };
  for (const e of entries) by[e.status].push(e);
  return by;
}

export function renderNotices({ entries, families }) {
  const by = summarize(entries);
  const lines = [
    "# Third-party notices",
    "",
    "secret-desk is MIT licensed (see LICENSE). It uses the open-source components below in production. This file is generated by `node scripts/licenses.mjs` from the installed dependencies; do not edit it by hand.",
    "",
    `Components: ${entries.length}. Not on the allow list (${ALLOWED.join(", ")}): ${by.warn.length + by.review.length + by.denied.length + by.unknown.length}.`,
    "",
    "| Component | Version | License | Source |",
    "|---|---|---|---|",
    ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.license}${e.status === "allowed" ? "" : ` (${e.status})`} | ${e.source || "-"} |`),
    "",
    "## Optional platform-specific binaries",
    "",
    "Next.js and sharp install prebuilt binaries per operating system and CPU. They are optional, differ by system and are listed here by family; check the license of the installed variant in its package.",
    "",
    ...families.map((f) => `- ${f.name}`),
    "",
  ];
  return lines.join("\n");
}

export function renderJson({ entries, families }) {
  return `${JSON.stringify({ components: entries.map(({ name, version, license, source, status }) => ({ name, version, license, source, status })), platformFamilies: families.map((f) => f.name) }, null, 2)}\n`;
}

/** Ergebnis fuer die CI: Exit 1 bei verbotener oder unbekannter Lizenz, Warnungen fuer alles Abweichende (auch bei den Familien, nach den hier gelesenen Lizenzen). */
export function policyReport({ entries, families }) {
  const all = [...entries, ...families.flatMap((f) => (f.licenses.length ? f.licenses.map((l) => ({ name: f.name, version: "(per platform)", license: l, status: classify(l) })) : []))];
  const by = summarize(all);
  const fail = [...by.denied, ...by.unknown];
  const warn = [...by.warn, ...by.review];
  return { fail, warn, ok: fail.length === 0 };
}
