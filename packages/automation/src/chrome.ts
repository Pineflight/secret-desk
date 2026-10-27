import { existsSync } from "node:fs";
import path from "node:path";

export class ChromeNotFoundError extends Error {
  constructor(detail: string) {
    super(`${detail} automation.chromePath setzen oder Google Chrome installieren (es wird kein Browser heruntergeladen).`);
    this.name = "ChromeNotFoundError";
  }
}

/**
 * Uebliche Installationsorte je System, in Suchreihenfolge (Chrome, Chromium, Edge). Pfade werden mit dem Pfadmodul des
 * jeweiligen Systems gebaut, damit die Liste auf jedem System testbar ist.
 */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    const w = path.win32;
    const bases = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["PROGRAMW6432"], env["LOCALAPPDATA"]].filter((r): r is string => !!r);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of bases) {
      for (const rel of [["Google", "Chrome", "Application", "chrome.exe"], ["Chromium", "Application", "chrome.exe"], ["Microsoft", "Edge", "Application", "msedge.exe"]]) {
        const p = w.join(r, ...rel);
        if (!seen.has(p.toLowerCase())) {
          seen.add(p.toLowerCase());
          out.push(p);
        }
      }
    }
    return out;
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    "/var/lib/flatpak/exports/bin/com.google.Chrome",
  ];
}

/**
 * Hinweis, wenn nichts gefunden wurde. Snap- und Flatpak-Browser laufen in einer Sandbox: ein Profilordner ausserhalb ihres
 * Bereichs oder die Fernsteuerung koennen scheitern. Dann besser ein Paket der Distribution oder das .deb von Google nehmen.
 */
export function chromeInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "Google Chrome oder Microsoft Edge installieren, oder --chrome-path / automation.chromePath auf chrome.exe bzw. msedge.exe setzen.";
  if (platform === "linux") return "google-chrome oder chromium (Paket der Distribution) installieren. Snap- und Flatpak-Builds sind sandboxed und koennen sich nicht steuern lassen; dann --chrome-path setzen.";
  return "Google Chrome installieren oder --chrome-path setzen.";
}

/** Pfad zu einem installierten Chrome/Chromium oder undefined. Ein angegebener Pfad muss existieren. */
export function findChrome(preferred?: string): string | undefined {
  if (preferred) {
    if (!existsSync(preferred)) throw new ChromeNotFoundError(`Chrome nicht gefunden unter ${preferred}.`);
    return preferred;
  }
  return chromeCandidates().find((p) => existsSync(p));
}
