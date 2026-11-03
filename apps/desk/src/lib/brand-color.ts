/** Logo colors: the brand color only where it stays readable on both surfaces, otherwise a neutral that follows the text color. */

/** Card surfaces the logos sit on: the light card and a dark surface (dark mode, dark embeds). */
export const LIGHT_SURFACE = "ffffff";
export const DARK_SURFACE = "1a1a18";
/** WCAG 1.4.11: graphical objects need 3:1. */
export const MIN_CONTRAST = 3;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a six digit hex color (with or without "#"). NaN for anything else. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return Number.NaN;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CSS fill for a logo: the brand color if it has enough contrast on both surfaces, else `currentColor`. */
export function brandFill(hex: string): string {
  const ok = contrast(hex, LIGHT_SURFACE) >= MIN_CONTRAST && contrast(hex, DARK_SURFACE) >= MIN_CONTRAST;
  return ok ? `#${hex.replace(/^#/, "")}` : "currentColor";
}

/** Up to two letters for a provider without a logo: initials of the first two words, else the first two letters. */
export function monogram(label: string): string {
  const words = label.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}
