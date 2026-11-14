import { ParamsInvalidError, effectiveParams, integrationDefaultsOf, ttlDaysProblems } from "./params.js";
import { assertPreflight, entryParamsState, preflightEntry } from "./preflight.js";
import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import { hashOf, issuanceSnapshot } from "./snapshot.js";
import { isWorkerPlace, type SecretEntry, type VariableEntry } from "./types.js";
import type { EvidenceStore } from "./evidence.js";
import { GitHubClient, placeToTarget, type FetchLike } from "./github.js";
import { checkPlaceWritable, listPlaceSecrets, putPlaceSecret, type PlaceClients } from "./place-io.js";
import type { WorkerSecretsClient } from "./worker-secrets.js";
import type { InventoryStore } from "./inventory.js";
import type { ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import { describePlace, RotationError, type PlaceOutcome, type RotateOptions } from "./rotate.js";
import type { SecretValue } from "./secret.js";
import { fingerprintOf, overallStatus, type ActorRef, type Check, type CompanionSummary, type ChecklistItem, type Confirmation, type VerificationReport } from "./verification.js";

export interface IssuanceDeps {
  inventory: InventoryStore;
  github: GitHubClient;
  /** Writes Cloudflare Worker secrets; without it Worker places fail the target check with a clear message. */
  workers?: WorkerSecretsClient;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  owner: string;
  fetch?: FetchLike;
  now?: () => Date;
  evidence?: EvidenceStore;
  /** Anbieter-Einstellungen aus der Konfiguration (erlaubte Hosts). */
  providerConfig?: ProviderConfig;
}

/**
 * Ein ausgestellter, noch nicht bestaetigter Wert. Er lebt nur im Arbeitsspeicher und nur bis expiresAt.
 * In GitHub ist bis zur Bestaetigung nichts geschrieben, am alten Wert nichts widerrufen.
 */
export interface PendingIssuance {
  id: string;
  secretId: string;
  value: SecretValue;
  /** Companion values for other entries; in memory only, written on confirm, dropped on reject or expiry. */
  companions: PendingCompanion[];
  report: VerificationReport;
  oldExternalId?: string;
  /** Hash ueber Ziele, Anbieter, Parameter, Stage und alte Kennung zum Zeitpunkt der Pruefung (siehe snapshot.ts). */
  snapshot: string;
  /** Der Eintrag, mit dem ausgestellt wurde. Widerrufen wird immer mit diesen Parametern, nie mit nachtraeglich geaenderten. */
  issuedSecret: SecretEntry;
  newExpires: string | null;
  /** Who prepared this issuance, when the caller said so (the runtime always does). Names and an opaque principal id, never a value. */
  preparedBy?: ActorRef;
  /** Who asked for it when that is not the preparer (for example the agent whose request a human approved). */
  requestedBy?: ActorRef;
  /** The approval request this issuance was prepared for, when there was one. */
  approvalId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface PendingCompanion {
  entryId: string;
  /** Whether the receiving entry is a secret or a variable (public value). */
  kind: "secret" | "variable";
  value: SecretValue;
  /** Hash of the receiving entry's places and stage at review time; a change before confirm makes the issuance stale. */
  snapshot: string;
}

const clientsOf = (deps: Pick<IssuanceDeps, "github" | "workers" | "owner">): PlaceClients => ({ github: deps.github, ...(deps.workers ? { workers: deps.workers } : {}), owner: deps.owner });

const companionSnapshot = (e: SecretEntry | VariableEntry): string => hashOf({ places: e.places, stage: e.stage });

/** A companion target is a secret entry or a variable entry; ids are unique across both. */
function companionEntry(inventory: InventoryStore, id: string): { entry: SecretEntry | VariableEntry; kind: "secret" | "variable" } | undefined {
  const secret = inventory.getSecret(id);
  if (secret) return { entry: secret, kind: "secret" };
  const variable = inventory.getVariable(id);
  return variable ? { entry: variable, kind: "variable" } : undefined;
}

/** Inventory ids a provider names in its `companionParams` for these effective params. */
function companionTargets(provider: { companionParams?: string[] } | undefined, params: Record<string, unknown>): string[] {
  return [...new Set((provider?.companionParams ?? []).map((k) => params[k]).filter((v): v is string => typeof v === "string" && v !== ""))];
}

export class IssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssuanceError";
  }
}

/**
 * Der Eintrag hat sich seit der Pruefung geaendert: es wird nichts mehr geschrieben und der neue Wert wird beim Anbieter widerrufen,
 * ausser das Tor (`revokeNewValue`) lehnt ab. `revokedNew` und `revokeRefused` sagen, was daraus wurde.
 */
