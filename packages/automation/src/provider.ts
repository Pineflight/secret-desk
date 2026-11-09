import { githubPlacesOf, type Check, type CompanionValue, type EvidenceStore, type IssueContext, type IssuedSecret, type ParamSpec, type Provider, type RevokeContext, type SecretEntry, type Stage } from "@secret-desk/core";
import type { BrowserDriver } from "./driver.js";
import type { Recipe } from "./recipe.js";
import { recipeParamVars, revokeRecipe, runRecipe, type RunHooks, type RunOptions, type Screenshot } from "./run.js";

type PerRun<T> = T | ((secretId: string) => T);

export interface BrowserProviderOptions {
  recipe: Recipe;
  /** Liefert pro Lauf einen frischen Treiber (runRecipe oeffnet und schliesst ihn). */
  driverFactory: () => BrowserDriver | Promise<BrowserDriver>;
  /** Hooks (Warten auf den Menschen, Fortschritt), auch pro Lauf waehlbar. */
  hooks?: PerRun<RunHooks>;
  /** Zeitlimit, Abbruchsignal; auch pro Lauf waehlbar. */
  runOptions?: PerRun<RunOptions>;
  evidence?: EvidenceStore;
}

export interface BrowserProvider extends Provider {
  automation: { recipeId: string };
  /** Belege des letzten Laufs zu diesem Secret holen (und vergessen). */
  takeScreenshots(secretId: string): Screenshot[];
  /** Belege des letzten Laufs an einen Bericht haengen. Liefert die Zahl der Anlagen. */
  attachScreenshots(secretId: string, reportId: string): Promise<number>;
}

const pick = <T>(v: PerRun<T> | undefined, secretId: string, fallback: T): T =>
  v === undefined ? fallback : typeof v === "function" ? (v as (id: string) => T)(secretId) : v;

const yyyymmdd = (d: Date): string => d.toISOString().slice(0, 10).replaceAll("-", "");
const hhmm = (d: Date): string => d.toISOString().slice(11, 16).replace(":", "");

/**
 * Name of a new token at the provider: the secret id, shortened if needed, plus date and time, at most 40 characters.
 * The id is cut, never the date: names must differ between renewals, or the row of the old token cannot be found again.
 * A long id keeps its start and its end (which usually carries the stage), joined by "~".
 */
export function tokenName(secretId: string, now: Date): string {
  const suffix = `-${yyyymmdd(now)}-${hhmm(now)}`;
  const room = 40 - suffix.length;
  if (secretId.length <= room) return `${secretId}${suffix}`;
  const tail = Math.floor((room - 1) / 2);
  const head = room - 1 - tail;
  return `${secretId.slice(0, head).replace(/-+$/, "")}~${secretId.slice(-tail).replace(/^-+/, "")}${suffix}`;
}

/** Variablen fuer ein Rezept aus einem Inventar-Eintrag. */
export function recipeVars(secret: SecretEntry, stage: Stage, now: Date, extra: { externalId?: string } = {}): Record<string, string> {
  const ownerParam = secret.params["owner"];
  const days = Math.min(366, Math.max(1, secret.ttlDays ?? 30));
  const perms = secret.params["permissions"];
  const permEntries = typeof perms === "object" && perms !== null && !Array.isArray(perms) ? Object.entries(perms).filter((e): e is [string, string] => typeof e[1] === "string") : [];
  // params.repos (list or comma-separated text) names the repositories the token may access when they differ from where the
  // value is stored, e.g. a token kept in one repository that reads two others. Otherwise the GitHub places decide.
  const repoParam = secret.params["repos"];
  const repoList = Array.isArray(repoParam)
    ? repoParam.filter((r): r is string => typeof r === "string")
    : typeof repoParam === "string"
      ? repoParam.split(",")
      : githubPlacesOf(secret.places).map((p) => p.repo);
  const repos = [...new Set(repoList.map((r) => r.trim()).filter((r) => r !== "").map((r) => r.split("/").pop()!))];
  return {
    name: tokenName(secret.id, now),
    // GitHub-Konto bzw. Organisation: params.owner, sonst der Verantwortliche des Eintrags.
    owner: typeof ownerParam === "string" ? ownerParam : (secret.owner ?? ""),
    days: String(days),
    date: now.toISOString().slice(0, 10),
    description: secret.description ?? "",
    repos: repos.join(","),
    permissions: permEntries.map(([k, v]) => `${k}=${v}`).join(","),
    permissionsQuery: permEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    stage,
    secretId: secret.id,
    ...(extra.externalId ? { externalId: extra.externalId } : {}),
  };
}

/**
 * Parameter specs of a recipe for the portal's parameter card and the `params_invalid` check.
 * Options become fixed choices (the value is its own label), a pattern stays a pattern. A parameter with a default is not
 * required: the recipe fills the gap.
 */
export function recipeParamSpecs(recipe: Pick<Recipe, "params">): ParamSpec[] {
  return recipe.params.map((p) => ({
    key: p.key,
    label: p.label,
    labelEn: p.labelEn ?? p.label,
    type: p.options ? "enum" : "string",
    required: p.required && p.default === undefined,
    help: p.help ?? "",
    helpEn: p.help ?? "",
    ...(p.options ? { options: p.options.map((value) => ({ value, label: value, labelEn: value })) } : {}),
    ...(!p.options && p.pattern !== undefined ? { pattern: p.pattern } : {}),
    ...(p.default !== undefined ? { defaultValue: p.default } : {}),
  }));
}

