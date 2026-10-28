import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GitHubError, InventoryError, NotConnectedError, ensurePrivateDir, expandHome as expandHomeCore, isPathInside, localPathProblem, writePrivateFile, type RemoteRepo } from "@secret-desk/core";
import type { Runtime } from "./runtime.js";

/**
 * Repositories und ihre lokalen Ordner. Die Verknuepfung Repository -> Ordner ist rechnerspezifisch und steht
 * deshalb in einer lokalen Datei (Standard ~/.secret-desk/repo-links.json, Modus 600), nie im geteilten Inventar.
 */

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor"]);

export interface RepoLinkStatus {
  /** Absoluter Pfad. Fuer Agenten leer (null), sie sehen nur, dass ein Ordner verknuepft ist. */
  path: string | null;
  exists: boolean;
  remote: string | null;
  /** null = nicht pruefbar (kein Ordner, kein origin). */
  remoteMatches: boolean | null;
}

export interface RepoRow {
  name: string;
  secrets: number;
  variables: number;
  templates: number;
  inInventory: boolean;
  github: { private: boolean; archived: boolean; pushedAt: string | null } | null;
  link: RepoLinkStatus | null;
  /** Der Name steht im Inventar, GitHub kennt das Repository unter diesem Namen nicht mehr, wohl aber unter diesem neuen. */
  renamedTo?: string;
}

export interface RepoList {
  owner: string;
  /** ok = live geladen, unavailable = Abruf fehlgeschlagen (still), off = nicht angefragt oder nicht verbunden. */
  github: "ok" | "unavailable" | "off";
  repos: RepoRow[];
}

export interface LinkResult {
  name: string;
  path: string;
  remote: string | null;
  remoteMatches: boolean | null;
  warnings: string[];
}

export interface ScanSuggestion {
  name: string;
  path: string;
  remote: string;
  /** true = genau dieser Ordner ist schon verknuepft. */
  linked: boolean;
}

export function expandHome(p: string): string {
  return expandHomeCore(p, homedir());
}

export function linksPath(rt: Runtime): string {
  return resolve(expandHome(rt.config.linksFile ?? join(homedir(), ".secret-desk", "repo-links.json")));
}

/** Zerlegt eine Git-Remote-URL (https, ssh, scp-Form) in Eigentuemer und Name. */
export function parseGitRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/:]+(?::\d+)?\/|[^@/\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

function remoteMatches(url: string | null, owner: string, name: string): boolean | null {
  if (!url) return null;
  const p = parseGitRemote(url);
  return p !== null && p.owner.toLowerCase() === owner.toLowerCase() && p.repo.toLowerCase() === name.toLowerCase();
}

function gitOrigin(dir: string): Promise<string | null> {
  return new Promise((res) => {
    execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => {
      const url = err ? "" : String(out).trim();
      res(url || null);
    });
  });
}

const isDir = (p: string): Promise<boolean> => stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

// Echt unterhalb (nicht gleich); auf Windows ohne Gross-/Kleinschreibung, Laufwerke muessen passen. Beide Seiten kommen aus `real`.
const strictlyBelow = (base: string, p: string): boolean => isPathInside(base, p);

/** Erlaubte Wurzeln fuer Verknuepfungen: der Home-Ordner und policy.envRoots (jeweils aufgeloest). */
async function allowedBases(rt: Runtime): Promise<string[]> {
  return Promise.all([homedir(), ...rt.config.policy.envRoots.map(expandHome)].map(real));
}

async function readLinks(rt: Runtime): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(linksPath(rt), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { links?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.links ?? {})) if (typeof v === "string" && NAME_RE.test(k)) out[k] = v;
    return out;
  } catch {
    throw new InventoryError("Die Datei mit den Verknuepfungen ist beschaedigt. Bitte pruefen oder loeschen.");
  }
}

async function writeLinks(rt: Runtime, links: Record<string, string>): Promise<void> {
  const file = linksPath(rt);
  await ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writePrivateFile(tmp, `${JSON.stringify({ version: 1, links }, null, 2)}\n`);
  await rename(tmp, file);
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new InventoryError("Der Repository-Name ist ungueltig.");
}