export class StaleIssuanceError extends IssuanceError {
  readonly revokedNew: boolean;
  readonly revokeRefused: RevokeRefusal | undefined;
  constructor(outcome: DiscardResult = { revokedNew: false }) {
    super("Eintrag wurde seit der Pruefung geaendert, bitte neu erzeugen");
    this.name = "StaleIssuanceError";
    this.revokedNew = outcome.revokedNew;
    this.revokeRefused = outcome.refused;
  }
}

const DEFAULT_CHECKLIST: readonly string[] = [
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
  options: RotateOptions & { manualValue?: SecretValue; ttlMinutes?: number; preparedBy?: ActorRef; requestedBy?: ActorRef; approvalId?: string } = {},
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
  const pc = deps.providerConfig ? { providerConfig: deps.providerConfig } : {};
  const snapshot = issuanceSnapshot(secret, kind0);
  const issuedSecret = structuredClone(secret);

  let value: SecretValue;
  let externalId: string | undefined;
  let expiresAt: string | null | undefined;
  let kind: VerificationReport["kind"];
  let params = secret.params;
  const preChecks: Check[] = [];
  const companions: PendingCompanion[] = [];
  const companionSummaries: CompanionSummary[] = [];
  if (options.manualValue) {
    value = options.manualValue;
    kind = "manual";
  } else {
    if (!provider || provider.kind !== "automatic" || !provider.issue) {
      throw new IssuanceError(`Anbieter "${secret.provider}" kann nicht automatisch erzeugen. Wert von Hand eingeben.`);
    }
    // Erst pruefen, dann ausstellen: fehlende Parameter melden sich mit Klartext, bevor ein Netzaufruf passiert.
    const state = entryParamsState(deps.inventory, provider, secret);
    const problems = [...state.problems, ...ttlDaysProblems(provider, secret)];
    if (problems.length > 0) throw new ParamsInvalidError(problems);
    params = state.effective;
    const pre = await preflightEntry(secret, deps, { rethrowNotConnected: true });
    assertPreflight(pre);
    if (pre.resource) preChecks.push({ id: "preflight-resource", label: "Ressource beim Anbieter", status: "pass", actual: pre.resource });
    for (const f of pre.findings) if (f.level !== "ok") preChecks.push({ id: `preflight:${f.id}`, label: f.label, status: "warn", ...(f.detail ? { detail: f.detail } : {}) });
    // Companion targets are checked before anything is created at the provider, so a bad target never leaves an orphan.
    for (const id of companionTargets(provider, params)) {
      const target = companionEntry(deps.inventory, id)?.entry;
      if (!target) throw new IssuanceError(`Secret nicht gefunden: ${id}`);
      if (id === secret.id) throw new IssuanceError("Der Eintrag darf nicht sein eigener Begleiter sein.");
      if (target.stage !== secret.stage) throw new IssuanceError(`Der Begleiter ${id} liegt in einer anderen Stage (${target.stage}).`);
      if (target.places.length === 0) throw new IssuanceError(`Der Begleiter ${id} hat kein Ziel (places).`);
    }
    const issued = await provider.issue({ secret, params, stage: secret.stage, stageKind: kind0, connections: deps.connections, fetch: f, now, label, ...pc });
    value = issued.value;
    externalId = issued.externalId;
    expiresAt = issued.expiresAt;
    kind = "issued";
    const allowed = companionTargets(provider, params);
    for (const c of issued.companions ?? []) {
      const found = allowed.includes(c.entryId) ? companionEntry(deps.inventory, c.entryId) : undefined;
      // A value for an entry nobody named, or for an entry of the wrong kind (a public value must never reach a secret
      // entry by accident, nor a secret a variable, which GitHub shows in clear text).
      if (!found || found.kind !== (c.kind ?? "secret")) {
        // The provider returned a value for an entry nobody named: undo what was created, write nothing.
        // Outside the revoke gate (`revokeNewValue`) on purpose: no item exists yet, nothing was written anywhere, and the value
        // was created a moment ago in this very call, so it cannot be in use.
        if (externalId && externalId !== secret.externalId && provider.revoke) await provider.revoke({ externalId, secret, params, connections: deps.connections, fetch: f, ...pc }).catch(() => undefined);
        throw new IssuanceError("Der Anbieter lieferte einen Begleitwert fuer einen nicht benannten Eintrag. Nichts wurde geschrieben.");
      }
      companions.push({ entryId: c.entryId, kind: found.kind, value: c.value, snapshot: companionSnapshot(found.entry) });
    }
  }

  const checks: Check[] = [...preChecks];
  checks.push(
    value.length >= 16
      ? { id: "value-shape", label: "Wert hat eine plausible Laenge", status: "pass", actual: `${value.length} Zeichen` }
      : { id: "value-shape", label: "Wert ist ungewoehnlich kurz", status: "warn", actual: `${value.length} Zeichen` },
  );
  for (const place of secret.places) {
    try {
      await checkPlaceWritable(clientsOf(deps), place);
      checks.push({ id: `target:${describePlace(place)}`, label: `Ziel erreichbar mit Schreibrecht: ${describePlace(place)}`, status: "pass" });
    } catch (err) {
      checks.push({ id: `target:${describePlace(place)}`, label: `Ziel nicht erreichbar: ${describePlace(place)}`, status: "fail", detail: (err as Error).message });
    }
  }
  for (const c of companions) {
    const target = companionEntry(deps.inventory, c.entryId)!.entry;
    const targets = target.places.map(describePlace);
    companionSummaries.push({ entryId: c.entryId, ...(c.kind === "variable" ? { kind: "variable" as const } : {}), name: target.name, targets, fingerprint: fingerprintOf(c.value) });
    for (const place of target.places) {
      try {
        // A variable is written with the same right as a secret but through another endpoint: reading it proves access.
        // A variable entry only has GitHub places (the schema allows nothing else).
        if (c.kind === "variable" && !isWorkerPlace(place)) await deps.github.listVariables(placeToTarget(deps.owner, place));
        else await checkPlaceWritable(clientsOf(deps), place);
        checks.push({ id: `companion-target:${c.entryId}:${describePlace(place)}`, label: `Ziel des Begleitwerts erreichbar mit Schreibrecht: ${describePlace(place)}`, status: "pass" });
      } catch (err) {
        checks.push({ id: `companion-target:${c.entryId}:${describePlace(place)}`, label: `Ziel des Begleitwerts nicht erreichbar: ${describePlace(place)}`, status: "fail", detail: (err as Error).message });
      }
    }
  }
  if (provider?.verify) {
    try {
      checks.push(...(await provider.verify({ secret, params, stage: secret.stage, stageKind: kind0, value, ...(externalId ? { externalId } : {}), expiresAt: expiresAt ?? null, connections: deps.connections, fetch: f, now, ...pc })));
    } catch (err) {
      checks.push({ id: "provider-verify", label: "Pruefung beim Anbieter nicht durchfuehrbar", status: "warn", detail: (err as Error).message });
    }
  }
  // Ohne Angabe des Anbieters und ohne ttlDays ist das Ablaufdatum unbekannt: das alte Datum darf nicht stehen bleiben,
  // sonst erscheint das frisch erneuerte Secret als abgelaufen.
  const newExpires = secret.expiry === "none" ? null : expiresAt ? toDay(expiresAt) : secret.ttlDays ? addDays(now, secret.ttlDays) : null;
  if (secret.expiry === "required" && !newExpires) checks.push({ id: "expiry-known", label: "Der Anbieter erzwingt ein Ablaufdatum, es ist nicht bekannt", status: "warn" });
  else if (secret.expiry === "possible" && !newExpires) checks.push({ id: "expiry-unknown", label: "Ablauf des neuen Werts unbekannt: das Secret wird als Ablauf unbekannt gefuehrt", status: "warn" });
  else checks.push({ id: "expiry", label: "Ablauf", status: "info", actual: newExpires ?? "kein Ablauf" });

  const items = provider?.reviewChecklist?.(secret, { stageKind: kind0 }) ?? DEFAULT_CHECKLIST;
  const checklist: ChecklistItem[] = items.map((text, i) => ({ id: `c${i + 1}`, text }));
  // A Worker secret is written to a deployed Worker: name it in the review so the human sees exactly where it goes.
  for (const place of secret.places) {
    if (isWorkerPlace(place)) checklist.push({ id: `c${checklist.length + 1}`, text: `Das Secret ${place.name ?? secret.name} wird als Worker-Secret auf dem Worker ${place.script} (Konto ${place.accountId}) geschrieben.` });
  }
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
    ...(companionSummaries.length ? { companions: companionSummaries } : {}),
    attachments: [],
  };
  await deps.evidence?.save(report);
  const ttl = (options.ttlMinutes ?? 15) * 60_000;
  return {
    id: report.id,
    secretId,
    value,
    companions,
    report,
    ...(secret.externalId ? { oldExternalId: secret.externalId } : {}),
    snapshot,
    issuedSecret,
    newExpires,
    ...(options.preparedBy ? { preparedBy: { ...options.preparedBy } } : {}),
    ...(options.requestedBy ? { requestedBy: { ...options.requestedBy } } : {}),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
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
  /** Hinweise zu Zustaenden, die der Mensch kennen muss (zum Beispiel: alter Token widerrufen, Inventar nicht gespeichert). */
  warnings?: string[];
}

