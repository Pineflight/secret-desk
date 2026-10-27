import type { Check, CheckStatus, VerifyContext } from "@secret-desk/core";
import { ProviderError, safeText, TIMEOUT_MS } from "./http.js";

/** Antwort einer Pruefabfrage: Statuscode wird nie zum Fehler, nur Netzprobleme werfen. */
export interface Reply {
  status: number;
  headers: Headers;
  json: unknown;
}

export const DAY_MS = 86_400_000;

export function check(id: string, label: string, status: CheckStatus, extra: { expected?: string; actual?: string; detail?: string } = {}): Check {
  return { id, label, status, ...extra };
}

/** Abfrage ohne Statuspruefung. Netzfehler werden zu ProviderError (bereinigt). */
export async function probe(provider: string, ctx: VerifyContext, url: string, init: RequestInit, secrets: string[]): Promise<Reply> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = (err as Error).name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "Zeitueberschreitung nach 20 s" : safeText((err as Error).message ?? "Fehler", secrets);
    throw new ProviderError(provider, null, `Anfrage fehlgeschlagen: ${reason}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

/** Abfrage mit dem soeben ausgestellten oder eingefuegten Wert als Bearer. */
export function probeWithValue(provider: string, ctx: VerifyContext, url: string, headers: Record<string, string> = {}): Promise<Reply> {
  const v = ctx.value.reveal();
  return probe(provider, ctx, url, { method: "GET", headers: { Authorization: `Bearer ${v}`, ...headers } }, [v]);
}

/** Abfrage mit dem Token der Verbindung. */
export async function probeWithConnection(provider: string, ctx: VerifyContext, connection: string, url: string): Promise<Reply> {
  const t = (await ctx.connections.token(connection)).reveal();
  return probe(provider, ctx, url, { method: "GET", headers: { Authorization: `Bearer ${t}` } }, [t, ctx.value.reveal()]);
}

/** Fuehrt eine Pruefung aus. Jeder Fehler wird zu einem warn-Befund mit bereinigter Kurzmeldung. */
export async function step(ctx: VerifyContext, id: string, label: string, fn: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? safeText(err.message, [ctx.value.reveal()]) : "Unbekannter Fehler";
    return [check(id, label, "warn", { detail: `Pruefung nicht moeglich: ${msg}` })];
  }
}

export async function steps(parts: Promise<Check[]>[]): Promise<Check[]> {
  return (await Promise.all(parts)).flat();
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sameSet(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { missing: [...sb].filter((x) => !sa.has(x)), extra: [...sa].filter((x) => !sb.has(x)) };
}

export function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** Vergleich zweier Zeitpunkte in Tagen (absolut). NaN bei unlesbarem Datum. */
export function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

export function day(iso: string): string {
  return iso.slice(0, 10);
}
