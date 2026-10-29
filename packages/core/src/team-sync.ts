import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, parseDocument } from "yaml";
import { ConfigSchema, type TeamSyncConfig } from "./config.js";
import { exportTeamBundle, TeamBundleError } from "./team.js";
import type { Inventory } from "./types.js";

export class TeamSyncError extends Error {
  constructor(
    message: string,
    readonly code: "not-configured" | "not-connected" | "not-found" | "denied" | "conflict" | "changed" | "invalid" | "network" | "forbidden-mode" | "too-soon" | "unwritable",
  ) {
    super(message);
    this.name = "TeamSyncError";
  }
}

/** Kennung des Inhalts (SHA-256, kurz). Kein Geheimnis. */
export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface BundleDiff {
  /** Je Bereich: Ids, die nur in der Quelle (added), nur im Ziel (removed) oder in beiden mit anderem Inhalt (changed) stehen. Nur Ids, keine Werte. */
  sections: Record<"secrets" | "variables" | "stages" | "providers" | "envTemplates", { added: string[]; changed: string[]; removed: string[] }>;
  empty: boolean;
}

const SECTION_KEYS = ["secrets", "variables", "stages", "providers", "envTemplates"] as const;

/** Team-Datei-Fassung eines Inventars (ohne externalId/rotatedAt), als Objekt zum Vergleichen. */
function normalized(inv: Inventory): Record<string, { id?: string }[]> {
  return parse(exportTeamBundle(inv), { schema: "core" }) as Record<string, { id?: string }[]>;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Unterschied zweier Inventare in der Fassung der Team-Datei. `next` ist das Ziel (zum Beispiel der Stand im Repository),
 * `base` der Ausgangspunkt (der lokale Stand). added = nur in next, removed = nur in base. Zeigt Ids, nie Inhalte.
 */
export function diffBundles(base: Inventory, next: Inventory): BundleDiff {
  const a = normalized(base);
  const b = normalized(next);
  const sections = {} as BundleDiff["sections"];
  let empty = true;
  for (const key of SECTION_KEYS) {
    const am = new Map((a[key] ?? []).map((x) => [String(x.id), stable(x)]));
    const bm = new Map((b[key] ?? []).map((x) => [String(x.id), stable(x)]));
    const added = [...bm.keys()].filter((id) => !am.has(id));
    const removed = [...am.keys()].filter((id) => !bm.has(id));
    const changed = [...bm.keys()].filter((id) => am.has(id) && am.get(id) !== bm.get(id));
    if (added.length || removed.length || changed.length) empty = false;
    sections[key] = { added, changed, removed };
  }
  // Ohne Stages in einer der Dateien sind die Standard-Stages gemeint; ein Unterschied zeigt sich nur bei echten Abweichungen.
  return { sections, empty };
}

/**
 * Pruefung vor jedem Push: die Team-Datei darf nur die Struktur enthalten. Schluessel, die Laufzeitwerte tragen, sind verboten
 * (externalId, rotatedAt) und der Text darf keinen der uebergebenen Geheimtexte (Tokens der Sitzung) enthalten.
 */
export function assertTeamFileClean(text: string, forbidden: readonly string[] = []): void {
  const doc = parse(text, { schema: "core" }) as { secrets?: Record<string, unknown>[] } | null;
  for (const s of doc?.secrets ?? []) {
    for (const key of ["externalId", "rotatedAt"]) if (key in s) throw new TeamBundleError(`Team-Datei enthaelt ${key}: wird nicht hochgeladen.`);
  }
  for (const f of forbidden) if (f.length >= 8 && text.includes(f)) throw new TeamBundleError("Team-Datei enthaelt einen Zugangs-Token: wird nicht hochgeladen.");
}

// ------------------------------------------------------------------------------------------------ Zustand (lokal)

export interface TeamSyncState {
  /** Blob-SHA der Datei im Repository beim letzten Abgleich. */
  remoteSha: string | null;
  /** Kennung der lokalen Team-Datei-Fassung beim letzten Abgleich. */
  localHash: string | null;
  lastSyncAt: string | null;
  lastPushAt: string | null;
  /** Offener Pull Request des letzten Pushs (Strategie pull-request). */
  pendingPullUrl: string | null;
  /** "Leer starten" gewaehlt: der Assistent soll nicht mehr erscheinen. */
  setupDismissed: boolean;
}

export const EMPTY_STATE: TeamSyncState = { remoteSha: null, localHash: null, lastSyncAt: null, lastPushAt: null, pendingPullUrl: null, setupDismissed: false };

export async function readTeamSyncState(path: string): Promise<TeamSyncState> {
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(await readFile(path, "utf8")) as Partial<TeamSyncState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function writeTeamSyncState(path: string, state: TeamSyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------------------------------------------ Konfigurationsdatei

const MINIMAL_CONFIG = `# secret-desk: Minimalkonfiguration (automatisch angelegt). Anpassen: docs/CONFIGURATION.md
inventory: ./inventory.yaml
github:
  owner: your-organization
  auth: { type: pat, source: { type: session } }
`;

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fehlt die Konfigurationsdatei, wird eine Minimalkonfiguration samt leerem Inventar angelegt (nur wenn der Ordner beschreibbar ist),
 * statt mit ENOENT abzubrechen. Gibt true zurueck, wenn etwas angelegt wurde.
 */
export async function ensureConfigFile(configPath: string): Promise<boolean> {
  try {
    await access(configPath, constants.R_OK);
    return false;
  } catch {
    /* anlegen */
  }
  const dir = dirname(configPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    /* unten melden */
  }
  if (!(await writable(dir))) throw new TeamSyncError(`Die Konfigurationsdatei ${configPath} fehlt und der Ordner ist nicht beschreibbar. Datei anlegen oder SECRET_DESK_CONFIG auf einen beschreibbaren Pfad setzen.`, "unwritable");
  await writeFile(configPath, MINIMAL_CONFIG, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(`${dir}/inventory.yaml`, "version: 1\nsecrets: []\nvariables: []\n", { flag: "wx" });
  } catch {
    /* Inventar existiert schon */
  }
  return true;
}

/** Schreibt (oder entfernt) den Abschnitt teamSync in die Konfigurationsdatei. Kommentare bleiben erhalten. */
export async function writeTeamSyncConfig(configPath: string, teamSync: TeamSyncConfig | null): Promise<void> {
  const doc = parseDocument(await readFile(configPath, "utf8"), { schema: "core" });
  if (teamSync) doc.set("teamSync", doc.createNode(JSON.parse(JSON.stringify(teamSync))));
  else doc.delete("teamSync");
  // Vor dem Schreiben pruefen, damit keine kaputte Konfiguration entsteht.
  const check = ConfigSchema.safeParse(doc.toJS());
  if (!check.success) throw new TeamSyncError(`Konfiguration waere ungueltig: ${check.error.issues.map((i) => i.message).join("; ")}`, "invalid");
  await writeFile(configPath, doc.toString({ lineWidth: 0 }), { mode: 0o600 });
}