/** Anfragen, die gerade bestaetigt werden oder schon bestaetigt sind: ein zweiter Aufruf darf nichts mehr schreiben. */
const committing = new WeakSet<PendingIssuance>();
const committed = new WeakSet<PendingIssuance>();
/** Items that were discarded (rejected, expired or stale): a second discard or a later commit must not touch the provider again. */
const discarded = new WeakSet<PendingIssuance>();
/**
 * Items for which a write to some place was ever started. Set before the first write is sent and never cleared: a write that
 * throws or times out may still have been applied by the remote, so from then on the new value may be in use somewhere and
 * nothing revokes it automatically (see `revokeNewValue`).
 */
const writeStarted = new WeakSet<PendingIssuance>();
/** The places a write was started for (written or possibly written), for the person who has to decide. */
const attemptedPlaces = new WeakMap<PendingIssuance, string[]>();

/** Was a write of this item to any place ever started? */
export const hasWriteStarted = (pending: PendingIssuance): boolean => writeStarted.has(pending);

/** The places a write of this item was started for: the new value is there or may be there. */
export const writtenPlacesOf = (pending: PendingIssuance): string[] => [...(attemptedPlaces.get(pending) ?? [])];

/**
 * Where an item stands for whoever wants to clean it up. `committing`: a commit is in flight. `committed`: the new value is in use.
 * `partial`: a write was started and the commit did not finish; only a person decides what happens to the new value.
 * `discarded`: done. `open`: no write was ever started, the new value may be deleted at the provider.
 */
