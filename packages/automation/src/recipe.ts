import { z } from "zod";
import { SelectorSchema, selectorProblem, selectorShape, type Selector } from "./selector.js";
import { KNOWN_VARS, placeholdersOf } from "./template.js";

const Regex = z.string().refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Ungueltiger regulaerer Ausdruck" },
);

const conditionShape = {
  /** Regulaerer Ausdruck gegen die aktuelle Adresse. */
  url: Regex.optional(),
  visible: SelectorSchema.optional(),
  /** Text, der irgendwo auf der Seite stehen muss. */
  text: z.string().min(1).optional(),
};

function oneCondition(c: { url?: unknown; visible?: unknown; text?: unknown }, ctx: z.RefinementCtx): void {
  const n = [c.url, c.visible, c.text].filter((x) => x !== undefined).length;
  if (n !== 1) ctx.addIssue({ code: "custom", message: "Genau eines von url, visible oder text angeben" });
}

/** Bedingung fuer Anmeldung, waitFor und pause. */
export const ConditionSchema = z.object(conditionShape).strict().superRefine(oneCondition);
export type Condition = z.infer<typeof ConditionSchema>;

const withSelector = <T extends z.ZodRawShape>(extra: T) =>
  z
    .object({ ...selectorShape, ...extra })
    .strict()
    .superRefine((v, ctx) => {
      const p = selectorProblem(v as Selector);
      if (p) ctx.addIssue({ code: "custom", message: p });
    });

/** Schritt fuer jeden Eintrag einer Liste, zum Beispiel jedes Repository. */
const Each = z.enum(["repos"]).optional();

const stepVariants = {
  goto: z.object({ goto: z.string().min(1) }).strict(),
  fill: z.object({ fill: withSelector({ value: z.string() }), each: Each }).strict(),
  select: z.object({ select: withSelector({ value: z.string().min(1) }), each: Each }).strict(),
  check: z.object({ check: withSelector({ checked: z.boolean().default(true) }), each: Each }).strict(),
  click: z.object({ click: withSelector({ createsToken: z.boolean().optional() }), each: Each }).strict(),
  press: z
    .object({
      press: z
        .object({ ...selectorShape, key: z.string().min(1) })
        .strict()
        .superRefine((v, ctx) => {
          const hasTarget = [v.role, v.label, v.text, v.placeholder, v.testid, v.css].some((x) => x !== undefined);
          const p = hasTarget ? selectorProblem(v as Selector) : undefined;
          if (p) ctx.addIssue({ code: "custom", message: p });
        }),
      each: Each,
    })
    .strict(),
  waitFor: z
    .object({
      waitFor: z
        .object({ ...conditionShape, timeoutSeconds: z.number().positive().max(3600).optional() })
        .strict()
        .superRefine(oneCondition),
    })
    .strict(),
  pause: z
    .object({
      pause: z.object({ human: z.string().min(1), until: ConditionSchema }).strict(),
    })
    .strict(),
  screenshot: z.object({ screenshot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/, "Name aus Buchstaben, Ziffern, . _ -") }).strict(),
};

export type Step = z.infer<(typeof stepVariants)[keyof typeof stepVariants]>;

/** Prueft einen Schritt anhand seines Schluessels, damit Fehler auf das Feld zeigen statt "Invalid input". */
export const StepSchema = z.unknown().transform<Step>((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.issues.push({ code: "custom", message: "Schritt muss ein Objekt sein", input: raw });
    return z.NEVER;
  }
  const keys = Object.keys(raw).filter((k) => k !== "each");
  const key = keys[0] as keyof typeof stepVariants | undefined;
  if (keys.length !== 1 || key === undefined || !Object.hasOwn(stepVariants, key)) {
    ctx.issues.push({ code: "custom", message: `Schritt braucht genau eine Art: ${Object.keys(stepVariants).join(", ")}`, input: raw });
    return z.NEVER;
  }
  const parsed = stepVariants[key].safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.issues.push({ code: "custom", message: issue.message, input: raw, path: issue.path });
    return z.NEVER;
  }
  return parsed.data as Step;
});

