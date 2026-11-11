import type { SecretValue } from "./secret.js";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import type { StageKind } from "./stages.js";
import type { SecretEntry, Stage } from "./types.js";
import type { Check } from "./verification.js";
import type { DiscoverHint, DiscoveredOption, ParamSpec, PreflightResult } from "./params.js";

export interface IssueContext {
  secret: SecretEntry;
  params: Record<string, unknown>;
  stage: Stage;
  /** Art der Stage (live/test/dev/shared). Fehlt sie, gilt die Art der Standard-Stage gleichen Namens. */
  stageKind?: StageKind;
  connections: ConnectionStore;
  fetch: FetchLike;
  now: Date;
  /** Name, unter dem der Token beim Anbieter erscheint. */
  label: string;
  /** Einstellungen aus der Konfiguration (nicht aus dem Inventar): zum Beispiel erlaubte Hosts. */
  providerConfig?: ProviderConfig;
}

/**
 * A value that comes out of the same provider answer as the main value but belongs to another inventory entry
 * (for example the client id next to the client secret of an Access service token). It is shown in the review,
 * written to the entry's places on confirm and discarded together with the main value.
 */
export interface CompanionValue {
  /** Inventory id of the receiving entry. Must be named in the provider's `companionParams`. */
  entryId: string;
  value: SecretValue;
  /**
   * What the receiving entry must be. `secret` (default) writes a secret and needs a secret entry; `variable` writes a
   * public value (for example the public half of a key pair) to a variable entry. A mismatch writes nothing.
   */
  kind?: "secret" | "variable";
}

export interface IssuedSecret {
  value: SecretValue;
  /** Further values from the same issuance for other entries. Only entries the provider names in params may receive one. */
  companions?: CompanionValue[];
  /** ISO-Zeitpunkt oder Datum, wann der Wert ablaeuft. */
  expiresAt?: string | null;
  /** Kennung beim Anbieter, damit der alte Wert spaeter widerrufen werden kann. */
  externalId?: string;
}

export interface RevokeContext {
  externalId: string;
  secret: SecretEntry;
  params: Record<string, unknown>;
  connections: ConnectionStore;
  fetch: FetchLike;
  providerConfig?: ProviderConfig;
}

export interface VerifyContext {
  secret: SecretEntry;
  params: Record<string, unknown>;
  stage: Stage;
  /** Art der Stage (live/test/dev/shared). Fehlt sie, gilt die Art der Standard-Stage gleichen Namens. */
  stageKind?: StageKind;
  /** Der soeben ausgestellte oder eingefuegte Wert. Nur zum Pruefen, nie speichern oder ausgeben. */
  value: SecretValue;
  externalId?: string;
  expiresAt?: string | null;
  connections: ConnectionStore;
  fetch: FetchLike;
  now: Date;
  providerConfig?: ProviderConfig;
}

/** Kontext fuer lesende Abfragen beim Anbieter (Entdeckung, Vorabcheck). Nur das gespeicherte Token der Integration, nie Schreibzugriffe. */
export interface DiscoverContext {
  connections: ConnectionStore;
  fetch: FetchLike;
  /** Bereits gewaehlte Parameter (zum Beispiel accountId, um Zonen einzuschraenken). */
  params: Record<string, unknown>;
  hint: DiscoverHint;
  providerConfig?: ProviderConfig;
}

export interface PreflightContext {
  secret: SecretEntry;
  /** Wirksame Parameter (Eintrag plus Standardwerte der Integration). */
  params: Record<string, unknown>;
  stage: Stage;
  stageKind?: StageKind;
  connections: ConnectionStore;
  fetch: FetchLike;
  providerConfig?: ProviderConfig;
}

export interface ProviderGuide {
  url: string;
  steps: string[];
  /** Seite des Anbieters mit bereits vorausgefuellten Feldern, soweit dieser es per Link erlaubt. */
  openUrl?(secret: SecretEntry, ctx: { owner: string; now: Date }): string;
}

export interface Provider {
  id: string;
  label: string;
  /** automatic = erzeugt selbst per API, manual = Wert wird von Hand eingefuegt. */
  kind: "automatic" | "manual";
  /**
   * The provider only reads a value the service already shows (keys that cannot be created or rotated through the portal). The
   * portal says "read from the provider" and offers "read again" instead of "generate new value"; nothing is created or revoked,
   * and the value does not expire through this provider.
   */
  readOnly?: boolean;
  /** Verbindung, die der Anbieter braucht (zum Beispiel cloudflare). */
  connection?: string;
  guide?: ProviderGuide;
  /** Parameter, die ein Eintrag dieses Anbieters unter `params` braucht (fehlt = keine). */
  params?: ParamSpec[];
  /** The `ttlDays` values the provider can honour (fehlt = any). A renewal of an entry with another value is `params_invalid`. */
  ttlDaysOptions?: readonly number[];
  /** Listet Ressourcen der verbundenen Integration (Konten, Projekte, Zonen ...). Nur lesend. Unbekannte Art: UnknownDiscoverKindError. */
  discover?(kind: string, ctx: DiscoverContext): Promise<DiscoveredOption[]>;
  /** Keys of `params` whose value is the inventory id of an entry that may receive a companion value from `issue`. */
  companionParams?: string[];
  /** Further discover kinds this provider answers that no parameter uses, for example sources of variables. */
  discoverKinds?: string[];
  /** Lesender Vorabcheck: gehoert die gewaehlte Ressource zur Integration? Laeuft vor dem Ausstellen. */
  preflight?(ctx: PreflightContext): Promise<PreflightResult>;
  /** Wie viele Stunden der Anbieter fuer den Wert maximal vorsieht, falls bekannt. */
  issue?(ctx: IssueContext): Promise<IssuedSecret>;
  /** Eigene Pruefungen nach dem Ausstellen (Funktionstest, Rechte, Ablauf). Liefert nur Befunde, nie Werte. */
  verify?(ctx: VerifyContext): Promise<Check[]>;
  /** Punkte, die der Mensch im Anbieter-Dashboard oder auf dem Beleg selbst beurteilt. */
  reviewChecklist?(secret: SecretEntry, ctx?: { stageKind: StageKind }): string[];
  revoke?(ctx: RevokeContext): Promise<void>;
}

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  register(provider: Provider): this {
    this.#providers.set(provider.id, provider);
    return this;
  }

  get(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  list(): Provider[] {
    return [...this.#providers.values()];
  }
}

/** Fallback fuer Anbieter ohne API. */
export const MANUAL_PROVIDER: Provider = {
  id: "manual",
  label: "Von Hand",
  kind: "manual",
};
