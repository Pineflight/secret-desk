import { parse, stringify } from "yaml";
import { InventoryStore } from "./inventory.js";
import { InventorySchema, type Inventory } from "./types.js";

export class TeamBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamBundleError";
  }
}

/**
 * Die Konfigurationsdatei fuer ein Team: Struktur des Inventars, Dev-Vorlagen und eigene Anbieter.
 * Enthaelt keine Werte und keine anbieterinternen Kennungen. Ein neues Teammitglied importiert sie,
 * verbindet seine eigenen Konten und erzeugt seine persoenliche Dev-Umgebung.
 */
export function exportTeamBundle(inventory: Inventory): string {
  const secrets = inventory.secrets.map(({ externalId: _externalId, rotatedAt: _rotatedAt, ...rest }) => rest);
  const doc = { ...inventory, secrets };
  const header = [
    "# secret-desk Team-Konfiguration",
    "# Enthaelt KEINE Werte. Import: secret-desk team import <datei>",
    "# Danach Konten verbinden und `secret-desk env export --repo <repo> --stage dev` ausfuehren.",
    "",
  ].join("\n");
  return header + stringify(JSON.parse(JSON.stringify(doc)), { lineWidth: 0 });
}

export function parseTeamBundle(text: string): Inventory {
  let raw: unknown;
  try {
    raw = parse(text, { schema: "core" });
  } catch (err) {
    throw new TeamBundleError(`Ungueltiges YAML: ${(err as Error).message}`);
  }
  const parsed = InventorySchema.safeParse(raw);
  if (!parsed.success) {
    throw new TeamBundleError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export interface MergeResult {
  added: string[];
  skipped: string[];
}

/** merge: vorhandene ids bleiben unveraendert, Neues kommt dazu. replace: ersetzt alles. */
export function mergeTeamBundle(store: InventoryStore, bundle: Inventory, mode: "merge" | "replace" = "merge"): MergeResult {
  if (mode === "replace") {
    store.replaceData(bundle);
    return { added: bundle.secrets.map((s) => s.id), skipped: [] };
  }
  const added: string[] = [];
  const skipped: string[] = [];
  for (const s of bundle.secrets) {
    if (store.getSecret(s.id)) skipped.push(s.id);
    else {
      store.addSecret(s);
      added.push(s.id);
    }
  }
  for (const p of bundle.providers) if (!store.data.providers.some((x) => x.id === p.id)) store.addProvider(p);
  for (const t of bundle.envTemplates) if (!store.data.envTemplates.some((x) => x.id === t.id)) store.addEnvTemplate(t);
  return { added, skipped };
}
