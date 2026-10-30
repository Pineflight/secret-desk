import { InventoryError, type EntryEdit, type InventoryStore } from "./inventory.js";
import { analyzeName, STAGE_TOKEN_HINT, type NamingConfig } from "./naming.js";
import { findStage, stageEnvironment } from "./stages.js";
import type { Inventory, Place, SecretEntry, VariableEntry } from "./types.js";
import { variableSourceKind, type VariableSource } from "./variable-sources.js";

/**
 * Vereinheitlichung des Inventars (siehe docs/NAMING.md): einheitliche Namen und, wo es geht, Werte, die ein Anbieter
 * automatisch liefert. `planNormalization` ist rein (kein Netz, keine Datei) und zeigt nur Namen, Stages, Anbieter und
 * Parameter-Schluessel, nie einen Wert. `applyNormalization` aendert nur das Inventar: es schreibt nie nach GitHub und
 * stellt nichts aus und widerruft nichts. Die Ids der Eintraege bleiben, denn Belege (Evidence-Ordner), Freigaben und
 * Vorlagen haengen an ihnen.
 */

export type NormalizationKind = "rename" | "provider" | "source" | "stage" | "merge" | "manual-only";

export interface NormalizationReason {
  /** Stabiler Code, zum Beispiel stage-in-name. */
  code: string;
  /** Deutscher Text (ASCII, wird an der API-Grenze uebersetzt). */
  text: string;
}

export interface NormalizationEntryState {
  id: string;
  entryKind: "secret" | "variable";
  name: string;
  stage: string;
  /** Nur Secrets. */
  provider?: string;
  /** Nur Secrets: Schluessel der Parameter, nie Werte. */
  paramKeys?: string[];
  /** Nur Variablen: Quelle des Sollwerts, falls gesetzt (resource null = noch zu waehlen). */
  source?: { connection: string; kind: string; field: string; resource: string | null } | null;
}

export interface NormalizationChange {
  /** Stabil fuer denselben Befund, zum Beispiel rename:secret:cf-token. */
  id: string;
  kind: NormalizationKind;
  entryKind: "secret" | "variable";
  entryIds: string[];
  before: NormalizationEntryState[];
  /** Leer bei merge und manual-only. */
  after: NormalizationEntryState[];
  reasons: NormalizationReason[];
  /** Der alte GitHub-Name steht in Workflows: nach dem Umbenennen erscheint er im Vergleich als verwaist, bis sie angepasst sind. */
  needsWorkflowChange: boolean;
  /** Eintraege (Id), mit denen es zusammenstoesst. Nur bei merge. */
  conflicts: string[];
  /** Mit applyNormalization anwendbar. merge, manual-only und Quellen ohne eindeutige Ressource sind es nicht. */
  autoApplicable: boolean;
  /** Parameter, die nach einem Anbieterwechsel noch fehlen (dafuer gibt es "Parameter vervollstaendigen"). */
  missingParams: string[];
}

export interface NormalizationPlan {
  changes: NormalizationChange[];
}

type EntryKind = "secret" | "variable";
type Entry = SecretEntry | VariableEntry;

interface Row {
  kind: EntryKind;
  entry: Entry;
  target: string;
  analysis: ReturnType<typeof analyzeName>;
  stageTarget: string | null;
}

const T = {
  nameCollision: "Nach dem Umbenennen haetten zwei Eintraege denselben Namen am selben Ziel: von Hand zusammenfuehren",
  stageFromName: "Die Stage stand im Namen, der Eintrag gilt dafuer",
  switchApiKey: "Der Schluessel laesst sich ueber die Supabase-API erzeugen",
  switchStripeWebhook: "Das Webhook-Secret entsteht beim Anlegen des Endpunkts ueber die Stripe-API",
  switchGrafana: "Das Token laesst sich fuer den Service-Account ueber die Grafana-API erzeugen",
  paramsNeeded: "Danach die Parameter vervollstaendigen (Projekt)",
  paramsNeededGeneric: "Danach die Parameter vervollstaendigen",
  sourceKnown: "Der Wert kommt aus dem Anbieter",
  sourceChoose: "Die Ressource ist nicht eindeutig: Ressource waehlen, dann laesst sich der Wert beziehen",
  sourceConflict: "Wert und Zuordnung nennen verschiedene Ressourcen: Ressource waehlen",
} as const;

