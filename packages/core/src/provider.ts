import type { SecretValue } from "./secret.js";
import type { ConnectionStore } from "./connections.js";
import type { FetchLike } from "./github.js";
import type { SecretEntry, Stage } from "./types.js";

export interface IssueContext {
  secret: SecretEntry;
  params: Record<string, unknown>;
  stage: Stage;
  connections: ConnectionStore;
  fetch: FetchLike;
  now: Date;
  /** Name, unter dem der Token beim Anbieter erscheint. */
  label: string;
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
}

export interface ProviderGuide {
  url: string;
  steps: string[];
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
