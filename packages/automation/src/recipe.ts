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

const simpleConditionShape = {
  /** Regulaerer Ausdruck gegen die aktuelle Adresse. */
  url: Regex.optional(),
  visible: SelectorSchema.optional(),
  /** Holds once no element matching the selector is visible any more (for example a row after deleting it). */
  hidden: SelectorSchema.optional(),
  /** Text, der irgendwo auf der Seite stehen muss. */
  text: z.string().min(1).optional(),
};

function exactlyOne(c: Record<string, unknown>, keys: string[], message: string, ctx: z.RefinementCtx): void {
  if (keys.filter((k) => c[k] !== undefined).length !== 1) ctx.addIssue({ code: "custom", message });
}

const SimpleConditionSchema = z.object(simpleConditionShape).strict().superRefine((c, ctx) => exactlyOne(c, ["url", "visible", "hidden", "text"], "Genau eines von url, visible, hidden oder text angeben", ctx));

const conditionShape = {
  ...simpleConditionShape,
  /** Holds when every listed condition holds (evaluated together, for example an address and the absence of a sign-in button). */
  all: z.array(SimpleConditionSchema).min(2).max(6).optional(),
};

function oneCondition(c: { url?: unknown; visible?: unknown; hidden?: unknown; text?: unknown; all?: unknown }, ctx: z.RefinementCtx): void {
  exactlyOne(c, ["url", "visible", "hidden", "text", "all"], "Genau eines von url, visible, hidden, text oder all angeben", ctx);
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

const WhenVar = z
  .object({ var: z.string().min(1), equals: z.string().optional(), notEquals: z.string().optional() })
  .strict()
  .superRefine((w, ctx) => {
    if ((w.equals === undefined) === (w.notEquals === undefined)) ctx.addIssue({ code: "custom", message: "Give exactly one of equals and notEquals" });
  });
const WhenVisible = z
  .object({
    visible: SelectorSchema,
    /** How long to wait for the element when deciding (default 0 = look once, now). A missing element after the wait means "no". */
    timeoutSeconds: z.number().min(0).max(120).optional(),
  })
  .strict();
const WhenAbsent = z
  .object({
    absent: SelectorSchema,
    /** How long to wait for the element to show up (default 0 = look once, now). It holds when it never does. */
    timeoutSeconds: z.number().min(0).max(120).optional(),
  })
  .strict();
const WhenAll = z.object({ all: z.array(z.union([WhenVar, WhenVisible, WhenAbsent])).min(2).max(5) }).strict();

/**
 * Runs the step only when the condition holds, evaluated when the step is reached; otherwise the step is skipped.
 * - `{ var, equals }`: the variable (a recipe parameter, a fixed variable or one set by a `set` step) equals the value. This is
 *   how one recipe serves several modes, for example a sandbox and a live address. The variable is named, not rendered.
 * - `{ visible, timeoutSeconds? }`: an element matching the selector is visible on the page now (waits up to the timeout for it).
 *   This is how one recipe serves a page that comes in two variants.
 * - `{ var, notEquals }`: the variable differs from the value (for example a parameter that is not empty).
 * - `{ absent, timeoutSeconds? }`: no element matching the selector shows up within the timeout (it holds at once when the
 *   element is not there and the timeout is 0). This is how a page that lacks a feature (no create button) is detected.
 * - `{ all: [...] }`: every listed condition holds.
 */
const When = z.union([WhenVar, WhenVisible, WhenAbsent, WhenAll]).optional();
export type When = z.infer<typeof When>;

/** Names of the variables a `when` reads. */
export function whenVars(when: When): string[] {
  if (!when) return [];
  if ("all" in when) return when.all.flatMap((w) => whenVars(w));
  return "var" in when ? [when.var] : [];
}

const VarName = z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/, "Schluessel aus Buchstaben und Ziffern, beginnt mit einem Kleinbuchstaben (hoechstens 31 Zeichen)");

