import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DeskClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

export class DeskApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeskApiError";
  }
}

/** Token fuer den Agenten-Zugang: Umgebung SECRET_DESK_AGENT_TOKEN oder Datei ~/.secret-desk/agent-token. */
export async function resolveAgentToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.SECRET_DESK_AGENT_TOKEN) return env.SECRET_DESK_AGENT_TOKEN.trim();
  try {
    return (await readFile(join(homedir(), ".secret-desk", "agent-token"), "utf8")).trim();
  } catch {
    throw new Error("Kein Agenten-Token gefunden. Portal starten und unter Agenten-Zugang einrichten (Datei ~/.secret-desk/agent-token).");
  }
}

/** Duenner Client fuer die lokale Agenten-Schnittstelle des Portals. Alle Antworten enthalten nur Metadaten. */
export class DeskClient {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: DeskClientOptions = {}) {
    this.#base = (options.baseUrl ?? process.env.SECRET_DESK_URL ?? "http://127.0.0.1:4747").replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.#token ?? (await resolveAgentToken());
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/api/agent${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DeskApiError(0, `Portal nicht erreichbar unter ${this.#base}. Laeuft es? (pnpm dev)`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        /* kein JSON */
      }
      throw new DeskApiError(res.status, message);
    }
    return (text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null) as T;
  }
}
