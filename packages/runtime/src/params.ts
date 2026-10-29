import {
  SUGGEST_MODES,
  markSuggestions,
  InventoryError,
  ParamsInvalidError,
  discoverResources,
  entryParamsState,
  hintFor,
  preflightEntry,
  validateEntryParams,
  type DiscoverHint,
  type DiscoveryResult,
  type EntryPreflight,
  type ParamProblem,
  type ParamSpec,
  type ResourceMapEntry,
  type Provider,
  type SecretEntry,
  stageKind,
  VARIABLE_SOURCES,
  VariableSourceSchema,
  assertPublicValue,
  parseInput,
  type VariableEntry,
  type VariableSource,
} from "@secret-desk/core";
import { readVariableField } from "@secret-desk/providers";
import { KNOWN_CONNECTIONS } from "./connection-check.js";
import type { Actor } from "./agent-api.js";
import { PolicyError } from "./agent-api.js";
import { issuanceDeps, type Runtime } from "./runtime.js";

/**
 * Parameter der Anbieter: Spezifikation, Pruefung, Entdeckung beim verbundenen Konto, Vorschlaege und Vorabcheck.
 * Alles hier ist Konfiguration (Kennungen, Adressen, Rechte), nie ein geheimer Wert oder ein Token.
 * Entdeckung und Vorabcheck lesen nur, mit dem gespeicherten Token der Integration. Vorgeschlagen wird nur; uebernommen
 * wird nie von allein.
 */

