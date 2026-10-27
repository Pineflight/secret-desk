import type { RepoList } from "@secret-desk/runtime";

/** Reine Logik fuer die Repository-Auswahl und die Repo-Seite (ohne React, ohne Netz). */

export type RepoSource = "inventory" | "github" | "linked";

export interface RepoSuggestion {
  name: string;
  sources: RepoSource[];
}

/** Macht aus der Serverliste Vorschlaege: Inventar, GitHub live, lokal verknuepft. */
export function buildSuggestions(list: Pick<RepoList, "repos"> | null | undefined): RepoSuggestion[] {
  return (list?.repos ?? []).map((r) => {
    const sources: RepoSource[] = [];
    if (r.inInventory) sources.push("inventory");
    if (r.github) sources.push("github");
    if (r.link) sources.push("linked");
    return { name: r.name, sources };
  });
}

/** Filtert beim Tippen: genaue Treffer zuerst, dann Praefix, dann Teilstring; sonst alphabetisch. Leere Eingabe zeigt alles. */
export function filterSuggestions(all: RepoSuggestion[], query: string, limit = 8): RepoSuggestion[] {
  const q = query.trim().toLowerCase();
  const rank = (n: string): number => {
    const l = n.toLowerCase();
    if (l === q) return 0;
    if (l.startsWith(q)) return 1;
    return l.includes(q) ? 2 : 3;
  };
  return all
    .filter((s) => q === "" || rank(s.name) < 3)
    .sort((a, b) => (q === "" ? 0 : rank(a.name) - rank(b.name)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Vorbelegter Dateipfad: verknuepfter Ordner plus Dateiname der Vorlage. */
export function defaultEnvPath(folder: string | null | undefined, file: string): string | null {
  if (!folder) return null;
  // Windows-Pfade (C:\\Users\\x\\proj) behalten ihr Trennzeichen.
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${file.replace(/^[\\/]+/, "")}`;
}

export type LinkState = "none" | "missing" | "ok" | "mismatch" | "no-remote";

/** Zustand einer Verknuepfung fuer die Statusspalte. */
export function linkState(link: { exists: boolean; remote: string | null; remoteMatches: boolean | null } | null | undefined): LinkState {
  if (!link) return "none";
  if (!link.exists) return "missing";
  if (link.remote === null) return "no-remote";
  return link.remoteMatches === false ? "mismatch" : "ok";
}
