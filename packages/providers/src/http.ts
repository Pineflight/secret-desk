import { redact, type ConnectionStore, type SecretValue } from "@secret-desk/core";

/** Fehler eines Anbieters. Die Meldung ist gekuerzt und von bekannten Werten bereinigt. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}${status ? ` (HTTP ${status})` : ""}: ${message}`);
    this.name = "ProviderError";
  }
}

const MAX_MESSAGE = 200;
export const TIMEOUT_MS = 20_000;

// Sicherheitsnetz fuer Werte, die der Aufrufer nicht kennt: Felder mit Wertnamen und typische Token-Praefixe.
const FIELD = /("(?:api_key|apikey|token|key|secret|value|password|access_token)"\s*:\s*")[^"]*(")/gi;
const PREFIXED = /\b(?:whsec|sk_live|sk_test|rk_live|rk_test|glsa|cfut|sbp|sb_secret)_[A-Za-z0-9_-]{6,}/g;

/** Bereinigt zuerst, kuerzt danach (sonst koennte ein Wert halb abgeschnitten durchrutschen). */
export function safeText(text: string, secrets: string[]): string {
  const clean = redact(text, secrets).replace(FIELD, "$1***$2").replace(PREFIXED, "***").replace(/\s+/g, " ").trim();
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE)}...` : clean;
}

type FetchFn = typeof fetch;

/**
 * JSON-Aufruf ueber das injizierte fetch. Nicht-2xx und Netzfehler werden zu ProviderError.
 * Leere Antworten (204) liefern undefined.
 */
export async function callJson<T = unknown>(
  provider: string,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  secrets: string[],
): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = (err as Error).name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "Zeitueberschreitung nach 20 s" : safeText((err as Error).message, secrets);
    throw new ProviderError(provider, null, `Anfrage fehlgeschlagen: ${reason}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ProviderError(provider, res.status, safeText(text, secrets) || res.statusText || "Fehler");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, res.status, "Antwort ist kein gueltiges JSON");
  }
}

export interface CallContext {
  fetch: FetchFn;
  connections: ConnectionStore;
}

/** Wie callJson, mit Bearer-Token der Verbindung. NotConnectedError wird nicht abgefangen. */
export async function callWithToken<T = unknown>(
  provider: string,
  ctx: CallContext,
  connection: string,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  extraSecrets: string[] = [],
): Promise<T | undefined> {
  const token: SecretValue = await ctx.connections.token(connection);
  const t = token.reveal();
  return callJson<T>(provider, ctx.fetch, url, { ...init, headers: { Authorization: `Bearer ${t}`, ...init.headers } }, [t, ...extraSecrets]);
}

export const JSON_HEADERS = { "Content-Type": "application/json" };

export function badResponse(provider: string): ProviderError {
  return new ProviderError(provider, null, "Unerwartete Antwort des Anbieters");
}

export function requireString(provider: string, params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v.trim()) throw new ProviderError(provider, null, `Parameter "${key}" fehlt oder ist kein Text`);
  return v.trim();
}

export function optionalString(provider: string, params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ProviderError(provider, null, `Parameter "${key}" muss Text sein`);
  return v.trim() || undefined;
}

export function requireStringArray(provider: string, params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !x)) {
    throw new ProviderError(provider, null, `Parameter "${key}" muss eine nicht leere Liste von Texten sein`);
  }
  return v as string[];
}

export function requireInt(provider: string, params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ProviderError(provider, null, `Parameter "${key}" muss eine positive ganze Zahl sein`);
  return v;
}

/** Ablaufzeitpunkt aus ttlDays, ohne Millisekunden. */
export function expiryFrom(now: Date, ttlDays: number | undefined): string | undefined {
  if (!ttlDays) return undefined;
  return new Date(now.getTime() + ttlDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Pfadsegment sicher einsetzen. */
export const seg = encodeURIComponent;
