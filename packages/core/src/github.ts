import { createSign } from "node:crypto";
import sodium from "libsodium-wrappers";
import { SecretValue } from "./secret.js";
import { placeKey, type LiveSnapshot } from "./status.js";
import type { Place } from "./types.js";

export type FetchLike = typeof fetch;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Die Abfrage war zu gross fuer die Seitengrenze: das Ergebnis waere unvollstaendig und darf nicht als vollstaendig gelten. */
export class GitHubTruncatedError extends GitHubError {
  constructor(what: string, limit: number) {
    super(0, `GitHub-Liste ${what} hat mehr als ${limit} Eintraege: die Abfrage waere unvollstaendig und wurde abgebrochen.`);
    this.name = "GitHubTruncatedError";
  }
}

/** Ein Ziel, das beim Abgleich nicht gelesen werden konnte (nicht: nicht vorhanden, das ist 404). */
export interface SnapshotError {
  repo: string;
  scope: GitHubTarget["scope"];
  environment?: string;
  status: number;
  message: string;
}

export interface SnapshotResult {
  snapshot: LiveSnapshot;
  /** Ziele mit Fehler (403, 429, 5xx, Netz ...). Fuer sie ist nichts ueber "fehlt" bekannt. */
  errors: SnapshotError[];
}

export interface GitHubTarget {
  owner: string;
  repo: string;
  scope: "repository" | "environment" | "organization";
  environment?: string;
}

export type TokenProvider = () => Promise<SecretValue>;

export function placeToTarget(owner: string, place: Place): GitHubTarget {
  return { owner, repo: place.repo, scope: place.scope, ...(place.environment ? { environment: place.environment } : {}) };
}

