import { z } from "zod";
import { SelectorSchema, selectorProblem, selectorShape, type Selector } from "./selector.js";
import { KNOWN_VARS, LOGIN_VARS, placeholdersOf } from "./template.js";

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
  /** Holds once no element matching the selector is visible any more (for example a row after deleting it). */
  hidden: SelectorSchema.optional(),
  /** Text, der irgendwo auf der Seite stehen muss. */
  text: z.string().min(1).optional(),
};

function oneCondition(c: { url?: unknown; visible?: unknown; hidden?: unknown; text?: unknown }, ctx: z.RefinementCtx): void {
  const n = [c.url, c.visible, c.hidden, c.text].filter((x) => x !== undefined).length;
  if (n !== 1) ctx.addIssue({ code: "custom", message: "Genau eines von url, visible, hidden oder text angeben" });
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

/**
 * Runs the step only when the variable (a recipe parameter or a fixed variable) equals the value. This is how one recipe
 * serves several modes, for example a sandbox and a live address. The variable is not a template: it is named, not rendered.
 */
const When = z.object({ var: z.string().min(1), equals: z.string() }).strict().optional();

const stepVariants = {
  goto: z.object({ goto: z.string().min(1), when: When }).strict(),
  fill: z.object({ fill: withSelector({ value: z.string() }), each: Each, when: When }).strict(),
  select: z.object({ select: withSelector({ value: z.string().min(1) }), each: Each, when: When }).strict(),
  check: z.object({ check: withSelector({ checked: z.boolean().default(true) }), each: Each, when: When }).strict(),
  click: z
    .object({
      click: withSelector({
        createsToken: z.boolean().optional(),
        /**
         * The element may be absent (a cookie banner, a one-time notice): wait `timeoutSeconds` for it and skip the step
         * when it does not show up. Never combine this with createsToken.
         */
        optional: z.boolean().optional(),
        /** Only with optional: how long to wait for the element (default 3 s). */
        timeoutSeconds: z.number().positive().max(30).optional(),
      }).superRefine((v, ctx) => {
        if (v.optional && v.createsToken) ctx.addIssue({ code: "custom", message: "optional und createsToken schliessen sich aus" });
        if (v.timeoutSeconds !== undefined && !v.optional) ctx.addIssue({ code: "custom", message: "timeoutSeconds gehoert nur zu optional: true" });
      }),
      each: Each,
      when: When,
    })
    .strict(),
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
      when: When,
    })
    .strict(),
  waitFor: z
    .object({
      waitFor: z
        .object({ ...conditionShape, timeoutSeconds: z.number().positive().max(3600).optional() })
        .strict()
        .superRefine(oneCondition),
      when: When,
    })
    .strict(),
  pause: z
    .object({
      pause: z.object({ human: z.string().min(1), until: ConditionSchema }).strict(),
      when: When,
    })
    .strict(),
  screenshot: z.object({ screenshot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/, "Name aus Buchstaben, Ziffern, . _ -"), when: When }).strict(),
};

export type Step = z.infer<(typeof stepVariants)[keyof typeof stepVariants]>;

