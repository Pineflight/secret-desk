/** Typen und kleine Helfer fuer die Team-Sync-Oberflaeche (Antworten des Servers, keine Werte). */
export type SyncSections = "secrets" | "variables" | "stages" | "providers" | "envTemplates";
export interface BundleDiff {
  sections: Record<SyncSections, { added: string[]; changed: string[]; removed: string[] }>;
  empty: boolean;
}
export interface SyncStatus {
  configured: boolean;
  connected: boolean;
  repo: string | null;
  path: string | null;
  branch: string | null;
  mode: "pull" | "pull-push" | null;
  pushStrategy: "pull-request" | "direct" | null;
  pushBranch: string | null;
  pullOnStart: boolean | null;
  lastSyncAt: string | null;
  lastPushAt: string | null;
  pendingPullUrl: string | null;
  lastCheck: { state: string; checkedAt: string } | null;
  lastError: string | null;
  setupNeeded: boolean;
}
export interface SyncCheck {
  state: string;
  remoteSha: string | null;
  diff: BundleDiff | null;
}
export interface PushPlan {
  diff: BundleDiff;
  remoteSha: string | null;
  localHash: string;
  strategy: "pull-request" | "direct";
  targetBranch: string;
}
export const SECTIONS: SyncSections[] = ["secrets", "variables", "stages", "providers", "envTemplates"];
