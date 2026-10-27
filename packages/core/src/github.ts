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

export class GitHubClient {
  readonly #auth: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(options: GitHubClientOptions) {
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

  /** Liest fuer alle uebergebenen Ziele die vorhandenen Secret-Namen (keine Werte). */
  async snapshot(owner: string, places: Place[]): Promise<LiveSnapshot> {
    const snapshot: LiveSnapshot = new Map();
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
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
      }
    }
    return snapshot;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = (await this.#auth()).reveal();
    const res = await this.#fetch(`${this.#base}${path}`, {
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
