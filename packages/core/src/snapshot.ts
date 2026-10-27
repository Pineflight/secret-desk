import { createHash } from "node:crypto";
import type { StageKind } from "./stages.js";
import type { Place, SecretEntry, VariableEntry } from "./types.js";

/** Stabile JSON-Darstellung: Schluessel sortiert, damit gleiche Inhalte denselben Hash ergeben. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const placeLabel = (p: Place): string => `${p.repo} (${p.scope === "environment" ? `environment ${p.environment ?? "?"}` : p.scope === "organization" ? "organization" : "repository"})${p.name ? ` als ${p.name}` : ""}`;

/**
 * Was zum Zeitpunkt einer Pruefung galt: Ziele, Anbieter, Parameter, Stage, Art der Stage, alte Kennung.
 * Aendert sich eines davon bis zur Bestaetigung, wird nicht geschrieben (der Eintrag koennte umgebogen worden sein).
 */
export function issuanceSnapshot(secret: SecretEntry, kind: StageKind): string {
  return hashOf({ places: secret.places, provider: secret.provider, params: hashOf(secret.params), stage: secret.stage, stageKind: kind, externalId: secret.externalId ?? null });
}

/** Inhalt einer Freigabe-Anfrage: lesbare Sicht fuer das Portal plus Hash ueber alles, was die Ausfuehrung bestimmt. */
export interface ApprovalSnapshot {
  hash: string;
  /** Anzeige fuer den Menschen. Nie ein geheimer Wert (Variablen-Sollwerte sind Konfiguration). */
  view: Record<string, string | number | null | string[]>;
}

export function secretApprovalSnapshot(secret: SecretEntry): ApprovalSnapshot {
  const view = { secret: secret.id, name: secret.name, provider: secret.provider, stage: secret.stage, ttlDays: secret.ttlDays ?? null, places: secret.places.map(placeLabel), paramsHash: hashOf(secret.params).slice(0, 12) };
  return { hash: hashOf({ view, places: secret.places, params: hashOf(secret.params) }), view };
}

export function variableApprovalSnapshot(v: VariableEntry): ApprovalSnapshot {
  const view = { variable: v.id, name: v.name, value: v.value, stage: v.stage, places: v.places.map(placeLabel) };
  return { hash: hashOf({ view, places: v.places }), view };
}
