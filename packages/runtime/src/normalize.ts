import { InventoryError, applyNormalization, planNormalization, type NormalizationPlan, type NormalizationResult } from "@secret-desk/core";
import { PolicyError, type Actor } from "./agent-api.js";
import type { Runtime } from "./runtime.js";

/**
 * Vereinheitlichung des Inventars (Namen, Anbieter, Quellen; siehe docs/NAMING.md). Der Plan nennt nur Namen, Stages,
 * Anbieter und Parameter-Schluessel, nie einen Wert. Anwenden aendert nur das Inventar und schreibt nie nach GitHub.
 */

/** Der Plan fuer das aktuelle Inventar. Rein lesend, auch fuer Agenten. */
export function getNormalizationPlan(rt: Runtime): NormalizationPlan {
  return planNormalization(rt.inventory.data, rt.config);
}

const MAX_CHANGES = 500;

/** Wendet gewaehlte Aenderungen an. Nur Menschen: Agenten duerfen den Plan lesen, nie anwenden. */
export async function applyNormalizationChanges(rt: Runtime, actor: Actor, body: { changeIds?: unknown }): Promise<NormalizationResult & { plan: NormalizationPlan }> {
  if (actor.kind !== "human") throw new PolicyError("Das Vereinheitlichen darf nur ein Mensch anwenden.");
  const ids = body.changeIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CHANGES || ids.some((x) => typeof x !== "string" || x === "")) {
    throw new InventoryError(`Feld changeIds: eine Liste mit 1 bis ${MAX_CHANGES} Aenderungs-Ids.`);
  }
  const result = await applyNormalization(rt.inventory, rt.config, ids as string[]);
  return { ...result, plan: getNormalizationPlan(rt) };
}
