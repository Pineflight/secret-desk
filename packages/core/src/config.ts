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
