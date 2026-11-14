import { stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  EnvExportError,
  PromptsRequiredError,
  agentStageIds,
  buildEnvFile,
  realpathLoose,
  type EnvCommand,
  type EnvTemplate,
  revokeIssuedTokens,
  addUnrevokedNotices,
  checkEnvTarget,
  forgetRunValues,
  isPathInside,
  isPathInsideOrSame,
  writeEnvFile,
  type Stage,
} from "@secret-desk/core";
import { translateDeep } from "./i18n-en.js";
import { PolicyError, agentMayWriteEnvFile, authorize, evidenceSvg as evidenceSvgOn, type Actor } from "./agent-api-core.js";
import { linkedFolder, usableEnvRoots } from "./repos.js";
import type { Runtime } from "./runtime.js";

/**
 * The agent API of the local edition. Everything that needs no Node API lives in `agent-api-core.ts` (it takes a `RuntimeCore`, and the
 * portable entry exports it by name); this module re-exports all of it, so every name keeps its place for the CLI, the MCP server, the
 * portal and the root entry, and adds what is bound to the machine: the export of an environment file (file system, paths, the host)
 * and `evidenceSvg`, which binds the English catalogue (it is built from every provider, so it stays on the Node side).
 */
export * from "./agent-api-core.js";

/**
 * The evidence sheet as an image. `lang: "en"` also translates the stored check texts with the catalogue of the API boundary; default "de" is unchanged.
 * Same function as in `agent-api-core.ts`, with the English catalogue bound to it.
 */
export async function evidenceSvg(rt: Runtime, secretId: string, reportId: string, lang: "de" | "en" = "de"): Promise<string> {
  return evidenceSvgOn(rt, secretId, reportId, lang, (text) => translateDeep(text, "en"));
}

// -------------------------------------------------------------------------------------------- Dev-Env

export type DevEnvResult =
  | { status: "written"; path: string; keys: string[]; sources: Record<string, string>; skipped: string[]; gitIgnored: boolean | null; warnings: string[] }
  | { status: "needs-input"; keys: string[]; message: string };

/**
 * Erzeugt eine .env fuer eine Vorlage. Agenten bekommen nur Pfad, Schluessel und Herkunft zurueck,
 * nie einen Wert, und duerfen nur freigegebene Stages und nur in freigegebene Ordner schreiben.
 */