/** Fest verdrahtete Quellen: Name (nach der Umbenennung) -> Quelle und, falls aus dem vorhandenen Wert ableitbar, die Ressource. */
interface SourceRule {
  kind: string;
  field: string;
  fromValue?: (value: string) => string | null;
  /** Standardwert der Integration (integrationDefaults), der die Ressource eindeutig macht. */
  defaultKey?: { connection: string; key: string };
}
const REF_RE = /^[a-z0-9]{20}$/;
const SUPABASE_URL_RE = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;
const CLOUDFLARE_ID_RE = /^[a-f0-9]{32}$/;
const SITEKEY_RE = /^0x[A-Za-z0-9_-]{8,}$/;
const SOURCE_RULES: Record<string, SourceRule> = {
  SUPABASE_URL: { kind: "supabase.project", field: "url", fromValue: (v) => SUPABASE_URL_RE.exec(v)?.[1] ?? null },
  SUPABASE_PROJECT_REF: { kind: "supabase.project", field: "ref", fromValue: (v) => (REF_RE.test(v) ? v : null) },
  SUPABASE_PUBLISHABLE_KEY: { kind: "supabase.project", field: "publishableKey" },
  CLOUDFLARE_ACCOUNT_ID: { kind: "cloudflare.account", field: "accountId", fromValue: (v) => (CLOUDFLARE_ID_RE.test(v) ? v : null), defaultKey: { connection: "cloudflare", key: "accountId" } },
  CLOUDFLARE_ZONE_ID: { kind: "cloudflare.zone", field: "zoneId", fromValue: (v) => (CLOUDFLARE_ID_RE.test(v) ? v : null) },
  TURNSTILE_SITE_KEY: { kind: "cloudflare.turnstileWidget", field: "sitekey", fromValue: (v) => (SITEKEY_RE.test(v) ? v : null) },
};

/**
 * Secrets, deren Wert ein Anbieter erzeugen kann: Name (nach der Umbenennung) -> Anbieter, feste Parameter und die
 * Pflichtparameter, die danach ueber "Parameter vervollstaendigen" gesetzt werden. Geraten wird dabei nichts.
 */
interface ProviderSwitch {
  provider: string;
  fixed: Record<string, string>;
  required: string[];
  reason: { code: string; text: string };
  paramsText: string;
}
const supabaseKey = (type: "secret" | "publishable"): ProviderSwitch => ({ provider: "supabase-api-key", fixed: { type }, required: ["projectRef"], reason: { code: "supabase-api-key", text: T.switchApiKey }, paramsText: T.paramsNeeded });
const grafanaToken: ProviderSwitch = { provider: "grafana-service-account-token", fixed: {}, required: ["baseUrl", "serviceAccountId"], reason: { code: "grafana-service-account-token", text: T.switchGrafana }, paramsText: T.paramsNeededGeneric };
const PROVIDER_SWITCHES: Record<string, ProviderSwitch> = {
  SUPABASE_SECRET_KEY: supabaseKey("secret"),
  SUPABASE_PUBLISHABLE_KEY: supabaseKey("publishable"),
  STRIPE_WEBHOOK_SECRET: { provider: "stripe-webhook-secret", fixed: {}, required: ["url", "events"], reason: { code: "stripe-webhook-secret", text: T.switchStripeWebhook }, paramsText: T.paramsNeededGeneric },
  GRAFANA_SERVICE_ACCOUNT_TOKEN: grafanaToken,
  GRAFANA_READ_TOKEN: grafanaToken,
};

