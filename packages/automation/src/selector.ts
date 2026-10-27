import { z } from "zod";

/** Felder, mit denen ein Element gefunden wird. Genau eines von role/label/text/placeholder/testid/css. */
export const selectorShape = {
  role: z.string().min(1).optional(),
  /** Zugaenglicher Name, nur zusammen mit role. */
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  testid: z.string().min(1).optional(),
  /** Letzte Wahl: bricht bei jeder Umgestaltung der Seite. */
  css: z.string().min(1).optional(),
};

const PRIMARY = ["role", "label", "text", "placeholder", "testid", "css"] as const;

export interface Selector {
  role?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  text?: string | undefined;
  placeholder?: string | undefined;
  testid?: string | undefined;
  css?: string | undefined;
}

/** Meldung, wenn die Selektorfelder nicht genau eine Suchart angeben; sonst undefined. */
export function selectorProblem(s: Selector): string | undefined {
  const used = PRIMARY.filter((k) => s[k] !== undefined);
  if (used.length !== 1) return "Genau eines von role, label, text, placeholder, testid oder css angeben";
  if (s.name !== undefined && s.role === undefined) return "name gehoert nur zu role";
  return undefined;
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
  if (s.role !== undefined) return s.name !== undefined ? `${s.role} "${s.name}"` : s.role;
  if (s.label !== undefined) return `Feld "${s.label}"`;
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
  return out;
}