export function issuanceStateOf(pending: PendingIssuance): "open" | "committing" | "committed" | "partial" | "discarded" {
  if (committing.has(pending)) return "committing";
  if (committed.has(pending)) return "committed";
  if (discarded.has(pending)) return "discarded";
  return writeStarted.has(pending) ? "partial" : "open";
}

/**
 * Stufe 2: Nach der Bestaetigung in alle Ziele schreiben, nachpruefen, den alten Wert widerrufen und das Inventar
 * aktualisieren. Bei einem Fehler an einem Ziel bleibt der alte Wert gueltig und die Anfrage offen.
 */
export async function commitIssuance(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  confirmation: { by: string; principalId?: string; ticks: string[]; note?: string },
  options: { force?: boolean; signal?: AbortSignal; hardBound?: number; beforeWrite?: () => void | Promise<void> } = {},
): Promise<CommitResult> {
  // Atomar (vor dem ersten await) als "in Bearbeitung" markieren: ein zweiter, auch paralleler Aufruf wirft sofort.
  if (committing.has(pending) || committed.has(pending) || discarded.has(pending)) throw new IssuanceError("Die Anfrage wird gerade bestaetigt oder ist schon erledigt.");
  committing.add(pending);
  let success = false;
  try {
    const result = await commitIssuanceOnce(pending, deps, confirmation, options);
    success = result.ok;
    return result;
  } finally {
    committing.delete(pending);
    if (success) committed.add(pending);
  }
}