/** Anbieter ohne API: (Name oder Dienst) -> Grund. Sie bleiben von Hand und stehen deshalb in der Liste. */
const MANUAL_ONLY: { test: RegExp; code: string; text: string }[] = [
  { test: /^SUPABASE_DB_PASSWORD$/, code: "supabase-db-password", text: "Supabase hat keine API fuer das Datenbank-Passwort: nur von Hand" },
  { test: /^SUPABASE_ACCESS_TOKEN$/, code: "supabase-pat", text: "Persoenliche Zugriffs-Tokens (PAT) erzeugt Supabase nur im Dashboard: nur von Hand" },
  { test: /REVENUECAT/i, code: "revenuecat", text: "RevenueCat hat keine API, die Schluessel erzeugt: nur von Hand" },
  { test: /PEECHO/i, code: "peecho", text: "Peecho hat keine API, die Schluessel erzeugt: nur von Hand" },
  { test: /VESSEL_?API/i, code: "vesselapi", text: "VesselAPI hat keine API, die Schluessel erzeugt: nur von Hand" },
  { test: /^DIP(_|$)/i, code: "dip", text: "Der DIP-Schluessel wird beantragt, es gibt keine API dafuer: nur von Hand" },
  { test: /OPENAI/i, code: "openai-admin", text: "OpenAI erzeugt Schluessel nur im Dashboard (keine API fuer Admin-Keys): nur von Hand" },
  { test: /^STRIPE_SECRET_KEY$/, code: "stripe-restricted-key", text: "Restricted Keys erzeugt Stripe nur im Dashboard: nur von Hand" },
  { test: /^CLOUDFLARE_(ACCESS_CLIENT|R2_)/, code: "cloudflare-not-yet", text: "Cloudflare koennte das per API, secret-desk hat dafuer noch keinen Anbieter: vorerst von Hand" },
];
/** Jeder andere Eintrag mit provider manual: in der Liste, damit sichtbar ist, was von Hand bleibt. */
const MANUAL_FALLBACK = { code: "no-provider", text: "Fuer diesen Wert hat secret-desk keinen Anbieter: von Hand" };

const namingOf = (config: { naming?: Partial<NamingConfig> | undefined }): Partial<NamingConfig> => config.naming ?? {};

/** Die vorgeschlagene Stage, wenn der Name eine nannte, der Eintrag "shared" ist und die Ziele dazu passen. */
function proposeStage(inv: Inventory, entry: Entry, removed: string[]): string | null {
  if (entry.stage !== "shared" || removed.length === 0) return null;
  const hints = new Set(removed.map((t) => STAGE_TOKEN_HINT[t] ?? null));
  if (hints.size !== 1) return null;
  const [hint] = [...hints];
  if (!hint) return null;
  const def = findStage(inv.stages, hint);
  if (!def) return null;
  const env = stageEnvironment(def);
  // Ein Ziel mit anderer Environment widerspricht dem Namen: dann nichts vorschlagen.
  if (entry.places.some((p) => p.scope === "environment" && p.environment !== env)) return null;
  return hint;
}

function stateOf(kind: EntryKind, e: Entry): NormalizationEntryState {
  if (kind === "secret") {
    const s = e as SecretEntry;
    return { id: s.id, entryKind: "secret", name: s.name, stage: s.stage, provider: s.provider, paramKeys: Object.keys(s.params).sort() };
  }
  const v = e as VariableEntry;
  return { id: v.id, entryKind: "variable", name: v.name, stage: v.stage, source: v.from ? { connection: v.from.connection, kind: v.from.kind, field: v.from.field, resource: v.from.resource } : null };
}

const change = (c: Omit<NormalizationChange, "id" | "conflicts" | "missingParams" | "needsWorkflowChange" | "autoApplicable"> & Partial<Pick<NormalizationChange, "conflicts" | "missingParams" | "needsWorkflowChange" | "autoApplicable">>, id: string): NormalizationChange => ({
  id,
  conflicts: [],
  missingParams: [],
  needsWorkflowChange: false,
  autoApplicable: true,
  ...c,
});

/** Ein Eintrag im Zustand nach der Aenderung, fuer die Kollisionspruefung. */
interface Item {
  kind: EntryKind;
  id: string;
  name: string;
  stage: string;
  places: Place[];
  /** Der Eintrag wird geaendert (umbenannt oder angewendet): nur dann zaehlt ein Zusammenstoss. */
  touched: boolean;
}

interface Collision {
  kind: EntryKind;
  ids: string[];
}

