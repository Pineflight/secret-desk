import { execFile } from "node:child_process";
import { SecretValue } from "./secret.js";

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
  source: SourceSpec["type"] | "none";
  hint?: string;
  /** Nur bei Tokens aus der Sitzung: Tag, bis zu dem der Token gilt, null = laeuft nie ab. */
  expires?: string | null;
}

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export interface ConnectionStoreOptions {
  specs?: Record<string, SourceSpec>;
  session?: SessionVault;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
}

export class ConnectionStore {
  readonly session: SessionVault;
  readonly #specs: Record<string, SourceSpec>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #exec: ExecFn;

  constructor(options: ConnectionStoreOptions = {}) {
    this.session = options.session ?? new SessionVault();
    this.#specs = options.specs ?? {};
    this.#env = options.env ?? process.env;
    this.#exec = options.exec ?? defaultExec;
  }

  /** Reihenfolge: Eingabe dieser Sitzung, dann die konfigurierte Quelle. */
  async token(id: string): Promise<SecretValue> {
    const fromSession = this.session.get(id);
    if (fromSession) return fromSession;
    const spec = this.#specs[id];
    if (!spec || spec.type === "session") {
      throw new NotConnectedError(id, "Im Portal unter Verbindungen ein Token fuer diese Sitzung eingeben.");
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
    if (this.session.has(id)) {
      const expires = this.session.expires(id);
      return { id, connected: true, source: "session", ...(expires !== undefined ? { expires } : {}) };
    }
    const spec = this.#specs[id];
    if (!spec) return { id, connected: false, source: "none", hint: "Nicht konfiguriert" };
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
