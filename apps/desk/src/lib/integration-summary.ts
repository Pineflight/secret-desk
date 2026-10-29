import { expiryLevel, type ExpiryLevel } from "./connection-health";
import { needsParams, type WithParams } from "./params-list";

/** Reine Zaehlung fuer den Abschnitt "Angebunden" der Uebersicht. Nur Anbieter, Zahlen, Status und Ablauf; nie Werte oder Namen von Konten. */
export interface ConnectionLike {
  id: string;
  connected: boolean;
  label?: string;
  daysLeft?: number | null;
}
export interface SecretLike extends WithParams {
  connection: string | null;
  automatic: boolean;
  places: readonly { repo: string }[];
}
export interface VariableLike {
  from: { connection: string } | null;
  places: readonly { repo: string }[];
}

export interface IntegrationRow {
  id: string;
  label: string;
  connected: boolean;
  daysLeft: number | null;
  /** Ablauf-Ampel; null ohne bekannte Restlaufzeit. */
  level: ExpiryLevel | null;
  secrets: number;
  /** Davon automatisch erneuerbar (Anbieter kind automatic). */
  autoSecrets: number;
  variables: number;
}

export interface OverviewSummary {
  rows: IntegrationRow[];
  automatic: number;
  manual: number;
  repos: number;
  paramsComplete: number;
  paramsMissing: number;
}

const NAMES: Record<string, string> = { github: "GitHub", cloudflare: "Cloudflare", supabase: "Supabase", stripe: "Stripe", "stripe-test": "Stripe (Test)", "stripe-live": "Stripe (Live)", resend: "Resend", grafana: "Grafana" };

/** Anzeigename: Beschriftung der Verbindung, sonst bekannter Name, sonst die Id. */
export const integrationName = (id: string, label?: string): string => label || NAMES[id] || id;

/**
 * Verbundene Integrationen immer; nicht verbundene nur, wenn Secrets oder Variablen an ihnen haengen
 * (dann als Einladung). Reihenfolge: verbunden zuerst, dann nach Zahl der haengenden Eintraege, dann Name.
 */
export function summarize(connections: readonly ConnectionLike[], secrets: readonly SecretLike[], variables: readonly VariableLike[]): OverviewSummary {
  const byId = new Map<string, IntegrationRow>();
  const row = (id: string, c?: ConnectionLike): IntegrationRow => {
    let r = byId.get(id);
    if (!r) {
      const daysLeft = c?.daysLeft ?? null;
      r = { id, label: integrationName(id, c?.label), connected: c?.connected ?? false, daysLeft, level: c?.connected ? expiryLevel(daysLeft) : null, secrets: 0, autoSecrets: 0, variables: 0 };
      byId.set(id, r);
    }
    return r;
  };
  for (const c of connections) row(c.id, c);
  for (const s of secrets) {
    if (!s.connection) continue;
    const r = row(s.connection);
    r.secrets += 1;
    if (s.automatic) r.autoSecrets += 1;
  }
  for (const v of variables) if (v.from) row(v.from.connection).variables += 1;

  const rows = [...byId.values()]
    .filter((r) => r.connected || r.secrets > 0 || r.variables > 0)
    .sort((a, b) => Number(b.connected) - Number(a.connected) || b.secrets + b.variables - (a.secrets + a.variables) || a.label.localeCompare(b.label));

  const repos = new Set<string>();
  for (const x of [...secrets, ...variables]) for (const p of x.places) repos.add(p.repo);
  const withParams = secrets.filter((s) => s.params.status !== "none");
  const paramsMissing = withParams.filter(needsParams).length;
  return {
    rows,
    automatic: secrets.filter((s) => s.automatic).length,
    manual: secrets.filter((s) => !s.automatic).length,
    repos: repos.size,
    paramsComplete: withParams.length - paramsMissing,
    paramsMissing,
  };
}

/** Bald faellig = gelb oder rot (unter 15 Tage, abgelaufen eingeschlossen). */
export const isDueSoon = (r: Pick<IntegrationRow, "level">): boolean => r.level === "soon" || r.level === "critical" || r.level === "expired";