/**
 * Zwei Eintraege derselben Art am selben Ziel (Repository, Bereich, Environment, Stage) unter demselben Namen, von denen
 * einer geaendert wird. Schon vorher bestehende Doppelungen bleiben unbehelligt.
 */
function findCollisions(items: Item[]): Collision[] {
  const byKey = new Map<string, Item[]>();
  for (const it of items) {
    for (const p of it.places) {
      const key = [it.kind, p.repo, p.scope, p.environment ?? "", it.stage, p.name ?? it.name].join("\u0000");
      byKey.set(key, [...(byKey.get(key) ?? []), it]);
    }
  }
  const groups = new Map<string, Collision>();
  for (const members of byKey.values()) {
    const ids = [...new Set(members.map((m) => m.id))].sort();
    if (ids.length < 2 || !members.some((m) => m.touched)) continue;
    groups.set(`${members[0]!.kind}:${ids.join("+")}`, { kind: members[0]!.kind, ids });
  }
  return [...groups.values()];
}

/** Eindeutige Ressource einer Variable: aus dem vorhandenen Wert, der Zuordnung (resourceMap) oder dem Integrations-Standard. */
function resolveResource(inv: Inventory, v: VariableEntry, rule: SourceRule): { resource: string | null; conflict: boolean } {
  const found = new Set<string>();
  const fromValue = v.value && rule.fromValue ? rule.fromValue(v.value) : null;
  if (fromValue) found.add(fromValue);

  const map = inv.resourceMap ?? [];
  const repos = [...new Set(v.places.map((p) => p.repo))];
  const mapped = repos.map((repo) => map.find((m) => m.kind === rule.kind && m.repo === repo && m.stage === v.stage) ?? map.find((m) => m.kind === rule.kind && m.repo === repo && m.stage === undefined));
  if (repos.length > 0 && mapped.every((m) => m !== undefined)) for (const m of mapped) found.add(m!.value);

  const def = rule.defaultKey ? inv.integrationDefaults?.[rule.defaultKey.connection]?.[rule.defaultKey.key] : undefined;
  if (typeof def === "string" && def !== "") found.add(def);

  if (found.size === 0) for (const r of inferredResources(inv, v, rule)) found.add(r);

  if (found.size === 1) return { resource: [...found][0]!, conflict: false };
  return { resource: null, conflict: found.size > 1 };
}

/** Supabase-Ref aus dem Wert einer Variable (Projekt-Ref oder Projekt-Adresse), sonst null. */
function supabaseRefOf(value: string): string | null {
  return REF_RE.test(value) ? value : (SUPABASE_URL_RE.exec(value)?.[1] ?? null);
}

/**
 * Nur wenn weder Wert, Zuordnung noch Standard etwas nennen: Supabase-Projekt aus Geschwister-Variablen (gleiche Repos,
 * gleiche Stage, Name mit SUPABASE und URL/PROJECT_REF), Cloudflare-Konto aus den Werten aller CLOUDFLARE_ACCOUNT_ID-Variablen.
 * Liefert mehrere Treffer, bleibt die Ressource offen (der Aufrufer zaehlt nur genau einen Treffer).
 */
function inferredResources(inv: Inventory, v: VariableEntry, rule: SourceRule): Set<string> {
  const out = new Set<string>();
  if (rule.kind === "supabase.project") {
    // Gleiches Ziel heisst gleiches Repo UND gleiche Environment (bzw. beide auf Repository-Ebene) bei gleicher Stage:
    // "shared" allein sagt nichts, Staging und Produktion duerfen sich nie gegenseitig ein Projekt liefern.
    const placeKey = (p: VariableEntry["places"][number]) => `${p.repo}|${p.scope}|${"environment" in p ? (p.environment ?? "") : ""}`;
    const targets = new Set(v.places.map(placeKey));
    for (const o of inv.variables) {
      if (o.id === v.id || !o.value || o.stage !== v.stage || !/^(NEXT_PUBLIC_|VITE_)?SUPABASE_.*(URL|PROJECT_REF)$/.test(o.name)) continue;
      if (targets.size === 0 || !o.places.some((p) => targets.has(placeKey(p)))) continue;
      const ref = supabaseRefOf(o.value);
      if (ref) out.add(ref);
    }
  }
  if (rule.kind === "cloudflare.account") {
    for (const o of inv.variables) if (o.name === "CLOUDFLARE_ACCOUNT_ID" && o.value && CLOUDFLARE_ID_RE.test(o.value)) out.add(o.value);
  }
  return out;
}