/** Prueft einen Schritt anhand seines Schluessels, damit Fehler auf das Feld zeigen statt "Invalid input". */
export const StepSchema = z.unknown().transform<Step>((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.issues.push({ code: "custom", message: "Schritt muss ein Objekt sein", input: raw });
    return z.NEVER;
  }
  const keys = Object.keys(raw).filter((k) => k !== "each" && k !== "when");
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


/** A provider message shown to the human: German (default UI language) with an optional English text. */
const Message = { message: z.string().min(1), messageEn: z.string().min(1).optional() };

/**
 * Guided sign-in of a provider (the human types email and password in the portal for this run only).
 * Steps may only fill, click and wait; `fill` values may use {{login.username}} and {{login.password}}, nothing else may.
 */
export const LoginFormSchema = z
  .object({
    /** Sign-in page, on `host`. */
    start: z.string().min(1),
    /** Page that shows whether a browser session is still signed in (default: start). */
    home: z.string().min(1).optional(),
    steps: z.array(StepSchema).min(1),
    /** The provider asks for a one-time code: it is typed into `field` and confirmed with `submit`. */
    mfa: z.object({ detect: ConditionSchema, field: SelectorSchema, submit: SelectorSchema }).strict().optional(),
    /** The provider waits for an approval elsewhere (push, e-mail link). The portal says so and waits. */
    approval: z.object({ detect: ConditionSchema, ...Message }).strict().optional(),
    /** A CAPTCHA or other bot check. The human solves it in the browser window; nothing is circumvented. */
    captcha: z.object({ detect: ConditionSchema, message: z.string().min(1).optional(), messageEn: z.string().min(1).optional() }).strict().optional(),
    /** Page states that mean the sign-in was refused (wrong password, locked account). */
    failure: z.array(z.object({ detect: ConditionSchema, ...Message }).strict()).default([]),
  })
  .strict();
export type LoginForm = z.infer<typeof LoginFormSchema>;

const Ident = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Kennung in kleinbuchstaben-mit-bindestrich");
const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "Hostname ohne Schema und Pfad");

const FromVar = z.enum(["name", "days", "date", "secretId"]);

/** Per-entry parameter of a recipe (for example a project id). Every declared key becomes a template variable. */
export const RecipeParamSchema = z
  .object({
    key: z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/, "Schluessel aus Buchstaben und Ziffern, beginnt mit einem Kleinbuchstaben (hoechstens 31 Zeichen)"),
    label: z.string().min(1),
    labelEn: z.string().min(1).optional(),
    /** Default true. A parameter with a default is never reported as missing. */
    required: z.boolean().default(true),
    /** The value must match this regular expression (anchor it with ^ and $). */
    pattern: Regex.optional(),
    /** Fixed choices. */
    options: z.array(z.string().min(1)).min(1).optional(),
    default: z.string().optional(),
    help: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.default !== undefined && paramValueProblem(p, p.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "Der Standardwert passt nicht zu pattern/options" });
    }
  });
export type RecipeParam = z.infer<typeof RecipeParamSchema>;

/** Why `value` is not allowed for the parameter (pattern/options), or undefined. Does not look at required. */
export function paramValueProblem(p: Pick<RecipeParam, "pattern" | "options">, value: string): string | undefined {
  if (p.options && !p.options.includes(value)) return `ist nicht erlaubt (erlaubt: ${p.options.join(", ")})`;
  if (p.pattern !== undefined && !new RegExp(p.pattern).test(value)) return "hat nicht das erwartete Format";
  return undefined;
}