async function commitIssuanceOnce(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  confirmation: { by: string; principalId?: string; ticks: string[]; note?: string },
  options: { force?: boolean; signal?: AbortSignal; hardBound?: number; beforeWrite?: () => void | Promise<void> },
): Promise<CommitResult> {
  const secret = deps.inventory.getSecret(pending.secretId);
  if (!secret) throw new IssuanceError(`Secret nicht gefunden: ${pending.secretId}`);
  // The deciding actor as it is recorded: the display name, plus the opaque principal id when the caller has one.
  const decider = { by: confirmation.by, ...(confirmation.principalId ? { principalId: confirmation.principalId } : {}) };
  const now = (deps.now ?? (() => new Date()))();
  if (now.getTime() > Date.parse(pending.expiresAt)) throw new IssuanceError("Die Anfrage ist abgelaufen. Neu ausstellen.");
  // Bindung an den Stand der Pruefung: Wurden Ziele, Anbieter, Parameter, Stage oder Kennung inzwischen geaendert
  // (zum Beispiel durch einen Agenten oder einen importierten Pull Request), geht der Wert nirgends hin.
  if (issuanceSnapshot(secret, stageKind(deps.inventory.stages, secret.stage)) !== pending.snapshot) {
    throw new StaleIssuanceError(await discardIssuanceNow(pending, deps, { ...decider, why: "stale" }));
  }
  if (!options.force && overallStatus(pending.report.checks) === "fail") {
    throw new IssuanceError("Die automatische Pruefung ist fehlgeschlagen. Verwerfen oder Ursache beheben.");
  }
  const missing = pending.report.checklist.filter((c) => !confirmation.ticks.includes(c.id));
  if (missing.length > 0) throw new IssuanceError(`Nicht alle Pruefpunkte bestaetigt: ${missing.map((m) => m.id).join(", ")}`);

  // Companions only go to the entries the provider named, and only while their places are what the review showed.
  const companionEntries: { entry: SecretEntry | VariableEntry; kind: "secret" | "variable"; value: SecretValue }[] = [];
  for (const c of pending.companions) {
    const found = companionEntry(deps.inventory, c.entryId);
    const entry = found?.entry;
    if (!entry || found.kind !== c.kind || companionSnapshot(entry) !== c.snapshot) {
      throw new StaleIssuanceError(await discardIssuanceNow(pending, deps, { ...decider, why: "stale" }));
    }
    companionEntries.push({ entry, kind: c.kind, value: c.value });
  }

  const outcomes: PlaceOutcome[] = [];
  const writes = [
    ...secret.places.map((place) => ({ place, name: place.name ?? secret.name, label: describePlace(place), value: pending.value, variable: false })),
    ...companionEntries.flatMap(({ entry, kind, value }) => entry.places.map((place) => ({ place, name: place.name ?? entry.name, label: `${entry.name}: ${describePlace(place)}`, value, variable: kind === "variable" }))),
  ];
  for (const w of writes) {
    // Fail closed: when the caller gave up on this commit (the review passed its hard bound while an earlier write was still
    // pending), nothing more is written, whatever the values captured above still say.
    // The same bound is also read from the clock here, so it holds without any access or sweep in between.
    if (options.signal?.aborted || (options.hardBound !== undefined && (deps.now ?? (() => new Date()))().getTime() >= options.hardBound)) {
      outcomes.push({ place: w.label, outcome: "failed", error: "Abgebrochen: die Anfrage ist abgelaufen." });
      continue;
    }
    // From here a write is started, and nothing may be revoked automatically again: set before the first write is sent, never
    // cleared. A caller that keeps the fact elsewhere (a store) records it first; when that fails, no write starts at all.
    if (!writeStarted.has(pending)) {
      await options.beforeWrite?.();
      writeStarted.add(pending);
    }
    attemptedPlaces.set(pending, [...(attemptedPlaces.get(pending) ?? []), w.label]);
    try {
      const outcome =
        w.variable && !isWorkerPlace(w.place)
          ? await deps.github.putVariable(placeToTarget(deps.owner, w.place), w.name, w.value.reveal())
          : await putPlaceSecret(clientsOf(deps), w.place, w.name, w.value);
      outcomes.push({ place: w.label, outcome });
    } catch (err) {
      outcomes.push({ place: w.label, outcome: "failed", error: (err as Error).message });
    }
  }
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  if (failed > 0) {
    // A write that failed may still have been applied by the remote (a time-out, a lost answer): every place a write was started
    // for counts. From here only a person decides about the new value (nothing revokes it automatically).
    const attempted = attemptedPlaces.get(pending) ?? [];
    if (attempted.length > 0) {
      pending.report.checks.push({ id: "partial-write", label: `Neuer Wert geschrieben oder moeglicherweise geschrieben, nicht widerrufen: ${attempted.join(", ")}`, status: "warn", detail: "Ein Mensch entscheidet: erneut bestaetigen oder ablehnen." });
      await deps.evidence?.save(pending.report).catch(() => undefined);
    }
    return { secretId: pending.secretId, reportId: pending.report.id, ok: false, partial: failed < outcomes.length, places: outcomes, revokedOld: false, expires: secret.expires };
  }

  // Every place holds the new value now: it is in use, whatever happens to the checks, the inventory or the report below.
  // Nothing may revoke it any more (an evidence failure later must not leave the item looking unconfirmed).
  committed.add(pending);

  // Nachpruefung: Der Name steht jetzt in jedem Ziel und wurde eben geaendert.
  const since = Date.parse(pending.createdAt) - 5_000;
  for (const w of writes) {
    const { place, label } = w;
    try {
      const live: { updatedAt?: string } | undefined =
        w.variable && !isWorkerPlace(place)
          ? (await deps.github.listVariables(placeToTarget(deps.owner, place))).find((s) => s.name === w.name && s.value === w.value.reveal())
          : (await listPlaceSecrets(clientsOf(deps), place)).find((s) => s.name === w.name);
      // A Worker lists names without change times: the name being there right after the write is all that can be seen.
      const fresh = live !== undefined && (live.updatedAt === undefined || Date.parse(live.updatedAt) >= since);
      pending.report.checks.push({ id: `written:${label}`, label: isWorkerPlace(place) ? `Auf dem Worker geschrieben: ${label}` : `In GitHub geschrieben: ${label}`, status: fresh ? "pass" : "warn", ...(live ? (live.updatedAt ? { actual: `geaendert ${live.updatedAt}` } : { actual: "Name vorhanden" }) : { detail: "Name nicht gefunden" }) });
    } catch (err) {
      pending.report.checks.push({ id: `written:${label}`, label: `Nachpruefung nicht moeglich: ${label}`, status: "warn", detail: (err as Error).message });
    }
  }

  const provider = deps.providers.get(secret.provider);
  let revokedOld = false;
  // A rotation keeps the provider id: the "old" value is the same object and must not be deleted.
  // Outside the revoke gate (`revokeNewValue`) on purpose: this revokes the OLD value, after every place holds the new one and
  // the person confirmed; the gate is for a NEW value that may be in use. It has two guards of its own: the identifier must
  // differ from the new one, and no entry outside this commit may still hold it (companions copy identifiers, so an entry
  // that was not part of this issuance can carry the same identifier and still use that value).
  const oldId = pending.oldExternalId;
  const oldHolder = oldId && oldId !== pending.report.externalId ? entryHoldingId(deps.inventory, oldId, [secret.id, ...companionEntries.map((c) => c.entry.id)]) : undefined;
  if (oldHolder && provider?.revoke) {
    pending.report.checks.push({ id: "revoke-old", label: `Alten Wert nicht widerrufen: seine Kennung ist noch die aktuelle von Eintrag ${oldHolder}`, status: "warn", detail: "Der Wert wird dort noch gebraucht. Beim Anbieter erst loeschen, wenn dieser Eintrag erneuert ist." });
  } else if (oldId && oldId !== pending.report.externalId && provider?.revoke) {
    try {
      await provider.revoke({ externalId: oldId, secret, params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)), connections: deps.connections, fetch: deps.fetch ?? fetch, ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}) });
      revokedOld = true;
      pending.report.checks.push({ id: "revoke-old", label: "Alter Wert beim Anbieter widerrufen", status: "pass" });
    } catch (err) {
      pending.report.checks.push({ id: "revoke-old", label: "Alten Wert widerrufen: fehlgeschlagen", status: "warn", detail: (err as Error).message });
    }
  }

  const day = toDay(now.toISOString());
  const warnings: string[] = [];
  // Unbekanntes Ablaufdatum bei einem Secret mit moeglichem Ablauf: als "unbekannt" fuehren statt mit altem Datum.
  const unknownExpiry = pending.newExpires === null && secret.expiry === "possible";
  try {
    deps.inventory.patchSecret(pending.secretId, {
      rotatedAt: day,
      verifiedAt: day,
      verifiedBy: confirmation.by,
      expires: pending.newExpires,
      ...(unknownExpiry ? { expiry: "unknown" as const } : {}),
      // No identifier for the new value: clear the old one instead of keeping the identifier of the value just revoked.
      externalId: pending.report.externalId ?? null,
    });
    for (const { entry, kind, value } of companionEntries) {
      if (kind === "variable") {
        // The expected value of the variable is the new public value, so the next comparison with GitHub is in sync.
        deps.inventory.patchVariable(entry.id, { value: value.reveal() });
        continue;
      }
      deps.inventory.patchSecret(entry.id, {
        rotatedAt: day,
        verifiedAt: day,
        verifiedBy: confirmation.by,
        // An entry that never expires keeps no expiry date.
        ...((entry as SecretEntry).expiry === "none" ? {} : { expires: pending.newExpires }),
        externalId: pending.report.externalId ?? null,
      });
    }
    await deps.inventory.save();
  } catch (err) {
    warnings.push(revokedOld ? "Der alte Token ist bereits widerrufen, aber das Inventar wurde nicht gespeichert." : "Der neue Wert ist in allen Zielen geschrieben, aber das Inventar wurde nicht gespeichert.");
    warnings.push(`Neue Kennung beim Anbieter: ${pending.report.externalId ?? "unbekannt"}`);
    warnings.push(`Grund: ${(err as Error).message}`);
    warnings.push("Inventar von Hand nachtragen.");
  }
  if (unknownExpiry) warnings.push("Der Ablauf des neuen Tokens ist unbekannt: das Secret steht jetzt auf Ablauf unbekannt.");

  const confirmationRecord: Confirmation = { ...decider, at: now.toISOString(), ticks: confirmation.ticks, decision: "confirmed", ...(confirmation.note ? { note: confirmation.note } : {}) };
  pending.report.confirmation = confirmationRecord;
  // The value is rolled out: a report that cannot be saved is a warning, not a failure of the confirmation.
  try {
    await deps.evidence?.save(pending.report);
  } catch {
    warnings.push("Der Pruefbericht konnte nicht gespeichert werden. Der neue Wert ist geschrieben.");
  }
  return { secretId: pending.secretId, reportId: pending.report.id, ok: true, partial: false, places: outcomes, revokedOld, expires: pending.newExpires, ...(warnings.length ? { warnings } : {}) };
}