export async function exportEnv(
  rt: Runtime,
  actor: Actor,
  input: {
    repo: string;
    stage?: Stage;
    template?: string;
    path?: string;
    overwrite?: boolean;
    prompts?: Record<string, string>;
    /** Human CLI only: without a path and without a linked folder, write `<fallbackDir>/<template.file>`. */
    fallbackDir?: string;
    /** Human CLI only: run the allowlisted commands of `command` entries on this machine. */
    runCommands?: boolean;
    /** Values shared between the templates of one CLI run (for `ref` entries). Memory only. */
    runValues?: Map<string, string>;
  },
): Promise<DevEnvResult> {
  if (actor.kind === "agent" && input.overwrite) throw new PolicyError("Bestehende Dateien ueberschreiben darf nur ein Mensch.");
  const stage: Stage = input.stage ?? (rt.inventory.stages.find((d) => d.kind === "dev")?.id ?? "dev");
  if (actor.kind === "agent" && !agentStageIds(rt.config, rt.inventory.stages).includes(stage)) {
    throw new PolicyError(`Agenten duerfen fuer ${stage} keine .env erzeugen.`);
  }
  if (actor.kind === "agent" && input.prompts && Object.keys(input.prompts).length > 0) {
    throw new PolicyError("Agenten uebergeben keine Werte. Eingaben macht der Mensch im Portal oder in der CLI.");
  }
  const templates = rt.inventory.data.envTemplates.filter((t) => (input.template ? t.id === input.template : t.repo === input.repo && t.stage === stage));
  const template = templates[0];
  if (!template) throw new EnvExportError(`Keine Vorlage fuer ${input.repo} (${stage}) gefunden.`);
  if (actor.kind === "agent" && !agentStageIds(rt.config, rt.inventory.stages).includes(template.stage)) {
    throw new PolicyError(`Agenten duerfen fuer ${template.stage} keine .env erzeugen.`);
  }
  const configured = rt.config.policy.envRoots;
  if (actor.kind === "agent" && configured.length === 0) {
    throw new PolicyError("policy.envRoots ist leer: Agenten duerfen keine Dateien schreiben.");
  }
  // Der verknuepfte Ordner des Repositories gilt als erlaubte Wurzel, aber nur fuer dieses Repository.
  const folder = await linkedFolder(rt, template.repo);
  let target = input.path?.trim() ? input.path.trim() : "";
  if (!target) {
    const base = folder ?? (actor.kind === "human" && input.fallbackDir ? input.fallbackDir : null);
    if (!base) throw new EnvExportError(`Kein Pfad angegeben und kein Ordner fuer ${template.repo} verknuepft.`);
    target = join(base, template.file);
    if (!isPathInside(base, target)) throw new EnvExportError(`Die Vorlage ${template.id} verweist mit "${template.file}" aus dem verknuepften Ordner hinaus.`);
  }
  if (actor.kind === "agent" && !agentMayWriteEnvFile(target)) throw new PolicyError("Agenten duerfen nur Dateien namens .env oder .env.* schreiben (nicht .envrc, .npmrc, Makefile, *.sh).");
  // Ohne envRoots gilt fuer Menschen keine Einschraenkung; mit envRoots kommt der verknuepfte Ordner hinzu.
  const roots = configured.length > 0 && folder ? [...configured, folder] : configured;
  // Values are about to be generated, fetched and written to a file: the hook is asked after every built-in check, before the first of those.
  await authorize(rt, { actor, action: "env.export", subject: { repo: template.repo, stage: template.stage } });
  try {
    const envDeps = { inventory: rt.inventory, providers: rt.providers, connections: rt.connections, fetch: rt.fetch, providerConfig: rt.config.providers };
    const readTemplateFile = async (other: EnvTemplate): Promise<string | null> => {
      const otherFolder = await linkedFolder(rt, other.repo);
      if (!otherFolder) return null;
      const file = join(otherFolder, other.file);
      if (!isPathInside(otherFolder, file)) return null;
      // Follow symlinks, then require a regular file that still lies inside the linked folder, at most 1 MiB.
      const real = await realpathLoose(file);
      if (!isPathInside(await realpathLoose(otherFolder), real)) return null;
      const info = await stat(real).catch(() => null);
      if (!info || !info.isFile() || info.size > 1024 * 1024) return null;
      return readFile(real, "utf8").catch(() => null);
    };
    const commandDir = folder ?? dirname(target);
    // Commands run only for a human who asked for them and only through the host of the runtime; there is no other way to start one.
    const host = rt.host;
    const wantsCommands = actor.kind === "human" && Boolean(input.runCommands);
    // The command runs in `commandDir` and prefers that folder's own node_modules/.bin: before anything starts, the folder must lie
    // (by real path) inside policy.envRoots or be the linked folder of the repository (itself checked against the allowed bases).
    // Empty and relative envRoots entries do not count (see `usableEnvRoots`). The check is check-then-use: it assumes an attacker
    // cannot write to the allowed roots or the linked folder while the command starts.
    let commandsAllowed = false;
    if (wantsCommands && host?.runCommand) {
      const realDir = await realpathLoose(commandDir);
      for (const root of [...usableEnvRoots(rt), ...(folder ? [folder] : [])]) {
        if (isPathInsideOrSame(await realpathLoose(root), realDir)) commandsAllowed = true;
      }
    }
    // Every check of the target that needs no value runs before the first value is issued: a provider that rotates in place replaces
    // the value at the provider when it issues, so an export that is bound to fail (file exists, path outside the roots, a folder at
    // the path) must not issue at all. `writeEnvFile` repeats the checks (the file system can change in between).
    const overwrite = actor.kind === "human" && (input.overwrite ?? false);
    // Values of earlier templates of the run: only a human passes them on; an agent's map is never read or changed.
    const runValues = actor.kind === "human" ? input.runValues : undefined;
    await checkEnvTarget(target, { overwrite, allowedRoots: roots });
    const built = await buildEnvFile(template, {
      ...envDeps,
      ...(actor.kind === "agent" ? { allowedIssueStages: agentStageIds(rt.config, rt.inventory.stages) } : {}),
      ...(input.prompts ? { prompts: input.prompts } : {}),
      ...(runValues ? { runValues } : {}),
      readTemplateFile,
      ...(commandsAllowed && host?.runCommand ? { runCommand: (command: EnvCommand) => host.runCommand!(command, commandDir) } : {}),
    });
    let written;
    // A write of the file counts as started from the moment `writeEnvFile` is about to create it (all its checks passed): the values
    // may be in the file from then on, whatever fails afterwards (the Git check, for example). No command receives an issued value.
    let writeStarted = false;
    try {
      // Without the host's `gitCheckIgnored` no process is started: the answer is "cannot be checked" (null), which becomes a warning below.
      const checkIgnored = host?.gitCheckIgnored ? (path: string) => host.gitCheckIgnored!(path) : async () => null;
      written = await writeEnvFile(target, built.text, { overwrite, allowedRoots: roots, checkIgnored, onWriteStart: () => { writeStarted = true; } });
    } catch (err) {
      // Datei nicht (vollstaendig) geschrieben: frisch ausgestellte Dev-Tokens nicht beim Anbieter verwaist lassen, aber nur ueber das Tor
      // (nie eine Kennung, die im Inventar noch gilt, nie nach Beginn des Schreibens), und was bleibt, steht in der Fehlermeldung.
      addUnrevokedNotices(err, await revokeIssuedTokens(built.issuedTokens, envDeps, { writeStarted }));
      if (!writeStarted) forgetRunValues(runValues, template.id);
      throw err;
    }
    const warnings: string[] = [];
    if (written.gitIgnored === false) warnings.push("Die Datei ist nicht von Git ignoriert. In .gitignore eintragen, bevor etwas committet wird.");
    if (written.gitIgnored === null) warnings.push("Ob Git die Datei ignoriert, liess sich nicht pruefen.");
    if (wantsCommands && !host?.runCommand) warnings.push("Befehle der Vorlage laufen in dieser Umgebung nicht; die betroffenen Werte bleiben leer.");
    else if (wantsCommands && !commandsAllowed) warnings.push("Befehle der Vorlage laufen nur in einem Ordner unter policy.envRoots oder im verknuepften Ordner; die betroffenen Werte bleiben leer.");
    return { status: "written", path: written.path, keys: built.keys, sources: built.sources, skipped: built.skipped, gitIgnored: written.gitIgnored, warnings };
  } catch (err) {
    if (err instanceof PromptsRequiredError) {
      return { status: "needs-input", keys: err.keys, message: "Diese Werte muss ein Mensch im Portal oder mit `secret-desk env export --prompt KEY=WERT` angeben." };
    }
    throw err;
  }
}