const requireHuman = (actor: Actor, what: string): void => {
  if (actor.kind !== "human") throw new PolicyError(`${what} darf nur ein Mensch.`);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function providerOrThrow(rt: Runtime, id: string): Provider {
  const p = rt.providers.get(id);
  if (!p) throw new InventoryError(`Unbekannter Anbieter: ${id}`);
  return p;
}

const deps = (rt: Runtime) => issuanceDeps(rt);

export type ResourceState = Pick<DiscoveryResult, "status" | "options" | "suggested" | "mapMismatch" | "error" | "hint" | "connection">;

export interface ParamsView {
  /** Nur bei bestehendem Eintrag. */
  secretId?: string;
  provider: string;
  providerLabel: string;
  connection: string | null;
  connected: boolean | null;
  specs: ParamSpec[];
  /** Werte, die der Eintrag selbst traegt (ohne Standardwerte). */
  values: Record<string, unknown>;
  /** Standardwerte der Integration, soweit der Anbieter sie nutzt. */
  defaults: Record<string, unknown>;
  /** Wirksam: Eintrag plus Standardwerte. */
  effective: Record<string, unknown>;
  /** Parameter im Inventar, die die Spezifikation nicht kennt. Sie bleiben erhalten. */
  unknown: Record<string, unknown>;
  problems: ParamProblem[];
  complete: boolean;
  /** Je Parameter mit Entdeckung: Optionen und hoechstens ein Vorschlag. Leer bei live=0. */
  resources: Record<string, ResourceState>;
  preflight: EntryPreflight | null;
}

const resourceOf = (d: DiscoveryResult): ResourceState => ({ status: d.status, options: d.options, suggested: d.suggested, ...(d.mapMismatch ? { mapMismatch: d.mapMismatch } : {}), ...(d.error ? { error: d.error } : {}), ...(d.hint ? { hint: d.hint } : {}), ...(d.connection ? { connection: d.connection } : {}) });

/** Entdeckt fuer jeden Parameter mit `discover` (je Art und Parameterstand nur einmal). */
async function discoverAll(rt: Runtime, provider: Provider, hint: DiscoverHint, params: Record<string, unknown>): Promise<Record<string, ResourceState>> {
  const out: Record<string, ResourceState> = {};
  const cache = new Map<string, ResourceState>();
  for (const spec of provider.params ?? []) {
    if (!spec.discover) continue;
    const cached = cache.get(spec.discover);
    if (cached) {
      out[spec.key] = cached;
      continue;
    }
    const r = resourceOf(await discoverResources(provider, spec.discover, deps(rt), hint, params));
    cache.set(spec.discover, r);
    out[spec.key] = r;
  }
  return out;
}

async function connectedState(rt: Runtime, provider: Provider): Promise<boolean | null> {
  if (!provider.connection) return null;
  return (await rt.connections.status(provider.connection)).connected;
}

/** Parameter eines bestehenden Eintrags. live (Standard): Entdeckung, Vorschlaege und Vorabcheck beim Anbieter. */
export async function getSecretParams(rt: Runtime, actor: Actor, id: string, options: { live?: boolean } = {}): Promise<ParamsView> {
  requireHuman(actor, "Parameter bearbeiten");
  const secret = rt.inventory.getSecret(id);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${id}`);
  const provider = rt.providers.get(secret.provider);
  if (!provider) throw new InventoryError(`Unbekannter Anbieter: ${secret.provider}`);
  const state = entryParamsState(rt.inventory, provider, secret);
  const specKeys = new Set((provider.params ?? []).map((s) => s.key));
  const live = options.live !== false;
  return {
    secretId: id,
    provider: provider.id,
    providerLabel: provider.label,
    connection: provider.connection ?? null,
    connected: await connectedState(rt, provider),
    specs: provider.params ?? [],
    values: Object.fromEntries(Object.entries(secret.params).filter(([k]) => specKeys.has(k))),
    defaults: state.defaults,
    effective: state.effective,
    unknown: Object.fromEntries(Object.entries(secret.params).filter(([k]) => !specKeys.has(k))),
    problems: state.problems,
    complete: state.problems.length === 0,
    resources: live ? await discoverAll(rt, provider, hintFor(rt.inventory, secret), state.effective) : {},
    preflight: live ? await preflightEntry(secret, deps(rt)) : null,
  };
}

/**
 * Speichert Parameter in das Inventar. `params` setzt Schluessel, `remove` entfernt welche, `preset` setzt die Werte eines
 * Presets (darunter liegende Schluessel aus `params` gehen vor). Unbekannte Schluessel werden abgelehnt, bestehende
 * unbekannte bleiben erhalten. Falsche Typen und Werte ausserhalb der Optionen sind params_invalid (nichts gespeichert);
 * fehlende Pflichtparameter nicht (Teilstand), sie stehen in problems/complete.
 */
export async function putSecretParams(rt: Runtime, actor: Actor, id: string, body: { params?: unknown; remove?: unknown; preset?: unknown }): Promise<ParamsView> {
  requireHuman(actor, "Parameter aendern");
  const secret = rt.inventory.getSecret(id);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${id}`);
  const provider = providerOrThrow(rt, secret.provider);
  const set: Record<string, unknown> = {};
  if (body.preset !== undefined) {
    const preset = (provider.params ?? []).flatMap((s) => s.presets ?? []).find((p) => p.id === body.preset);
    if (!preset) throw new InventoryError(`Unbekanntes Preset: ${String(body.preset)}`);
    Object.assign(set, preset.values);
  }
  if (body.params !== undefined) {
    if (!isRecord(body.params)) throw new InventoryError("Feld params muss ein Objekt sein.");
    Object.assign(set, body.params);
  }
  const remove = Array.isArray(body.remove) ? body.remove.filter((k): k is string => typeof k === "string") : [];
  for (const key of Object.keys(set)) if (set[key] === null) {
    delete set[key];
    remove.push(key);
  }
  const bad = validateEntryParams(provider, { params: set }, undefined, { strict: true, requireComplete: false });
  if (bad.length > 0) throw new ParamsInvalidError(bad);
  const known = new Set((provider.params ?? []).map((s) => s.key));
  const unknownRemove = remove.filter((k) => !known.has(k));
  if (unknownRemove.length > 0) throw new InventoryError(`Parameter nicht vorgesehen: ${unknownRemove.join(", ")}`);
  rt.inventory.setSecretParams(id, set, remove);
  await rt.inventory.save();
  return getSecretParams(rt, actor, id, { live: false });
}

