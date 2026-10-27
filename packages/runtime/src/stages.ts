import { InventoryError, StageDefSchema, stageDefIssues, stageEnvironment, type StageDef } from "@secret-desk/core";
import type { z } from "zod";
import type { Runtime } from "./runtime.js";

export interface StageUsage {
  secrets: number;
  variables: number;
  templates: number;
  policy: boolean;
}

export interface StageView extends StageDef {
  /** Wirksamer GitHub-Environment-Name oder null. */
  environmentName: string | null;
  usage: StageUsage;
}

/** Wer eine Stage nutzt: Secrets, Variablen, Env-Vorlagen und die Agenten-Richtlinie. */
export function stageUsage(rt: Runtime, id: string): StageUsage {
  const inv = rt.inventory.data;
  return {
    secrets: inv.secrets.filter((s) => s.stage === id).length,
    variables: inv.variables.filter((v) => v.stage === id).length,
    templates: inv.envTemplates.filter((t) => t.stage === id).length,
    policy: (rt.config.policy.agentStages ?? []).includes(id),
  };
}

const inUse = (u: StageUsage): boolean => u.secrets + u.variables + u.templates > 0 || u.policy;

/** Alle Stage-Definitionen mit Nutzung. Agenten duerfen lesen. */
export function listStages(rt: Runtime): StageView[] {
  return rt.inventory.stages.map((d) => ({
    ...d,
    environmentName: stageEnvironment(d),
    usage: stageUsage(rt, d.id),
  }));
}

/** Ersetzt die ganze Liste. Wer entfernt, was noch genutzt wird, bekommt eine Meldung mit Zaehlern. */
export async function setStages(rt: Runtime, defs: z.input<typeof StageDefSchema>[]): Promise<StageView[]> {
  const parsed = StageDefSchema.array().safeParse(defs);
  if (!parsed.success) throw new InventoryError(parsed.error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("; "));
  const issues = stageDefIssues(parsed.data);
  if (issues.length > 0) throw new InventoryError(issues.join("; "));
  if (parsed.data.length === 0) throw new InventoryError("Mindestens eine Stage ist noetig");
  const keep = new Set(parsed.data.map((d) => d.id));
  for (const old of rt.inventory.stages) {
    if (keep.has(old.id)) continue;
    const u = stageUsage(rt, old.id);
    if (u.policy) throw new InventoryError(`Stage ${old.id} steht in der Agenten-Richtlinie (policy.agentStages) und kann nicht entfernt werden`);
    if (inUse(u)) throw new InventoryError(`Stage ${old.id} wird noch genutzt (${u.secrets} Secrets, ${u.variables} Variablen, ${u.templates} Vorlagen) und kann nicht entfernt werden`);
  }
  rt.inventory.setStages(parsed.data);
  await rt.inventory.save();
  return listStages(rt);
}
