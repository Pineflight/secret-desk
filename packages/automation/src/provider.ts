import type { EvidenceStore, IssueContext, IssuedSecret, Provider, RevokeContext, SecretEntry, Stage } from "@secret-desk/core";
import type { BrowserDriver } from "./driver.js";
import type { Recipe } from "./recipe.js";
import { revokeRecipe, runRecipe, type RunHooks, type RunOptions, type Screenshot } from "./run.js";

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

/** Variablen fuer ein Rezept aus einem Inventar-Eintrag. */
export function recipeVars(secret: SecretEntry, stage: Stage, now: Date, extra: { externalId?: string } = {}): Record<string, string> {
  const ownerParam = secret.params["owner"];
  const days = Math.min(366, Math.max(1, secret.ttlDays ?? 30));
  const perms = secret.params["permissions"];
  const permEntries = typeof perms === "object" && perms !== null && !Array.isArray(perms) ? Object.entries(perms).filter((e): e is [string, string] => typeof e[1] === "string") : [];
  const repos = [...new Set(secret.places.map((p) => p.repo.split("/").pop() ?? p.repo))];
  return {
    name: `${secret.id}-${yyyymmdd(now)}`.slice(0, 40),
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

/** Provider, der Token ueber ein Browser-Rezept erzeugt. Passt zum Provider-Interface aus @secret-desk/core. */
export function createBrowserProvider(opts: BrowserProviderOptions): BrowserProvider {
  const { recipe } = opts;
  const shots = new Map<string, Screenshot[]>();

  return {
    id: recipe.provider ?? recipe.id,
    label: recipe.label,
    kind: "automatic",
    automation: { recipeId: recipe.id },
    guide: {
      url: `https://${recipe.host}/`,
      steps: ["secret-desk oeffnet ein Browserfenster.", "Dort selbst anmelden (Passwort, 2FA); secret-desk tippt keine Zugangsdaten.", "Der Rest laeuft automatisch, danach pruefen und bestaetigen."],
    },
    reviewChecklist: (secret) => [
      `Name beim Anbieter beginnt mit "${secret.id}" und traegt das heutige Datum`,
      "Der Token hat nur die Rechte, die der Dienst braucht",
      "Ablauf ist gesetzt",
    ],
    async issue(ctx: IssueContext): Promise<IssuedSecret> {
      const secretId = ctx.secret.id;
      const vars = recipeVars(ctx.secret, ctx.stage, ctx.now);
      const driver = await opts.driverFactory();
      try {
        const result = await runRecipe(recipe, vars, driver, pick(opts.hooks, secretId, {}), pick(opts.runOptions, secretId, {}));
        shots.set(secretId, result.screenshots);
        return { value: result.value, ...(result.externalId ? { externalId: result.externalId } : {}), expiresAt: result.expiresAt ?? null };
      } catch (err) {
        shots.delete(secretId);
        throw err;
      }
    },
    async revoke(ctx: RevokeContext): Promise<void> {
      if (!recipe.revoke) throw new Error(`${recipe.label}: Widerruf ist nicht automatisiert, bitte beim Anbieter von Hand widerrufen (Kennung: ${ctx.externalId}).`);
      const vars = recipeVars(ctx.secret, ctx.secret.stage, new Date(), { externalId: ctx.externalId });
      const driver = await opts.driverFactory();
      await revokeRecipe(recipe, vars, driver, pick(opts.hooks, ctx.secret.id, {}), pick(opts.runOptions, ctx.secret.id, {}));
    },
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
