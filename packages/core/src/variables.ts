import type { GitHubClient, GitHubTarget } from "./github.js";
import { placeToTarget } from "./github.js";
import { GitHubError } from "./github.js";
import { looksSecret } from "./guards.js";
import type { InventoryStore } from "./inventory.js";
import type { Place, VariableEntry } from "./types.js";

export type DriftState = "in-sync" | "missing" | "different" | "unknown-expected" | "unreachable";

export interface VariableDrift {
  variableId: string;
  place: Place;
  placeLabel: string;
  state: DriftState;
  expected: string | null;
  actual: string | null;
  updatedAt: string | null;
  /** Nur bei state "unreachable": Meldung und HTTP-Status von GitHub, damit die Ursache sichtbar ist. */
  error?: string;
  errorStatus?: number;
}

export class VariableError extends Error {
  constructor(
    message: string,
    /** Maschinenlesbar: secret-blocked = sieht eindeutig geheim aus, secret-ack = der Mensch muss bestaetigen, dass der Wert oeffentlich ist. */
    readonly code?: "secret-blocked" | "secret-ack",
  ) {
    super(message);
    this.name = "VariableError";
  }
}

export function placeLabel(p: Place): string {
  return `${p.repo}/${p.scope === "environment" ? `env:${p.environment}` : p.scope === "organization" ? "org" : "repo"}`;
}

/** Wirft, wenn der Wert eindeutig wie ein Geheimnis aussieht, oder (warn) ohne Bestaetigung. */
export function assertPublicValue(name: string, value: string, acknowledgedPublic = false): void {
  const finding = looksSecret(name, value);
  if (!finding) return;
  if (finding.level === "block") throw new VariableError(finding.reason, "secret-blocked");
  if (!acknowledgedPublic) throw new VariableError(`${finding.reason} Zum Bestaetigen acknowledgedPublic setzen.`, "secret-ack");
}

/** Vergleicht Soll (Inventar) und Ist (GitHub) fuer alle Ziele einer Variable. */
export async function inspectVariable(github: GitHubClient, owner: string, variable: VariableEntry): Promise<VariableDrift[]> {
  const cache = new Map<string, Map<string, { value: string; updatedAt: string }> | null>();
  const failures = new Map<string, { error: string; errorStatus?: number }>();
  const out: VariableDrift[] = [];
  for (const place of variable.places) {
    const target = placeToTarget(owner, place);
    const key = `${target.repo}/${target.scope}/${target.environment ?? ""}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, new Map((await github.listVariables(target)).map((v) => [v.name, { value: v.value, updatedAt: v.updatedAt }])));
      } catch (err) {
        cache.set(key, null);
        failures.set(key, { error: err instanceof Error ? err.message : String(err), ...(err instanceof GitHubError ? { errorStatus: err.status } : {}) });
      }
    }
    const live = cache.get(key);
    const name = place.name ?? variable.name;
    const label = placeLabel(place);
    if (live === null) out.push({ variableId: variable.id, place, placeLabel: label, state: "unreachable", expected: variable.value, actual: null, updatedAt: null, ...failures.get(key) });
    else {
      const found = live!.get(name);
      const state: DriftState = !found ? "missing" : variable.value === null ? "unknown-expected" : found.value === variable.value ? "in-sync" : "different";
      out.push({ variableId: variable.id, place, placeLabel: label, state, expected: variable.value, actual: found?.value ?? null, updatedAt: found?.updatedAt ?? null });
    }
  }
  return out;
}

export interface ApplyOutcome {
  place: string;
  outcome: "created" | "updated" | "unchanged" | "failed";
  error?: string;
}

/** Setzt den Sollwert in alle Ziele. Ohne Sollwert oder bei geheim wirkendem Wert passiert nichts. */
export async function applyVariable(
  github: GitHubClient,
  owner: string,
  variable: VariableEntry,
  options: { acknowledgedPublic?: boolean } = {},
): Promise<ApplyOutcome[]> {
  if (variable.value === null) throw new VariableError("Die Variable hat keinen Sollwert. Erst setzen oder aus GitHub uebernehmen.");
  assertPublicValue(variable.name, variable.value, options.acknowledgedPublic);
  const drift = await inspectVariable(github, owner, variable);
  const out: ApplyOutcome[] = [];
  for (const d of drift) {
    if (d.state === "in-sync") {
      out.push({ place: d.placeLabel, outcome: "unchanged" });
      continue;
    }
    try {
      const target: GitHubTarget = placeToTarget(owner, d.place);
      out.push({ place: d.placeLabel, outcome: await github.putVariable(target, d.place.name ?? variable.name, variable.value) });
    } catch (err) {
      out.push({ place: d.placeLabel, outcome: "failed", error: (err as Error).message });
    }
  }
  return out;
}

/** Uebernimmt den Ist-Wert aus GitHub als Sollwert, wenn er an allen erreichbaren Zielen gleich ist. */
export async function adoptVariable(github: GitHubClient, owner: string, inventory: InventoryStore, id: string): Promise<VariableEntry> {
  const variable = inventory.getVariable(id);
  if (!variable) throw new VariableError(`Variable nicht gefunden: ${id}`);
  const drift = await inspectVariable(github, owner, variable);
  const values = [...new Set(drift.filter((d) => d.actual !== null).map((d) => d.actual!))];
  if (values.length === 0) throw new VariableError("In GitHub ist die Variable nirgends gesetzt.");
  if (values.length > 1) throw new VariableError("Die Ziele haben unterschiedliche Werte. Sollwert von Hand festlegen.");
  assertPublicValue(variable.name, values[0]!, true);
  return inventory.patchVariable(id, { value: values[0]! });
}