export const RecipeSchema = z
  .object({
    id: Ident,
    label: z.string().min(1),
    /** Anbieter-Id, die das Rezept bedient, falls nicht gleich der Rezept-Id. */
    provider: Ident.optional(),
    /** Seiten ausserhalb dieses Hosts (und allowHosts) werden nicht bedient. */
    host: Hostname,
    allowHosts: z.array(Hostname).default([]),
    /** Per-entry parameters, read from `params` of the inventory entry. Each key is usable as {{key}}. */
    params: z.array(RecipeParamSchema).default([]),
    login: z.object({ expect: ConditionSchema, message: z.string().optional(), form: LoginFormSchema.optional() }).strict().optional(),
    steps: z.array(StepSchema).min(1),
    capture: z
      .object({
        token: z
          .object({
            find: SelectorSchema,
            /** Read this attribute of the element instead of its text or value (for a key the page shows truncated but carries whole). */
            attribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,40}$/, "Attributname").optional(),
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
    const seen = new Set<string>();
    r.params.forEach((p, i) => {
      if (known.has(p.key)) ctx.addIssue({ code: "custom", path: ["params", i, "key"], message: `Der Schluessel ${p.key} ist eine feste Rezeptvariable und darf nicht als Parameter dienen` });
      else if (seen.has(p.key)) ctx.addIssue({ code: "custom", path: ["params", i, "key"], message: `Parameter ${p.key} ist doppelt deklariert` });
      seen.add(p.key);
    });
    for (const p of r.params) known.add(p.key);
    const checkText = (value: unknown, path: (string | number)[]): void => {
      for (const text of stringsOf(value)) {
        for (const v of placeholdersOf(text)) {
          if (!known.has(v)) ctx.addIssue({ code: "custom", path, message: `Unbekannte Variable {{${v}}}` });
        }
      }
    };
    checkText(r.capture, ["capture"]);
    checkText(r.mask, ["mask"]);
    const check = (steps: Step[], base: string): void =>
      steps.forEach((step, i) => {
        checkText(step, [base, i]);
        if ("when" in step && step.when && !known.has(step.when.var)) ctx.addIssue({ code: "custom", path: [base, i, "when", "var"], message: `Unbekannte Variable ${step.when.var}` });
        if ("goto" in step) gotoProblem(step.goto, r).forEach((message) => ctx.addIssue({ code: "custom", path: [base, i, "goto"], message }));
      });
    check(r.steps, "steps");
    if (r.revoke) check(r.revoke.steps, "revoke");
    if (r.login?.form) loginFormProblems(r.login.form, r).forEach((p) => ctx.addIssue({ code: "custom", path: ["login", "form", ...p.path], message: p.message }));
    const creates = r.steps.some((s) => "click" in s && s.click.createsToken === true);
    if (!creates) ctx.addIssue({ code: "custom", path: ["steps"], message: "Ein click-Schritt braucht createsToken: true (der Punkt, ab dem beim Anbieter etwas entsteht)" });
  });

export type Recipe = z.infer<typeof RecipeSchema>;

/** Static checks of `login.form`: allowed step kinds, hosts, and where the sign-in variables may appear. */
function loginFormProblems(form: LoginForm, r: { host: string; allowHosts: string[] }): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string): void => void out.push({ path, message });
  const allowed = new Set<string>(LOGIN_VARS);
  for (const key of ["start", "home"] as const) {
    const url = form[key];
    if (url === undefined) continue;
    if (url.includes("{{")) add([key], "The address must not contain variables");
    else gotoProblem(url, r).forEach((message) => add([key], message));
  }
  const used = new Set<string>();
  form.steps.forEach((step, i) => {
    const kind = Object.keys(step).find((k) => k !== "each" && k !== "when");
    if (kind !== "fill" && kind !== "click" && kind !== "waitFor") return add(["steps", i], "A sign-in step is fill, click or waitFor");
    if ("each" in step && step.each) add(["steps", i, "each"], "A sign-in step must not repeat per item");
    if ("when" in step && step.when) add(["steps", i, "when"], "A sign-in step must not be conditional");
    if ("click" in step && step.click.createsToken) add(["steps", i], "A sign-in step must not create a token");
    // Sign-in variables only in the value of a fill: selectors and conditions end up in error texts and logs.
    const rest = "fill" in step ? { ...step.fill, value: "" } : step;
    if (stringsOf(rest).some((t) => placeholdersOf(t).length > 0)) add(["steps", i], "Only the value of a fill step may use {{login.username}} or {{login.password}}");
    if ("fill" in step) {
      for (const v of placeholdersOf(step.fill.value)) {
        if (!allowed.has(v)) add(["steps", i, "fill", "value"], `Unknown variable {{${v}}} (only {{login.username}} and {{login.password}})`);
        else used.add(v);
      }
    }
  });
  for (const v of LOGIN_VARS) if (!used.has(v)) add(["steps"], `No fill step uses {{${v}}}`);
  const others: [string, unknown][] = [["mfa", form.mfa], ["approval", form.approval], ["captcha", form.captcha], ["failure", form.failure]];
  for (const [name, value] of others) {
    if (value !== undefined && stringsOf(value).some((t) => placeholdersOf(t).length > 0)) add([name], "No variables allowed here");
  }
  return out;
}

/** Alle Texte eines Schritts ausser regulaeren Ausdruecken (url, pattern) und Tastennamen. */
function stringsOf(value: unknown, key = ""): string[] {
  if (key === "url" || key === "key" || key === "pattern") return [];
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