const stepVariants = {
  goto: z.object({ goto: z.string().min(1), when: When }).strict(),
  /**
   * Reads the address from the `href` of the element and opens it, under the same host rules as `goto` (a link whose address
   * differs per account, for example one that carries a numeric id). Fails closed when the element or its `href` is missing or the
   * address leaves the allowed hosts.
   */
  follow: z.object({ follow: withSelector({}), when: When }).strict(),
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
        .object({
          ...conditionShape,
          /** Holds as soon as one of the conditions holds (a page that may show one of several variants of a form). */
          any: z.array(ConditionSchema).min(2).max(5).optional(),
          timeoutSeconds: z.number().positive().max(3600).optional(),
        })
        .strict()
        .superRefine((c, ctx) => exactlyOne(c, ["url", "visible", "hidden", "text", "all", "any"], "Genau eines von url, visible, hidden, text, all oder any angeben", ctx)),
      when: When,
    })
    .strict(),
  pause: z
    .object({
      pause: z.object({ human: z.string().min(1), until: ConditionSchema }).strict(),
      when: When,
    })
    .strict(),
  /**
   * The provider may ask to confirm access here (GitHub "Confirm access"). Runs once the page is shown; the human answers in the
   * portal (see sudo.ts). `until` holds when the page the recipe wants is there, which also ends the step when no confirmation
   * was asked. A run without a portal to answer in waits for the human in the browser window instead.
   */
  confirmAccess: z
    .object({
      confirmAccess: z.object({ flow: z.enum(["github-sudo"]), until: ConditionSchema, timeoutSeconds: z.number().positive().max(3600).optional() }).strict(),
      when: When,
    })
    .strict(),
  /**
   * Sets a variable of the run to a fixed value (for example which variant of a page was found), for the `when` of later steps.
   * The name must be new: a parameter or a fixed variable cannot be overwritten.
   */
  set: z.object({ set: z.object({ var: VarName, value: z.string() }).strict(), when: When }).strict(),
  /**
   * Ends the run with this message (a variant the recipe does not support). Put it before the click that creates anything.
   * `unsupported: true`: the account or page cannot do what the recipe needs (not a broken recipe); the run ends as "unsupported".
   */
  fail: z.object({ fail: z.string().min(1), unsupported: z.boolean().optional(), when: When }).strict(),
  screenshot: z.object({ screenshot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/, "Name aus Buchstaben, Ziffern, . _ -"), when: When }).strict(),
};

export type Step = z.infer<(typeof stepVariants)[keyof typeof stepVariants]>;

/** Prueft einen Schritt anhand seines Schluessels, damit Fehler auf das Feld zeigen statt "Invalid input". */
export const StepSchema = z.unknown().transform<Step>((raw, ctx) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    ctx.issues.push({ code: "custom", message: "Schritt muss ein Objekt sein", input: raw });
    return z.NEVER;
  }
  const keys = Object.keys(raw).filter((k) => k !== "each" && k !== "when" && k !== "unsupported");
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
    /**
     * The provider signs in by email alone (a one-time code or a link, no password). The form then fills only
     * {{login.username}}; the code comes through `mfa`. Single-sign-on methods still take their own credentials.
     */
    passwordless: z.boolean().optional(),
    /** Sign-in page, on `host`. */
    start: z.string().min(1),
    /** Page that shows whether a browser session is still signed in (default: start). */
    home: z.string().min(1).optional(),
    steps: z.array(StepSchema).min(1),
    /** The provider asks for a one-time code: it is typed into `field` and confirmed with `submit`. */
    mfa: z.object({ detect: ConditionSchema, field: SelectorSchema, submit: SelectorSchema }).strict().optional(),
    /** The provider waits for an approval elsewhere (push, e-mail link). The portal says so and waits. */
    approval: z.object({ detect: ConditionSchema, ...Message, /** Where the page shows the number to tap on the device, if it does. */ number: SelectorSchema.optional() }).strict().optional(),
    /** A CAPTCHA or other bot check. The script cannot solve it: a challenge that stays ends the run with a message, nothing is circumvented. */
    captcha: z.object({ detect: ConditionSchema, message: z.string().min(1).optional(), messageEn: z.string().min(1).optional() }).strict().optional(),
    /** Page states that mean the sign-in was refused (wrong password, locked account). */
    failure: z.array(z.object({ detect: ConditionSchema, ...Message }).strict()).default([]),
  })
  .strict();
export type LoginForm = z.infer<typeof LoginFormSchema>;

