import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "./connections.js";
import type { EvidenceStore } from "./evidence.js";
import { GitHubClient, placeToTarget, type FetchLike } from "./github.js";
import type { InventoryStore } from "./inventory.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import { describePlace, RotationError, type PlaceOutcome, type RotateOptions } from "./rotate.js";
import type { SecretValue } from "./secret.js";
import { fingerprintOf, overallStatus, type Check, type ChecklistItem, type Confirmation, type VerificationReport } from "./verification.js";

export interface IssuanceDeps {
  inventory: InventoryStore;
  github: GitHubClient;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  owner: string;
  fetch?: FetchLike;
  now?: () => Date;
  evidence?: EvidenceStore;
}

/**
 * Ein ausgestellter, noch nicht bestaetigter Wert. Er lebt nur im Arbeitsspeicher und nur bis expiresAt.
 * In GitHub ist bis zur Bestaetigung nichts geschrieben, am alten Wert nichts widerrufen.
 */
export interface PendingIssuance {
  id: string;
  secretId: string;
  value: SecretValue;
  report: VerificationReport;
  oldExternalId?: string;
  newExpires: string | null;
  createdAt: string;
  expiresAt: string;
}

export class IssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuanceError";
  }
}

const DEFAULT_CHECKLIST: string[] = [
  "Der Name beim Anbieter ist der erwartete.",
  "Die Rechte sind so eng wie vorgesehen.",
  "Das Ablaufdatum stimmt.",
  "Die Ziele sind die richtigen Repositories und Umgebungen.",
];

const toDay = (iso: string): string => iso.slice(0, 10);
const addDays = (d: Date, days: number): string => new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Stufe 1: Wert beim Anbieter erzeugen (oder von Hand uebernehmen), pruefen und als Bericht bereitstellen.
 * Es wird nichts in GitHub geschrieben und nichts widerrufen.
 */
