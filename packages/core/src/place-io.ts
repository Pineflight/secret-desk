import { GitHubError, placeToTarget, type GitHubClient } from "./github.js";
import type { SecretValue } from "./secret.js";
import { placeKey, type LiveSnapshot } from "./status.js";
import { isWorkerPlace, type Place } from "./types.js";
import { WorkerSecretsClient, WorkerSecretsError, workerKey } from "./worker-secrets.js";

/**
 * One door to the two kinds of places: the GitHub secret store and the secrets of a Cloudflare Worker. The callers (rotation,
 * issuance, sync, doctor, status) say what they want to do with a place; this module picks the client. Worker places need the
 * `workers` client; without it every Worker place fails with a clear message instead of being skipped.
 */
export interface PlaceClients {
  github: Pick<GitHubClient, "putSecret" | "publicKey" | "listSecrets">;
  workers?: Pick<WorkerSecretsClient, "putSecret" | "check" | "listSecretNames">;
  owner: string;
}
export type WriteClients = { github: Pick<GitHubClient, "putSecret">; workers?: Pick<WorkerSecretsClient, "putSecret">; owner: string };
export type ReadClients = { github: Pick<GitHubClient, "listSecrets">; workers?: Pick<WorkerSecretsClient, "listSecretNames">; owner: string };

export const NO_WORKERS_MESSAGE = "Die Verbindung \"cloudflare\" ist nicht eingerichtet: Worker-Secrets koennen nicht geschrieben werden.";

function needWorkers<W>(c: { workers?: W }): W {
  if (!c.workers) throw new WorkerSecretsError(0, NO_WORKERS_MESSAGE);
  return c.workers;
}

/** Writes a secret value into a place. The plaintext leaves this function only towards GitHub (sealed) or Cloudflare (TLS). */
export async function putPlaceSecret(c: WriteClients, place: Place, name: string, value: SecretValue): Promise<"created" | "updated"> {
  if (isWorkerPlace(place)) return needWorkers(c).putSecret(place, name, value);
  return c.github.putSecret(placeToTarget(c.owner, place), name, value);
}

/** Proves the place is reachable with the right to write: GitHub public key, or the name list of the Worker. */
export async function checkPlaceWritable(c: PlaceClients, place: Place): Promise<void> {
  if (isWorkerPlace(place)) return needWorkers(c).check(place);
  await c.github.publicKey(placeToTarget(c.owner, place));
}

/** Names (and, where the store has them, change times) of the secrets in a place. Never a value. */
export async function listPlaceSecrets(c: ReadClients, place: Place): Promise<{ name: string; updatedAt?: string }[]> {
  if (isWorkerPlace(place)) return (await needWorkers(c).listSecretNames(place)).map((name) => ({ name }));
  return c.github.listSecrets(placeToTarget(c.owner, place));
}

/** Status code of a failed read of a place (404 = the place does not exist), 0 when unknown. */
export const placeErrorStatus = (err: unknown): number => (err instanceof GitHubError || err instanceof WorkerSecretsError ? err.status : 0);

/** A place that could not be read when the live state was taken ("missing" is unknown there). */
export interface PlaceReadError {
  repo: string;
  scope: Place["scope"];
  environment?: string;
  accountId?: string;
  script?: string;
  status: number;
  message: string;
}

/** Identity of the store a place lives in (the unit that is read once): repository, environment, organization or Worker. */
export const storeId = (p: Place): string => (isWorkerPlace(p) ? `cloudflare-worker/${workerKey(p)}` : `${p.repo}/${p.scope}/${p.environment ?? ""}`);

/** Whether a read error belongs to the store of this place. */
export const errorMatchesPlace = (e: PlaceReadError, p: Place): boolean =>
  isWorkerPlace(p) ? e.scope === "cloudflare-worker" && e.accountId === p.accountId && e.script === p.script : e.scope === p.scope && e.repo === p.repo && (e.environment ?? "") === (p.environment ?? "");

/**
 * Reads the secret names of every store the places live in (once per store). A store with 403/429/5xx does not tip over the
 * rest: it appears in `errors`. 404 means "the place does not exist" and is no error. Names and times only, no values.
 */
export async function snapshotPlaces(c: ReadClients, places: readonly Place[]): Promise<{ snapshot: LiveSnapshot; errors: PlaceReadError[] }> {
  const snapshot: LiveSnapshot = new Map();
  const errors: PlaceReadError[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const id = storeId(place);
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      for (const s of await listPlaceSecrets(c, place)) snapshot.set(placeKey(c.owner, { ...place, name: s.name }, s.name), { name: s.name, updatedAt: s.updatedAt ?? "" });
    } catch (err) {
      const status = placeErrorStatus(err);
      if (status === 404) continue;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(isWorkerPlace(place) ? { repo: "", scope: place.scope, accountId: place.accountId, script: place.script, status, message } : { repo: place.repo, scope: place.scope, ...(place.environment ? { environment: place.environment } : {}), status, message });
    }
  }
  return { snapshot, errors };
}