/** Parameterstatus fuer Listen und die Agenten-Schnittstelle: nur fehlend/ok, keine Werte. */
export function paramStatus(rt: Runtime, secret: Pick<SecretEntry, "provider" | "params">): { status: "ok" | "missing" | "invalid" | "none"; missing: string[] } {
  const provider = rt.providers.get(secret.provider);
  if (!provider?.params?.length) return { status: "none", missing: [] };
  const problems = entryParamsState(rt.inventory, provider, secret).problems;
  if (problems.length === 0) return { status: "ok", missing: [] };
  const missing = problems.filter((p) => p.code === "missing").map((p) => p.key);
  return { status: problems.some((p) => p.code !== "missing") ? "invalid" : "missing", missing };
}

// ------------------------------------------------------------------------------- Entwuerfe (ohne Eintrag)

const draftHint = (rt: Runtime, repo?: string, stage?: string): DiscoverHint => ({ repos: repo ? [repo] : [], ...(stage ? { stage, stageKind: stageKind(rt.inventory.stages, stage) } : {}), ...(rt.inventory.data.resourceMap ? { resourceMap: rt.inventory.data.resourceMap } : {}) });

/** Spezifikation und Vorschlaege fuer einen Eintrag, der noch nicht existiert (Anlegedialog). */
export async function getProviderParams(rt: Runtime, actor: Actor, providerId: string, options: { repo?: string; stage?: string; live?: boolean; params?: Record<string, unknown> } = {}): Promise<ParamsView> {
  requireHuman(actor, "Parameter ansehen");
  const provider = providerOrThrow(rt, providerId);
  const state = entryParamsState(rt.inventory, provider, { params: options.params ?? {} });
  return {
    provider: provider.id,
    providerLabel: provider.label,
    connection: provider.connection ?? null,
    connected: await connectedState(rt, provider),
    specs: provider.params ?? [],
    values: options.params ?? {},
    defaults: state.defaults,
    effective: state.effective,
    unknown: {},
    problems: state.problems,
    complete: state.problems.length === 0,
    resources: options.live === false ? {} : await discoverAll(rt, provider, draftHint(rt, options.repo, options.stage), state.effective),
    preflight: null,
  };
}

/** Entdeckung einer Art fuer einen Anbieter-Entwurf. `params`: bereits gewaehlte Parameter (zum Beispiel accountId). */
export async function getProviderResources(rt: Runtime, actor: Actor, providerId: string, kind: string, options: { repo?: string; stage?: string; params?: Record<string, unknown> } = {}): Promise<DiscoveryResult & { provider: string; kind: string }> {
  requireHuman(actor, "Ressourcen ansehen");
  const provider = providerOrThrow(rt, providerId);
  const r = await discoverResources(provider, kind, deps(rt), draftHint(rt, options.repo, options.stage), effectiveFor(rt, provider, options.params ?? {}));
  return { provider: provider.id, kind, ...r };
}

function effectiveFor(rt: Runtime, provider: Provider, params: Record<string, unknown>): Record<string, unknown> {
  return entryParamsState(rt.inventory, provider, { params }).effective;
}

// ---------------------------------------------------------------------------------------- Integrationen

export interface ConnectionResources {
  connection: string;
  connected: boolean;
  /** Parameter, die als Standardwert der Integration gesetzt werden koennen (Fallback fuer Eintraege). */
  defaultSpecs: ParamSpec[];
  defaults: Record<string, unknown>;
  resources: Record<string, ResourceState>;
}

function providersOf(rt: Runtime, connection: string): Provider[] {
  const list = rt.providers.list().filter((p) => p.connection === connection);
  return list;
}

