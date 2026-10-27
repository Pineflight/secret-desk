import {
  EnvExportError,
  InventoryError,
  NotConnectedError,
  PromptsRequiredError,
  RotationError,
  STAGES,
  buildEnvFile,
  computeStatus,
  exportTeamBundle,
  planRotation,
  rotateSecret,
  writeEnvFile,
  type Place,
  type SecretEntry,
  type Stage,
  type StatusLevel,
} from "@secret-desk/core";
import type { z } from "zod";
import type { SecretSchema, ProviderDefSchema, EnvTemplateSchema, EnvEntrySchema } from "@secret-desk/core";
import type { Approval } from "./approvals.js";
import type { Runtime } from "./runtime.js";

/**
 * Die Operationen, die Portal, MCP-Server und CLI gemeinsam nutzen. Hier sitzt die Richtlinie:
 * Agenten duerfen Metadaten pflegen und Dev-Dateien erzeugen, aber nichts in staging oder production
 * ausloesen, ohne dass ein Mensch es freigibt. Kein Rueckgabewert enthaelt je einen geheimen Wert.
 */
export interface Actor {
  /** "human" (Portal/CLI) oder "agent" (MCP). */
  kind: "human" | "agent";
  name: string;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface SecretView {
  id: string;
  name: string;
  title: string | null;
  product: string | null;
  stage: Stage;
  service: string;
  provider: string;
  automatic: boolean;
  expiry: SecretEntry["expiry"];
  expires: string | null;
  daysLeft: number | null;
  status: StatusLevel;
  rotatedAt: string | null;
  ttlDays: number | null;
  places: Place[];
  guide: { url: string; steps: string[] } | null;
  connection: string | null;
  notes: string | null;
}

function view(rt: Runtime, s: SecretEntry, today: Date, live?: Awaited<ReturnType<Runtime["github"]["snapshot"]>>): SecretView {
  const provider = rt.providers.get(s.provider);
  const r = computeStatus(s, today, { thresholds: rt.inventory.data.thresholds, ...(live ? { live, owner: rt.owner } : {}) });
  return {
    id: s.id,
    name: s.name,
    title: s.title ?? null,
    product: s.product ?? null,
    stage: s.stage,
    service: s.service,
    provider: s.provider,
    automatic: provider?.kind === "automatic" && typeof provider.issue === "function",
    expiry: s.expiry,
    expires: s.expires,
    daysLeft: r.daysLeft,
    status: r.status,
    rotatedAt: s.rotatedAt ?? null,
    ttlDays: s.ttlDays ?? null,
    places: s.places,
    guide: provider?.guide ?? null,
    connection: provider?.connection ?? null,
    notes: s.notes ?? null,
  };
}

export interface ListFilter {
  stage?: Stage;
  repo?: string;
  product?: string;
  status?: StatusLevel;
  provider?: string;
  /** Live-Abgleich mit GitHub (Netzwerk). */
  live?: boolean;
}

export async function listSecrets(rt: Runtime, filter: ListFilter = {}, today = new Date()): Promise<SecretView[]> {
  let secrets = rt.inventory.data.secrets;
  if (filter.stage) secrets = secrets.filter((s) => s.stage === filter.stage);
  if (filter.repo) secrets = secrets.filter((s) => s.places.some((p) => p.repo === filter.repo));
  if (filter.product) secrets = secrets.filter((s) => s.product === filter.product);
  if (filter.provider) secrets = secrets.filter((s) => s.provider === filter.provider);
  const live = filter.live ? await rt.github.snapshot(rt.owner, secrets.flatMap((s) => s.places)) : undefined;
  const views = secrets.map((s) => view(rt, s, today, live));
  const out = filter.status ? views.filter((v) => v.status === filter.status) : views;
  return out.sort((a, b) => b.daysLeft === null ? -1 : a.daysLeft === null ? 1 : a.daysLeft - b.daysLeft);
}

export function getSecret(rt: Runtime, id: string, today = new Date()): SecretView {
  const s = rt.inventory.getSecret(id);
  if (!s) throw new InventoryError(`Secret nicht gefunden: ${id}`);
  return view(rt, s, today);
}

export interface Overview {
  total: number;
  byStage: Record<Stage, number>;
  byStatus: Record<StatusLevel, number>;
  attention: SecretView[];
}

export async function overview(rt: Runtime, today = new Date()): Promise<Overview> {
  const all = await listSecrets(rt, {}, today);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  const byStatus: Record<StatusLevel, number> = { ok: 0, unknown: 0, soon: 0, "no-date": 0, due: 0, missing: 0, expired: 0 };
  for (const v of all) {
    byStage[v.stage] += 1;
    byStatus[v.status] += 1;
  }
  return { total: all.length, byStage, byStatus, attention: all.filter((v) => ["expired", "due", "missing", "no-date", "soon"].includes(v.status)).slice(0, 25) };
}

export function listProviders(rt: Runtime) {
  return rt.providers.list().map((p) => ({ id: p.id, label: p.label, kind: p.kind, connection: p.connection ?? null, guide: p.guide ?? null }));
}

export async function listConnections(rt: Runtime) {
  const ids = [...new Set(["github", "github-app-key", ...rt.providers.list().flatMap((p) => (p.connection ? [p.connection] : []))])];
  return rt.connections.statuses(ids);
}

/** Nur Metadaten: neue Eintraege duerfen Agenten anlegen, ausgeloest wird dadurch nichts. */
export async function addSecret(rt: Runtime, entry: z.input<typeof SecretSchema>): Promise<SecretView> {
  const created = rt.inventory.addSecret(entry);
  await rt.inventory.save();
  return view(rt, created, new Date());
}

export async function updateSecretMeta(rt: Runtime, id: string, patch: Parameters<Runtime["inventory"]["patchSecret"]>[1]): Promise<SecretView> {
  const updated = rt.inventory.patchSecret(id, patch);
  await rt.inventory.save();
  return view(rt, updated, new Date());
}

export async function addManualProvider(rt: Runtime, def: z.input<typeof ProviderDefSchema>) {
  const created = rt.inventory.addProvider(def);
  await rt.inventory.save();
  rt.providers.register({ id: created.id, label: created.label, kind: "manual", guide: { url: created.url, steps: created.steps } });
  return created;
}

export async function addEnvTemplate(rt: Runtime, template: z.input<typeof EnvTemplateSchema>) {
  const created = rt.inventory.addEnvTemplate(template);
  await rt.inventory.save();
  return created;
}

export async function addEnvEntry(rt: Runtime, templateId: string, entry: z.input<typeof EnvEntrySchema>) {
  const updated = rt.inventory.addEnvEntry(templateId, entry);
  await rt.inventory.save();
  return updated;
}

export function teamExport(rt: Runtime): string {
  return exportTeamBundle(rt.inventory.data);
}

export type RotationRequestResult =
  | { status: "executed"; secretId: string; ok: boolean; places: { place: string; outcome: string }[]; expires: string | null }
  | { status: "pending-approval"; approvalId: string; secretId: string; message: string }
  | { status: "dry-run"; plan: ReturnType<typeof planRotation> };

/**
 * Menschen rotieren sofort. Agenten nur in freigegebenen Stages, sonst entsteht eine Anfrage,
 * die ein Mensch im Portal bestaetigt.
 */
export async function requestRotation(
  rt: Runtime,
  actor: Actor,
  secretId: string,
  options: { reason?: string; dryRun?: boolean } = {},
): Promise<RotationRequestResult> {
  const secret = rt.inventory.getSecret(secretId);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${secretId}`);
  if (options.dryRun) return { status: "dry-run", plan: planRotation(secretId, rt) };
  const agentMayRunNow = actor.kind === "human" || (rt.config.policy.agentStages.includes(secret.stage) && secret.places.length > 0);
  if (!agentMayRunNow) {
    const approval = rt.approvals.create({ secretId, requestedBy: actor.name, reason: options.reason ?? null });
    return {
      status: "pending-approval",
      approvalId: approval.id,
      secretId,
      message: `Stage ${secret.stage} braucht eine Freigabe im Portal (Reiter Freigaben).`,
    };
  }
  const result = await rotateSecret(secretId, { inventory: rt.inventory, github: rt.github, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch });
  return { status: "executed", secretId, ok: result.ok, places: result.places.map((p) => ({ place: p.place, outcome: p.outcome })), expires: result.expires };
}

/** Freigabe oder Ablehnung durch einen Menschen. Fuehrt bei Freigabe die Rotation aus. */
export async function resolveApproval(rt: Runtime, actor: Actor, id: string, decision: "approve" | "deny"): Promise<Approval> {
  if (actor.kind !== "human") throw new PolicyError("Freigaben darf nur ein Mensch erteilen.");
  const approval = rt.approvals.get(id);
  if (!approval) throw new PolicyError(`Anfrage nicht gefunden: ${id}`);
  if (decision === "deny") return rt.approvals.resolve(id, "denied");
  try {
    const result = await rotateSecret(approval.secretId, { inventory: rt.inventory, github: rt.github, providers: rt.providers, connections: rt.connections, owner: rt.owner, fetch: rt.fetch });
    return rt.approvals.resolve(id, result.ok ? "approved" : "failed", result.ok ? "rotiert" : "Ziele fehlgeschlagen");
  } catch (err) {
    const message = err instanceof RotationError || err instanceof NotConnectedError ? err.message : "Rotation fehlgeschlagen";
    return rt.approvals.resolve(id, "failed", message);
  }
}

export type DevEnvResult =
  | { status: "written"; path: string; keys: string[]; sources: Record<string, string>; gitIgnored: boolean | null; warnings: string[] }
  | { status: "needs-input"; keys: string[]; message: string };

/**
 * Erzeugt eine .env fuer eine Dev-Vorlage. Agenten bekommen nur Pfad, Schluessel und Herkunft zurueck,
 * nie einen Wert, und duerfen nur dev und nur in freigegebene Ordner schreiben.
 */
export async function exportEnv(
  rt: Runtime,
  actor: Actor,
  input: { repo: string; stage?: Stage; template?: string; path: string; overwrite?: boolean; prompts?: Record<string, string> },
): Promise<DevEnvResult> {
  const stage: Stage = input.stage ?? "dev";
  if (actor.kind === "agent" && !rt.config.policy.agentStages.includes(stage)) {
    throw new PolicyError(`Agenten duerfen fuer ${stage} keine .env erzeugen.`);
  }
  if (actor.kind === "agent" && input.prompts && Object.keys(input.prompts).length > 0) {
    throw new PolicyError("Agenten uebergeben keine Werte. Eingaben macht der Mensch im Portal oder in der CLI.");
  }
  const templates = rt.inventory.data.envTemplates.filter((t) => (input.template ? t.id === input.template : t.repo === input.repo && t.stage === stage));
  const template = templates[0];
  if (!template) throw new EnvExportError(`Keine Vorlage fuer ${input.repo} (${stage}) gefunden.`);
  const roots = rt.config.policy.envRoots;
  if (actor.kind === "agent" && roots.length === 0) {
    throw new PolicyError("policy.envRoots ist leer: Agenten duerfen keine Dateien schreiben.");
  }
  try {
    const built = await buildEnvFile(template, { inventory: rt.inventory, providers: rt.providers, connections: rt.connections, fetch: rt.fetch, ...(input.prompts ? { prompts: input.prompts } : {}) });
    const written = await writeEnvFile(input.path, built.text, { overwrite: input.overwrite ?? false, allowedRoots: roots });
    const warnings: string[] = [];
    if (written.gitIgnored === false) warnings.push("Die Datei ist nicht von Git ignoriert. In .gitignore eintragen, bevor etwas committet wird.");
    if (written.gitIgnored === null) warnings.push("Ob Git die Datei ignoriert, liess sich nicht pruefen.");
    return { status: "written", path: written.path, keys: built.keys, sources: built.sources, gitIgnored: written.gitIgnored, warnings };
  } catch (err) {
    if (err instanceof PromptsRequiredError) {
      return { status: "needs-input", keys: err.keys, message: "Diese Werte muss ein Mensch im Portal oder mit `secret-desk env export --prompt KEY=WERT` angeben." };
    }
    throw err;
  }
}
