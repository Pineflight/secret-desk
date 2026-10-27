import { translate } from "./i18n";

export const MAX_TAGS = 12;
export const MAX_DESCRIPTION = 500;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Prüft ein Schlagwort. Liefert eine Fehlermeldung oder null. */
export function validateTag(tag: string): string | null {
  if (!tag) return translate("meta.tagEmpty");
  if (!TAG_RE.test(tag)) return translate("meta.tagInvalid", { tag });
  return null;
}

/** Zerlegt Eingaben mit Komma, Semikolon oder Leerzeichen in Schlagworte (klein geschrieben, ohne Dubletten). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,;\s]+/)) {
    const t = raw.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Fügt Eingaben zur Liste hinzu und meldet den ersten Fehler. */
export function addTags(current: string[], input: string): { tags: string[]; error: string | null } {
  const tags = [...current];
  for (const t of parseTags(input)) {
    const err = validateTag(t);
    if (err) return { tags: current, error: err };
    if (tags.includes(t)) continue;
    if (tags.length >= MAX_TAGS) return { tags: current, error: translate("meta.tagMax", { max: MAX_TAGS }) };
    tags.push(t);
  }
  return { tags, error: null };
}

/** Kürzt auf eine Zeile mit Auslassungszeichen. */
export function truncate(text: string | null | undefined, max = 90): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