function defaultSpecsOf(providers: Provider[]): ParamSpec[] {
  const seen = new Map<string, ParamSpec>();
  for (const p of providers) for (const s of p.params ?? []) if (s.integrationDefault && !seen.has(s.key)) seen.set(s.key, s);
  return [...seen.values()];
}

/** Entdeckbare Arten einer Integration, jeweils mit dem Anbieter, der sie kann. */
function kindsOf(providers: Provider[]): Map<string, Provider> {
  const out = new Map<string, Provider>();
  for (const p of providers) for (const s of p.params ?? []) if (s.discover && p.discover && !out.has(s.discover)) out.set(s.discover, p);
  return out;
}

/**
 * Was die verbundene Integration hergibt (Konten, Projekte, Zonen, Domains ...) und welche Standardwerte sie braucht.
 * Ohne `kind` alle Arten, die ohne weitere Parameter gehen; mit `kind` genau diese (und `params` fuer Abhaengigkeiten).
 */
export async function getConnectionResources(rt: Runtime, actor: Actor, connection: string, options: { kind?: string; repo?: string; stage?: string; params?: Record<string, unknown> } = {}): Promise<ConnectionResources> {
  requireHuman(actor, "Ressourcen ansehen");
  const providers = providersOf(rt, connection);
  // Bekannte Verbindungen ohne Anbieter (github, team-sync, ...) haben nichts zu entdecken: leere Ansicht statt Fehler.
  if (providers.length === 0 && !KNOWN_CONNECTIONS.has(connection)) throw new InventoryError(`Unbekannte Verbindung: ${connection}`);
  const kinds = kindsOf(providers);
  const hint = draftHint(rt, options.repo, options.stage);
  const resources: Record<string, ResourceState> = {};
  const wanted = options.kind ? [options.kind] : [...kinds.keys()];
  for (const kind of wanted) {
    const p = kinds.get(kind);
    if (!p) {
      resources[kind] = { status: "unsupported", options: [], suggested: null, error: `Unbekannte Entdeckungsart: ${kind}` };
      continue;
    }
    resources[kind] = resourceOf(await discoverResources(p, kind, deps(rt), hint, options.params ?? {}));
  }
  return {
    connection,
    connected: (await rt.connections.status(connection)).connected,
    defaultSpecs: defaultSpecsOf(providers),
    defaults: rt.inventory.data.integrationDefaults?.[connection] ?? {},
    resources,
  };
}

/** Setzt Standardwerte einer Integration (nicht geheim). null/leer entfernt einen Schluessel. Ersetzt nur die genannten Schluessel. */
export async function putConnectionDefaults(rt: Runtime, actor: Actor, connection: string, body: { values?: unknown }): Promise<{ connection: string; defaults: Record<string, unknown>; defaultSpecs: ParamSpec[] }> {
  requireHuman(actor, "Standardwerte aendern");
  const providers = providersOf(rt, connection);
  if (providers.length === 0 && !KNOWN_CONNECTIONS.has(connection)) throw new InventoryError(`Unbekannte Verbindung: ${connection}`);
  if (!isRecord(body.values)) throw new InventoryError("Feld fehlt: values");
  const specs = defaultSpecsOf(providers);
  const next = { ...(rt.inventory.data.integrationDefaults?.[connection] ?? {}) };
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.values)) {
    if (v === null || v === "") delete next[k];
    else set[k] = v;
  }
  const bad = validateEntryParams({ params: specs }, { params: set }, undefined, { strict: true, requireComplete: false });
  if (bad.length > 0) throw new ParamsInvalidError(bad);
  Object.assign(next, set);
  rt.inventory.setIntegrationDefaults(connection, next);
  await rt.inventory.save();
  return { connection, defaults: next, defaultSpecs: specs };
}

// ------------------------------------------------------------------------------------------ Zuordnung

export interface ResourceMapView {
  entries: ResourceMapEntry[];
  /** Entdeckungsarten, fuer die eine Zuordnung moeglich ist. */
  kinds: string[];
}

