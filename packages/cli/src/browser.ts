import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_PROFILE_DIR,
  PlaywrightDriver,
  RecipeRunError,
  dryRunRecipe,
  chromeInstallHint,
  findChrome,
  loadRecipesDetailed,
  playwrightAvailable,
  type Recipe,
} from "@secret-desk/automation";

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Mitgelieferte Rezepte liegen im Repo-Wurzelverzeichnis (packages/cli/{src,dist} -> ../../../recipes). */
const BUNDLED_RECIPES = fileURLToPath(new URL("../../../recipes", import.meta.url));

const OPTIONS = {
  recipes: { type: "string", multiple: true },
  "chrome-path": { type: "string" },
  "profile-dir": { type: "string" },
  dry: { type: "boolean" },
  out: { type: "string" },
  "login-timeout": { type: "string" },
  name: { type: "string" },
  owner: { type: "string" },
  days: { type: "string" },
  date: { type: "string" },
  description: { type: "string" },
  repos: { type: "string" },
  permissions: { type: "string" },
  stage: { type: "string" },
  "secret-id": { type: "string" },
} as const;

export async function browserCmd(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "doctor") return doctor(rest, io);
  if (sub === "run") return run(rest, io);
  io.err("browser doctor | browser run <rezept-id> --dry");
  return 2;
}

const line = (io: Io, status: "ok" | "warn" | "fail", text: string): void => io.out(`[${status.padEnd(4)}] ${text}`);

function dirs(extra: string[] | undefined): string[] {
  return [BUNDLED_RECIPES, ...(extra ?? [])];
}

async function statusComment(file: string): Promise<string> {
  const m = /^#\s*STATUS:\s*(.+)$/m.exec(await readFile(file, "utf8"));
  return m?.[1]?.trim() ?? "kein Status-Kommentar";
}

async function doctor(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: OPTIONS });
  let bad = 0;

  if (await playwrightAvailable()) line(io, "ok", "playwright-core installiert");
  else {
    bad++;
    line(io, "fail", "playwright-core fehlt (pnpm install)");
  }

  try {
    const chrome = findChrome(values["chrome-path"]);
    if (chrome) line(io, "ok", `Chrome gefunden: ${chrome}`);
    else line(io, "warn", `Kein Chrome an den ueblichen Orten; es wird channel "chrome" versucht. ${chromeInstallHint()}`);
  } catch (err) {
    bad++;
    line(io, "fail", (err as Error).message);
  }

  line(io, "ok", `Profilordner: ${values["profile-dir"] ?? DEFAULT_PROFILE_DIR} (wird beim ersten Lauf angelegt${process.platform === "win32" ? "; Schutz ueber das Benutzerprofil" : ", Modus 700"})`);

  const { recipes, errors } = await loadRecipesDetailed(dirs(values.recipes));
  for (const r of recipes) line(io, "ok", `Rezept ${r.recipe.id} (${r.recipe.host}): ${await statusComment(r.file)}`);
  for (const e of errors) {
    bad++;
    line(io, "fail", `Rezept ungueltig: ${e.message}`);
  }
  if (recipes.length === 0 && errors.length === 0) line(io, "warn", "Keine Rezepte gefunden");

  io.out(bad === 0 ? "Browser-Automatisierung ist startbereit (Rezepte sind nicht gegen echte Seiten geprueft)." : `${bad} Problem(e) beheben.`);
  return bad === 0 ? 0 : 1;
}

function varsFrom(recipe: Recipe, v: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"]): Record<string, string> {
  const date = v.date ?? new Date().toISOString().slice(0, 10);
  return {
    name: v.name ?? `${recipe.id}-probe-${date.replaceAll("-", "")}`.slice(0, 40),
    owner: v.owner ?? "",
    days: v.days ?? "30",
    date,
    description: v.description ?? "Probelauf",
    repos: v.repos ?? "",
    permissions: v.permissions ?? "",
    permissionsQuery: (v.permissions ?? "")
      .split(",")
      .filter(Boolean)
      .map((p) => p.split("=").map(encodeURIComponent).join("="))
      .join("&"),
    stage: v.stage ?? "dev",
    secretId: v["secret-id"] ?? "probelauf",
  };
}

async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  const id = positionals[0];
  if (!id) throw new Error("browser run <rezept-id> --dry");
  if (!values.dry) throw new Error("Nur der Probelauf ist ueber die Kommandozeile moeglich: --dry (echte Laeufe starten ueber renew im Portal)");

  const { recipes, errors } = await loadRecipesDetailed(dirs(values.recipes));
  const found = recipes.find((r) => r.recipe.id === id);
  if (!found) {
    for (const e of errors) io.err(e.message);
    throw new Error(`Rezept ${id} nicht gefunden (bekannt: ${recipes.map((r) => r.recipe.id).join(", ") || "keine"})`);
  }

  const driver = new PlaywrightDriver({
    ...(values["chrome-path"] ? { chromePath: values["chrome-path"] } : {}),
    ...(values["profile-dir"] ? { profileDir: values["profile-dir"] } : {}),
  });
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  io.out(`Probelauf ${id}: ein Browserfenster oeffnet sich. Es wird nichts erzeugt.`);

  try {
    const result = await dryRunRecipe(
      found.recipe,
      varsFrom(found.recipe, values),
      driver,
      {
        onWaitingForHuman: (w) => io.out(`Warte auf dich im Browserfenster: ${w.reason}${w.url ? ` (${w.url})` : ""}`),
        onProgress: (p) => io.out(`  Schritt ${p.index}/${p.total}: ${p.label}`),
      },
      { signal: ac.signal, ...(values["login-timeout"] ? { loginTimeoutMinutes: Number(values["login-timeout"]) } : {}) },
    );
    if (values.out) {
      await mkdir(values.out, { recursive: true });
      for (const s of result.screenshots) await writeFile(join(values.out, `${s.name}.png`), s.png);
    }
    io.out(`Fertig: ${result.executed} Schritt(e) bis vor das Erzeugen, ${result.screenshots.length} Beleg(e)${values.out ? ` in ${values.out}` : ""}. Es wurde kein Token angelegt.`);
    return 0;
  } catch (err) {
    if (err instanceof RecipeRunError) {
      io.err(`Abbruch (${err.kind}): ${err.message}`);
      return 1;
    }
    throw err;
  }
}
