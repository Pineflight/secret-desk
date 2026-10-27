import { execFile } from "node:child_process";
import { SecretValue } from "./secret.js";
import { VaultUnavailableError, type SecretVault } from "./vault.js";

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
  source: SourceSpec["type"] | "vault" | "none";
  hint?: string;
  /** Nur bei Tokens aus der Sitzung: Tag, bis zu dem der Token gilt, null = laeuft nie ab. */
  expires?: string | null;
  /** Nur bei Tokens aus dem Tresor: Kurzform des SHA-256, um den Token wiederzuerkennen. */
  fingerprint?: string;
}

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export interface ConnectionStoreOptions {
  specs?: Record<string, SourceSpec>;
  session?: SessionVault;
  /** Dauerhafter, verschluesselter Tresor (optional). */
  vault?: SecretVault;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  /** Uhr fuer die Ablaufpruefung (Tests). */
  now?: () => Date;
}

export class ConnectionStore {
  readonly session: SessionVault;
  readonly vault: SecretVault | undefined;
  readonly #specs: Record<string, SourceSpec>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #exec: ExecFn;
  readonly #now: () => Date;

  constructor(options: ConnectionStoreOptions = {}) {
    this.session = options.session ?? new SessionVault();
    this.vault = options.vault;
    this.#specs = options.specs ?? {};
    this.#env = options.env ?? process.env;
    this.#exec = options.exec ?? defaultExec;
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
    if (spec.type === "env") {
      const v = this.#env[spec.name];
      if (!v) throw new NotConnectedError(id, `Umgebungsvariable ${spec.name} ist nicht gesetzt.`);
      return new SecretValue(v);
    }
    try {
      const out = (await this.#exec("op", ["read", spec.ref])).trim();
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
    let stored: Awaited<ReturnType<SecretVault["info"]>> = null;
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
      const ok = Boolean(this.#env[spec.name]);
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

  async statuses(ids: string[]): Promise<ConnectionStatus[]> {
    return Promise.all(ids.map((id) => this.status(id)));
  }
}