/** Provider, der Token ueber ein Browser-Rezept erzeugt. Passt zum Provider-Interface aus @secret-desk/core. */
export function createBrowserProvider(opts: BrowserProviderOptions): BrowserProvider {
  const { recipe } = opts;
  const shots = new Map<string, Screenshot[]>();

  const read = recipe.kind === "read";
  const companionKey = recipe.capture.companion;

  return {
    id: recipe.provider ?? recipe.id,
    label: recipe.label,
    kind: "automatic",
    automation: { recipeId: recipe.id },
    ...(read ? { readOnly: true } : {}),
    ...(companionKey ? { companionParams: [companionKey] } : {}),
    ...(recipe.params.length > 0 ? { params: recipeParamSpecs(recipe) } : {}),
    guide: {
      url: `https://${recipe.host}/`,
      steps: read
        ? ["secret-desk opens a browser window.", "Sign in there yourself (password, 2FA); secret-desk types no credentials.", "The values are read from the page, nothing is created at the provider. Then check and confirm."]
        : ["secret-desk oeffnet ein Browserfenster.", "Dort selbst anmelden (Passwort, 2FA); secret-desk tippt keine Zugangsdaten.", "Der Rest laeuft automatisch, danach pruefen und bestaetigen."],
    },
    reviewChecklist: (secret) => {
      const v = recipeVars(secret, secret.stage, new Date());
      if (read) {
        const shown = recipe.params.filter((p) => p.options && !(p.key === recipe.capture.pick)).map((p) => `${p.key}: ${String(secret.params[p.key] ?? p.default ?? "not set")}`);
        return [
          `The value was read from the provider's page, not created${shown.length ? ` (${shown.join(", ")})` : ""}: the account and portal match the entry`,
          "The value belongs to the name and target shown above and to no other",
        ];
      }
      return [
        `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
        `Konto/Besitzer beim Anbieter stimmt mit dem Eintrag ueberein (owner: ${v["owner"] || "nicht gesetzt"})`,
        `Rechte (params.permissions): ${v["permissions"] || "keine angegeben"}. Der Token hat genau diese und nur die Rechte, die der Dienst braucht`,
        "Ablauf ist gesetzt",
      ];
    },
    async issue(ctx: IssueContext): Promise<IssuedSecret> {
      const secretId = ctx.secret.id;
      // Parameters are checked before a browser is opened (fail closed).
      const vars = { ...recipeVars(ctx.secret, ctx.stage, ctx.now), ...recipeParamVars(recipe, ctx.secret.params) };
      const driver = await opts.driverFactory();
      try {
        const result = await runRecipe(recipe, vars, driver, pick(opts.hooks, secretId, {}), pick(opts.runOptions, secretId, {}));
        shots.set(secretId, result.screenshots);
        if (read) {
          // The value the entry picked is the main value; the other one goes to the entry named by the companion parameter, if any.
          // A read run always returns its values (run.ts runRead).
          const values = result.values!;
          const picked = recipe.capture.pick === undefined ? Object.keys(values)[0] : vars[recipe.capture.pick];
          const target = companionKey ? vars[companionKey]!.trim() : "";
          const otherName = Object.keys(values).find((n) => n !== picked);
          const other = otherName !== undefined ? values[otherName] : undefined;
          const companions: CompanionValue[] = target !== "" && other ? [{ entryId: target, value: other }] : [];
          return { value: result.value, expiresAt: null, ...(companions.length ? { companions } : {}) };
        }
        return { value: result.value, ...(result.externalId ? { externalId: result.externalId } : {}), expiresAt: result.expiresAt ?? null };
      } catch (err) {
        shots.delete(secretId);
        throw err;
      }
    },
    ...(read
      ? {
          // The page offers no way to check a key. The shape was checked while reading; whether the provider accepts it is not known.
          async verify(): Promise<Check[]> {
            return [
              { id: "read-shape", label: "Value read from the provider's page and matches the expected shape", status: "pass" },
              { id: "read-unchecked", label: `Not checked against ${recipe.label}`, status: "info", detail: "The provider offers no call to test the key. The value is only as good as the page it was read from." },
            ];
          },
        }
      : {
          async revoke(ctx: RevokeContext): Promise<void> {
            if (!recipe.revoke) throw new Error(`${recipe.label}: Widerruf ist nicht automatisiert, bitte beim Anbieter von Hand widerrufen (Kennung: ${ctx.externalId}).`);
            const vars = { ...recipeVars(ctx.secret, ctx.secret.stage, new Date(), { externalId: ctx.externalId }), ...recipeParamVars(recipe, ctx.secret.params) };
            const driver = await opts.driverFactory();
            await revokeRecipe(recipe, vars, driver, pick(opts.hooks, ctx.secret.id, {}), pick(opts.runOptions, ctx.secret.id, {}));
          },
        }),
    takeScreenshots(secretId) {
      const s = shots.get(secretId) ?? [];
      shots.delete(secretId);
      return s;
    },
    async attachScreenshots(secretId, reportId) {
      const list = this.takeScreenshots(secretId);
      if (!opts.evidence) return 0;
      for (const s of list) await opts.evidence.attach(secretId, reportId, s.png, "image/png", `Browser: ${s.name}`);
      return list.length;
    },
  };
}
