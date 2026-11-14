import { randomUUID } from "node:crypto";
import type { EvidenceStore } from "./evidence.js";
import { fingerprintOf, type VerificationReport } from "./verification.js";
import { assertEntryParams, effectiveParams, integrationDefaultsOf, validateEntryParams, type ParamProblem } from "./params.js";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import { placeToTarget, type GitHubClient, type FetchLike } from "./github.js";
import { putPlaceSecret } from "./place-io.js";
import { WorkerSecretsClient } from "./worker-secrets.js";
import type { InventoryStore } from "./inventory.js";
import { entryHoldingId, revokeNewValue, type RevokeOutcome } from "./issuance.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import { isWorkerPlace, type Place, type SecretEntry, type Stage } from "./types.js";

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
  /** Writes Cloudflare Worker secrets; without it Worker places fail with a clear message. */
  workers?: WorkerSecretsClient;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  owner: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Anbieter-Einstellungen aus der Konfiguration (erlaubte Hosts). */
  providerConfig?: ProviderConfig;
  /** When present, a new token that stays valid at the provider after a failed rotation is noted in a report here (identifier, never the value). */
  evidence?: EvidenceStore;
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
  /** The provider only reads a value that already exists (nothing is created, nothing is revoked). */
  readOnly: boolean;
  places: string[];
  revokesOld: boolean;
  ttlDays: number | null;
  /** Parameter-Pruefung gegen die Spezifikation des Anbieters (ohne Netzaufruf). */
  params: { ok: boolean; missing: string[]; problems: ParamProblem[] };
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
  /** Kennung des frisch ausgestellten Tokens, wenn er nach einem Fehler beim Anbieter bestehen blieb (verwaist). */
  orphanExternalId?: string;
  /**
   * true = der frisch ausgestellte Token wurde nach dem Fehler beim Anbieter widerrufen. Nur mit `acknowledgeWritten`: ohne sie
   * widerruft `rotateSecret` nie, nachdem ein Schreibvorgang gesendet wurde (siehe `revokeNewValue`).
   */
  newTokenRevoked?: boolean;
  warnings?: string[];
}