const Ident = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Kennung in kleinbuchstaben-mit-bindestrich");
const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "Hostname ohne Schema und Pfad");

const FromVar = z.enum(["name", "days", "date", "secretId"]);

export const RecipeSchema = z
  .object({
    id: Ident,
    label: z.string().min(1),
    /** Anbieter-Id, die das Rezept bedient, falls nicht gleich der Rezept-Id. */
    provider: Ident.optional(),
    /** Seiten ausserhalb dieses Hosts (und allowHosts) werden nicht bedient. */
    host: Hostname,
    allowHosts: z.array(Hostname).default([]),
    login: z.object({ expect: ConditionSchema, message: z.string().optional() }).strict().optional(),
    steps: z.array(StepSchema).min(1),
    capture: z
      .object({
        token: z
          .object({
            find: SelectorSchema,
            /** Der Wert muss passen, sonst Abbruch. Gruppe 1, falls vorhanden. */
            pattern: Regex.optional(),
            timeoutSeconds: z.number().positive().max(600).default(30),
          })
          .strict(),
        externalId: z
          .union([z.object({ from: FromVar }).strict(), z.object({ find: SelectorSchema, pattern: Regex.optional() }).strict()])
          .optional(),
        expires: z.object({ from: z.literal("days") }).strict().optional(),
      })
      .strict(),
    mask: z.array(SelectorSchema).default([]),
    revoke: z.object({ steps: z.array(StepSchema).min(1) }).strict().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const known = new Set<string>(KNOWN_VARS);
    const check = (steps: Step[], base: string): void =>
      steps.forEach((step, i) => {
        for (const text of stringsOf(step)) {
          for (const v of placeholdersOf(text)) {
            if (!known.has(v)) ctx.addIssue({ code: "custom", path: [base, i], message: `Unbekannte Variable {{${v}}}` });
          }
        }
        if ("goto" in step) gotoProblem(step.goto, r).forEach((message) => ctx.addIssue({ code: "custom", path: [base, i, "goto"], message }));
      });
    check(r.steps, "steps");
    if (r.revoke) check(r.revoke.steps, "revoke");
    const creates = r.steps.some((s) => "click" in s && s.click.createsToken === true);
    if (!creates) ctx.addIssue({ code: "custom", path: ["steps"], message: "Ein click-Schritt braucht createsToken: true (der Punkt, ab dem beim Anbieter etwas entsteht)" });
  });

export type Recipe = z.infer<typeof RecipeSchema>;

/** Alle Texte eines Schritts ausser regulaeren Ausdruecken (url) und Tastennamen. */
function stringsOf(value: unknown, key = ""): string[] {
  if (key === "url" || key === "key") return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringsOf(v));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => stringsOf(v, k));
  return [];
}

const LOCAL = new Set(["localhost", "127.0.0.1"]);

/** Statische Pruefung einer goto-Adresse: Schema und Host duerfen nicht von Variablen abhaengen. */
function gotoProblem(url: string, r: { host: string; allowHosts: string[] }): string[] {
  const m = /^(https?):\/\/([^/?#{]*)/.exec(url);
  if (!m || m[2] === "") return ["Adresse muss mit https:// und festem Host beginnen (keine Variable im Host)"];
  const host = (m[2] as string).replace(/:\d+$/, "").toLowerCase();
  const problems: string[] = [];
  if (m[1] === "http" && !LOCAL.has(host)) problems.push("http nur fuer localhost");
  if (!hostAllowed(host, r)) problems.push(`Host ${host} ist nicht host/allowHosts des Rezepts`);
  return problems;
}

/** host oder ein Eintrag aus allowHosts (auch "*.beispiel.de" fuer Subdomains). */
export function hostAllowed(hostname: string, r: { host: string; allowHosts: string[] }): boolean {
  const h = hostname.toLowerCase();
  return [r.host, ...r.allowHosts].some((a) => {
    const allowed = a.toLowerCase();
    return allowed.startsWith("*.") ? h.endsWith(allowed.slice(1)) : h === allowed;
  });
}
