import type { SecretValue } from "./secret.js";
import type { ConnectionStore } from "./connections.js";
import type { ProviderConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import type { StageKind } from "./stages.js";
import type { SecretEntry, Stage } from "./types.js";
import type { Check } from "./verification.js";

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

export interface IssuedSecret {
  value: SecretValue;
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
  /** Verbindung, die der Anbieter braucht (zum Beispiel cloudflare). */
  connection?: string;
  guide?: ProviderGuide;
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