const mapView = (rt: Runtime): ResourceMapView => ({ entries: rt.inventory.data.resourceMap ?? [], kinds: Object.keys(SUGGEST_MODES) });

function mapKeyOf(rt: Runtime, body: Record<string, unknown>): { kind: string; repo: string; stage?: string } {
  const text = (k: string): string | undefined => (typeof body[k] === "string" && (body[k] as string).trim() !== "" ? (body[k] as string).trim() : undefined);
  const kind = text("kind");
  if (!kind) throw new InventoryError("Feld fehlt: kind");
  if (!SUGGEST_MODES[kind]) throw new InventoryError(`Unbekannte Entdeckungsart: ${kind}`);
  const repo = text("repo");
  if (!repo) throw new InventoryError("Feld fehlt: repo");
  const stage = text("stage");
  if (stage && !rt.inventory.stages.some((d) => d.id === stage)) throw new InventoryError(`Unbekannte Stage: ${stage}`);
  return { kind, repo, ...(stage ? { stage } : {}) };
}

/** Die Zuordnung Repository (und Stage) zu Ressourcen des Anbieters. Nicht geheim. */
export function getResourceMap(rt: Runtime, actor: Actor): ResourceMapView {
  requireHuman(actor, "Zuordnung ansehen");
  return mapView(rt);
}

/** Setzt eine Zuordnung. (kind, repo, stage) ist der Schluessel; ein vorhandener Eintrag wird ersetzt. */
export async function putResourceMap(rt: Runtime, actor: Actor, body: Record<string, unknown>): Promise<ResourceMapView & { entry: ResourceMapEntry }> {
  requireHuman(actor, "Zuordnung aendern");
  const key = mapKeyOf(rt, body);
  const value = typeof body["value"] === "string" ? body["value"].trim() : typeof body["value"] === "number" ? String(body["value"]) : "";
  if (!value) throw new InventoryError("Feld fehlt: value");
  const label = typeof body["label"] === "string" && body["label"].trim() !== "" ? body["label"].trim() : undefined;
  const entry = rt.inventory.setResourceMap({ ...key, value, ...(label ? { label } : {}) });
  await rt.inventory.save();
  return { ...mapView(rt), entry };
}

/** Entfernt eine Zuordnung. */
export async function deleteResourceMap(rt: Runtime, actor: Actor, body: Record<string, unknown>): Promise<ResourceMapView & { removed: boolean }> {
  requireHuman(actor, "Zuordnung aendern");
  const removed = rt.inventory.removeResourceMapEntry(mapKeyOf(rt, body));
  if (removed) await rt.inventory.save();
  return { ...mapView(rt), removed };
}

// ------------------------------------------------------------------------------------------ Sammelvorschlag

export interface ParamSuggestion {
  secretId: string;
  provider: string;
  stage: string;
  missing: string[];
  /** Je fehlendem Parameter mit Entdeckung: der Vorschlag (eindeutig) oder null (keiner/zweideutig). */
  suggestions: Record<string, { value: string | number; label: string; reason: string } | null>;
  status: "suggested" | "partial" | "none" | "not-connected";
}

/**
 * Vorschlaege fuer alle Eintraege mit fehlenden Parametern. Schreibt nichts: der Mensch uebernimmt je Eintrag
 * (PUT secrets/:id/params). Zweideutige oder unsichere Treffer ergeben keinen Vorschlag.
 */
