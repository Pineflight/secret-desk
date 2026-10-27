import { z } from "zod";
import type { DeskClient } from "./client.js";

const StageEnum = z.enum(["dev", "staging", "production", "shared"]);
const PlaceInput = z.object({
  repo: z.string(),
  scope: z.enum(["repository", "environment", "organization"]),
  environment: z.string().optional(),
  name: z.string().optional(),
});

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run: (client: DeskClient, input: Record<string, unknown>) => Promise<unknown>;
}

const qs = (o: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Werkzeuge fuer KI-Agenten. Keines liefert oder verlangt je einen geheimen Wert:
 * Agenten pflegen Metadaten, fragen Status ab und stellen Anfragen, die ein Mensch freigibt.
 */
export const TOOLS: ToolDef[] = [
  {
    name: "desk_overview",
    description: "Uebersicht aller Secrets nach Stage und Status, dazu die dringendsten Eintraege (abgelaufen, bald faellig, fehlend).",
    inputSchema: {},
    run: (c) => c.request("GET", "/overview"),
  },
  {
    name: "desk_list_secrets",
    description: "Listet Secrets (nur Metadaten, nie Werte). Filter: stage (dev, staging, production, shared), repo, product, status (ok, soon, due, expired, no-date, unknown), provider.",
    inputSchema: { stage: StageEnum.optional(), repo: z.string().optional(), product: z.string().optional(), status: z.string().optional(), provider: z.string().optional() },
    run: (c, i) => c.request("GET", `/secrets${qs(i)}`),
  },
  {
    name: "desk_get_secret",
    description: "Ein Secret mit Ziel-Orten, Ablauf, Anbieter und Anleitung (falls manuell).",
    inputSchema: { id: z.string() },
    run: (c, i) => c.request("GET", `/secrets/${encodeURIComponent(String(i.id))}`),
  },
  {
    name: "desk_add_secret",
    description:
      "Legt einen neuen Eintrag im Inventar an (nur Metadaten). id in kleinbuchstaben-mit-bindestrich, name als GROSSBUCHSTABEN_MIT_UNTERSTRICH, stage dev|staging|production|shared. Ausser dev braucht jeder Eintrag mindestens ein Ziel in places (repo, scope repository|environment, bei environment den Namen). provider ist die Id eines Anbieters (siehe desk_list_providers), sonst manual. Der Wert selbst wird nie angegeben.",
    inputSchema: {
      id: z.string(),
      name: z.string(),
      service: z.string(),
      stage: StageEnum,
      provider: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      expiry: z.enum(["none", "possible", "required", "unknown"]).optional(),
      expires: z.string().optional(),
      ttlDays: z.number().int().positive().optional(),
      product: z.string().optional(),
      notes: z.string().optional(),
      places: z.array(PlaceInput).optional(),
    },
    run: (c, i) => c.request("POST", "/secrets", i),
  },
  {
    name: "desk_update_secret",
    description: "Aendert Metadaten eines Eintrags (expires als JJJJ-MM-TT oder null, notes, ttlDays, title). Keine Werte.",
    inputSchema: { id: z.string(), expires: z.string().nullable().optional(), notes: z.string().optional(), ttlDays: z.number().int().positive().optional(), title: z.string().optional() },
    run: (c, i) => {
      const { id, ...patch } = i;
      return c.request("PATCH", `/secrets/${encodeURIComponent(String(id))}`, patch);
    },
  },
  {
    name: "desk_list_providers",
    description: "Anbieter-Module: id, ob automatisch oder manuell, welche Verbindung sie brauchen, Anleitung fuer manuelle.",
    inputSchema: {},
    run: (c) => c.request("GET", "/providers"),
  },
  {
    name: "desk_list_connections",
    description: "Welche Anbieter-Verbindungen hergestellt sind (nur ja/nein und Quelle, keine Tokens).",
    inputSchema: {},
    run: (c) => c.request("GET", "/connections"),
  },
  {
    name: "desk_add_provider",
    description: "Fuegt einen Anbieter ohne API hinzu: nur Anzeigename, Adresse der Seite, wo der Mensch den Token anlegt, und Schritte als Anleitung.",
    inputSchema: { id: z.string(), label: z.string(), url: z.string().url(), steps: z.array(z.string()).optional() },
    run: (c, i) => c.request("POST", "/providers", i),
  },
  {
    name: "desk_add_env_template",
    description:
      "Legt eine .env-Vorlage fuer ein Repo und eine Stage an. Je Eintrag: key und from = { type: default, value } | { type: generate, kind: hex|base64|uuid, bytes } | { type: issue, secret: <id> } | { type: prompt, hint }. Defaults nur fuer Nicht-Geheimes wie URLs.",
    inputSchema: {
      id: z.string(),
      repo: z.string(),
      stage: StageEnum.optional(),
      file: z.string().optional(),
      entries: z.array(z.object({ key: z.string(), description: z.string().optional(), from: z.record(z.string(), z.unknown()) })).min(1),
    },
    run: (c, i) => c.request("POST", "/env-templates", i),
  },
  {
    name: "desk_add_env_entry",
    description: "Haengt einen Eintrag an eine bestehende .env-Vorlage.",
    inputSchema: { template: z.string(), key: z.string(), description: z.string().optional(), from: z.record(z.string(), z.unknown()) },
    run: (c, i) => {
      const { template, ...entry } = i;
      return c.request("POST", `/env-templates/${encodeURIComponent(String(template))}/entries`, entry);
    },
  },
  {
    name: "desk_request_rotation",
    description:
      "Bittet darum, ein Secret beim Anbieter zu erneuern und in GitHub zu schreiben. dryRun zeigt nur den Plan. In staging und production fuehrt das nie sofort aus, sondern erzeugt eine Freigabe-Anfrage, die ein Mensch im Portal bestaetigt. Danach mit desk_get_approval nachsehen.",
    inputSchema: { secretId: z.string(), reason: z.string().optional(), dryRun: z.boolean().optional() },
    run: (c, i) => c.request("POST", "/rotation-requests", i),
  },
  {
    name: "desk_get_approval",
    description: "Status einer Freigabe-Anfrage (pending, approved, denied, failed).",
    inputSchema: { id: z.string() },
    run: (c, i) => c.request("GET", `/approvals/${encodeURIComponent(String(i.id))}`),
  },
  {
    name: "desk_export_dev_env",
    description:
      "Erzeugt die .env fuer die lokale Entwicklung eines Repos (nur Stage dev). Schreibt die Datei in den angegebenen Pfad (muss in einem freigegebenen Ordner liegen), Modus 600. Antwort enthaelt nur Pfad, Schluessel und Herkunft, nie Werte. Lies die Datei danach nicht aus. Fehlen Eingaben (prompt-Eintraege), meldet das Werkzeug needs-input: Die muss ein Mensch im Portal oder in der CLI eintragen.",
    inputSchema: { repo: z.string(), template: z.string().optional(), path: z.string(), overwrite: z.boolean().optional() },
    run: (c, i) => c.request("POST", "/env-export", i),
  },
  {
    name: "desk_team_export",
    description: "Team-Konfiguration (Inventar-Struktur und Dev-Vorlagen, ohne Werte) als YAML, zum Weitergeben an neue Teammitglieder.",
    inputSchema: {},
    run: (c) => c.request("GET", "/team-export"),
  },
];