/** The ways a human can sign in at a provider. `email` is the provider's own form; the others go through an identity provider. */
export const LOGIN_METHOD_IDS = ["email", "google", "apple", "microsoft", "github"] as const;
export type LoginMethodId = (typeof LOGIN_METHOD_IDS)[number];

/**
 * One sign-in method of a recipe. `email` needs no entry (it is `login.form`). Every other method declares only the
 * provider-side steps up to the identity provider (for example clicking "Continue with Apple"); the built-in flow of that
 * identity provider (see idp.ts) does the rest. The steps may click and wait, nothing else, and use no variables.
 */
export const LoginMethodSchema = z
  .object({
    id: z.enum(LOGIN_METHOD_IDS),
    label: z.string().min(1).optional(),
    labelEn: z.string().min(1).optional(),
    steps: z.array(StepSchema).optional(),
  })
  .strict();
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

const Ident = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Kennung in kleinbuchstaben-mit-bindestrich");
const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "Hostname ohne Schema und Pfad");
/** A host, or `*.example.test` for every subdomain of it (a hosted sign-in page whose name carries a tenant). */
const AllowedHost = z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, "Hostname ohne Schema und Pfad, optional mit *. davor");

/** A value of the parameter that picks the host (an option of the parameter). */
const HostKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/, "A value of letters, digits, hyphen and underscore");

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

export const RECIPE_KINDS = ["create", "read"] as const;
export type RecipeKind = (typeof RECIPE_KINDS)[number];

const ParamKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/, "Schluessel aus Buchstaben und Ziffern, beginnt mit einem Kleinbuchstaben (hoechstens 31 Zeichen)");
const ValueName = z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/, "Schluessel aus Buchstaben und Ziffern, beginnt mit einem Kleinbuchstaben (hoechstens 31 Zeichen)");

const CaptureTokenSchema = z
  .object({
    find: SelectorSchema,
    /** Read this attribute of the element instead of its text or value (for a key the page shows truncated but carries whole). */
    attribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,40}$/, "Attributname").optional(),
    /** Der Wert muss passen, sonst Abbruch. Gruppe 1, falls vorhanden. */
    pattern: Regex.optional(),
    timeoutSeconds: z.number().positive().max(600).default(30),
    /**
     * Other places the token may show up (a page that comes in more than one variant). The first of `find` and these that is
     * visible wins, in this order; the `pattern` applies to all. Each has its own `attribute` (or none: the text is read).
     */
    alternatives: z
      .array(z.object({ find: SelectorSchema, attribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,40}$/, "Attributname").optional() }).strict())
      .max(3)
      .optional(),
  })
  .strict();

/** One value a `read` recipe takes from the page. The pattern is required: a value of the wrong shape ends the run. */
const CaptureValueSchema = z
  .object({
    find: SelectorSchema,
    attribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_:-]{0,40}$/, "Attributname").optional(),
    pattern: Regex,
    timeoutSeconds: z.number().positive().max(600).default(30),
  })
  .strict();
export type CaptureValue = z.infer<typeof CaptureValueSchema>;

