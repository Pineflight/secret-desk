import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { StageSchema } from "./types.js";

export const SourceSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("env"), name: z.string().min(1) }),
  z.object({ type: z.literal("op"), ref: z.string().startsWith("op://") }),
  z.object({ type: z.literal("session") }),
]);

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
      /** Stages, die Agenten (MCP) ohne Freigabe anfassen duerfen. */
      agentStages: z.array(StageSchema).default(["dev"]),
      /** Ordner, in die Env-Dateien geschrieben werden duerfen. Leer = nur ausdruecklich angegebene Pfade. */
      envRoots: z.array(z.string()).default([]),
    })
    .default({ agentStages: ["dev"], envRoots: [] }),
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
    })
    .default({ enabled: true, loginTimeoutMinutes: 10 }),
  server: z.object({ port: z.number().int().min(1024).max(65535).default(4747) }).default({ port: 4747 }),
});
export type DeskConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(path: string): Promise<DeskConfig> {
  const text = await readFile(path, "utf8");
  const parsed = ConfigSchema.safeParse(parse(text, { schema: "core" }));
  if (!parsed.success) {
    throw new Error(`Konfiguration ungueltig: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