/** Verschluesselt einen Wert so, wie GitHub es verlangt (libsodium sealed box, base64). */
export async function sealForGitHub(publicKeyBase64: string, plaintext: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

function secretsPath(t: GitHubTarget): string {
  if (t.scope === "organization") return `/orgs/${enc(t.owner)}/actions/secrets`;
  if (t.scope === "environment") {
    if (!t.environment) throw new GitHubError(0, "environment fehlt");
    return `/repos/${enc(t.owner)}/${enc(t.repo)}/environments/${enc(t.environment)}/secrets`;
  }
  return `/repos/${enc(t.owner)}/${enc(t.repo)}/actions/secrets`;
}

function variablesPath(t: GitHubTarget): string {
  return secretsPath(t).replace(/\/secrets$/, "/variables");
}

const enc = encodeURIComponent;

export interface GitHubClientOptions {
  auth: TokenProvider;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Wartefunktion fuer die einmalige Wiederholung nach 429/Retry-After (Tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Laengste Wartezeit, die fuer eine Wiederholung akzeptiert wird (Standard 10 s). */
  maxRetryWaitMs?: number;
}

export interface RemoteVariable {
  name: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteSecret {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteRepo {
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
}

export class GitHubClient {
  readonly #auth: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #base: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetryWaitMs: number;

  constructor(options: GitHubClientOptions) {
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? fetch;
    this.#base = options.baseUrl ?? "https://api.github.com";
  }

  async listSecrets(target: GitHubTarget): Promise<RemoteSecret[]> {
    const out: RemoteSecret[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const res = await this.#request("GET", `${secretsPath(target)}?per_page=100&page=${page}`);
      const body = (await res.json()) as { secrets?: { name: string; created_at: string; updated_at: string }[] };
      const items = body.secrets ?? [];
      out.push(...items.map((s) => ({ name: s.name, createdAt: s.created_at, updatedAt: s.updated_at })));
      if (items.length < 100) break;
      if (page === 20) throw new GitHubTruncatedError("Secrets", 2000);
    }
    return out;
  }

  /** Repositories des Eigentuemers (Organisation, sonst Nutzer). Nur Metadaten, bis zu 500. */
  async listRepos(owner: string): Promise<RemoteRepo[]> {
    try {
      return await this.#repoPages(`/orgs/${enc(owner)}/repos`);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err;
    }
    return this.#repoPages(`/users/${enc(owner)}/repos`);
  }

  async #repoPages(path: string): Promise<RemoteRepo[]> {
    type Item = { name: string; private?: boolean; archived?: boolean; default_branch?: string | null; pushed_at?: string | null };
    const out: RemoteRepo[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const res = await this.#request("GET", `${path}?per_page=100&page=${page}`);
      const items = (await res.json()) as Item[];
      out.push(...items.map((r) => ({ name: r.name, private: r.private === true, archived: r.archived === true, defaultBranch: r.default_branch ?? null, pushedAt: r.pushed_at ?? null })));
      if (items.length < 100) break;
    }
    return out;
  }

  async publicKey(target: GitHubTarget): Promise<{ keyId: string; key: string }> {
    const res = await this.#request("GET", `${secretsPath(target)}/public-key`);
    const body = (await res.json()) as { key_id: string; key: string };
    return { keyId: body.key_id, key: body.key };
  }

  /** Schreibt einen bereits verschluesselten Wert (Browser-Flow: der Server sieht nie Klartext). */
  async putEncrypted(target: GitHubTarget, name: string, encryptedValue: string, keyId: string): Promise<"created" | "updated"> {
    const body: Record<string, unknown> = { encrypted_value: encryptedValue, key_id: keyId };
    if (target.scope === "organization") body.visibility = "selected";
    const res = await this.#request("PUT", `${secretsPath(target)}/${enc(name)}`, body);
    return res.status === 201 ? "created" : "updated";
  }

  /** Verschluesselt im Speicher und schreibt. Der Klartext verlaesst diese Funktion nicht. */
  async putSecret(target: GitHubTarget, name: string, value: SecretValue): Promise<"created" | "updated"> {
    const { keyId, key } = await this.publicKey(target);
    const encrypted = await sealForGitHub(key, value.reveal());
    return this.putEncrypted(target, name, encrypted, keyId);
  }

  /** Variablen sind lesbar: Name und Wert. */
  async listVariables(target: GitHubTarget): Promise<RemoteVariable[]> {
    const out: RemoteVariable[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const res = await this.#request("GET", `${variablesPath(target)}?per_page=30&page=${page}`);
      const body = (await res.json()) as { variables?: { name: string; value: string; created_at: string; updated_at: string }[] };
      const items = body.variables ?? [];
      out.push(...items.map((v) => ({ name: v.name, value: v.value, createdAt: v.created_at, updatedAt: v.updated_at })));
      if (items.length < 30) break;
      if (page === 20) throw new GitHubTruncatedError("Variablen", 600);
    }
    return out;
  }

  /** Legt eine Variable an oder aendert sie. */
  async putVariable(target: GitHubTarget, name: string, value: string): Promise<"created" | "updated"> {
    try {
      await this.#request("PATCH", `${variablesPath(target)}/${enc(name)}`, { name, value });
      return "updated";
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err;
    }
    const body: Record<string, unknown> = { name, value };
    if (target.scope === "organization") body.visibility = "selected";
    await this.#request("POST", variablesPath(target), body);
    return "created";
  }

  async deleteVariable(target: GitHubTarget, name: string): Promise<void> {
    await this.#request("DELETE", `${variablesPath(target)}/${enc(name)}`);
  }

  async deleteSecret(target: GitHubTarget, name: string): Promise<void> {
    await this.#request("DELETE", `${secretsPath(target)}/${enc(name)}`);
  }

  async listEnvironments(owner: string, repo: string): Promise<string[]> {
    const res = await this.#request("GET", `/repos/${enc(owner)}/${enc(repo)}/environments?per_page=100`);
    const body = (await res.json()) as { environments?: { name: string }[] };
    return (body.environments ?? []).map((e) => e.name);
  }

  /** Wie snapshotDetailed, aber nur der Stand. Ein Ziel mit Fehler fehlt dann einfach (siehe snapshotDetailed). */
  async snapshot(owner: string, places: Place[]): Promise<LiveSnapshot> {
    return (await this.snapshotDetailed(owner, places)).snapshot;
  }

  /**
   * Liest fuer alle uebergebenen Ziele die vorhandenen Secret-Namen (keine Werte). Ein Ziel mit 403/429/5xx kippt nicht den
   * ganzen Abgleich: Es erscheint in `errors`, die uebrigen liefern ihr Ergebnis. 404 heisst "Ziel gibt es nicht" und ist kein Fehler.
   */
  async snapshotDetailed(owner: string, places: Place[]): Promise<SnapshotResult> {
    const snapshot: LiveSnapshot = new Map();
    const errors: SnapshotError[] = [];
    const seen = new Set<string>();
    for (const place of places) {
      const target = placeToTarget(owner, place);
      const id = `${target.repo}/${target.scope}/${target.environment ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        for (const s of await this.listSecrets(target)) {
          snapshot.set(placeKey(owner, { ...place, name: s.name }, s.name), { name: s.name, updatedAt: s.updatedAt });
        }
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) continue;
        errors.push({ repo: target.repo, scope: target.scope, ...(target.environment ? { environment: target.environment } : {}), status: err instanceof GitHubError ? err.status : 0, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { snapshot, errors };
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    let res = await this.#send(method, path, body);
    if (!res.ok && (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))) {
      // Einmal wiederholen, aber nur bei kurzer, ausdruecklich genannter Wartezeit.
      const header = res.headers.get("retry-after");
      const retryAfter = header === null || header.trim() === "" ? Number.NaN : Number(header);
      if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter * 1000 <= this.#maxRetryWaitMs) {
        await this.#sleep(retryAfter * 1000);
        res = await this.#send(method, path, body);
      }
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const parsed = (await res.json()) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        /* keine JSON-Antwort */
      }
      throw new GitHubError(res.status, `GitHub ${method} ${path.split("?")[0]} -> ${res.status}: ${detail}`);
    }
    return res;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = (await this.#auth()).reveal();
    return this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "secret-desk",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}

/** Ein Personal Access Token, nur im Speicher. */
export function patProvider(value: SecretValue): TokenProvider {
  return async () => value;
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: SecretValue;
  /** Owner (Organisation oder Nutzer), auf dem die App installiert ist. */
  owner: string;
  /** Token auf diese Repositories beschraenken (Namen ohne Owner). */
  repositories?: string[];
  permissions?: Record<string, "read" | "write">;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => Date;
}

/** Erzeugt bei Bedarf ein Installations-Token (eine Stunde gueltig) und cached es bis kurz vor Ablauf. */
export function githubAppProvider(options: GitHubAppOptions): TokenProvider {
  const f = options.fetch ?? fetch;
  const base = options.baseUrl ?? "https://api.github.com";
  const now = options.now ?? (() => new Date());
  let cached: { token: SecretValue; expiresAt: number } | null = null;

  const jwt = (): string => {
    const t = Math.floor(now().getTime() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const data = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: t - 60, exp: t + 540, iss: options.appId })}`;
    const signature = createSign("RSA-SHA256").update(data).sign(options.privateKey.reveal()).toString("base64url");
    return `${data}.${signature}`;
  };

  const call = async (method: string, path: string, bearer: string, body?: unknown): Promise<Response> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${bearer}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "secret-desk",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new GitHubError(res.status, `GitHub App ${method} ${path} -> ${res.status}`);
    return res;
  };

  return async () => {
    if (cached && cached.expiresAt - now().getTime() > 60_000) return cached.token;
    const app = jwt();
    const installations = (await (await call("GET", "/app/installations?per_page=100", app)).json()) as { id: number; account?: { login?: string } }[];
    const inst = installations.find((i) => i.account?.login?.toLowerCase() === options.owner.toLowerCase());
    if (!inst) throw new GitHubError(404, `GitHub App ist auf ${options.owner} nicht installiert`);
    const body: Record<string, unknown> = {};
    if (options.repositories?.length) body.repositories = options.repositories;
    if (options.permissions) body.permissions = options.permissions;
    const created = (await (await call("POST", `/app/installations/${inst.id}/access_tokens`, app, body)).json()) as { token: string; expires_at: string };
    cached = { token: new SecretValue(created.token), expiresAt: Date.parse(created.expires_at) };
    return cached.token;
  };
}
