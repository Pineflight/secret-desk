import type { Place } from "./types.js";

// Pure pieces of the status module that the portable GitHub client needs. Kept apart from `status.ts` and `types.ts`
// so that importing them does not pull in the zod schemas. `status.ts` re-exports everything from here.

export interface LiveSecret {
  name: string;
  updatedAt: string;
}

/** Was im GitHub-Secret-Speicher tatsaechlich liegt, je Ziel (nur Namen und Zeitstempel). */
export type LiveSnapshot = Map<string, LiveSecret>;

export function placeKey(owner: string, place: Place, fallbackName: string): string {
  const name = place.name ?? fallbackName;
  // Same test as `isWorkerPlace` in types.ts (that module carries the zod schemas, so it is not imported here).
  if (place.scope === "cloudflare-worker") return `cloudflare-worker/${place.accountId}/${place.script}/${name}`;
  const where = place.scope === "environment" ? `env:${place.environment}` : place.scope === "organization" ? "org" : "repo";
  return `${owner}/${place.repo}/${where}/${name}`;
}
