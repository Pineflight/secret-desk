import { assertEntryParams, effectiveParams, integrationDefaultsOf } from "./params.js";
import { execFile } from "node:child_process";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import type { InventoryStore } from "./inventory.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import type { EnvCommand, EnvSource, EnvTemplate } from "./types.js";
import { isPathInsideOrSame, localPathProblem, realpathLoose, writePrivateFile } from "./platform.js";

export class EnvExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvExportError";
  }
}

export class PromptsRequiredError extends EnvExportError {
  constructor(readonly keys: string[]) {
    super(`Eingabe noetig fuer: ${keys.join(", ")}`);
    this.name = "PromptsRequiredError";
  }
}

export interface EnvBuildDeps {
  inventory: InventoryStore;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  fetch?: FetchLike;
  now?: () => Date;
  /** Vom Nutzer eingegebene Werte fuer `prompt`-Eintraege. */
  prompts?: Record<string, string>;
  /** Konfiguration der Anbieter (zum Beispiel erlaubte Grafana-Hosts), wird an provider.issue durchgereicht. */
  providerConfig?: ProviderConfig;
  /**
   * Nur diese Stages duerfen als `issue`-Quelle ausgestellt werden (gesetzt fuer Agenten: Dev-Stages).
   * Ohne Angabe gilt keine Einschraenkung (Mensch).
   */
  allowedIssueStages?: string[];
  /**
   * Values of earlier templates in the same export run, key `<templateId>:<KEY>`. `ref` entries read from here first, and
   * buildEnvFile adds the values it produces. Lives in memory only.
   */
  runValues?: Map<string, string>;
  /** Text of the file a referenced template already produced, or null. Read only when the run has no value. */
  readTemplateFile?: (template: EnvTemplate) => Promise<string | null>;
  /**
   * Runs an allowlisted command and returns its output as KEY=VALUE pairs. Only the CLI on the developer machine passes it.
   * Without it, `command` entries are written as commented, empty lines.
   */
  runCommand?: (command: EnvCommand) => Promise<Map<string, string>>;
}

export type EnvSourceType = EnvSource["type"];

export interface EnvBuildResult {
  text: string;
  keys: string[];
  /** Zuordnung Schluessel -> Herkunft, ohne Werte. */
  sources: Record<string, EnvSourceType>;
  /** Keys written as a commented, empty line (optional prompt without input, command without the CLI). No values. */
  skipped: string[];
  issuedSecretIds: string[];
  /** Fuer jeden ausgestellten Wert die Kennung beim Anbieter (falls er eine nennt). Zum Widerrufen, wenn die Datei nicht geschrieben wird. */
  issuedTokens: { secretId: string; externalId?: string }[];
}

/**
 * Widerruft ausgestellte Werte beim Anbieter (best effort). Liefert die Eintraege, die sich nicht widerrufen liessen,
 * als "secretId (Kennung)" - ohne Kennung oder ohne revoke bleibt nur der Hinweis.
 */
export async function revokeIssuedTokens(
  tokens: EnvBuildResult["issuedTokens"],
  deps: Pick<EnvBuildDeps, "inventory" | "providers" | "connections" | "fetch" | "providerConfig">,
): Promise<string[]> {
  const failed: string[] = [];
  for (const t of tokens) {
    const secret = deps.inventory.getSecret(t.secretId);
    const provider = secret ? deps.providers.get(secret.provider) : undefined;
    if (!secret || !t.externalId || !provider?.revoke) {
      failed.push(`${t.secretId} (${t.externalId ?? "ohne Kennung"})`);
      continue;
    }
    try {
      await provider.revoke({ externalId: t.externalId, secret, params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)), connections: deps.connections, fetch: deps.fetch ?? fetch, ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}) });
    } catch {
      failed.push(`${t.secretId} (${t.externalId})`);
    }
  }
  return failed;
}

export function generateValue(kind: "hex" | "base64" | "base64url" | "uuid", bytes: number): string {
  if (kind === "uuid") return randomUUID();
  const b = randomBytes(bytes);
  return kind === "hex" ? b.toString("hex") : kind === "base64url" ? b.toString("base64url") : b.toString("base64");
}

