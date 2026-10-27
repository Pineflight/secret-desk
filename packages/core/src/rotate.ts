import type { ConnectionStore } from "./connections.js";
import { GitHubClient, placeToTarget, type FetchLike } from "./github.js";
import type { InventoryStore } from "./inventory.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import type { Place, SecretEntry, Stage } from "./types.js";

export type RotationEvent =
  | { type: "issued"; secretId: string }
  | { type: "uploaded"; secretId: string; place: string; outcome: "created" | "updated" }
  | { type: "upload-failed"; secretId: string; place: string; message: string }
  | { type: "revoked"; secretId: string }
  | { type: "revoke-failed"; secretId: string; message: string }
  | { type: "recorded"; secretId: string; expires: string | null };

export interface RotateDeps {
  inventory: InventoryStore;
  github: GitHubClient;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  owner: string;
  fetch?: FetchLike;
  now?: () => Date;
  onEvent?: (event: RotationEvent) => void;
}

export interface RotateOptions {
  revokeOld?: boolean;
  /** Stages, die diese Anfrage anfassen darf (zum Beispiel nur dev fuer Agenten). */
  allowedStages?: Stage[];
}

export class RotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotationError";
  }
}

export interface RotationPlan {
  secretId: string;
  stage: Stage;
  provider: string;
  automatic: boolean;
  places: string[];
  revokesOld: boolean;
  ttlDays: number | null;
}

export interface PlaceOutcome {
  place: string;
  outcome: "created" | "updated" | "failed";
  error?: string;
}

export interface RotationResult {
  secretId: string;
  ok: boolean;
  partial: boolean;
  places: PlaceOutcome[];
  revoked: boolean;
  expires: string | null;
}

export function describePlace(p: Place): string {
  return `${p.repo}/${p.scope === "environment" ? `env:${p.environment}` : p.scope === "organization" ? "org" : "repo"}`;
}

function guard(secret: SecretEntry, options: RotateOptions): void {
  if (options.allowedStages && !options.allowedStages.includes(secret.stage)) {
    throw new RotationError(`Stage ${secret.stage} ist fuer diese Anfrage nicht freigegeben.`);
  }
}

export function planRotation(secretId: string, deps: Pick<RotateDeps, "inventory" | "providers">, options: RotateOptions = {}): RotationPlan {
  const secret = deps.inventory.getSecret(secretId);
  if (!secret) throw new RotationError(`Secret nicht gefunden: ${secretId}`);
  guard(secret, options);
  const provider = deps.providers.get(secret.provider);
  return {
    secretId,
    stage: secret.stage,
    provider: secret.provider,
    automatic: provider?.kind === "automatic" && typeof provider.issue === "function",
    places: secret.places.map(describePlace),
    revokesOld: Boolean(secret.externalId && provider?.revoke && options.revokeOld !== false),
    ttlDays: secret.ttlDays ?? null,
  };
}