/** Plant die Vereinheitlichung. Rein: liest nur das Inventar und die Namensregeln der Konfiguration. */
export function planNormalization(inv: Inventory, config: { naming?: Partial<NamingConfig> | undefined } = {}): NormalizationPlan {
  const naming = namingOf(config);
  const rows: Row[] = [
    ...inv.secrets.map((entry) => ({ kind: "secret" as const, entry })),
    ...inv.variables.map((entry) => ({ kind: "variable" as const, entry })),
  ].map((r) => {
    const analysis = analyzeName(r.entry.name, naming);
    return { ...r, analysis, target: analysis.suggested, stageTarget: proposeStage(inv, r.entry, analysis.removedStageTokens) };
  });

  const collisions = findCollisions(rows.map((r) => ({ kind: r.kind, id: r.entry.id, name: r.target, stage: r.stageTarget ?? r.entry.stage, places: r.entry.places, touched: r.target !== r.entry.name })));
  const blocked = new Set(collisions.flatMap((c) => c.ids));
  const changes: NormalizationChange[] = [];

  for (const row of rows) {
    const { entry, kind } = row;
    const before = stateOf(kind, entry);
    const renamed = row.target !== entry.name;

    if (renamed && !blocked.has(entry.id)) {
      changes.push(change({ kind: "rename", entryKind: kind, entryIds: [entry.id], before: [before], after: [{ ...before, name: row.target }], reasons: row.analysis.findings.map((f) => ({ code: f.code, text: f.text })), needsWorkflowChange: true }, `rename:${kind}:${entry.id}`));
    }
    if (row.stageTarget) {
      changes.push(change({ kind: "stage", entryKind: kind, entryIds: [entry.id], before: [before], after: [{ ...before, stage: row.stageTarget }], reasons: [{ code: "stage-from-name", text: T.stageFromName }] }, `stage:${kind}:${entry.id}`));
    }
    if (kind === "secret") changes.push(...secretChanges(row, before as NormalizationEntryState));
    else changes.push(...variableChanges(inv, row, before));
  }

  for (const { kind, ids } of collisions) {
    const members = rows.filter((r) => r.kind === kind && ids.includes(r.entry.id));
    changes.push(change({ kind: "merge", entryKind: kind, entryIds: ids, before: members.map((m) => stateOf(kind, m.entry)), after: [], reasons: [{ code: "name-collision", text: T.nameCollision }], conflicts: ids, autoApplicable: false }, `merge:${kind}:${ids.join("+")}`));
  }
  return { changes };
}

function secretChanges(row: Row, before: NormalizationEntryState): NormalizationChange[] {
  const s = row.entry as SecretEntry;
  if (s.provider !== "manual") return [];
  const sw = PROVIDER_SWITCHES[row.target];
  if (sw) {
    const keys = [...new Set([...Object.keys(s.params), ...Object.keys(sw.fixed)])].sort();
    const missing = sw.required.filter((k) => s.params[k] === undefined);
    return [change({ kind: "provider", entryKind: "secret", entryIds: [s.id], before: [before], after: [{ ...before, provider: sw.provider, paramKeys: keys }], reasons: [sw.reason, ...(missing.length > 0 ? [{ code: "params-needed", text: sw.paramsText }] : [])], missingParams: missing }, `provider:secret:${s.id}`)];
  }
  const subject = `${row.target} ${s.service}`;
  const only = MANUAL_ONLY.find((m) => m.test.test(row.target) || m.test.test(s.service) || m.test.test(subject)) ?? MANUAL_FALLBACK;
  return [change({ kind: "manual-only", entryKind: "secret", entryIds: [s.id], before: [before], after: [], reasons: [{ code: only.code, text: only.text }], autoApplicable: false }, `manual-only:secret:${s.id}`)];
}