/** VAPID key pair for Web Push: public = uncompressed P-256 point, private = 32 bytes, both base64url. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const priv = Buffer.alloc(32);
  ecdh.getPrivateKey().copy(priv, 32 - ecdh.getPrivateKey().length);
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: priv.toString("base64url") };
}

type GenerateSource = Extract<EnvSource, { type: "generate" }>;

/**
 * Value for a `generate` entry. `pairs` holds the VAPID pairs of one export, so a public and a private entry with the same
 * `pair` belong together.
 */
export function generateEntryValue(from: GenerateSource, pairs: Map<string, { publicKey: string; privateKey: string }>): string {
  if (from.kind === "vapid-public" || from.kind === "vapid-private") {
    const id = from.pair ?? "default";
    let keys = pairs.get(id);
    if (!keys) {
      keys = generateVapidKeys();
      pairs.set(id, keys);
    }
    return from.kind === "vapid-public" ? keys.publicKey : keys.privateKey;
  }
  return `${from.prefix ?? ""}${generateValue(from.kind, from.bytes)}`;
}

/**
 * Reads KEY=VALUE lines the way formatEnvValue writes them (also `export KEY=`, single and double quotes, multi-line quotes).
 * Comments and blank lines are skipped. Used for produced files and command output, never logged.
 */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = text;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const end = src.indexOf("\n", i);
    const line = src.slice(i, end === -1 ? n : end);
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(line);
    if (!m) {
      i = end === -1 ? n : end + 1;
      continue;
    }
    let pos = i + m[0].length;
    const quote = src[pos];
    let value = "";
    if (quote === "'" || quote === '"') {
      pos++;
      while (pos < n && src[pos] !== quote) {
        if (quote === '"' && src[pos] === "\\" && pos + 1 < n) {
          const next = src[pos + 1]!;
          value += next === "n" ? "\n" : next;
          pos += 2;
          continue;
        }
        value += src[pos];
        pos++;
      }
      if (pos >= n) {
        // Unterminated quote: skip this key, go on with the next line instead of swallowing the rest of the file.
        i = end === -1 ? n : end + 1;
        continue;
      }
      pos++; // closing quote
      const rest = src.indexOf("\n", pos);
      i = rest === -1 ? n : rest + 1;
    } else {
      const raw = line.slice(m[0].length);
      const hash = raw.search(/\s#/);
      value = (hash === -1 ? raw : raw.slice(0, hash)).trim();
      i = end === -1 ? n : end + 1;
    }
    out.set(m[1]!, value);
  }
  return out;
}

const COMMANDS: Record<EnvCommand, { program: string; args: string[] }> = {
  "supabase-status": { program: "supabase", args: ["status", "-o", "env"] },
};

/** Environment names a local command may see: system basics and Docker, never prompt values or provider tokens. */
const COMMAND_ENV_NAMES = /^(PATH|PATHEXT|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TERM|DOCKER_[A-Z_]+|XDG_[A-Z_]+|SystemRoot|ComSpec|APPDATA|LOCALAPPDATA|USERPROFILE)$/;

function commandEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && COMMAND_ENV_NAMES.test(name)) out[name] = value;
  return out;
}

/** Package manager of a repository folder, from its lock file. */
function packageManagerOf(cwd: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The repository's own binary (node_modules/.bin/<program>) when it has one, else the program from PATH. */
function programFor(program: string, cwd: string): string {
  const local = join(cwd, "node_modules", ".bin", program);
  return existsSync(local) ? local : program;
}

/**
 * How to start the local stack in this repository: its own package.json script that runs `supabase start`, else the
 * repository's Supabase CLI through the package manager, else the global CLI. Only names from package.json, never values.
 */
export function supabaseStartCommand(cwd: string): string {
  const pm = packageManagerOf(cwd);
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (typeof script === "string" && /\bsupabase\s+start\b/.test(script) && /^[A-Za-z0-9:._-]{1,60}$/.test(name)) return `${pm} run ${name}`;
    }
  } catch {
    // no or unreadable package.json: fall through
  }
  if (existsSync(join(cwd, "node_modules", ".bin", "supabase"))) return `${pm} exec supabase start`;
  return "supabase start";
}