/** Verknuepft ein Repository mit einem Ordner. Prueft Pfad, Git-Ordner und Remote (Remote nur als Warnung). */
export async function setLink(rt: Runtime, name: string, rawPath: string): Promise<LinkResult> {
  checkName(name);
  if (typeof rawPath !== "string" || rawPath.trim() === "") throw new InventoryError("Der Pfad fehlt.");
  const expanded = expandHome(rawPath.trim());
  const pathProblem = localPathProblem(expanded);
  if (pathProblem) throw new InventoryError(pathProblem);
  if (!isAbsolute(expanded)) throw new InventoryError("Der Pfad muss absolut sein (oder mit ~ beginnen).");
  if (!(await exists(expanded))) throw new InventoryError("Ordner existiert nicht.");
  const path = await real(expanded);
  if (!(await isDir(path))) throw new InventoryError("Der Pfad ist kein Ordner.");
  const bases = await allowedBases(rt);
  if (!bases.some((b) => strictlyBelow(b, path))) throw new InventoryError("Der Ordner liegt ausserhalb des Home-Ordners und der erlaubten Ordner (policy.envRoots).");
  if (!(await exists(join(path, ".git")))) throw new InventoryError("Der Ordner ist kein Git-Repository (.git fehlt).");
  const remote = await gitOrigin(path);
  const matches = remoteMatches(remote, rt.owner, name);
  const warnings: string[] = [];
  if (remote === null) warnings.push("Der Ordner hat keinen Remote origin. Ob er zu diesem Repository gehoert, laesst sich nicht pruefen.");
  else if (matches === false) warnings.push(`Der Remote origin (${remote}) zeigt nicht auf ${rt.owner}/${name}.`);
  const links = await readLinks(rt);
  links[name] = path;
  await writeLinks(rt, links);
  return { name, path, remote, remoteMatches: matches, warnings };
}

export async function removeLink(rt: Runtime, name: string): Promise<{ ok: true; removed: boolean }> {
  checkName(name);
  const links = await readLinks(rt);
  const removed = name in links;
  if (removed) {
    delete links[name];
    await writeLinks(rt, links);
  }
  return { ok: true, removed };
}

/**
 * Verknuepfter Ordner eines Repositories oder null. Prueft bei jeder Nutzung erneut, dass der Ordner
 * existiert und noch unter Home oder policy.envRoots liegt (die Datei koennte von Hand geaendert sein).
 */
export async function linkedFolder(rt: Runtime, name: string): Promise<string | null> {
  const stored = (await readLinks(rt))[name];
  if (!stored || !isAbsolute(stored) || !(await isDir(stored))) return null;
  const path = await real(stored);
  const bases = await allowedBases(rt);
  return bases.some((b) => strictlyBelow(b, path)) ? path : null;
}

/** Tiefe 0 = die Wurzel selbst, 2 = Enkel der Wurzel. Ein Git-Ordner wird nicht weiter durchsucht. */
async function* gitDirs(root: string, depth: number): AsyncGenerator<string> {
  if (depth > 2) return;
  if (await exists(join(root, ".git"))) {
    yield root;
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    yield* gitDirs(join(root, e.name), depth + 1);
  }
}

