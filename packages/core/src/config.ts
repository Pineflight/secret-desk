import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { SecretName, StageSchema } from "./types.js";
import type { StageDef } from "./stages.js";

export const SourceSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("env"), name: z.string().min(1) }),
  z.object({ type: z.literal("op"), ref: z.string().startsWith("op://") }),
  z.object({ type: z.literal("session") }),
]);

/** Team-Sync: Team-Datei (ohne Werte) mit einem privaten GitHub-Repository abgleichen. Der Zugangs-Token ist die Verbindung "team-sync". */
export const TeamSyncSchema = z.object({
  /** Ziel-Repository, "owner/name". */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Format "owner/name"'),
  /** Pfad der Team-Datei im Repository. */
  path: z.string().min(1).default("secret-desk.team.yaml"),
  /** Zweig, aus dem gelesen wird und (bei strategy pull-request) in den der Pull Request geht. */
  branch: z.string().min(1).default("main"),
  /** pull: nur lesen. pull-push: Aenderungen aus dem Portal zusaetzlich ins Repository schieben (nach Bestaetigung). */
  mode: z.enum(["pull", "pull-push"]).default("pull"),
  push: z
    .object({
      /** pull-request: Aenderung auf einem eigenen Zweig und Pull Request. direct: Commit direkt auf den Zweig. */
      strategy: z.enum(["pull-request", "direct"]).default("pull-request"),
      /** Zweig fuer Pull Requests. */
      branch: z.string().min(1).default("secret-desk/team-sync"),
    })
    .default({ strategy: "pull-request", branch: "secret-desk/team-sync" }),
  /** Beim Start des Portals den Stand im Repository abfragen (nur lesend, nichts wird ohne Vorschau uebernommen). */
  pullOnStart: z.boolean().default(true),
});
export type TeamSyncConfig = z.infer<typeof TeamSyncSchema>;
export const TEAM_SYNC_CONNECTION = "team-sync";