export const RecipeSchema = z
  .object({
    id: Ident,
    label: z.string().min(1),
    /** Anbieter-Id, die das Rezept bedient, falls nicht gleich der Rezept-Id. */
    provider: Ident.optional(),
    /**
     * Seiten ausserhalb dieses Hosts (und allowHosts) werden nicht bedient. Exactly one of `host` (one portal) or
     * `hostBy` + `hosts` (several portals with separate accounts). After parsing `host` is always set: with `hosts` it is the
     * first host (a label for lists); a run, a check and a sign-in use the host of the parameter value (see `resolveRecipe`).
     */
    host: Hostname.optional(),
    /** The parameter (declared under `params`, with `options` = the keys of `hosts`) whose value picks the host. */
    hostBy: ParamKey.optional(),
    /** Host per value of the parameter `hostBy`, for example `{ live: www.example.test, test: test.www.example.test }`. */
    hosts: z.record(HostKey, Hostname).optional(),
    allowHosts: z.array(AllowedHost).default([]),
    /** Per-entry parameters, read from `params` of the inventory entry. Each key is usable as {{key}}. */
    params: z.array(RecipeParamSchema).default([]),
    login: z.object({ expect: ConditionSchema, message: z.string().optional(), form: LoginFormSchema.optional(), methods: z.array(LoginMethodSchema).optional() }).strict().optional(),
    steps: z.array(StepSchema).min(1),
    /**
     * `create` (default): the recipe creates a token at the provider (one click carries `createsToken: true`) and reads it once.
     * `read`: the recipe only reads values the provider already shows (keys that cannot be created or rotated through the
     * portal, for example a print service that issues fixed keys). It has no `createsToken`, no `revoke` and no expiry.
     */
    kind: z.enum(RECIPE_KINDS).default("create"),
    capture: z
      .object({
        /** kind `create`: the one new token. */
        token: CaptureTokenSchema.optional(),
        externalId: z
          .union([z.object({ from: FromVar }).strict(), z.object({ find: SelectorSchema, pattern: Regex.optional() }).strict()])
          .optional(),
        expires: z.object({ from: z.literal("days") }).strict().optional(),
        /** kind `read`: one to two named values read in the same run. */
        values: z.record(ValueName, CaptureValueSchema).optional(),
        /** kind `read`: the recipe parameter (with `options` = the value names) that says which value is the entry's own. */
        pick: ParamKey.optional(),
        /** kind `read` with two values: the recipe parameter that holds the inventory id of the entry that receives the other value. */
        companion: ParamKey.optional(),
        /** kind `read`: another page to try when the values above are not found (same value names, own selectors). */
        fallback: z.object({ steps: z.array(StepSchema).min(1), values: z.record(ValueName, CaptureValueSchema) }).strict().optional(),
      })
      .strict(),
    mask: z.array(SelectorSchema).default([]),
    revoke: z.object({ steps: z.array(StepSchema).min(1) }).strict().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const hostProblems = hostFormProblems(r);
    hostProblems.forEach((p) => ctx.addIssue({ code: "custom", path: p.path, message: p.message }));
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
    const assigned = new Set<string>();
    const assigns = (steps: Step[], base: string): void =>
      steps.forEach((step, i) => {
        if (!("set" in step)) return;
        if (known.has(step.set.var)) ctx.addIssue({ code: "custom", path: [base, i, "set", "var"], message: `Die Variable ${step.set.var} existiert schon und kann nicht gesetzt werden` });
        assigned.add(step.set.var);
      });
    assigns(r.steps, "steps");
    if (r.revoke) assigns(r.revoke.steps, "revoke");
    if (r.capture.fallback) assigns(r.capture.fallback.steps, "fallback");
    const whenKnown = new Set([...known, ...assigned]);
    const check = (steps: Step[], base: string): void =>
      steps.forEach((step, i) => {
        checkText(step, [base, i]);
        if ("when" in step) for (const v of whenVars(step.when)) if (!whenKnown.has(v)) ctx.addIssue({ code: "custom", path: [base, i, "when", "var"], message: `Unbekannte Variable ${v}` });
        if ("goto" in step) gotoProblem(step.goto, allHostsOf(r)).forEach((message) => ctx.addIssue({ code: "custom", path: [base, i, "goto"], message }));
      });
    check(r.steps, "steps");
    if (r.revoke) check(r.revoke.steps, "revoke");
    if (r.login?.form) loginFormProblems(r.login.form, r).forEach((p) => ctx.addIssue({ code: "custom", path: ["login", "form", ...p.path], message: p.message }));
    if (r.login?.methods) loginMethodProblems(r.login.methods, r.login.form !== undefined).forEach((p) => ctx.addIssue({ code: "custom", path: ["login", "methods", ...p.path], message: p.message }));
    if (r.capture.fallback) check(r.capture.fallback.steps, "fallback");
    if (r.kind === "create") {
      const creates = r.steps.some((s) => "click" in s && s.click.createsToken === true);
      if (!creates) ctx.addIssue({ code: "custom", path: ["steps"], message: "Ein click-Schritt braucht createsToken: true (der Punkt, ab dem beim Anbieter etwas entsteht)" });
      if (!r.capture.token) ctx.addIssue({ code: "custom", path: ["capture", "token"], message: "capture.token is required (kind create)" });
      for (const k of ["values", "pick", "companion", "fallback"] as const) {
        if (r.capture[k] !== undefined) ctx.addIssue({ code: "custom", path: ["capture", k], message: `capture.${k} belongs to kind read` });
      }
    } else {
      readProblems(r).forEach((p) => ctx.addIssue({ code: "custom", path: p.path, message: p.message }));
    }
  })
  // Hand `host` to everything downstream as a string: with `hosts` it is the first host (see `resolveRecipe` for the one to use).
  .transform((r) => ({ ...r, host: r.host ?? Object.values(r.hosts ?? {})[0] ?? "" }));

