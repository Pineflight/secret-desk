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
  /** Bei params_invalid: Befunde je Parameter. Bei preflight_failed: Befunde des Vorabchecks. */
  readonly problems?: unknown[];
  readonly findings?: unknown[];
  constructor(status: number, message: string, extra: { code?: string; hint?: string; connection?: string; problems?: unknown[]; findings?: unknown[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.connection !== undefined) this.connection = extra.connection;
    if (extra.problems !== undefined) this.problems = extra.problems;
    if (extra.findings !== undefined) this.findings = extra.findings;
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

/** Liest ?launch= aus der Adresse und entfernt es sofort aus der Adressleiste. Wird nie gespeichert. */
function takeLaunchSecret(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  try {
    const url = new URL(window.location.href);
    const launch = url.searchParams.get("launch");
    if (!launch) return null;
    url.searchParams.delete("launch");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return launch;
  } catch {
    return null;
  }
}

/** launch: Startgeheimnis aus dem Eingabefeld der Startseite; sonst wird ?launch= aus der Adresse gelesen. */
export async function ensureSession(force = false, launchInput?: string): Promise<SessionInfo> {
  if (force) {
    session = null;
    pending = null;
  }
  if (session) return session;
  if (!pending) {
    pending = (async () => {
      const launch = launchInput ?? takeLaunchSecret();
      const res = await fetch("/api/session", { credentials: "same-origin", cache: "no-store", ...(launch ? { headers: { "x-secret-desk-launch": launch } } : {}) });
      if (!res.ok) {
        const body = (await safeJson(res)) as { error?: string; code?: string } | null;
        if (res.status === 401 && body?.code === "launch-required") throw new ApiError(401, translate("common.err.launch"), { code: "launch-required" });
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
  const b = (body ?? {}) as { error?: unknown; code?: unknown; hint?: unknown; connection?: unknown; problems?: unknown; findings?: unknown };
  const message = typeof b.error === "string" && b.error ? b.error : translate("common.err.request", { status });
  return new ApiError(status, message, {
    ...(typeof b.code === "string" ? { code: b.code } : {}),
    ...(typeof b.hint === "string" ? { hint: b.hint } : {}),
    ...(typeof b.connection === "string" ? { connection: b.connection } : {}),
    ...(Array.isArray(b.problems) ? { problems: b.problems } : {}),
    ...(Array.isArray(b.findings) ? { findings: b.findings } : {}),
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
