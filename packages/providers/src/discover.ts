import { ParamsInvalidError, UnknownDiscoverKindError, type DiscoverContext, type ParamProblem, type ParamSpec, type PreflightFinding } from "@secret-desk/core";
import { isRecord } from "./checks.js";
import { callWithToken, ProviderError } from "./http.js";

/** Lesender GET mit dem Token der Verbindung. */
export function getJson<T = unknown>(provider: string, ctx: Pick<DiscoverContext, "connections" | "fetch">, connection: string, url: string): Promise<T | undefined> {
  return callWithToken<T>(provider, ctx, connection, url, { method: "GET" });
}

export function unknownKind(kind: string): never {
  throw new UnknownDiscoverKindError(kind);
}

/** Der Schluessel fehlt in den Parametern; fuer Entdeckungen, die einen anderen Parameter brauchen (zum Beispiel accountId). */
export function needParam(specs: readonly ParamSpec[], params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  const spec = specs.find((s) => s.key === key);
  const problem: ParamProblem = { key, code: "missing", message: `${key} fehlt`, label: spec?.label ?? key, labelEn: spec?.labelEn ?? key };
  throw new ParamsInvalidError([problem]);
}

export const asList = (json: unknown, key?: string): Record<string, unknown>[] => {
  const v = key && isRecord(json) ? json[key] : json;
  return Array.isArray(v) ? v.filter(isRecord) : [];
};

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Fehler beim Lesen einer Liste zu einem Befund: 401/403 = Token darf nicht lesen, sonst Netz/Anbieter. */
export function readFailure(err: unknown, what: string): PreflightFinding {
  if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) return { id: "read", level: "warn", label: `${what} nicht lesbar: dem Token fehlt das Leserecht`, detail: err.message };
  return { id: "read", level: "warn", label: `${what} nicht lesbar`, detail: err instanceof Error ? err.message : "Fehler" };
}