export type Recipe = z.infer<typeof RecipeSchema>;

/** Static checks of a `kind: read` recipe: nothing is created, the values and their mapping to entries are declared. */
function readProblems(r: {
  params: RecipeParam[];
  steps: Step[];
  revoke?: { steps: Step[] } | undefined;
  capture: { token?: unknown; externalId?: unknown; expires?: unknown; values?: Record<string, unknown> | undefined; pick?: string | undefined; companion?: string | undefined; fallback?: { steps: Step[]; values: Record<string, unknown> } | undefined };
}): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string): void => void out.push({ path, message });
  const c = r.capture;
  if (c.token !== undefined) add(["capture", "token"], "A read recipe has capture.values, not capture.token");
  if (c.externalId !== undefined) add(["capture", "externalId"], "A read recipe creates nothing, so there is no externalId");
  if (c.expires !== undefined) add(["capture", "expires"], "A read recipe has no expiry: the keys it reads do not expire through this recipe");
  if (r.revoke) add(["revoke"], "A read recipe has nothing to revoke");
  const creating = (steps: Step[]): boolean => steps.some((s) => "click" in s && s.click.createsToken === true);
  if (creating(r.steps)) add(["steps"], "A read recipe must not create anything (no createsToken)");
  if (c.fallback && creating(c.fallback.steps)) add(["capture", "fallback", "steps"], "A read recipe must not create anything (no createsToken)");
  const names = Object.keys(c.values ?? {});
  if (names.length < 1 || names.length > 2) {
    add(["capture", "values"], "capture.values needs one or two values");
    return out;
  }
  if (c.fallback) {
    const other = Object.keys(c.fallback.values).sort().join(",");
    if (other !== [...names].sort().join(",")) add(["capture", "fallback", "values"], "The fallback reads the same value names as capture.values");
  }
  const param = (key: string | undefined, path: string): RecipeParam | undefined => {
    const p = r.params.find((x) => x.key === key);
    if (!p) add(["capture", path], `capture.${path} names the parameter ${key ?? "?"}, which is not declared under params`);
    return p;
  };
  if (names.length === 2 && c.pick === undefined) add(["capture", "pick"], "Two values need capture.pick (the parameter that says which value the entry takes)");
  if (names.length === 1 && c.pick !== undefined) add(["capture", "pick"], "capture.pick belongs to two values");
  if (c.pick !== undefined) {
    const p = param(c.pick, "pick");
    if (p && (!p.options || [...p.options].sort().join(",") !== [...names].sort().join(",") || !p.required || p.default !== undefined)) {
      add(["params"], `The parameter ${c.pick} is required, has no default and lists exactly the value names (${names.join(", ")}) as options`);
    }
  }
  if (c.companion !== undefined) {
    if (names.length !== 2) add(["capture", "companion"], "capture.companion belongs to two values");
    const p = param(c.companion, "companion");
    if (p && (p.required || p.options || p.default !== undefined || p.pattern === undefined)) add(["params"], `The parameter ${c.companion} is optional, has a pattern (the inventory id of the receiving entry) and no options or default`);
    if (c.companion === c.pick) add(["capture", "companion"], "capture.companion and capture.pick are different parameters");
  }
  return out;
}