/** Sucht in policy.envRoots (bis Tiefe 2) Git-Ordner, deren origin auf den Eigentuemer zeigt. Aendert nichts. */
export async function scanLocal(rt: Runtime): Promise<ScanSuggestion[]> {
  const links = await readLinks(rt);
  const found = new Map<string, ScanSuggestion>();
  for (const rootRaw of rt.config.policy.envRoots) {
    const root = await real(expandHome(rootRaw));
    if (!(await isDir(root))) continue;
    for await (const dir of gitDirs(root, 0)) {
      const remote = await gitOrigin(dir);
      const parsed = remote ? parseGitRemote(remote) : null;
      if (!remote || !parsed || parsed.owner.toLowerCase() !== rt.owner.toLowerCase() || !NAME_RE.test(parsed.repo)) continue;
      if (found.has(parsed.repo)) continue;
      found.set(parsed.repo, { name: parsed.repo, path: dir, remote, linked: links[parsed.repo] === dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function linkStatus(rt: Runtime, name: string, stored: string, withPath: boolean): Promise<RepoLinkStatus> {
  const present = await isDir(stored);
  const remote = present ? await gitOrigin(stored) : null;
  return { path: withPath ? stored : null, exists: present, remote, remoteMatches: remoteMatches(remote, rt.owner, name) };
}

/** Alle bekannten Repositories: Inventar, optional live von GitHub, und die lokalen Verknuepfungen. */
export async function listRepos(rt: Runtime, opts: { live?: boolean; includePaths?: boolean } = {}): Promise<RepoList> {
  const inv = rt.inventory.data;
  const rows = new Map<string, RepoRow>();
  const row = (name: string): RepoRow => {
    let r = rows.get(name);
    if (!r) {
      r = { name, secrets: 0, variables: 0, templates: 0, inInventory: false, github: null, link: null };
      rows.set(name, r);
    }
    return r;
  };
  for (const s of inv.secrets) for (const n of new Set(s.places.map((p) => p.repo))) { const r = row(n); r.inInventory = true; r.secrets += 1; }
  for (const v of inv.variables) for (const n of new Set(v.places.map((p) => p.repo))) { const r = row(n); r.inInventory = true; r.variables += 1; }
  for (const t of inv.envTemplates) { const r = row(t.repo); r.inInventory = true; r.templates += 1; }

  let github: RepoList["github"] = "off";
  if (opts.live) {
    try {
      const remote: RemoteRepo[] = await rt.github.listRepos(rt.owner);
      for (const g of remote) row(g.name).github = { private: g.private, archived: g.archived, pushedAt: g.pushedAt };
      github = "ok";
      const renames = await resolveRenames(rt, [...rows.values()].filter((r) => r.inInventory && r.github === null).map((r) => r.name));
      for (const [oldName, newName] of renames) rows.get(oldName)!.renamedTo = newName;
    } catch (err) {
      // Nie blockieren: ohne Verbindung oder bei GitHub-Fehlern bleibt es bei der Inventar-Liste.
      github = err instanceof NotConnectedError ? "off" : err instanceof GitHubError ? "unavailable" : "unavailable";
    }
  }

  const links = await readLinks(rt);
  for (const name of Object.keys(links)) row(name);
  await Promise.all([...rows.values()].map(async (r) => {
    const stored = links[r.name];
    if (stored) r.link = await linkStatus(rt, r.name, stored, opts.includePaths !== false);
  }));
  return { owner: rt.owner, github, repos: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Fragt GitHub nach dem aktuellen Namen von Repositories, die im Inventar stehen, in der Repository-Liste aber fehlen.
 * Liefert nur die tatsaechlich umbenannten (alter Name -> neuer Name im selben Eigentuemer). Hoechstens vier Anfragen
 * gleichzeitig; ein Fehler bei einem Repository laesst es einfach aus.
 */
export async function resolveRenames(rt: Runtime, names: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const old = names[next++]!;
      try {
        const r = await rt.github.resolveRepo(rt.owner, old);
        const [owner, name] = r ? r.fullName.split("/") : [];
        if (r && owner && name && owner.toLowerCase() === rt.owner.toLowerCase() && name.toLowerCase() !== old.toLowerCase()) out.set(old, name);
      } catch {
        /* nicht aufloesbar: keine Aussage */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
  return out;
}

/**
 * Benennt ein Repository im Inventar um (Ziele von Secrets und Variablen, Vorlagen) und zieht eine lokale Verknuepfung mit.
 * Aendert nichts in GitHub. Nur fuer Menschen (die Route liegt im Portal, nicht in der Agenten-API).
 */
export async function renameInventoryRepo(rt: Runtime, from: string, to: string): Promise<{ from: string; to: string; changed: number; linkMoved: boolean }> {
  checkName(from);
  checkName(to);
  if (from.toLowerCase() === to.toLowerCase()) throw new InventoryError("Alter und neuer Name sind gleich.");
  const changed = rt.inventory.renameRepo(from, to);
  if (changed === 0) throw new InventoryError(`Das Repository ${from} kommt im Inventar nicht vor.`);
  await rt.inventory.save();
  const links = await readLinks(rt);
  let linkMoved = false;
  if (from in links && !(to in links)) {
    links[to] = links[from]!;
    delete links[from];
    await writeLinks(rt, links);
    linkMoved = true;
  }
  return { from, to, changed, linkMoved };
}
