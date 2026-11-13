import { SecretValue } from "./secret.js";
import { VaultUnavailableError, type Vault } from "./vault-core.js";

/** Woher ein Zugangs-Token fuer einen Anbieter kommt. Der Wert selbst steht nie in der Konfiguration. */
export type SourceSpec =
  | { type: "env"; name: string }
  | { type: "op"; ref: string }
  | { type: "session" };

export class NotConnectedError extends Error {
  constructor(
    readonly connection: string,
    readonly hint: string,
  ) {
    super(`Verbindung "${connection}" ist nicht hergestellt. ${hint}`);
    this.name = "NotConnectedError";
  }
}

/** Zugangs-Tokens, die der Nutzer fuer diese Sitzung eingegeben hat. Nur im Arbeitsspeicher. */
export class SessionVault {
  readonly #values = new Map<string, SecretValue>();
  readonly #expires = new Map<string, string | null>();

  /** expires = Tag (YYYY-MM-DD), bis zu dem der Token gilt; null = laeuft nie ab. Kein Geheimnis. */
  set(id: string, value: SecretValue | string, expires?: string | null): void {
    this.#values.set(id, typeof value === "string" ? new SecretValue(value) : value);
    if (expires === undefined) this.#expires.delete(id);
    else this.#expires.set(id, expires);
  }

  /** undefined = nicht angegeben, null = laeuft nie ab. */
  expires(id: string): string | null | undefined {
    return this.#expires.get(id);
  }

  get(id: string): SecretValue | undefined {
    return this.#values.get(id);
  }

  has(id: string): boolean {
    return this.#values.has(id);
  }

  delete(id: string): void {
    this.#values.delete(id);
    this.#expires.delete(id);
  }

  clear(): void {
    this.#values.clear();
    this.#expires.clear();
  }

  ids(): string[] {
    return [...this.#values.keys()];
  }
}

export interface ConnectionStatus {
  id: string;
  connected: boolean;
  source: SourceSpec["type"] | "vault" | "none" | "github";
  // "github": team-sync without an own token, served by the GitHub integration.
  hint?: string;
  /** Nur bei Tokens aus der Sitzung: Tag, bis zu dem der Token gilt, null = laeuft nie ab. */
  expires?: string | null;
  /** Nur bei Tokens aus dem Tresor: Kurzform des SHA-256, um den Token wiederzuerkennen. */
  fingerprint?: string;
}

/**
 * What the process hosting the store lets a configuration reach. The local edition supplies both capabilities; a
 * runtime that shares one process between several users omits them, so a configured source cannot read the host.
 */
export interface ConnectionHost {
  readonly label: string;
  /** Value of an environment variable of the host, or undefined. */
  env?(name: string): string | undefined;
  /** Resolves a password-manager reference on the host. Rejects when it cannot be read. */
  readReference?(ref: string): Promise<string>;
}

export interface ConnectionStoreCoreOptions {
  specs?: Record<string, SourceSpec>;
  session?: SessionVault;
  /** Dauerhafter, verschluesselter Tresor (optional). */
  vault?: Vault;
  /** Without a host, `env` and `op` sources are not available. */
  host?: ConnectionHost;
  /** Uhr fuer die Ablaufpruefung (Tests). */
  now?: () => Date;
}

const SOURCE_UNAVAILABLE = "Diese Quelle ist in dieser Umgebung nicht verfuegbar. Im Portal unter Verbindungen ein Token eingeben.";

export class ConnectionStoreCore {
  readonly session: SessionVault;
  readonly vault: Vault | undefined;
  readonly #specs: Record<string, SourceSpec>;
  readonly #host: ConnectionHost | undefined;
  readonly #now: () => Date;

  constructor(options: ConnectionStoreCoreOptions = {}) {
    this.session = options.session ?? new SessionVault();
    this.vault = options.vault;
    this.#specs = options.specs ?? {};
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date());
  }