/** Static checks of `login.form`: allowed step kinds, hosts, and where the sign-in variables may appear. */
function loginFormProblems(form: LoginForm, r: HostFields): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string): void => void out.push({ path, message });
  const allowed = new Set<string>(LOGIN_VARS);
  for (const key of ["start", "home"] as const) {
    const url = form[key];
    if (url === undefined) continue;
    // Only {{host}} may appear (the recipe's own host, in the host position); it is checked once per host the recipe can use.
    if (url.replaceAll("{{host}}", "").includes("{{")) add([key], "The address must not contain variables (only {{host}})");
    else if (url.includes("{{host}}")) {
      for (const h of hostListOf(r)) gotoProblem(url.replaceAll("{{host}}", h), { host: h, allowHosts: r.allowHosts }).forEach((message) => add([key], `${message} (host ${h})`));
    } else gotoProblem(url, allHostsOf(r)).forEach((message) => add([key], message));
  }
  const used = new Set<string>();
  form.steps.forEach((step, i) => {
    const kind = Object.keys(step).find((k) => k !== "each" && k !== "when" && k !== "unsupported");
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
  for (const v of LOGIN_VARS) {
    if (form.passwordless && v === "login.password") {
      if (used.has(v)) add(["steps"], "A passwordless sign-in must not use {{login.password}}");
      continue;
    }
    if (!used.has(v)) add(["steps"], `No fill step uses {{${v}}}`);
  }
  const others: [string, unknown][] = [["mfa", form.mfa], ["approval", form.approval], ["captcha", form.captcha], ["failure", form.failure]];
  for (const [name, value] of others) {
    if (value !== undefined && stringsOf(value).some((t) => placeholdersOf(t).length > 0)) add([name], "No variables allowed here");
  }
  return out;
}

/** Static checks of `login.methods`: unique ids, the provider-side steps of a single-sign-on method, no steps for email. */
function loginMethodProblems(methods: LoginMethod[], hasForm: boolean): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string): void => void out.push({ path, message });
  const seen = new Set<string>();
  if (methods.length > 0 && !hasForm) add([], "login.methods needs login.form (its start page, and the email method)");
  methods.forEach((m, i) => {
    if (seen.has(m.id)) add([i, "id"], `Method ${m.id} is declared twice`);
    seen.add(m.id);
    if (m.id === "email") {
      if (m.steps) add([i, "steps"], "The email method is login.form and has no steps of its own");
      return;
    }
    if (!m.steps || m.steps.length === 0) return add([i, "steps"], `Method ${m.id} needs the provider-side steps (for example clicking its button)`);
    m.steps.forEach((step, j) => {
      const kind = Object.keys(step).find((k) => k !== "each" && k !== "when" && k !== "unsupported");
      if (kind !== "click" && kind !== "waitFor") return add([i, "steps", j], "A single-sign-on step is click or waitFor");
      if ("each" in step && step.each) add([i, "steps", j, "each"], "A sign-in step must not repeat per item");
      if ("when" in step && step.when) add([i, "steps", j, "when"], "A sign-in step must not be conditional");
      if ("click" in step && step.click.createsToken) add([i, "steps", j], "A sign-in step must not create a token");
      if (stringsOf(step).some((t) => placeholdersOf(t).length > 0)) add([i, "steps", j], "No variables allowed in single-sign-on steps");
    });
  });
  return out;
}

export interface LoginMethodInfo {
  id: LoginMethodId;
  label: string | null;
  labelEn: string | null;
}

