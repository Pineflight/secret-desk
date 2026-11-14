import type { FetchLike, TokenProvider } from "./github-core.js";
import type { SecretValue } from "./secret.js";
import type { WorkerPlace } from "./types.js";

/**
 * Secrets of a deployed Cloudflare Worker (what `wrangler secret put NAME --env staging` writes), through the Cloudflare API
 * with the token of the `cloudflare` connection (permission "Workers Scripts Write"; reading the names needs "Workers Scripts Read",
 * which "Write" includes). Only secrets, never Worker variables. The API returns names only: a value is never read back, and
 * there is no delete here.
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Id of the connection whose token writes Worker secrets. */
export const CLOUDFLARE_CONNECTION = "cloudflare";

export class WorkerSecretsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkerSecretsError";
  }
}

export interface WorkerSecretsClientOptions {
  auth: TokenProvider;
  fetch?: FetchLike;
  baseUrl?: string;
}

/** One Worker the connection token can see (metadata only). */
export interface RemoteWorkerScript {
  name: string;
}

const enc = encodeURIComponent;

/** Unique key of the Worker a place points at: listings are read once per Worker. */
export const workerKey = (p: Pick<WorkerPlace, "accountId" | "script">): string => `${p.accountId}/${p.script}`;

export class WorkerSecretsClient {
  readonly #auth: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #base: string;

  constructor(options: WorkerSecretsClientOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? fetch;
    this.#base = options.baseUrl ?? CLOUDFLARE_API_BASE;
  }

  /** Names of the secrets on the Worker. A missing Worker (404) or a token without the right (401/403) throws with the status. */
  async listSecretNames(place: Pick<WorkerPlace, "accountId" | "script">): Promise<string[]> {
    const res = await this.#request("GET", `${this.#scriptPath(place)}/secrets`);
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    if (!body || !Array.isArray(body.result)) throw new WorkerSecretsError(res.status, "Cloudflare answered with something unexpected for the list of Worker secrets.");
    return body.result.flatMap((r: unknown) => (r !== null && typeof r === "object" && typeof (r as { name?: unknown }).name === "string" ? [(r as { name: string }).name] : []));
  }

  /** Reachability with write access to the extent the API allows without writing: the list of names. */
  async check(place: Pick<WorkerPlace, "accountId" | "script">): Promise<void> {
    await this.listSecretNames(place);
  }

  /**
   * Sets a secret on the Worker (replaces an existing one of the same name). The API does not say whether the name existed, so the
   * outcome comes from the name list read right before; if that read fails the outcome is "updated" (the write still happens).
   */
  async putSecret(place: Pick<WorkerPlace, "accountId" | "script">, name: string, value: SecretValue): Promise<"created" | "updated"> {
    let before: Set<string> | null = null;
    try {
      before = new Set(await this.listSecretNames(place));
    } catch {
      before = null;
    }
    await this.#request("PUT", `${this.#scriptPath(place)}/secrets`, { name, text: value.reveal(), type: "secret_text" });
    return before !== null && !before.has(name) ? "created" : "updated";
  }

  /** All Workers of the account (for the place editor). */
  async listScripts(accountId: string): Promise<RemoteWorkerScript[]> {
    const res = await this.#request("GET", `/accounts/${enc(accountId)}/workers/scripts`);
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
    if (!body || !Array.isArray(body.result)) throw new WorkerSecretsError(res.status, "Cloudflare answered with something unexpected for the list of Workers.");
    return body.result.flatMap((r: unknown) => (r !== null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" ? [{ name: (r as { id: string }).id }] : []));
  }

  #scriptPath(place: Pick<WorkerPlace, "accountId" | "script">): string {
    return `/accounts/${enc(place.accountId)}/workers/scripts/${enc(place.script)}`;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = (await this.#auth()).reveal();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "secret-desk",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new WorkerSecretsError(res.status, await failureText(method, path, res));
    return res;
  }
}

/** Fixed, status-based text for a failed Cloudflare call. */
function statusText(status: number): string {
  if (status === 401) return "Authentifizierung fehlgeschlagen; der Token der Cloudflare-Verbindung ist ungueltig oder abgelaufen und braucht das Recht Workers Scripts Write";
  if (status === 403) return "Keine Berechtigung; der Token der Cloudflare-Verbindung braucht das Recht Workers Scripts Write";
  if (status === 404) return "Worker nicht gefunden (Konto und Name pruefen)";
  if (status === 429) return "Zu viele Anfragen (Rate Limit); spaeter erneut versuchen";
  if (status >= 500) return "Cloudflare meldet einen Serverfehler; spaeter erneut versuchen";
  return "Anfrage von Cloudflare abgelehnt";
}

/**
 * Method, path, status, a fixed text per status class and the numeric Cloudflare error codes. Never the upstream message text
 * (it is not ours to copy into results), never the request body (it may hold a value) and never the token.
 */
async function failureText(method: string, path: string, res: Response): Promise<string> {
  let codes: number[] = [];
  try {
    const parsed = (await res.json()) as { errors?: { code?: unknown }[] };
    codes = (parsed.errors ?? []).flatMap((e) => (typeof e.code === "number" && Number.isInteger(e.code) ? [e.code] : [])).slice(0, 10);
  } catch {
    /* no JSON answer */
  }
  return `Cloudflare ${method} ${path.split("?")[0]} -> ${res.status}: ${statusText(res.status)}${codes.length > 0 ? ` (Cloudflare-Code ${codes.join(", ")})` : ""}`;
}