export async function suggestAllParams(rt: Runtime, actor: Actor): Promise<{ suggestions: ParamSuggestion[] }> {
  requireHuman(actor, "Vorschlaege einholen");
  const out: ParamSuggestion[] = [];
  const cache = new Map<string, DiscoveryResult>();
  for (const secret of rt.inventory.data.secrets) {
    const provider = rt.providers.get(secret.provider);
    if (!provider?.params?.length) continue;
    const state = entryParamsState(rt.inventory, provider, secret);
    const missing = state.problems.filter((p) => p.code === "missing").map((p) => p.key);
    if (missing.length === 0) continue;
    const hint = hintFor(rt.inventory, secret);
    const suggestions: ParamSuggestion["suggestions"] = {};
    let notConnected = false;
    for (const key of missing) {
      const spec = provider.params.find((s) => s.key === key);
      if (!spec?.discover) continue;
      // Ohne Vorschlagsregel (zum Beispiel Berechtigungen) gibt es nie einen Vorschlag: kein Anbieter-Aufruf noetig.
      if (!SUGGEST_MODES[spec.discover]) {
        suggestions[key] = null;
        continue;
      }
      // Die Liste haengt nur vom Anbieter und vom Konto ab, nicht vom Eintrag: einmal laden, je Eintrag neu bewerten.
      // Zonen/Widgets haengen vom gewaehlten Konto ab: ohne es keine Entdeckung.
      const cacheKey = `${provider.id}|${spec.discover}|${String(state.effective["accountId"] ?? "")}`;
      let d = cache.get(cacheKey);
      if (!d) {
        d = await discoverResources(provider, spec.discover, deps(rt), { repos: [], stage: "" }, state.effective);
        cache.set(cacheKey, d);
      }
      if (d.status === "not-connected") notConnected = true;
      const marked = d.status === "ok" ? markSuggestions(spec.discover, d.options, hint) : { options: d.options, suggested: null };
      const hit = marked.options.find((o) => o.suggestedFor);
      suggestions[key] = hit ? { value: hit.value, label: hit.label, reason: hit.suggestedFor!.reason } : null;
    }
    const found = Object.values(suggestions).filter(Boolean).length;
    out.push({
      secretId: secret.id,
      provider: provider.id,
      stage: secret.stage,
      missing,
      suggestions,
      status: notConnected && found === 0 ? "not-connected" : found === 0 ? "none" : found === Object.keys(suggestions).length && Object.keys(suggestions).length === missing.length ? "suggested" : "partial",
    });
  }
  return { suggestions: out };
}

// ------------------------------------------------------------------------------------ Variablen aus Quellen

/** Quellen, aus denen Variablen geladen werden koennen, mit Feldern (nur erlaubte, nie geheime) und Verbindungsstand. */
export async function listVariableSources(rt: Runtime, actor: Actor) {
  requireHuman(actor, "Quellen ansehen");
  const out = [];
  for (const k of VARIABLE_SOURCES) out.push({ ...k, connected: (await rt.connections.status(k.connection)).connected });
  return { sources: out };
}

/** Liest den Wert eines erlaubten Felds der gewaehlten Ressource aus der Integration (lesend). */
async function readSource(rt: Runtime, src: VariableSource, hint: DiscoverHint, params: Record<string, unknown> = {}): Promise<{ value: string; label: string }> {
  const provider = kindsOf(providersOf(rt, src.connection)).get(src.kind);
  if (!provider?.discover) throw new InventoryError(`Unbekannte Quelle: ${src.kind}`);
  const options = await provider.discover(src.kind, { connections: rt.connections, fetch: rt.fetch, params, hint, providerConfig: rt.config.providers });
  const option = options.find((o) => String(o.value) === src.resource);
  if (!option) throw new InventoryError(`Die Ressource ${src.resource} gibt es in der Verbindung ${src.connection} nicht.`);
  const value = await readVariableField(src.kind, src.field, option, { connections: rt.connections, fetch: rt.fetch });
  return { value, label: option.label };
}

const varHint = (rt: Runtime, v: Pick<VariableEntry, "places" | "stage">): DiscoverHint => hintFor(rt.inventory, v);

export interface SourceValue {
  from: VariableSource;
  /** Gelesener Wert (oeffentlich oder Kennung, nie geheim). */
  value: string;
  resourceLabel: string;
}