/** The sign-in methods a recipe offers: `email` when it has `login.form`, then the declared single-sign-on methods. */
export function loginMethodsOf(recipe: Pick<Recipe, "login">): LoginMethodInfo[] {
  const login = recipe.login;
  if (!login?.form) return [];
  const declared = login.methods ?? [];
  const email = declared.find((m) => m.id === "email");
  const out: LoginMethodInfo[] = [{ id: "email", label: email?.label ?? null, labelEn: email?.labelEn ?? email?.label ?? null }];
  for (const m of declared) if (m.id !== "email") out.push({ id: m.id, label: m.label ?? null, labelEn: m.labelEn ?? m.label ?? null });
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

/** The host fields of a recipe as written (before `host` is filled in). */
export interface HostFields {
  host?: string | undefined;
  hostBy?: string | undefined;
  hosts?: Record<string, string> | undefined;
  allowHosts: string[];
}

/** Every host the recipe can sign in at: its `host`, or all values of `hosts`. */
export function hostListOf(r: Pick<HostFields, "host" | "hosts">): string[] {
  return r.hosts ? Object.values(r.hosts) : r.host ? [r.host] : [];
}

/** All hosts of the recipe as one allowlist (static checks of addresses, which may name any of them). */
function allHostsOf(r: HostFields): { host: string; allowHosts: string[] } {
  const hosts = hostListOf(r);
  return { host: hosts[0] ?? "", allowHosts: [...hosts.slice(1), ...r.allowHosts] };
}

/** Static checks of the host fields: one form only, and `hosts` matches the options of the parameter `hostBy`. */
function hostFormProblems(r: HostFields & { params: RecipeParam[] }): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string): void => void out.push({ path, message });
  const multi = r.hostBy !== undefined || r.hosts !== undefined;
  if (r.host !== undefined && multi) add(["host"], "Use either host or hostBy with hosts, not both");
  if (r.host === undefined && !multi) add(["host"], "host is required (or hostBy with hosts)");
  if (!multi) return out;
  if (r.hostBy === undefined || r.hosts === undefined) {
    add([r.hostBy === undefined ? "hostBy" : "hosts"], "hostBy and hosts belong together");
    return out;
  }
  const keys = Object.keys(r.hosts);
  if (keys.length < 2) add(["hosts"], "hosts lists at least two hosts (use host for one)");
  const p = r.params.find((x) => x.key === r.hostBy);
  if (!p) return add(["hostBy"], `hostBy names the parameter ${r.hostBy}, which is not declared under params`), out;
  if (!p.options || [...p.options].sort().join(",") !== [...keys].sort().join(",")) add(["params"], `The parameter ${r.hostBy} lists exactly the keys of hosts (${keys.join(", ")}) as options`);
  return out;
}

/**
 * The recipe for one portal: a recipe with `hosts` becomes a single-host recipe (`host` = the host of `selector`, `hosts` and
 * `hostBy` gone), so the allowlist, the sign-in and the checks see exactly one portal. `selector` is a value of the parameter
 * `hostBy` or one of the hosts. `{{host}}` in `login.form.start`, `login.form.home` and `login.expect` is replaced by that host.
 * Throws when a recipe with several hosts gets no (or an unknown) selector.
 */
export function resolveRecipe(recipe: Recipe, selector?: string | undefined): Recipe {
  let host = recipe.host;
  if (recipe.hosts) {
    const value = (selector ?? "").trim();
    const found = recipe.hosts[value] ?? Object.values(recipe.hosts).find((h) => h === value.toLowerCase());
    if (found === undefined) throw new RecipeHostError(`${recipe.id}: ${value === "" ? "no host chosen" : "unknown host"} (${recipe.hostBy}: ${Object.keys(recipe.hosts).join(", ")})`);
    host = found;
  }
  const { hosts: _hosts, hostBy: _hostBy, ...rest } = recipe;
  const out: Recipe = { ...rest, host };
  if (recipe.login) {
    const sub = (text: string, regex = false): string => text.replaceAll("{{host}}", regex ? host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : host);
    const subDeep = (value: unknown, key = ""): unknown => {
      if (typeof value === "string") return sub(value, key === "url");
      if (Array.isArray(value)) return value.map((v) => subDeep(v));
      if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subDeep(v, k)]));
      return value;
    };
    out.login = {
      ...recipe.login,
      expect: subDeep(recipe.login.expect) as NonNullable<Recipe["login"]>["expect"],
      ...(recipe.login.form ? { form: { ...recipe.login.form, start: sub(recipe.login.form.start), ...(recipe.login.form.home !== undefined ? { home: sub(recipe.login.form.home) } : {}) } } : {}),
    };
  }
  return out;
}

export class RecipeHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeHostError";
  }
}

/** The host a run of the recipe uses for these entry parameters (no parameter needed for a single-host recipe). Null: not decidable. */
export function hostForParams(recipe: Pick<Recipe, "host" | "hostBy" | "hosts" | "params">, params: Record<string, unknown>): string | null {
  if (!recipe.hosts || !recipe.hostBy) return recipe.host;
  const raw = params[recipe.hostBy];
  const value = typeof raw === "string" ? raw.trim() : "";
  const spec = recipe.params.find((p) => p.key === recipe.hostBy);
  return recipe.hosts[value !== "" ? value : (spec?.default ?? "")] ?? null;
}