/**
 * Runs an allowlisted command (fixed program and arguments, no shell) in `cwd` and parses its KEY=VALUE output. The
 * repository's own binary in node_modules/.bin wins over PATH. Errors name the command, the exit code and how to start the
 * stack, never the output.
 */
export function runEnvCommand(command: EnvCommand, cwd: string, options: { timeoutMs?: number } = {}): Promise<Map<string, string>> {
  // Only the names in COMMANDS exist: nothing a configuration or a request supplies can select another program.
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) return Promise.reject(new EnvExportError("Unknown template command."));
  const spec = COMMANDS[command];
  const program = programFor(spec.program, cwd);
  return new Promise((res, rej) => {
    execFile(program, spec.args, { cwd, env: commandEnv(), timeout: options.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      if (err) {
        const code = (err as { code?: number | string }).code;
        if (code === "ENOENT") return rej(new EnvExportError(`Befehl ${command}: Programm "${spec.program}" nicht gefunden (weder im Repository unter node_modules/.bin noch im PATH).`));
        return rej(new EnvExportError(`Befehl ${command} fehlgeschlagen (Exit-Code ${typeof code === "number" ? code : "unbekannt"}). Laeuft der lokale Stack? Im Repository starten mit: ${supabaseStartCommand(cwd)}`));
      }
      res(parseEnvText(stdout));
    });
  });
}

/**
 * Maskiert einen Wert so, dass `source .env`, docker compose und dotenv-Parser ihn als reinen Text lesen und nichts ausfuehren.
 *   1. Nur harmlose Zeichen: unveraendert.
 *   2. Sonst in EINFACHE Anfuehrungszeichen: In der POSIX-Shell, bei docker compose und bei dotenv ist dort alles wortwoertlich
 *      ($(...), Backticks, $VAR, Backslashes, Zeilenumbrueche). Das ist der Normalfall.
 *   3. Enthaelt der Wert selbst ein einfaches Anfuehrungszeichen (dort nicht maskierbar): doppelte Anfuehrungszeichen
 *      und \, ", $ sowie Backtick mit Backslash maskieren. Zeilenumbrueche bleiben echte Zeilenumbrueche (in der Shell und
 *      in dotenv innerhalb doppelter Anfuehrungszeichen gueltig; die Zeichenfolge \n wuerde die Shell nicht umsetzen).
 */
export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** Text fuer eine Kommentarzeile: jede Art von Zeilenumbruch wird zu einem Leerzeichen, sonst koennte ein Kommentar eine Zuweisung einschleusen. */
export function commentText(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").trim();
}

/**
 * Baut den Inhalt einer .env-Datei fuer eine Vorlage. Werte entstehen jetzt: Defaults aus der
 * Vorlage, Zufallswerte, frisch ausgestellte persoenliche Dev-Tokens oder Eingaben. Das Portal
 * speichert sie nirgends, sie stehen nur im Ergebnis.
 */
