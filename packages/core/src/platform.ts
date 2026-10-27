import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Plattform-Helfer. Alles hier nimmt `platform` als Parameter, damit sich Windows-Verhalten auf jedem System
 * testen laesst (path.win32 / path.posix statt dem Pfadmodul des aktuellen Systems).
 */
export type Platform = NodeJS.Platform;

export function pathFor(platform: Platform = process.platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Dateirechte: auf POSIX chmod 600/700. Windows kennt diese Modi nicht (chmod wirkt dort nur auf das
 * Schreibschutz-Bit). Dort schuetzt das Benutzerprofil (ACL: nur der Benutzer, SYSTEM und Administratoren);
 * es wird nichts vorgetaeuscht und nichts versucht.
 */
export async function securePrivateFile(file: string, platform: Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  await chmod(file, 0o600);
}

/** Legt einen privaten Ordner an (POSIX: Modus 700, auch wenn er schon existierte). */
export async function ensurePrivateDir(dir: string, platform: Platform = process.platform): Promise<void> {
  await mkdir(dir, { recursive: true, ...(platform === "win32" ? {} : { mode: 0o700 }) });
  if (platform !== "win32") await chmod(dir, 0o700);
}

/** Schreibt eine private Datei (POSIX: Modus 600 von Anfang an und nachtraeglich abgesichert). */
export async function writePrivateFile(file: string, data: string | Uint8Array, platform: Platform = process.platform, flag?: string): Promise<void> {
  await writeFile(file, data, { ...(typeof data === "string" ? { encoding: "utf8" as const } : {}), ...(platform === "win32" ? {} : { mode: 0o600 }), ...(flag ? { flag } : {}) });
  await securePrivateFile(file, platform);
}

/** `~`, `~/x` (auf Windows auch `~\x`) auf den Home-Ordner abbilden. Alles andere bleibt unveraendert. */
export function expandHome(p: string, home: string = homedir(), platform: Platform = process.platform): string {
  const api = pathFor(platform);
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return api.join(home, p.slice(2));
  return p;
}

/** UNC- und Geraetepfade (`\\server\share`, `\\?\C:\...`, `\\.\pipe`) gibt es nur auf Windows; dort werden sie abgelehnt. */
export function isUncPath(p: string, platform: Platform = process.platform): boolean {
  return platform === "win32" && /^[\\/]{2}/.test(p);
}

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** Windows-reservierte Geraetenamen (CON, NUL, COM1 ...), auch mit Endung (`nul.txt`) und nachgestellten Punkten/Leerzeichen. */
export function isReservedWindowsName(name: string): boolean {
  const base = name.replace(/[. ]+$/, "").split(".")[0]!.trimEnd();
  return RESERVED.test(base);
}

/** Fehlermeldung, wenn der Pfad auf Windows nicht verwendbar ist (UNC, reservierter Name, verbotenes Zeichen), sonst null. */
export function localPathProblem(p: string, platform: Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  if (isUncPath(p, platform)) return "Netzwerk- und Geraetepfade (UNC, \\\\?\\) sind nicht erlaubt. Bitte einen lokalen Laufwerkspfad angeben.";
  const rest = p.replace(/^[A-Za-z]:/, "");
  if (/[<>:"|?*\u0000-\u001f]/.test(rest)) return "Der Pfad enthaelt Zeichen, die Windows nicht erlaubt (< > : \" | ? *).";
  const segments = rest.split(/[\\/]+/).filter(Boolean);
  const bad = segments.find((s) => isReservedWindowsName(s));
  return bad ? `Der Pfad enthaelt den unter Windows reservierten Namen "${bad}".` : null;
}

/** Macht einen Namen zu einem gueltigen Dateinamen auf allen Systemen (Windows-verbotene Zeichen, reservierte Namen, Punkt am Ende). */
export function sanitizeFileName(name: string, fallback = "file"): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").replace(/^\s+/, "");
  if (out === "" || out === "." || out === "..") out = fallback;
  if (isReservedWindowsName(out)) out = `_${out}`;
  return out;
}

/**
 * true, wenn `target` echt unterhalb von `base` liegt (nicht gleich). Auf Windows ohne Beachtung der Gross-/Kleinschreibung
 * (path.win32 vergleicht so), Laufwerke muessen uebereinstimmen. Fuer echte Dateisystem-Pfade vorher `realpathLoose` aufrufen.
 */
export function isPathInside(base: string, target: string, platform: Platform = process.platform): boolean {
  const api = pathFor(platform);
  const rel = api.relative(api.resolve(base), api.resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/** Wie isPathInside, aber auch der Ordner selbst zaehlt. */
export function isPathInsideOrSame(base: string, target: string, platform: Platform = process.platform): boolean {
  const api = pathFor(platform);
  const a = api.resolve(base);
  const b = api.resolve(target);
  return (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b) || isPathInside(base, target, platform);
}

/**
 * realpath, aber auch fuer noch nicht existierende Pfade: der vorhandene Anfang wird aufgeloest (Symlinks, Gross-/Kleinschreibung
 * wie auf der Platte), der Rest angehaengt.
 */
export async function realpathLoose(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(await realpathLoose(parent), path.basename(abs));
  }
}