function toDay(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Erzeugt einen neuen Wert beim Anbieter, schreibt ihn in alle Ziele, widerruft den alten
 * und traegt das neue Datum ein. Schlaegt ein Ziel fehl, bleibt der alte Wert gueltig.
 * Der Klartext verlaesst diese Funktion nicht und steht in keinem Ergebnis oder Ereignis.
 */
export async function rotateSecret(secretId: string, deps: RotateDeps, options: RotateOptions = {}): Promise<RotationResult> {
  const secret = deps.inventory.getSecret(secretId);
  if (!secret) throw new RotationError(`Secret nicht gefunden: ${secretId}`);
  guard(secret, options);
  const provider = deps.providers.get(secret.provider);
  if (!provider || provider.kind !== "automatic" || !provider.issue) {
    throw new RotationError(`Anbieter "${secret.provider}" kann nicht automatisch erzeugen. Wert von Hand einfuegen.`);
  }
  if (secret.places.length === 0) throw new RotationError("Das Secret hat kein Ziel (places).");

  const now = (deps.now ?? (() => new Date()))();
  const f = deps.fetch ?? fetch;
  const issued = await provider.issue({
    secret,
    params: secret.params,
    stage: secret.stage,
    stageKind: stageKind(deps.inventory.stages, secret.stage),
    connections: deps.connections,
    fetch: f,
    now,
    label: `${secret.id}-${now.toISOString().slice(0, 10)}`,
  });
  deps.onEvent?.({ type: "issued", secretId });

  const outcomes: PlaceOutcome[] = [];
  for (const place of secret.places) {
    const label = describePlace(place);
    try {
      const outcome = await deps.github.putSecret(placeToTarget(deps.owner, place), place.name ?? secret.name, issued.value);
      outcomes.push({ place: label, outcome });
      deps.onEvent?.({ type: "uploaded", secretId, place: label, outcome });
    } catch (err) {
      const message = (err as Error).message;
      outcomes.push({ place: label, outcome: "failed", error: message });
      deps.onEvent?.({ type: "upload-failed", secretId, place: label, message });
    }
  }

  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  if (failed > 0) {
    return { secretId, ok: false, partial: failed < outcomes.length, places: outcomes, revoked: false, expires: secret.expires };
  }

  let revoked = false;
  if (options.revokeOld !== false && secret.externalId && provider.revoke) {
    try {
      await provider.revoke({ externalId: secret.externalId, secret, params: secret.params, connections: deps.connections, fetch: f });
      revoked = true;
      deps.onEvent?.({ type: "revoked", secretId });
    } catch (err) {
      deps.onEvent?.({ type: "revoke-failed", secretId, message: (err as Error).message });
    }
  }

  const expires = issued.expiresAt ? toDay(issued.expiresAt) : secret.ttlDays ? addDays(now, secret.ttlDays) : secret.expiry === "none" ? null : secret.expires;
  deps.inventory.patchSecret(secretId, {
    rotatedAt: toDay(now.toISOString()),
    expires,
    ...(issued.externalId ? { externalId: issued.externalId } : {}),
  });
  await deps.inventory.save();
  deps.onEvent?.({ type: "recorded", secretId, expires });
  return { secretId, ok: true, partial: false, places: outcomes, revoked, expires };
}

export interface EncryptedUpload {
  place: Place;
  keyId: string;
  encryptedValue: string;
}

/** Browser-Flow: Der Browser hat verschluesselt, der Server leitet nur weiter und traegt das Datum ein. */
export async function uploadEncrypted(
  secretId: string,
  items: EncryptedUpload[],
  deps: Pick<RotateDeps, "inventory" | "github" | "owner" | "now">,
  meta: { expires?: string | null; externalId?: string } = {},
  options: RotateOptions = {},
): Promise<RotationResult> {
  const secret = deps.inventory.getSecret(secretId);
  if (!secret) throw new RotationError(`Secret nicht gefunden: ${secretId}`);
  guard(secret, options);
  const outcomes: PlaceOutcome[] = [];
  for (const item of items) {
    const label = describePlace(item.place);
    const known = secret.places.some((p) => describePlace(p) === label);
    if (!known) {
      outcomes.push({ place: label, outcome: "failed", error: "Ziel gehoert nicht zu diesem Secret" });
      continue;
    }
    try {
      const outcome = await deps.github.putEncrypted(placeToTarget(deps.owner, item.place), item.place.name ?? secret.name, item.encryptedValue, item.keyId);
      outcomes.push({ place: label, outcome });
    } catch (err) {
      outcomes.push({ place: label, outcome: "failed", error: (err as Error).message });
    }
  }
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  const now = (deps.now ?? (() => new Date()))();
  if (failed === 0) {
    deps.inventory.patchSecret(secretId, {
      rotatedAt: toDay(now.toISOString()),
      ...(meta.expires !== undefined ? { expires: meta.expires } : {}),
      ...(meta.externalId ? { externalId: meta.externalId } : {}),
    });
    await deps.inventory.save();
  }
  return { secretId, ok: failed === 0, partial: failed > 0 && failed < outcomes.length, places: outcomes, revoked: false, expires: meta.expires ?? secret.expires };
}
