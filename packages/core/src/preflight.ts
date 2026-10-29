import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import type { InventoryStore } from "./inventory.js";
import {
  PreflightError,
  UnknownDiscoverKindError,
  effectiveParams,
  integrationDefaultsOf,
  markSuggestions,
  validateEntryParams,
  type DiscoverHint,
  type MapMismatch,
  type DiscoveredOption,
  type ParamProblem,
  type PreflightFinding,
} from "./params.js";
import { NotConnectedError } from "./connections.js";
import type { Provider, ProviderRegistry } from "./provider.js";
import { stageKind } from "./stages.js";
import type { SecretEntry } from "./types.js";

export interface ParamsDeps {
  inventory: InventoryStore;
  providers: ProviderRegistry;
  connections: ConnectionStore;
  fetch?: FetchLike;
  providerConfig?: ProviderConfig;
}

/** Parameter eines Eintrags: Wirksame Werte (mit Standardwerten der Integration) und Befunde. Rein, ohne Netzaufruf. */
export function entryParamsState(inventory: InventoryStore, provider: Provider | undefined, secret: Pick<SecretEntry, "params">): { effective: Record<string, unknown>; defaults: Record<string, unknown>; problems: ParamProblem[] } {
  const defaults = provider ? (integrationDefaultsOf(inventory, provider) ?? {}) : {};
  if (!provider) return { effective: secret.params, defaults, problems: [] };
  return { effective: effectiveParams(provider, secret.params, defaults), defaults, problems: validateEntryParams(provider, secret, defaults) };
}

export interface EntryPreflight {
  status: "ok" | "warn" | "fail" | "skipped" | "not-connected";
  /** Warum uebersprungen: "params" (Pflichtparameter fehlen), "none" (der Anbieter hat keinen Vorabcheck), "not-connected". */
  skippedReason?: "params" | "none" | "not-connected";
  resource: string | null;
  findings: PreflightFinding[];
  connection?: string;
  hint?: string;
}

const worst = (f: PreflightFinding[]): "ok" | "warn" | "fail" => (f.some((x) => x.level === "fail") ? "fail" : f.some((x) => x.level === "warn") ? "warn" : "ok");

/**
 * Lesender Vorabcheck eines Eintrags. Ohne vollstaendige Parameter laeuft kein Netzaufruf (Status skipped/params).
 * `rethrowNotConnected`: Beim Ausstellen soll die fehlende Verbindung den gewohnten Fehler liefern.
 */
export async function preflightEntry(secret: SecretEntry, deps: ParamsDeps, options: { rethrowNotConnected?: boolean } = {}): Promise<EntryPreflight> {
  const provider = deps.providers.get(secret.provider);
  if (!provider?.preflight) return { status: "skipped", skippedReason: "none", resource: null, findings: [] };
  const state = entryParamsState(deps.inventory, provider, secret);
  if (state.problems.length > 0) return { status: "skipped", skippedReason: "params", resource: null, findings: [] };
  try {
    const r = await provider.preflight({
      secret,
      params: state.effective,
      stage: secret.stage,
      stageKind: stageKind(deps.inventory.stages, secret.stage),
      connections: deps.connections,
      fetch: deps.fetch ?? fetch,
      ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}),
    });
    return { status: worst(r.findings), resource: r.resource, findings: r.findings };
  } catch (err) {
    if (err instanceof NotConnectedError) {
      if (options.rethrowNotConnected) throw err;
      return { status: "not-connected", skippedReason: "not-connected", resource: null, findings: [], connection: err.connection, hint: err.hint };
    }
    throw err;
  }
}

/** Wirft PreflightError bei sicheren Fehlbefunden (level fail). Warnungen blockieren nicht. */
export function assertPreflight(result: EntryPreflight): void {
  if (result.findings.some((f) => f.level === "fail")) throw new PreflightError(result.findings);
}

export interface DiscoveryResult {
  status: "ok" | "not-connected" | "needs-params" | "error" | "unsupported";
  options: DiscoveredOption[];
  suggested: string | number | null;
  /** Die Zuordnung (resourceMap) nennt eine Ressource, die der Anbieter nicht kennt. */
  mapMismatch?: MapMismatch;
  error?: string;
  hint?: string;
  connection?: string;
}

/** Hinweis fuer Vorschlaege aus einem Eintrag: Repositories der Ziele, Stage und deren Art. */
export function hintFor(inventory: InventoryStore, secret: Pick<SecretEntry, "places" | "stage">): DiscoverHint {
  return { repos: [...new Set(secret.places.map((p) => p.repo))], stage: secret.stage, stageKind: stageKind(inventory.stages, secret.stage), ...(inventory.data.resourceMap ? { resourceMap: inventory.data.resourceMap } : {}) };
}

/** Entdeckung mit Vorschlag. Fehler werden zum Status, nicht zur Ausnahme (ausser Programmierfehlern). */
export async function discoverResources(provider: Provider, kind: string, deps: Omit<ParamsDeps, "providers" | "inventory">, hint: DiscoverHint, params: Record<string, unknown> = {}): Promise<DiscoveryResult> {
  if (!provider.discover) return { status: "unsupported", options: [], suggested: null };
  try {
    const found = await provider.discover(kind, { connections: deps.connections, fetch: deps.fetch ?? fetch, params, hint, ...(deps.providerConfig ? { providerConfig: deps.providerConfig } : {}) });
    const marked = markSuggestions(kind, found, hint);
    return { status: "ok", ...marked };
  } catch (err) {
    if (err instanceof NotConnectedError) return { status: "not-connected", options: [], suggested: null, connection: err.connection, hint: err.hint, error: err.message };
    if (err instanceof UnknownDiscoverKindError) return { status: "unsupported", options: [], suggested: null, error: err.message };
    if (err instanceof Error && err.name === "ParamsInvalidError") return { status: "needs-params", options: [], suggested: null, error: err.message };
    if (err instanceof Error && err.name === "ProviderError") return { status: "error", options: [], suggested: null, error: err.message };
    throw err;
  }
}