export async function prepareIssuance(
  secretId: string,
  deps: IssuanceDeps,
  options: RotateOptions & { manualValue?: SecretValue; ttlMinutes?: number } = {},
): Promise<PendingIssuance> {
  const secret = deps.inventory.getSecret(secretId);
  if (!secret) throw new IssuanceError(`Secret nicht gefunden: ${secretId}`);
  if (options.allowedStages && !options.allowedStages.includes(secret.stage)) {
    throw new RotationError(`Stage ${secret.stage} ist fuer diese Anfrage nicht freigegeben.`);
  }
  if (secret.places.length === 0) throw new IssuanceError("Das Secret hat kein Ziel (places).");
  const provider = deps.providers.get(secret.provider);
  const now = (deps.now ?? (() => new Date()))();
  const f = deps.fetch ?? fetch;
  const kind0 = stageKind(deps.inventory.stages, secret.stage);
  const label = `${secret.id}-${now.toISOString().slice(0, 10)}`;

  let value: SecretValue;
  let externalId: string | undefined;
  let expiresAt: string | null | undefined;
  let kind: VerificationReport["kind"];
  if (options.manualValue) {
    value = options.manualValue;
    kind = "manual";
  } else {
    if (!provider || provider.kind !== "automatic" || !provider.issue) {
      throw new IssuanceError(`Anbieter "${secret.provider}" kann nicht automatisch erzeugen. Wert von Hand eingeben.`);
    }
    const issued = await provider.issue({ secret, params: secret.params, stage: secret.stage, stageKind: kind0, connections: deps.connections, fetch: f, now, label });
    value = issued.value;
    externalId = issued.externalId;
    expiresAt = issued.expiresAt;
    kind = "issued";
  }

  const checks: Check[] = [];
  checks.push(
    value.length >= 16
      ? { id: "value-shape", label: "Wert hat eine plausible Laenge", status: "pass", actual: `${value.length} Zeichen` }
      : { id: "value-shape", label: "Wert ist ungewoehnlich kurz", status: "warn", actual: `${value.length} Zeichen` },
  );
  for (const place of secret.places) {
    try {
      await deps.github.publicKey(placeToTarget(deps.owner, place));
      checks.push({ id: `target:${describePlace(place)}`, label: `Ziel erreichbar mit Schreibrecht: ${describePlace(place)}`, status: "pass" });
    } catch (err) {
      checks.push({ id: `target:${describePlace(place)}`, label: `Ziel nicht erreichbar: ${describePlace(place)}`, status: "fail", detail: (err as Error).message });
    }
  }
  if (provider?.verify) {
    try {
      checks.push(...(await provider.verify({ secret, params: secret.params, stage: secret.stage, stageKind: kind0, value, ...(externalId ? { externalId } : {}), expiresAt: expiresAt ?? null, connections: deps.connections, fetch: f, now })));
    } catch (err) {
      checks.push({ id: "provider-verify", label: "Pruefung beim Anbieter nicht durchfuehrbar", status: "warn", detail: (err as Error).message });
    }
  }
  const newExpires = expiresAt ? toDay(expiresAt) : secret.ttlDays ? addDays(now, secret.ttlDays) : secret.expiry === "none" ? null : secret.expires;
  if (secret.expiry === "required" && !newExpires) checks.push({ id: "expiry-known", label: "Der Anbieter erzwingt ein Ablaufdatum, es ist nicht bekannt", status: "warn" });
  else checks.push({ id: "expiry", label: "Ablauf", status: "info", actual: newExpires ?? "kein Ablauf" });

  const items = provider?.reviewChecklist?.(secret, { stageKind: kind0 }) ?? DEFAULT_CHECKLIST;
  const checklist: ChecklistItem[] = items.map((text, i) => ({ id: `c${i + 1}`, text }));
  if (kind0 === "live") checklist.push({ id: `c${checklist.length + 1}`, text: "Ich weiss, dass dieser Wert die Produktion betrifft." });

  const report: VerificationReport = {
    id: randomUUID(),
    secretId,
    secretName: secret.name,
    createdAt: now.toISOString(),
    kind,
    provider: secret.provider,
    stage: secret.stage,
    label,
    ...(externalId ? { externalId } : {}),
    expiresAt: expiresAt ?? null,
    targets: secret.places.map(describePlace),
    checks,
    checklist,
    fingerprint: fingerprintOf(value),
    attachments: [],
  };
  await deps.evidence?.save(report);
  const ttl = (options.ttlMinutes ?? 15) * 60_000;
  return {
    id: report.id,
    secretId,
    value,
    report,
    ...(secret.externalId ? { oldExternalId: secret.externalId } : {}),
    newExpires,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
}

export interface CommitResult {
  secretId: string;
  reportId: string;
  ok: boolean;
  partial: boolean;
  places: PlaceOutcome[];
  revokedOld: boolean;
  expires: string | null;
}

/**
 * Stufe 2: Nach der Bestaetigung in alle Ziele schreiben, nachpruefen, den alten Wert widerrufen und das Inventar
 * aktualisieren. Bei einem Fehler an einem Ziel bleibt der alte Wert gueltig und die Anfrage offen.
 */
export async function commitIssuance(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  confirmation: { by: string; ticks: string[]; note?: string },
  options: { force?: boolean } = {},
): Promise<CommitResult> {
  const secret = deps.inventory.getSecret(pending.secretId);
  if (!secret) throw new IssuanceError(`Secret nicht gefunden: ${pending.secretId}`);
  const now = (deps.now ?? (() => new Date()))();
  if (now.getTime() > Date.parse(pending.expiresAt)) throw new IssuanceError("Die Anfrage ist abgelaufen. Neu ausstellen.");
  if (!options.force && overallStatus(pending.report.checks) === "fail") {
    throw new IssuanceError("Die automatische Pruefung ist fehlgeschlagen. Verwerfen oder Ursache beheben.");
  }
  const missing = pending.report.checklist.filter((c) => !confirmation.ticks.includes(c.id));
  if (missing.length > 0) throw new IssuanceError(`Nicht alle Pruefpunkte bestaetigt: ${missing.map((m) => m.id).join(", ")}`);

  const outcomes: PlaceOutcome[] = [];
  for (const place of secret.places) {
    const label = describePlace(place);
    try {
      const outcome = await deps.github.putSecret(placeToTarget(deps.owner, place), place.name ?? secret.name, pending.value);
      outcomes.push({ place: label, outcome });
    } catch (err) {
      outcomes.push({ place: label, outcome: "failed", error: (err as Error).message });
    }
  }
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  if (failed > 0) {
    return { secretId: pending.secretId, reportId: pending.report.id, ok: false, partial: failed < outcomes.length, places: outcomes, revokedOld: false, expires: secret.expires };
  }

  // Nachpruefung: Der Name steht jetzt in jedem Ziel und wurde eben geaendert.
  const since = Date.parse(pending.createdAt) - 5_000;
  for (const place of secret.places) {
    const label = describePlace(place);
    try {
      const live = (await deps.github.listSecrets(placeToTarget(deps.owner, place))).find((s) => s.name === (place.name ?? secret.name));
      const fresh = live !== undefined && Date.parse(live.updatedAt) >= since;
      pending.report.checks.push({ id: `written:${label}`, label: `In GitHub geschrieben: ${label}`, status: fresh ? "pass" : "warn", ...(live ? { actual: `geaendert ${live.updatedAt}` } : { detail: "Name nicht gefunden" }) });
    } catch (err) {
      pending.report.checks.push({ id: `written:${label}`, label: `Nachpruefung nicht moeglich: ${label}`, status: "warn", detail: (err as Error).message });
    }
  }

  const provider = deps.providers.get(secret.provider);
  let revokedOld = false;
  if (pending.oldExternalId && provider?.revoke) {
    try {
      await provider.revoke({ externalId: pending.oldExternalId, secret, params: secret.params, connections: deps.connections, fetch: deps.fetch ?? fetch });
      revokedOld = true;
      pending.report.checks.push({ id: "revoke-old", label: "Alter Wert beim Anbieter widerrufen", status: "pass" });
    } catch (err) {
      pending.report.checks.push({ id: "revoke-old", label: "Alten Wert widerrufen: fehlgeschlagen", status: "warn", detail: (err as Error).message });
    }
  }

  const day = toDay(now.toISOString());
  deps.inventory.patchSecret(pending.secretId, {
    rotatedAt: day,
    verifiedAt: day,
    verifiedBy: confirmation.by,
    expires: pending.newExpires,
    ...(pending.report.externalId ? { externalId: pending.report.externalId } : {}),
  });
  await deps.inventory.save();

  const confirmationRecord: Confirmation = { by: confirmation.by, at: now.toISOString(), ticks: confirmation.ticks, decision: "confirmed", ...(confirmation.note ? { note: confirmation.note } : {}) };
  pending.report.confirmation = confirmationRecord;
  await deps.evidence?.save(pending.report);
  return { secretId: pending.secretId, reportId: pending.report.id, ok: true, partial: false, places: outcomes, revokedOld, expires: pending.newExpires };
}

/** Verwirft einen ausgestellten Wert: Der neue Wert wird beim Anbieter wieder geloescht, nichts wurde geschrieben. */
export async function discardIssuance(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  reason: { by: string; why: "rejected" | "expired"; note?: string },
): Promise<{ revokedNew: boolean }> {
  const secret = deps.inventory.getSecret(pending.secretId);
  const provider = secret ? deps.providers.get(secret.provider) : undefined;
  let revokedNew = false;
  if (secret && pending.report.externalId && provider?.revoke) {
    try {
      await provider.revoke({ externalId: pending.report.externalId, secret, params: secret.params, connections: deps.connections, fetch: deps.fetch ?? fetch });
      revokedNew = true;
    } catch {
      /* bleibt gueltig, steht im Bericht */
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  pending.report.confirmation = {
    by: reason.by,
    at: now.toISOString(),
    ticks: [],
    decision: "rejected",
    note: `${reason.why === "expired" ? "Zeit abgelaufen" : "Abgelehnt"}${reason.note ? `: ${reason.note}` : ""}${pending.report.externalId && !revokedNew ? " (neuer Wert beim Anbieter NICHT widerrufen)" : ""}`,
  };
  await deps.evidence?.save(pending.report);
  return { revokedNew };
}