/** Vorschau fuer den Anlegedialog: Wert einer Quelle, ohne eine Variable zu kennen. Schreibt nichts. */
export async function previewVariableSource(rt: Runtime, actor: Actor, body: { connection?: unknown; kind?: unknown; resource?: unknown; field?: unknown; params?: unknown; repo?: unknown; stage?: unknown }): Promise<SourceValue> {
  requireHuman(actor, "Quellen lesen");
  const kind = typeof body.kind === "string" ? body.kind : "";
  const from = parseInput(VariableSourceSchema, { connection: body.connection ?? VARIABLE_SOURCES.find((k) => k.kind === kind)?.connection, kind, resource: body.resource, field: body.field });
  const hint = draftHint(rt, typeof body.repo === "string" ? body.repo : undefined, typeof body.stage === "string" ? body.stage : undefined);
  const r = await readSource(rt, from, hint, isRecord(body.params) ? body.params : {});
  return { from, value: r.value, resourceLabel: r.label };
}

export interface SourceProposal {
  variableId: string;
  from: VariableSource;
  current: string | null;
  proposed: string;
  resourceLabel: string;
  changed: boolean;
  applied: boolean;
}

/**
 * Laedt den Sollwert einer Variable aus ihrer Quelle (oder der im Aufruf genannten). Ohne `apply` nur der Vorschlag.
 * Mit `apply: true` (nach der Bestaetigung durch den Menschen) wird er als Sollwert ins Inventar geschrieben und die Quelle
 * gemerkt, ueber denselben Weg wie jede Sollwert-Aenderung (Pruefung auf Geheimnisse inklusive). In GitHub geschrieben
 * wird dadurch nichts: das bleibt "apply" der Variable.
 */
export async function loadVariableFromSource(rt: Runtime, actor: Actor, id: string, body: { connection?: unknown; kind?: unknown; resource?: unknown; field?: unknown; params?: unknown; apply?: unknown; acknowledgedPublic?: unknown }): Promise<SourceProposal> {
  requireHuman(actor, "Variablen aus Quellen laden");
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  const given = body.kind !== undefined || body.resource !== undefined || body.field !== undefined;
  const from = given
    ? parseInput(VariableSourceSchema, { connection: body.connection ?? VARIABLE_SOURCES.find((k) => k.kind === body.kind)?.connection, kind: body.kind ?? v.from?.kind, resource: body.resource ?? v.from?.resource, field: body.field ?? v.from?.field })
    : v.from;
  if (!from) throw new InventoryError("Die Variable hat keine Quelle: kind, resource und field angeben.");
  const r = await readSource(rt, from, varHint(rt, v), isRecord(body.params) ? body.params : {});
  const apply = body.apply === true;
  if (apply) {
    assertPublicValue(v.name, r.value, body.acknowledgedPublic === true);
    rt.inventory.patchVariable(id, { value: r.value, from });
    await rt.inventory.save();
  }
  return { variableId: id, from, current: v.value, proposed: r.value, resourceLabel: r.label, changed: v.value !== r.value, applied: apply };
}

/** Vorschlaege fuer alle Variablen mit Quelle. Schreibt nichts. Fehler einer Variable stoppen die anderen nicht. */
export async function suggestAllVariables(rt: Runtime, actor: Actor): Promise<{ suggestions: (Omit<SourceProposal, "applied"> & { status: "ok" } | { variableId: string; from: VariableSource; status: "error"; error: string })[] }> {
  requireHuman(actor, "Vorschlaege einholen");
  const out: Awaited<ReturnType<typeof suggestAllVariables>>["suggestions"] = [];
  for (const v of rt.inventory.data.variables) {
    if (!v.from) continue;
    try {
      const r = await readSource(rt, v.from, varHint(rt, v));
      out.push({ variableId: v.id, from: v.from, current: v.value, proposed: r.value, resourceLabel: r.label, changed: v.value !== r.value, status: "ok" });
    } catch (err) {
      out.push({ variableId: v.id, from: v.from, status: "error", error: err instanceof Error ? err.message : "Fehler" });
    }
  }
  return { suggestions: out };
}
