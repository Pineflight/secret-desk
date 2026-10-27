import { existsSync } from "node:fs";
import { join } from "node:path";

export class ChromeNotFoundError extends Error {
  constructor(detail: string) {
    super(`${detail} automation.chromePath setzen oder Google Chrome installieren (es wird kein Browser heruntergeladen).`);
    this.name = "ChromeNotFoundError";
  }
}

/** Uebliche Installationsorte je System, in Suchreihenfolge. */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((r): r is string => !!r);
    return roots.flatMap((r) => [join(r, "Google", "Chrome", "Application", "chrome.exe"), join(r, "Chromium", "Application", "chrome.exe")]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/** Pfad zu einem installierten Chrome/Chromium oder undefined. Ein angegebener Pfad muss existieren. */
export function findChrome(preferred?: string): string | undefined {
  if (preferred) {
    if (!existsSync(preferred)) throw new ChromeNotFoundError(`Chrome nicht gefunden unter ${preferred}.`);
    return preferred;
  }
  return chromeCandidates().find((p) => existsSync(p));
}