export const ConfigSchema = z.object({
  /** Pfad zur Inventar-Datei, relativ zur Konfiguration. */
  inventory: z.string().min(1),
  /** Ordner fuer Pruefberichte und Anlagen, relativ zur Konfiguration. Nicht ins Git. */
  evidenceDir: z.string().default(".secret-desk-evidence"),
  /** Lokale Datei mit den Ordner-Verknuepfungen der Repositories (rechnerspezifisch, nie im Inventar). Standard: ~/.secret-desk/repo-links.json. */
  linksFile: z.string().min(1).optional(),
  /** Tresor fuer Zugangs-Tokens der Integrationen (verschluesselt, Schluessel im Schluesselbund). */
  vault: z
    .object({
      enabled: z.boolean().default(true),
      /** Datei des Tresors. Standard: ~/.secret-desk/vault.json. */
      file: z.string().min(1).optional(),
      /**
       * Nur wenn ausdruecklich gesetzt. Windows: Ort des DPAPI-geschuetzten Schluessel-Blobs (Standard: <Tresordatei>.key).
       * Linux/macOS: Datei mit dem Schluessel (Base64, 32 Byte, Modus 600), statt Schluesselbund. Schluessel und Daten liegen dann
       * auf demselben Datentraeger: nur nutzen, wenn kein Schluesselbund verfuegbar ist.
       */
      keyFile: z.string().min(1).optional(),
    })
    .default({ enabled: true }),
  github: z.object({
    owner: z.string().min(1),
    auth: z.discriminatedUnion("type", [
      z.object({ type: z.literal("pat"), source: SourceSpecSchema.default({ type: "session" }) }),
      z.object({
        type: z.literal("app"),
        appId: z.string().min(1),
        privateKey: SourceSpecSchema,
        repositories: z.array(z.string()).optional(),
      }),
    ]),
  }),
  /** Quellen fuer Zugangs-Tokens der Anbieter, je Verbindungs-Id (cloudflare, supabase, stripe, ...). */
  connections: z.record(z.string(), SourceSpecSchema).default({}),
  policy: z
    .object({
      /** Stage-Ids, die Agenten (MCP) ohne Freigabe anfassen duerfen. Fehlt die Angabe: alle Stages der Art dev. */
      agentStages: z.array(StageSchema).optional(),
      /** Ordner, in die Env-Dateien geschrieben werden duerfen. Leer = nur ausdruecklich angegebene Pfade. */
      envRoots: z.array(z.string()).default([]),
    })
    .default({ envRoots: [] }),
  /**
   * Einstellungen einzelner Anbieter. Netzwerkziele, die ein Eintrag im Inventar frei waehlen kann, werden hier freigegeben:
   * Das Inventar kann aus fremden Quellen kommen (Git, Pull Requests), die Konfiguration nicht.
   */
  providers: z
    .object({
      grafana: z
        .object({
          /** Zusaetzlich zu *.grafana.net erlaubte Hosts (exakter Hostname, ohne Port, nur https). */
          allowedHosts: z.array(z.string().min(1)).default([]),
        })
        .default({ allowedHosts: [] }),
    })
    .default({ grafana: { allowedHosts: [] } }),
  /** Browser-Automatisierung (Rezepte, siehe docs/BROWSER-AUTOMATION.md). Relative Pfade gelten ab der Konfigurationsdatei, `~` ist das Home-Verzeichnis. */
  automation: z
    .object({
      enabled: z.boolean().default(true),
      /** Chrome/Chromium/Edge; sonst wird an den ueblichen Orten gesucht. */
      chromePath: z.string().min(1).optional(),
      /** Dauerhaftes Browserprofil. Standard: ~/.secret-desk/browser-profile. */
      profileDir: z.string().min(1).optional(),
      /** Wie lange auf Anmeldung, 2FA oder CAPTCHA im Fenster gewartet wird. */
      loginTimeoutMinutes: z.number().min(1).max(120).default(10),
      /** Verlangsamt jede Browseraktion (Millisekunden), zum Zuschauen. */
      slowMoMs: z.number().int().min(0).max(5000).optional(),
      /** Zusaetzliche Ordner mit Rezepten (*.yaml). Zusaetzlich immer <Ordner des Inventars>/recipes. */
      recipesDirs: z.array(z.string().min(1)).optional(),
      /** Rezepte aus anderen Ordnern als den mitgelieferten laden. Rezepte sind ausfuehrbare Browserskripte: nur fuer Quellen, denen du vertraust. */
      allowExternalRecipes: z.boolean().default(false),
    })
    .default({ enabled: true, loginTimeoutMinutes: 10, allowExternalRecipes: false }),
  /** Stage-Vergleich. */
  compare: z
    .object({
      /** Repositories, die der Vergleich weder anzeigt noch liest (Organisations-Vorlagen, Upptime-Repositories mit fremden Workflows ...). */
      ignoreRepos: z.array(z.string().min(1)).default([".github", ".github-private"]),
    })
    .default({ ignoreRepos: [".github", ".github-private"] }),
  /** Namenskonvention (siehe docs/NAMING.md): Ausnahmen und feste Umbenennungen fuer die Vereinheitlichung des Inventars. */
  naming: z
    .object({
      /** Alter Name -> neuer Name. Geht den allgemeinen Regeln vor, zum Beispiel MAIL_API_KEY -> RESEND_API_KEY. */
      renames: z.record(z.string().min(1), SecretName).default({}),
      /** Namen, die nie geaendert werden. */
      keep: z.array(z.string().min(1)).default([]),
    })
    .default({ renames: {}, keep: [] }),
  /** Team-Sync mit einem privaten GitHub-Repository (siehe docs/TEAM.md). Ohne Angabe aus. */
  teamSync: TeamSyncSchema.optional(),
  server: z.object({ port: z.number().int().min(1024).max(65535).default(4747) }).default({ port: 4747 }),
});
export type DeskConfig = z.infer<typeof ConfigSchema>;
/** Anbieter-Einstellungen, wie sie an provider.issue/verify/revoke durchgereicht werden. */
export type ProviderConfig = DeskConfig["providers"];

export async function loadConfig(path: string): Promise<DeskConfig> {
  const text = await readFile(path, "utf8");
  const parsed = ConfigSchema.safeParse(parse(text, { schema: "core" }));
  if (!parsed.success) {
    throw new Error(`Konfiguration ungueltig: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Stage-Ids, die Agenten direkt anfassen duerfen: Richtlinie oder, ohne Angabe, alle Stages der Art dev. Nie live. */
export function agentStageIds(config: Pick<DeskConfig, "policy">, defs: readonly StageDef[]): string[] {
  const ids = config.policy.agentStages ?? defs.filter((d) => d.kind === "dev").map((d) => d.id);
  // Produktionsgrad (live) braucht immer eine Freigabe, auch wenn die Richtlinie die Stage nennt.
  return ids.filter((id) => defs.find((d) => d.id === id)?.kind !== "live");
}