export async function buildEnvFile(template: EnvTemplate, deps: EnvBuildDeps): Promise<EnvBuildResult> {
  const missing = template.entries.filter((e) => e.from.type === "prompt" && !e.from.optional && !deps.prompts?.[e.key]).map((e) => e.key);
  if (missing.length > 0) throw new PromptsRequiredError(missing);

  const now = (deps.now ?? (() => new Date()))();
  const lines: string[] = [
    `# Generated by secret-desk on ${now.toISOString().slice(0, 10)} for ${commentText(template.repo)} (${commentText(template.stage)}).`,
    "# Contains secrets. Do not commit, do not share.",
    "",
  ];
  const sources: EnvBuildResult["sources"] = {};
  const skipped: string[] = [];
  const issued: string[] = [];
  const issuedTokens: EnvBuildResult["issuedTokens"] = [];
  /** Values resolved before anything is issued (ref, command); null = written as a commented, empty line. */
  const resolved = new Map<string, string | null>();
  const commandOutput = new Map<EnvCommand, Map<string, string>>();
  const templateFiles = new Map<string, Map<string, string> | null>();

  // Erst alles pruefen, dann ausstellen: Eine fehlende Variable oder Quelle darf nicht erst nach dem ersten `issue` auffallen.
  for (const entry of template.entries) {
    const from = entry.from;
    if (from.type === "variable") {
      const variable = deps.inventory.getVariable(from.variable);
      if (!variable || variable.value === null) throw new EnvExportError(`Variable ${from.variable} hat keinen Sollwert. Im Portal setzen oder aus GitHub uebernehmen.`);
    } else if (from.type === "issue") {
      const secret = deps.inventory.getSecret(from.secret);
      if (!secret) throw new EnvExportError(`Unbekanntes Secret: ${from.secret}`);
      if (deps.allowedIssueStages && !deps.allowedIssueStages.includes(secret.stage)) {
        throw new EnvExportError(`${secret.id}: Die Stage ${secret.stage} darf hier nicht ausgestellt werden.`);
      }
      const provider = deps.providers.get(secret.provider);
      if (!provider || provider.kind !== "automatic" || !provider.issue) {
        throw new EnvExportError(`${secret.id}: Anbieter "${secret.provider}" kann keinen Dev-Wert erzeugen. In der Vorlage "prompt" verwenden.`);
      }
      assertEntryParams(provider, secret, integrationDefaultsOf(deps.inventory, provider));
    } else if (from.type === "ref") {
      const key = `${from.template}:${from.key}`;
      let value = deps.runValues?.get(key);
      // A template already exported in this run is authoritative: its old file must not fill a key it left empty.
      if (value === undefined && !deps.runValues?.has(`${from.template}:`)) {
        const target = deps.inventory.data.envTemplates.find((t) => t.id === from.template);
        if (!target) throw new EnvExportError(`${entry.key}: unbekannte Vorlage ${from.template}`);
        if (!templateFiles.has(target.id)) {
          const text = deps.readTemplateFile ? await deps.readTemplateFile(target) : null;
          templateFiles.set(target.id, text === null ? null : parseEnvText(text));
        }
        value = templateFiles.get(target.id)?.get(from.key);
      }
      if (value === undefined || value === "") {
        throw new EnvExportError(`${entry.key}: Kein Wert fuer ${from.key} aus der Vorlage ${from.template}. Zuerst diese Vorlage exportieren oder beide zusammen (--repo mehrfach angeben).`);
      }
      resolved.set(entry.key, value);
    } else if (from.type === "command") {
      if (!deps.runCommand) {
        resolved.set(entry.key, null);
        continue;
      }
      let output = commandOutput.get(from.command);
      if (!output) {
        try {
          output = await deps.runCommand(from.command);
        } catch (err) {
          if (!from.optional) throw err;
          output = new Map();
        }
        commandOutput.set(from.command, output);
      }
      const value = output.get(from.key);
      if (value === undefined || value === "") {
        if (!from.optional) throw new EnvExportError(`${entry.key}: Befehl ${from.command} liefert keinen Wert fuer ${from.key}.`);
        resolved.set(entry.key, null);
      } else resolved.set(entry.key, value);
    }
  }
  const pairs = new Map<string, { publicKey: string; privateKey: string }>();

  try {
    for (const entry of template.entries) {
      let value: string | null;
      const from = entry.from;
      if (from.type === "default") value = from.value;
      else if (from.type === "generate") value = generateEntryValue(from, pairs);
      else if (from.type === "prompt") value = deps.prompts?.[entry.key] || null;
      else if (from.type === "ref" || from.type === "command") value = resolved.get(entry.key) ?? null;
      else if (from.type === "variable") value = deps.inventory.getVariable(from.variable)!.value!;
      else {
        const secret = deps.inventory.getSecret(from.secret)!;
        const provider = deps.providers.get(secret.provider)!;
        const result = await provider.issue!({
          secret,
          params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)),
          stage: template.stage,
          stageKind: stageKind(deps.inventory.stages, template.stage),
          connections: deps.connections,
          fetch: deps.fetch ?? fetch,
          now,
          label: `${secret.id}-${template.stage}-${now.toISOString().slice(0, 10)}`,
          ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}),
        });
        value = result.value.reveal();
        issued.push(secret.id);
        issuedTokens.push({ secretId: secret.id, ...(result.externalId ? { externalId: result.externalId } : {}) });
      }
      if (entry.description) lines.push(`# ${commentText(entry.description)}`);
      sources[entry.key] = from.type;
      if (value === null) {
        const why = from.type === "command" ? (deps.runCommand ? `optional, not reported by ${from.command}` : `filled by the CLI from ${from.command}`) : `optional${from.type === "prompt" && from.hint ? `: ${commentText(from.hint)}` : ", not set"}`;
        lines.push(`# ${entry.key}= (${why})`);
        skipped.push(entry.key);
        continue;
      }
      lines.push(`${entry.key}=${formatEnvValue(value)}`);
      deps.runValues?.set(`${template.id}:${entry.key}`, value);
    }
  } catch (err) {
    // Ein spaeterer Schritt ist gescheitert: schon ausgestellte Werte nicht beim Anbieter verwaist zuruecklassen.
    const failed = await revokeIssuedTokens(issuedTokens, deps);
    if (err instanceof Error && failed.length > 0) err.message += ` Nicht widerrufen (beim Anbieter von Hand entfernen): ${failed.join(", ")}.`;
    throw err;
  }
  deps.runValues?.set(`${template.id}:`, "");
  return { text: `${lines.join("\n")}\n`, keys: template.entries.map((e) => e.key), sources, skipped, issuedSecretIds: issued, issuedTokens };
}