  /** Ein Datum (YYYY-MM-DD) liegt vor dem heutigen Tag: der Token ist abgelaufen. */
  #expired(expires: string | null | undefined): boolean {
    return typeof expires === "string" && expires < this.#now().toISOString().slice(0, 10);
  }

  /** Reihenfolge: Eingabe dieser Sitzung, Tresor, dann die konfigurierte Quelle. Ein defekter Tresor oder ein abgelaufener Token verhindert den Rueckfall nicht. */
  async token(id: string): Promise<SecretValue> {
    let problem: string | null = null;
    const fromSession = this.session.get(id);
    if (fromSession) {
      if (this.#expired(this.session.expires(id))) problem = "Token abgelaufen";
      else return fromSession;
    }
    if (this.vault) {
      try {
        const fromVault = await this.vault.get(id);
        if (fromVault) {
          const info = await this.vault.info(id).catch(() => null);
          if (this.#expired(info?.expires)) problem = problem ?? "Token abgelaufen";
          else return fromVault;
        }
      } catch (err) {
        if (!(err instanceof VaultUnavailableError)) throw err;
        problem = "Tresor-Eintrag nicht lesbar";
      }
    }
    const spec = this.#specs[id];
    if (!spec || spec.type === "session") {
      throw new NotConnectedError(id, problem ? `${problem}. Im Portal unter Verbindungen ein neues Token eingeben.` : "Im Portal unter Verbindungen ein Token fuer diese Sitzung eingeben.");
    }
    const host = this.#host;
    if (spec.type === "env") {
      if (!host?.env) throw new NotConnectedError(id, SOURCE_UNAVAILABLE);
      const v = host.env(spec.name);
      if (!v) throw new NotConnectedError(id, `Umgebungsvariable ${spec.name} ist nicht gesetzt.`);
      return new SecretValue(v);
    }
    if (!host?.readReference) throw new NotConnectedError(id, SOURCE_UNAVAILABLE);
    try {
      const out = (await host.readReference(spec.ref)).trim();
      if (!out) throw new Error("leer");
      return new SecretValue(out);
    } catch {
      throw new NotConnectedError(id, `1Password-Referenz ${spec.ref} konnte nicht gelesen werden (op angemeldet?).`);
    }
  }

  async status(id: string): Promise<ConnectionStatus> {
    let problem: string | null = null;
    if (this.session.has(id)) {
      const expires = this.session.expires(id);
      if (!this.#expired(expires)) return { id, connected: true, source: "session", ...(expires !== undefined ? { expires } : {}) };
      problem = "Token abgelaufen";
    }
    let stored: Awaited<ReturnType<Vault["info"]>> = null;
    if (this.vault) {
      try {
        stored = await this.vault.info(id);
        if (stored) {
          // info() entschluesselt nichts: ob der Eintrag lesbar ist, zeigt erst get().
          await this.vault.get(id);
        }
      } catch (err) {
        stored = null;
        if (err instanceof VaultUnavailableError) problem = problem ?? "Tresor-Eintrag nicht lesbar";
      }
    }
    if (stored && this.#expired(stored.expires)) {
      problem = problem ?? "Token abgelaufen";
      stored = null;
    }
    if (stored) return { id, connected: true, source: "vault", fingerprint: stored.fingerprint, ...(stored.expires !== undefined ? { expires: stored.expires } : {}) };
    const spec = this.#specs[id];
    if (!spec) return { id, connected: false, source: "none", hint: problem ?? "Nicht konfiguriert" };
    if (spec.type === "env") {
      const host = this.#host;
      if (!host?.env) return { id, connected: false, source: "env", hint: SOURCE_UNAVAILABLE };
      const ok = Boolean(host.env(spec.name));
      return { id, connected: ok, source: "env", ...(ok ? {} : { hint: `${spec.name} fehlt` }) };
    }
    if (spec.type === "session") return { id, connected: false, source: "session", hint: "Token fuer diese Sitzung eingeben" };
    try {
      await this.token(id);
      return { id, connected: true, source: "op" };
    } catch (err) {
      return { id, connected: false, source: "op", hint: err instanceof NotConnectedError ? err.hint : "op fehlgeschlagen" };
    }
  }

  /** Ids of all connections that hold a value (session or vault) or are configured, starting with `prefix`. Internal entries are left out. */
  async ids(prefix = ""): Promise<string[]> {
    const out = new Set<string>(this.session.ids());
    for (const id of Object.keys(this.#specs)) out.add(id);
    if (this.vault) {
      try {
        for (const i of await this.vault.list()) out.add(i.id);
      } catch {
        // An unreadable vault lists nothing; the status of single ids still reports the problem.
      }
    }
    return [...out].filter((id) => id.startsWith(prefix) && !id.endsWith("#label") && !id.endsWith("#meta") && !id.endsWith("#value")).sort();
  }

  async statuses(ids: string[]): Promise<ConnectionStatus[]> {
    return Promise.all(ids.map((id) => this.status(id)));
  }
}
