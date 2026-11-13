import { buildSyncPlan, runSync, type SecretValueSource, type SyncPlan, type SyncResult } from "@secret-desk/core";
import { authorize, requireHuman, type Actor } from "./agent-api.js";
import type { Runtime } from "./runtime.js";

/** Vault entry that holds the stored value of an inventory secret. Never listed as a connection (`connections.ids` skips `#value`). */
export const secretValueEntry = (secretId: string): string => `${secretId}#value`;

/** Stored secret values live encrypted in the vault, next to the connection tokens. No vault, no stored values. */
export function secretValueSource(rt: Runtime): SecretValueSource | undefined {
  const vault = rt.connections.vault;
  if (!vault) return undefined;
  return {
    info: async (id) => {
      const i = await vault.info(secretValueEntry(id));
      return i ? { fingerprint: i.fingerprint, savedAt: i.savedAt } : null;
    },
    get: (id) => vault.get(secretValueEntry(id)),
  };
}

const planDeps = (rt: Runtime, repo?: string) => ({
  github: rt.github,
  workers: rt.workers,
  owner: rt.owner,
  inventory: rt.inventory.data,
  ignoreRepos: rt.config.compare.ignoreRepos,
  canIssue: (id: string) => rt.providers.get(id)?.kind === "automatic",
  ...(secretValueSource(rt) ? { values: secretValueSource(rt)! } : {}),
  ...(repo ? { repo } : {}),
});

/** Read-only: what a sync to GitHub would do. Names, places and reasons, never a value. Agents may read it. */
export function planGitHubSync(rt: Runtime, _actor: Actor, options: { repo?: string } = {}): Promise<SyncPlan> {
  return buildSyncPlan(planDeps(rt, options.repo));
}

export interface GitHubSyncRequest {
  keys: string[];
  confirmProduction?: boolean;
  repo?: string;
  onProgress?: (done: number, total: number) => void;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
}

/**
 * Writes the selected lines of a fresh plan to GitHub (variables and stored secret values). Humans only: the plan is rebuilt
 * here, so a caller can only choose among lines the plan really contains. Nothing is ever deleted in GitHub.
 */
export async function runGitHubSync(rt: Runtime, actor: Actor, request: GitHubSyncRequest): Promise<SyncResult> {
  requireHuman(actor, "Alles nach GitHub schreiben");
  await authorize(rt, { actor, action: "github.sync" });
  const plan = await buildSyncPlan(planDeps(rt, request.repo));
  const values = secretValueSource(rt);
  return runSync(
    { github: rt.github, workers: rt.workers, owner: rt.owner, plan, inventory: rt.inventory.data, ...(values ? { values } : {}) },
    { keys: request.keys, ...(request.confirmProduction !== undefined ? { confirmProduction: request.confirmProduction } : {}), ...(request.onProgress ? { onProgress: request.onProgress } : {}), ...(request.sleep ? { sleep: request.sleep } : {}), ...(request.batchSize ? { batchSize: request.batchSize } : {}) },
  );
}