export interface WriteEnvResult {
  path: string;
  /** true = von Git ignoriert, false = nicht ignoriert (Warnung), null = nicht pruefbar. */
  gitIgnored: boolean | null;
}

/** Asks Git whether it ignores `path` (starts `git`): true, false, or null when it cannot be checked. */
export function gitCheckIgnored(path: string): Promise<boolean | null> {
  return new Promise((res) => {
    execFile("git", ["check-ignore", "-q", path], { cwd: dirname(path), timeout: 5000, windowsHide: true }, (err) => {
      if (!err) return res(true);
      const code = (err as { code?: number | string }).code;
      res(code === 1 ? false : null);
    });
  });
}

/** Schreibt die Datei mit Modus 600. Ueberschreibt nur mit overwrite, und nur innerhalb erlaubter Wurzeln. */
export async function writeEnvFile(
  path: string,
  text: string,
  options: {
    overwrite?: boolean;
    allowedRoots?: string[];
    /** How to ask whether Git ignores the written file. Default: `gitCheckIgnored` (starts `git`). A caller without that capability passes a function that answers null. */
    checkIgnored?: (path: string) => Promise<boolean | null>;
  } = {},
): Promise<WriteEnvResult> {
  const problem = localPathProblem(path);
  if (problem) throw new EnvExportError(problem);
  const target = resolve(path);
  if (options.allowedRoots && options.allowedRoots.length > 0) {
    // Symlinks und die Schreibweise auf der Platte aufloesen, dann vergleichen (Windows: ohne Gross-/Kleinschreibung).
    const realTarget = await realpathLoose(target);
    let ok = false;
    for (const root of options.allowedRoots) {
      const realRoot = await realpathLoose(root);
      if (isPathInsideOrSame(realRoot, realTarget)) ok = true;
    }
    if (!ok) throw new EnvExportError(`Pfad liegt ausserhalb der erlaubten Ordner: ${target}`);
  }
  const exists = await stat(target).then(() => true, () => false);
  if (exists && !options.overwrite) throw new EnvExportError(`Datei existiert schon: ${target}`);
  await mkdir(dirname(target), { recursive: true });
  await writePrivateFile(target, text);
  return { path: target, gitIgnored: await (options.checkIgnored ?? gitCheckIgnored)(target) };
}