/**
 * The id of an entry, other than those in `except`, whose current identifier is `id`, or undefined. Companions copy identifiers,
 * so the identifier of a value can be the current one of an entry that is not part of the flow asking.
 */
export function entryHoldingId(inventory: InventoryStore, id: string, except: readonly string[]): string | undefined {
  return inventory.data.secrets.find((s) => s.externalId === id && !except.includes(s.id))?.id;
}

/** What the gate reads: the inventory and what it takes to call a provider. No places, no GitHub: it never writes. */
export type RevokeGateDeps = Pick<IssuanceDeps, "inventory" | "providers" | "connections" | "fetch" | "providerConfig">;

/** Why the gate did not call the provider. The first reason is a decision for a person; the others mean the record is stale. */
export type RevokeRefusal = "write-started" | "value-in-use" | "secret-gone" | "provider-changed" | "no-id" | "no-revoke";

export type RevokeOutcome = { status: "revoked" } | { status: "failed" } | { status: "refused"; reason: RevokeRefusal };

/** What the gate needs to know about a new value: metadata only, from a pending item or from a record. */
export interface RevokeTarget {
  secretId: string;
  /** The provider of the entry when the value was issued. */
  provider: string;
  /** The provider's identifier of the new value. Absent: nothing to delete (for example a renewal in place). */
  externalId?: string | undefined;
  /** Entries that received companion values from the same issuance. */
  companionIds?: readonly string[] | undefined;
  /** A write was started, according to a record (another process, an earlier life of this one). */
  writeStarted?: boolean | undefined;
  /** The pending item itself, when this process holds it: its in-memory fact counts too. */
  pending?: PendingIssuance | undefined;
  /** The entry as it was issued: the delete uses its provider and parameters. Without it the entry in the inventory is used. */
  issuedSecret?: SecretEntry | undefined;
}

