import { getLocale, translate } from "./i18n";
import { refreshCounts } from "./refresh";
/** Client fuer die Portal-Schnittstelle. Haelt nur die CSRF-Kennung im Speicher, nie einen Wert. */
export interface SessionInfo {
  csrf: string;
  user: string;
  demo: boolean;
  owner: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly hint?: string;
  readonly connection?: string;
  constructor(status: number, message: string, extra: { code?: string; hint?: string; connection?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.connection !== undefined) this.connection = extra.connection;
  }
}

let session: SessionInfo | null = null;
let pending: Promise<SessionInfo> | null = null;

export function resetSessionForTests(): void {
  session = null;
  pending = null;
}

export function currentSession(): SessionInfo | null {
  return session;
}

export async function ensureSession(force = false): Promise<SessionInfo> {
  if (force) {
    session = null;
    pending = null;
  }
  if (session) return session;
  if (!pending) {
    pending = (async () => {
      const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const body = (await safeJson(res)) as { error?: string } | null;
        throw new ApiError(res.status, body?.error ?? translate("common.err.session"));
      }
      const data = (await res.json()) as SessionInfo;
      session = data;
      return data;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function toApiError(status: number, body: unknown): ApiError {
  const b = (body ?? {}) as { error?: unknown; code?: unknown; hint?: unknown; connection?: unknown };
  const message = typeof b.error === "string" && b.error ? b.error : translate("common.err.request", { status });
  return new ApiError(status, message, {
    ...(typeof b.code === "string" ? { code: b.code } : {}),
    ...(typeof b.hint === "string" ? { hint: b.hint } : {}),
    ...(typeof b.connection === "string" ? { connection: b.connection } : {}),
  });
}

export function apiPath(path: string): string {
  return `/api/ui/${path.replace(/^\/+/, "")}`;
}

export async function api<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const s = await ensureSession();
  const headers: Record<string, string> = { "x-secret-desk-csrf": s.csrf, "x-secret-desk-lang": getLocale() };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(apiPath(path), { method, headers, ...(payload !== undefined ? { body: payload } : {}), credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, translate("common.err.unreachable"));
  }
  if (res.status === 401 && !retried) {
    await ensureSession(true);
    return api<T>(method, path, body, true);
  }
  const data = await safeJson(res);
  if (!res.ok) throw toApiError(res.status, data);
  if (method !== "GET") refreshCounts();
  return data as T;
}

export const enc = encodeURIComponent;

export function evidenceSvgUrl(secretId: string, reportId: string): string {
  return `/api/ui/evidence/${enc(secretId)}/${enc(reportId)}/svg`;
}

export function attachmentUrl(secretId: string, reportId: string, file: string): string {
  return `/api/ui/evidence/${enc(secretId)}/${enc(reportId)}/attachments/${enc(file)}`;
}
