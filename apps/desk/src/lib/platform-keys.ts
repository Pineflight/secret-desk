/** Plattformerkennung fuer das Tastenkuerzel der Befehlspalette: Cmd+K (macOS/iOS) oder Strg+K (sonst). Touch-Geraete bekommen einen Such-Knopf. */

export interface NavigatorLike {
  userAgentData?: { platform?: string } | undefined;
  platform?: string | undefined;
  userAgent?: string | undefined;
  maxTouchPoints?: number | undefined;
}

export type KeyPlatform = "mac" | "other";

export function detectPlatform(nav: NavigatorLike | undefined): KeyPlatform {
  if (!nav) return "other";
  const hint = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  if (/mac|iphone|ipad|ipod/i.test(hint)) return "mac";
  // iPadOS meldet sich als "MacIntel" mit Touch; das zaehlt auch als mac (Tastaturkuerzel mit Cmd).
  return "other";
}

/** Grobe Touch-Erkennung: Geraet ohne feinen Zeiger (kein Hover). Das Kuerzel wird dann nicht angezeigt. */
export function isTouchDevice(nav: NavigatorLike | undefined, coarse: boolean | undefined): boolean {
  if (coarse !== undefined) return coarse;
  return (nav?.maxTouchPoints ?? 0) > 0 && !/mac|win|x86|i[3-6]86/i.test(nav?.platform ?? "");
}

/** Beschriftung des Kuerzels: "⌘K" oder "Strg K" (de) / "Ctrl K" (en). */
export function shortcutLabel(platform: KeyPlatform, locale: "de" | "en"): string {
  return platform === "mac" ? "⌘K" : locale === "de" ? "Strg K" : "Ctrl K";
}

/** Ist das Tastaturereignis das Oeffnen-Kuerzel? Cmd+K auf mac, Strg+K sonst; Alt/Shift zaehlen nicht. */
export function isPaletteShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, platform: KeyPlatform): boolean {
  if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  return platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
