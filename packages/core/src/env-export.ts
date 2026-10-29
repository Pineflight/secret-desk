import { assertEntryParams, effectiveParams, integrationDefaultsOf } from "./params.js";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import type { InventoryStore } from "./inventory.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import type { EnvTemplate } from "./types.js";
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
}

export interface EnvBuildResult {
  text: string;
  keys: string[];
  /** Zuordnung Schluessel -> Herkunft, ohne Werte. */
  sources: Record<string, "default" | "generate" | "issue" | "prompt" | "variable">;
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

export function generateValue(kind: "hex" | "base64" | "uuid", bytes: number): string {
  if (kind === "uuid") return randomUUID();
  const b = randomBytes(bytes);
  return kind === "hex" ? b.toString("hex") : b.toString("base64");
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
  const missing = template.entries.filter((e) => e.from.type === "prompt" && !deps.prompts?.[e.key]).map((e) => e.key);
  if (missing.length > 0) throw new PromptsRequiredError(missing);

  const now = (deps.now ?? (() => new Date()))();
  const lines: string[] = [
    `# Erzeugt von secret-desk am ${now.toISOString().slice(0, 10)} fuer ${commentText(template.repo)} (${commentText(template.stage)}).`,
    "# Enthaelt Geheimnisse. Nicht committen, nicht weitergeben.",
    "",
  ];
  const sources: EnvBuildResult["sources"] = {};
  const issued: string[] = [];
  const issuedTokens: EnvBuildResult["issuedTokens"] = [];

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
    }
  }

  try {
    for (const entry of template.entries) {
      let value: string;
      const from = entry.from;
      if (from.type === "default") value = from.value;
      else if (from.type === "generate") value = generateValue(from.kind, from.bytes);
      else if (from.type === "prompt") value = deps.prompts![entry.key]!;
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
      lines.push(`${entry.key}=${formatEnvValue(value)}`);
      sources[entry.key] = from.type;
    }
  } catch (err) {
    // Ein spaeterer Schritt ist gescheitert: schon ausgestellte Werte nicht beim Anbieter verwaist zuruecklassen.
    const failed = await revokeIssuedTokens(issuedTokens, deps);
    if (err instanceof Error && failed.length > 0) err.message += ` Nicht widerrufen (beim Anbieter von Hand entfernen): ${failed.join(", ")}.`;
    throw err;
  }
  return { text: `${lines.join("\n")}\n`, keys: template.entries.map((e) => e.key), sources, issuedSecretIds: issued, issuedTokens };
}

export interface WriteEnvResult {
  path: string;
  /** true = von Git ignoriert, false = nicht ignoriert (Warnung), null = nicht pruefbar. */
  gitIgnored: boolean | null;
}

function checkIgnored(path: string): Promise<boolean | null> {
  return new Promise((res) => {
    execFile("git", ["check-ignore", "-q", path], { cwd: dirname(path), timeout: 5000, windowsHide: true }, (err) => {
      if (!err) return res(true);
      const code = (err as { code?: number | string }).code;
      res(code === 1 ? false : null);
    });
  });
}

/** Schreibt die Datei mit Modus 600. Ueberschreibt nur mit overwrite, und nur innerhalb erlaubter Wurzeln. */
export async function writeEnvFile(path: string, text: string, options: { overwrite?: boolean; allowedRoots?: string[] } = {}): Promise<WriteEnvResult> {
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
  return { path: target, gitIgnored: await checkIgnored(target) };
}
