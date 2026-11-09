import { z } from "zod";

/** Felder, mit denen ein Element gefunden wird. Genau eines von role/label/text/placeholder/testid/css. */
export const selectorShape = {
  role: z.string().min(1).optional(),
  /** Zugaenglicher Name, nur zusammen mit role. */
  name: z.string().min(1).optional(),
  /** Only with role and name, or with label: the accessible name or label must match exactly (default: contains). */
  exact: z.boolean().optional(),
  label: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  testid: z.string().min(1).optional(),
  /** Letzte Wahl: bricht bei jeder Umgestaltung der Seite. */
  css: z.string().min(1).optional(),
  /** Several elements may match (for example a button that appears twice): take the first visible one instead of failing. */
  first: z.boolean().optional(),
};

const PRIMARY = ["role", "label", "text", "placeholder", "testid", "css"] as const;

export interface Selector {
  role?: string | undefined;
  name?: string | undefined;
  exact?: boolean | undefined;
  label?: string | undefined;
  text?: string | undefined;
  placeholder?: string | undefined;
  testid?: string | undefined;
  css?: string | undefined;
  first?: boolean | undefined;
}

/**
 * Text fields of a selector (`name`, `label`, `text`, `placeholder`) are plain text, or a regular expression written as
 * `/pattern/flags`. A recipe uses the second form to match the wording of more than one interface language, for example
 * `/^(Create key|Schlüssel erstellen)$/i`. Flags: i, m, s, u only (anything else is a plain text).
 */
const REGEX_TEXT = /^\/(.+)\/([a-z]*)$/s;

/** The regular expression behind a `/pattern/flags` text, or null for a plain text. Throws for an invalid pattern. */
export function textPattern(value: string): RegExp | null {
  const m = REGEX_TEXT.exec(value);
  if (!m) return null;
  const flags = m[2]!;
  // Other letters after the last slash (`/path/to`) mean a plain text, not a pattern.
  if (!/^[imsu]*$/.test(flags)) return null;
  return new RegExp(m[1]!, flags);
}

/** What a driver hands to the browser: the regular expression for a `/pattern/flags` text, else the text itself. */
export const textMatcher = (value: string): string | RegExp => textPattern(value) ?? value;

/** Problem text when a `/pattern/flags` value does not compile; `{{variables}}` are replaced by a letter first. */
function patternProblem(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    textPattern(value.replace(/\{\{[^}]*\}\}/g, "x"));
    return undefined;
  } catch {
    return "Invalid regular expression in a /pattern/flags text";
  }
}

/** Meldung, wenn die Selektorfelder nicht genau eine Suchart angeben; sonst undefined. */
export function selectorProblem(s: Selector): string | undefined {
  const used = PRIMARY.filter((k) => s[k] !== undefined);
  if (used.length !== 1) return "Genau eines von role, label, text, placeholder, testid oder css angeben";
  if (s.name !== undefined && s.role === undefined) return "name gehoert nur zu role";
  if (s.exact !== undefined && s.name === undefined && s.label === undefined) return "exact gehoert nur zu role mit name oder zu label";
  return patternProblem(s.name) ?? patternProblem(s.label) ?? patternProblem(s.text) ?? patternProblem(s.placeholder);
}

export const SelectorSchema = z
  .object(selectorShape)
  .strict()
  .superRefine((s, ctx) => {
    const p = selectorProblem(s);
    if (p) ctx.addIssue({ code: "custom", message: p });
  });

/** Kurzbeschreibung fuer Fehlermeldungen und Protokolle. Enthaelt nur das Rezept, nie Seiteninhalt. */
export function describeSelector(s: Selector): string {
  if (s.role !== undefined) return s.name !== undefined ? `${s.role} "${s.name}"${s.exact ? " (exact)" : ""}` : s.role;
  if (s.label !== undefined) return `Feld "${s.label}"${s.exact ? " (exact)" : ""}`;
  if (s.text !== undefined) return `Text "${s.text}"`;
  if (s.placeholder !== undefined) return `Platzhalter "${s.placeholder}"`;
  if (s.testid !== undefined) return `testid ${s.testid}`;
  return `css ${s.css ?? "?"}`;
}

/** Selektorfelder aus einem Objekt herausziehen (der Rest sind Schrittfelder). */
export function pickSelector(o: Record<string, unknown>): Selector {
  const out: Selector = {};
  for (const k of [...PRIMARY, "name"] as const) {
    const v = o[k];
    if (typeof v === "string") out[k] = v;
  }
  if (typeof o["exact"] === "boolean") out.exact = o["exact"];
  if (typeof o["first"] === "boolean") out.first = o["first"];
  return out;
}