export function describePlace(p: Place): string {
  if (isWorkerPlace(p)) return `Cloudflare Worker ${p.script} (${p.accountId})`;
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
  const problems: ParamProblem[] = provider ? validateEntryParams(provider, secret, integrationDefaultsOf(deps.inventory, provider)) : [];
  return {
    secretId,
    stage: secret.stage,
    provider: secret.provider,
    automatic: provider?.kind === "automatic" && typeof provider.issue === "function",
    readOnly: provider?.readOnly === true,
    places: secret.places.map(describePlace),
    revokesOld: Boolean(secret.externalId && provider?.revoke && options.revokeOld !== false),
    ttlDays: secret.ttlDays ?? null,
    params: { ok: problems.length === 0, missing: problems.filter((p) => p.code === "missing").map((p) => p.key), problems },
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
 * Der neue Wert wird nach einem Fehler nur ueber das Tor `revokeNewValue` widerrufen (nie, wenn ein Schreibvorgang gesendet
 * wurde oder seine Kennung die aktuelle des Eintrags ist), der alte nur, wenn seine Kennung nicht die des neuen und nicht
 * die aktuelle eines anderen Eintrags ist.
 * `acknowledgeWritten` hebt die Sperre "ein Schreibvorgang wurde gesendet" auf und darf nur auf die ausdrueckliche Handlung eines
 * Menschen gesetzt werden (er weiss, dass Ziele den neuen Wert erhalten haben koennen und dann einen widerrufenen halten); nie
 * aus einer Voreinstellung, einer Konfiguration oder der Anfrage eines Agenten. Bleibt der neue Token nach einem Fehler gueltig,
 * steht seine Kennung nur in `orphanExternalId` und in den Warnungen (und im Bericht, wenn `deps.evidence` gesetzt ist).
 * Der Klartext verlaesst diese Funktion nicht und steht in keinem Ergebnis oder Ereignis.
 */
export async function rotateSecret(secretId: string, deps: RotateDeps, options: RotateOptions & { acknowledgeWritten?: boolean } = {}): Promise<RotationResult> {
  const secret = deps.inventory.getSecret(secretId);
  if (!secret) throw new RotationError(`Secret nicht gefunden: ${secretId}`);
  guard(secret, options);
  const provider = deps.providers.get(secret.provider);
  if (!provider || provider.kind !== "automatic" || !provider.issue) {
    throw new RotationError(`Anbieter "${secret.provider}" kann nicht automatisch erzeugen. Wert von Hand einfuegen.`);
  }
  if (secret.places.length === 0) throw new RotationError("Das Secret hat kein Ziel (places).");

  assertEntryParams(provider, secret, integrationDefaultsOf(deps.inventory, provider));
  const now = (deps.now ?? (() => new Date()))();
  const f = deps.fetch ?? fetch;
  const issued = await provider.issue({
    secret,
    params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)),
    stage: secret.stage,
    stageKind: stageKind(deps.inventory.stages, secret.stage),
    connections: deps.connections,
    fetch: f,
    now,
    label: `${secret.id}-${now.toISOString().slice(0, 10)}`,
    ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}),
  });
  deps.onEvent?.({ type: "issued", secretId });

  const outcomes: PlaceOutcome[] = [];
  for (const place of secret.places) {
    const label = describePlace(place);
    try {
      const outcome = await putPlaceSecret({ github: deps.github, ...(deps.workers ? { workers: deps.workers } : {}), owner: deps.owner }, place, place.name ?? secret.name, issued.value);
      outcomes.push({ place: label, outcome });
      deps.onEvent?.({ type: "uploaded", secretId, place: label, outcome });
    } catch (err) {
      const message = (err as Error).message;
      outcomes.push({ place: label, outcome: "failed", error: message });
      deps.onEvent?.({ type: "upload-failed", secretId, place: label, message });
    }
  }

  // A provider that rotates in place hands back the identifier the entry already has: the "new" value is the old object.
  const inPlace = issued.externalId !== undefined && issued.externalId === secret.externalId;
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  if (failed > 0) {
    const result: RotationResult = { secretId, ok: false, partial: failed < outcomes.length, places: outcomes, revoked: false, expires: secret.expires };
    const warnings: string[] = [];
    const failedPlaces = outcomes.filter((o) => o.outcome === "failed").map((o) => o.place).join(", ");
    if (inPlace) {
      // Rotation in place: the provider replaced the value when it issued, the new value is returned to nobody and the places that
      // were not written hold a value that no longer works. Nothing can be revoked (the identifier is the live one); rotate again.
      warnings.push(
        failed === outcomes.length
          ? `Der Anbieter hat den Wert unter derselben Kennung (${issued.externalId}) ersetzt (Rotation an Ort und Stelle), aber kein Ziel hat den neuen Wert bestaetigt und er wird nicht zurueckgegeben: diese Ziele halten hoechstens noch den alten Wert, der nicht mehr gilt: ${failedPlaces}. Nichts ist zu widerrufen. Das Secret erneut rotieren und seine Ziele schreiben.`
          : `Der Anbieter hat den Wert unter derselben Kennung (${issued.externalId}) ersetzt (Rotation an Ort und Stelle) und der neue Wert ist nur in einem Teil der Ziele geschrieben: diese Ziele halten noch den alten Wert, der nicht mehr gilt: ${failedPlaces}. Nichts ist zu widerrufen. Das Secret erneut rotieren und seine Ziele schreiben.`,
      );
    } else if (failed === outcomes.length) {
      // No place reported success, but a write that reported failure (a time-out, a lost answer) may still have been applied by the
      // remote, so the new value may be in use: the gate decides. A write was sent for every place, so it refuses (`write-started`)
      // unless a person acknowledged; it also refuses an identifier that is the current one of the entry (rotation in place).
      const outcome: RevokeOutcome = issued.externalId
        ? await revokeNewValue({ secretId, provider: secret.provider, externalId: issued.externalId, writeStarted: true }, deps, { acknowledgeWritten: options.acknowledgeWritten === true })
        : { status: "refused", reason: "no-id" };
      if (outcome.status === "revoked") {
        result.newTokenRevoked = true;
        warnings.push("Der neue Token wurde beim Anbieter widerrufen, obwohl Schreibvorgaenge gesendet wurden: Ziele, die ihn doch erhalten haben, halten jetzt einen widerrufenen Wert. Der alte bleibt gueltig.");
      } else if (outcome.status === "failed") {
        result.orphanExternalId = issued.externalId!;
        warnings.push(`Der neue Token (Kennung ${issued.externalId}) konnte beim Anbieter nicht widerrufen werden und bleibt dort bestehen: bitte von Hand widerrufen.`);
      } else if (outcome.reason === "value-in-use") {
        // Another entry (not this one: that is the in-place case above) records the identifier as its current one.
        warnings.push(`Der neue Token (Kennung ${issued.externalId}) wurde nicht widerrufen: seine Kennung ist die aktuelle eines anderen Eintrags im Inventar, der Token ist in Gebrauch.`);
      } else if (outcome.reason === "write-started") {
        result.orphanExternalId = issued.externalId!;
        warnings.push(`Der neue Token (Kennung ${issued.externalId}) wurde nicht widerrufen: Schreibvorgaenge wurden gesendet und koennen trotz Fehlermeldung angewendet worden sein, der Token kann in Gebrauch sein. Er bleibt beim Anbieter gueltig: Ziele pruefen und das Secret erneut rotieren oder ihn beim Anbieter von Hand widerrufen.`);
      } else if (outcome.reason === "no-id") {
        warnings.push("Der Anbieter nennt keine Kennung fuer den neuen Token: ihn beim Anbieter pruefen und von Hand widerrufen.");
      } else {
        // `no-revoke`: the provider cannot delete it; `secret-gone` and `provider-changed` cannot happen here (the entry was just read).
        result.orphanExternalId = issued.externalId!;
        warnings.push(`Der neue Token (Kennung ${issued.externalId}) bleibt beim Anbieter bestehen: bitte von Hand widerrufen.`);
      }
    } else {
      // Teilweise geschrieben: der neue Token ist in einigen Zielen im Einsatz, Widerruf wuerde sie brechen. The value is not returned, so
      // the other places cannot be written again: they hold the old value, which stays valid, until the secret is rotated again.
      if (issued.externalId) {
        result.orphanExternalId = issued.externalId;
        warnings.push(`Der neue Token (Kennung ${issued.externalId}) ist nur in einem Teil der Ziele geschrieben: die anderen Ziele (${failedPlaces}) halten noch den alten Wert, der gueltig bleibt. Das Secret erneut rotieren; den neuen Token beim Anbieter nur von Hand widerrufen, wenn kein Ziel ihn braucht.`);
      } else {
        warnings.push(`Der neue Token ist nur in einem Teil der Ziele geschrieben: die anderen Ziele (${failedPlaces}) halten noch den alten Wert, der gueltig bleibt. Das Secret erneut rotieren.`);
      }
    }
    // A new token that stays valid at the provider exists only in this result: say so in the evidence too, when there is a store.
    if (result.orphanExternalId && !inPlace && deps.evidence) {
      const report: VerificationReport = {
        id: randomUUID(),
        secretId,
        secretName: secret.name,
        createdAt: now.toISOString(),
        kind: "issued",
        provider: secret.provider,
        stage: secret.stage,
        label: `${secret.id}-${now.toISOString().slice(0, 10)}`,
        externalId: result.orphanExternalId,
        expiresAt: issued.expiresAt ?? null,
        targets: secret.places.map(describePlace),
        checks: [{ id: "rotation-new-token-valid", label: `Rotation fehlgeschlagen: der neue Token (Kennung ${result.orphanExternalId}) ist beim Anbieter noch gueltig`, status: "warn", detail: "Ein Mensch entscheidet: das Secret erneut rotieren oder den Token beim Anbieter von Hand widerrufen." }],
        checklist: [],
        fingerprint: fingerprintOf(issued.value),
        attachments: [],
      };
      await deps.evidence.save(report).catch(() => undefined);
    }
    result.warnings = warnings;
    return result;
  }

  // Ohne Ablaufangabe des Anbieters und ohne ttlDays ist das Ablaufdatum unbekannt: das alte Datum darf nicht stehen bleiben,
  // sonst erscheint das frisch erneuerte Secret als abgelaufen.
  const expires = secret.expiry === "none" ? null : issued.expiresAt ? toDay(issued.expiresAt) : secret.ttlDays ? addDays(now, secret.ttlDays) : null;
  const warnings: string[] = [];
  // The old value goes only after every place holds the new one. Not when it has the identifier of the new one (rotation in place:
  // the old value is the object that now holds the new value), and not when another entry still has it as its current identifier
  // (companions copy identifiers, so that entry can still use it). Outside the gate on purpose: the gate is for a NEW value.
  let revoked = false;
  if (options.revokeOld !== false && secret.externalId && provider.revoke && !inPlace) {
    const holder = entryHoldingId(deps.inventory, secret.externalId, [secret.id]);
    if (holder) {
      warnings.push(`Der alte Token (Kennung ${secret.externalId}) wurde nicht widerrufen: seine Kennung ist noch die aktuelle von Eintrag ${holder}, der Wert wird dort noch gebraucht.`);
    } else {
      try {
        await provider.revoke({ externalId: secret.externalId, secret, params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)), connections: deps.connections, fetch: f, ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}) });
        revoked = true;
        deps.onEvent?.({ type: "revoked", secretId });
      } catch (err) {
        deps.onEvent?.({ type: "revoke-failed", secretId, message: (err as Error).message });
      }
    }
  }
  if (!issued.expiresAt && !secret.ttlDays && secret.expiry === "possible") warnings.push("Das Ablaufdatum des neuen Tokens ist unbekannt (kein ttlDays, keine Angabe des Anbieters). Datum von Hand eintragen.");
  try {
    deps.inventory.patchSecret(secretId, {
      rotatedAt: toDay(now.toISOString()),
      expires,
      ...(issued.externalId ? { externalId: issued.externalId } : {}),
    });
    await deps.inventory.save();
  } catch (err) {
    warnings.push(revoked ? "Der alte Token ist bereits widerrufen, aber das Inventar wurde nicht gespeichert." : "Der neue Token ist in allen Zielen geschrieben, aber das Inventar wurde nicht gespeichert.");
    warnings.push(`Neue Kennung: ${issued.externalId ?? "unbekannt"}`);
    warnings.push(`Grund: ${(err as Error).message}`);
    return { secretId, ok: true, partial: false, places: outcomes, revoked, expires, ...(issued.externalId ? { orphanExternalId: issued.externalId } : {}), warnings };
  }
  deps.onEvent?.({ type: "recorded", secretId, expires });
  return { secretId, ok: true, partial: false, places: outcomes, revoked, expires, ...(warnings.length ? { warnings } : {}) };
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
    if (isWorkerPlace(item.place)) {
      outcomes.push({ place: label, outcome: "failed", error: "Worker-Secrets gehen nicht ueber den Browser-Upload: der Wert wird nur vom Server geschrieben" });
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