function variableChanges(inv: Inventory, row: Row, before: NormalizationEntryState): NormalizationChange[] {
  const v = row.entry as VariableEntry;
  const rule = SOURCE_RULES[row.target];
  if (v.from || !rule) return [];
  const kind = variableSourceKind(rule.kind);
  if (!kind) return [];
  const { resource, conflict } = resolveResource(inv, v, rule);
  const source = { connection: kind.connection, kind: rule.kind, field: rule.field, resource };
  const reason = resource ? { code: "source-known", text: T.sourceKnown } : conflict ? { code: "source-conflict", text: T.sourceConflict } : { code: "source-choose-resource", text: T.sourceChoose };
  return [change({ kind: "source", entryKind: "variable", entryIds: [v.id], before: [before], after: [{ ...before, source }], reasons: [reason], autoApplicable: resource !== null }, `source:variable:${v.id}`)];
}

export interface NormalizationResult {
  /** Die angewendeten Aenderungen (Id). */
  applied: string[];
  /** Eintraege, die danach noch Parameter brauchen: dafuer "Parameter vervollstaendigen". */
  needsParams: { secretId: string; missing: string[] }[];
}

/**
 * Wendet die gewaehlten Aenderungen an und speichert. Alles oder nichts: ist eine Id unbekannt, nicht automatisch
 * anwendbar oder stiesse das Ergebnis mit einem anderen Eintrag zusammen, passiert nichts. Schreibt nie nach GitHub.
 */
export async function applyNormalization(inventory: InventoryStore, config: { naming?: Partial<NamingConfig> | undefined }, changeIds: string[]): Promise<NormalizationResult> {
  const ids = [...new Set(changeIds)];
  if (ids.length === 0) throw new InventoryError("Keine Aenderung gewaehlt");
  const plan = planNormalization(inventory.data, config);
  const chosen: NormalizationChange[] = [];
  for (const id of ids) {
    const c = plan.changes.find((x) => x.id === id);
    if (!c) throw new InventoryError(`Unbekannte Aenderung: ${id}`);
    if (!c.autoApplicable) throw new InventoryError(`Aenderung nicht automatisch anwendbar: ${id}`);
    chosen.push(c);
  }

  const edits = new Map<string, EntryEdit>();
  const editOf = (kind: EntryKind, id: string): EntryEdit => {
    const key = `${kind}:${id}`;
    let e = edits.get(key);
    if (!e) edits.set(key, (e = { kind, id }));
    return e;
  };
  for (const c of chosen) {
    const after = c.after[0]!;
    const e = editOf(c.entryKind, after.id);
    if (c.kind === "rename") e.name = after.name;
    else if (c.kind === "stage") e.stage = after.stage;
    else if (c.kind === "provider") {
      e.provider = after.provider!;
      const sw = PROVIDER_SWITCHES[analyzeName(after.name, namingOf(config)).suggested];
      if (sw) e.params = { ...e.params, ...sw.fixed };
    } else if (c.kind === "source") e.from = after.source as VariableSource;
  }

  inventory.applyEdits([...edits.values()], (next) => {
    // Das Ergebnis darf mit keinem anderen Eintrag am selben Ziel zusammenstossen (zum Beispiel wenn nur ein Teil der Umbenennungen gewaehlt wurde).
    const items: Item[] = [...next.secrets.map((e) => ({ kind: "secret" as const, e })), ...next.variables.map((e) => ({ kind: "variable" as const, e }))].map(({ kind, e }) => ({ kind, id: e.id, name: e.name, stage: e.stage, places: e.places, touched: edits.has(`${kind}:${e.id}`) }));
    const clash = findCollisions(items)[0];
    if (clash) throw new InventoryError(`Zwei Eintraege haetten denselben Namen am selben Ziel: ${clash.ids.join(", ")}`);
  });
  await inventory.save();

  const needsParams = chosen.filter((c) => c.kind === "provider" && c.missingParams.length > 0).map((c) => ({ secretId: c.entryIds[0]!, missing: c.missingParams }));
  return { applied: chosen.map((c) => c.id), needsParams };
}