/**
 * THE gate: the only code that asks a provider to revoke or delete a newly issued value. Every site goes through it (commit's
 * stale checks, discard, the sweep and its retries, a person's reject, an explicit orphan revoke). It refuses, without calling
 * the provider, whenever the value may be in use:
 *  - `write-started`: a write of this item to any place was ever started (a failed or timed-out write may still have been
 *    applied). Only `acknowledgeWritten`, which a person's reject or an explicit orphan revoke supplies, lifts this.
 *  - `value-in-use`: the identifier is the current one of the entry or of a companion entry, read now (another review of the
 *    same provider identifier may have been confirmed).
 *  - `secret-gone`, `provider-changed`: for a record alone (no issued entry) the entry must still exist with the same provider.
 *  - `no-id`, `no-revoke`: there is nothing to call.
 * The gate knows only the inventory, not uses outside it. The rotate flow and the environment export call it too (the new value
 * of a rotation whose writes all failed, the values of an export that failed), with `writeStarted` set by the caller: the
 * first when it sent any write, the second when it began to write the file. Outside the gate on purpose: the old-value revokes
 * (after a confirmed commit and after a rotation, each with its own guards) and the undo inside `prepareIssuance`.
 */
export async function revokeNewValue(target: RevokeTarget, deps: RevokeGateDeps, options: { acknowledgeWritten?: boolean } = {}): Promise<RevokeOutcome> {
  const id = target.externalId;
  if (!id) return { status: "refused", reason: "no-id" };
  const current = deps.inventory.getSecret(target.secretId);
  const live = [current?.externalId, ...(target.companionIds ?? []).map((entry) => deps.inventory.getSecret(entry)?.externalId)];
  if (live.includes(id)) return { status: "refused", reason: "value-in-use" };
  const started = target.writeStarted === true || (target.pending !== undefined && writeStarted.has(target.pending));
  if (started && !options.acknowledgeWritten) return { status: "refused", reason: "write-started" };
  if (!target.issuedSecret) {
    if (!current) return { status: "refused", reason: "secret-gone" };
    if (current.provider !== target.provider) return { status: "refused", reason: "provider-changed" };
  }
  const secret = (target.issuedSecret ?? current)!;
  const provider = deps.providers.get(secret.provider);
  if (!provider?.revoke) return { status: "refused", reason: "no-revoke" };
  try {
    await provider.revoke({ externalId: id, secret, params: effectiveParams(provider, secret.params, integrationDefaultsOf(deps.inventory, provider)), connections: deps.connections, fetch: deps.fetch ?? fetch, ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}) });
    return { status: "revoked" };
  } catch {
    /* bleibt gueltig, steht im Bericht */
    return { status: "failed" };
  }
}

export interface DiscardResult {
  revokedNew: boolean;
  /** Set when the gate refused to call the provider. */
  refused?: RevokeRefusal;
}

/** Verwirft einen ausgestellten Wert: Der neue Wert wird beim Anbieter wieder geloescht, nichts wurde geschrieben. */
export async function discardIssuance(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  reason: { by: string; principalId?: string; why: "rejected" | "expired" | "stale"; note?: string; acknowledgeWritten?: boolean },
): Promise<DiscardResult> {
  // Waehrend der Bestaetigung (oder danach) darf der Wert nicht widerrufen werden: er wird gerade geschrieben bzw. ist im Einsatz.
  if (committing.has(pending) || committed.has(pending)) throw new IssuanceError("Die Anfrage wird gerade bestaetigt oder ist schon erledigt.");
  return discardIssuanceNow(pending, deps, reason);
}

async function discardIssuanceNow(
  pending: PendingIssuance,
  deps: IssuanceDeps,
  reason: { by: string; principalId?: string; why: "rejected" | "expired" | "stale"; note?: string; acknowledgeWritten?: boolean },
): Promise<DiscardResult> {
  // Marked before the first await: a second discard (also a parallel one) throws instead of revoking again.
  if (discarded.has(pending)) throw new IssuanceError("Die Anfrage wird gerade bestaetigt oder ist schon erledigt.");
  discarded.add(pending);
  // Same id as before means the provider rotated in place: nothing new exists that could be deleted.
  const rotatedInPlace = pending.report.externalId !== undefined && pending.report.externalId === pending.oldExternalId;
  const externalId = rotatedInPlace ? undefined : pending.report.externalId;
  // Widerrufen mit dem Eintrag von damals: spaeter geaenderte Parameter (zum Beispiel eine andere Adresse) bleiben aussen vor.
  // A value the provider issued but named no identifier for cannot be deleted: the gate says so (`no-id`) and the report must too.
  const issuedWithoutId = pending.report.kind === "issued" && pending.report.externalId === undefined;
  const outcome: RevokeOutcome | undefined =
    externalId || issuedWithoutId
      ? await revokeNewValue({ secretId: pending.secretId, provider: pending.issuedSecret?.provider ?? pending.report.provider, externalId, companionIds: pending.companions.map((c) => c.entryId), pending, ...(pending.issuedSecret ? { issuedSecret: pending.issuedSecret } : {}) }, deps, { acknowledgeWritten: reason.acknowledgeWritten === true })
      : undefined;
  const revokedNew = outcome?.status === "revoked";
  if (outcome?.status === "refused" && outcome.reason === "no-id") {
    pending.report.checks.push({ id: "revoke-no-id", label: "Neuer Wert konnte beim Anbieter nicht geloescht werden: der Anbieter hat keine Kennung genannt", status: "warn", detail: "Von Hand beim Anbieter loeschen oder verfallen lassen." });
  }
  // A person decided about a value a write was started for and the revoke worked: say which places now hold a revoked value.
  if (revokedNew && reason.acknowledgeWritten === true && writeStarted.has(pending)) {
    pending.report.checks.push({ id: "revoked-written", label: `Neuer Wert widerrufen, obwohl ein Schreibvorgang begonnen war. Diese Orte halten einen widerrufenen Wert: ${writtenPlacesOf(pending).join(", ")}`, status: "warn" });
  }
  const now = (deps.now ?? (() => new Date()))();
  pending.report.confirmation = {
    by: reason.by,
    ...(reason.principalId ? { principalId: reason.principalId } : {}),
    at: now.toISOString(),
    ticks: [],
    decision: "rejected",
    note: `${reason.why === "expired" ? "Zeit abgelaufen" : reason.why === "stale" ? "Eintrag seit der Pruefung geaendert" : "Abgelehnt"}${reason.note ? `: ${reason.note}` : ""}${pending.report.externalId && !revokedNew ? " (neuer Wert beim Anbieter NICHT widerrufen)" : ""}`,
  };
  // The delete above has happened (or was refused) whatever the report store does: a failing store must not look like a failed
  // delete, or the caller would revoke an already revoked identifier a second time.
  try {
    await deps.evidence?.save(pending.report);
  } catch {
    /* the result below is what counts */
  }
  return { revokedNew, ...(outcome?.status === "refused" ? { refused: outcome.reason } : {}) };
}
