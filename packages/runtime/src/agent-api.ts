import { join, relative, isAbsolute } from "node:path";
import { connectionGuide } from "./connection-guides.js";
import {
  EnvExportError,
  InventoryError,
  NotConnectedError,
  PromptsRequiredError,
  RotationError,
  SecretValue,
  STAGES,
  adoptVariable,
  applyVariable,
  assertPublicValue,
  buildEnvFile,
  commitIssuance,
  computeStatus,
  discardIssuance,
  exportTeamBundle,
  inspectVariable,
  overallStatus,
  planRotation,
  prepareIssuance,
  renderEvidenceSvg,
  writeEnvFile,
  type CommitResult,
  type EnvTemplateSchema,
  type EnvEntrySchema,
  type OverallStatus,
  type Place,
  type ProviderDefSchema,
  type SecretEntry,
  type SecretSchema,
  type Stage,
  type StatusLevel,
  type VariableDrift,
  type VariableEntry,
  type VariableSchema,
  type VerificationReport,
} from "@secret-desk/core";
import type { z } from "zod";
import type { Approval } from "./approvals.js";
import { linkedFolder } from "./repos.js";
import { issuanceDeps, type Runtime } from "./runtime.js";

/**
 * Die Operationen, die Portal, MCP-Server und CLI gemeinsam nutzen. Hier sitzt die Richtlinie:
 * Agenten duerfen Metadaten und Variablen-Sollwerte pflegen und Dev-Dateien erzeugen, aber nichts in staging
 * oder production ausloesen, ohne dass ein Mensch es freigibt. Bestaetigen darf nur ein Mensch.
 * Kein Rueckgabewert enthaelt je einen geheimen Wert.
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

const requireHuman = (actor: Actor, what: string): void => {
  if (actor.kind !== "human") throw new PolicyError(`${what} darf nur ein Mensch.`);
};

const agentMayRunNow = (rt: Runtime, actor: Actor, stage: Stage, hasPlaces: boolean): boolean =>
  actor.kind === "human" || (rt.config.policy.agentStages.includes(stage) && hasPlaces);

// ---------------------------------------------------------------------------------------------- Secrets

export interface SecretView {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  owner: string | null;
  link: string | null;
  tags: string[];
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
  verifiedAt: string | null;
  verifiedBy: string | null;
  ttlDays: number | null;
  places: Place[];
  guide: { url: string; steps: string[]; openUrl: string } | null;
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
    description: s.description ?? null,
    owner: s.owner ?? null,
    link: s.link ?? null,
    tags: s.tags,
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
    verifiedAt: s.verifiedAt ?? null,
    verifiedBy: s.verifiedBy ?? null,
    ttlDays: s.ttlDays ?? null,
    places: s.places,
    guide: provider?.guide ? { url: provider.guide.url, steps: provider.guide.steps, openUrl: provider.guide.openUrl?.(s, { owner: rt.owner, now: today }) ?? provider.guide.url } : null,
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
  /** Freitext: Name, id, Beschreibung, Schlagworte, Verantwortlicher, Ziele. */
  q?: string;
  tag?: string;
  /** Live-Abgleich mit GitHub (Netzwerk). */
  live?: boolean;
}

export async function listSecrets(rt: Runtime, filter: ListFilter = {}, today = new Date()): Promise<SecretView[]> {
  let secrets = rt.inventory.data.secrets;
  if (filter.stage) secrets = secrets.filter((s) => s.stage === filter.stage);
  if (filter.repo) secrets = secrets.filter((s) => s.places.some((p) => p.repo === filter.repo));
  if (filter.product) secrets = secrets.filter((s) => s.product === filter.product);
  if (filter.provider) secrets = secrets.filter((s) => s.provider === filter.provider);
  if (filter.tag) secrets = secrets.filter((s) => s.tags.includes(filter.tag!));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    secrets = secrets.filter((s) => [s.id, s.name, s.title, s.description, s.owner, s.product, s.service, ...s.tags, ...s.places.map((p) => p.repo)].some((x) => x?.toLowerCase().includes(q)));
  }
  const live = filter.live ? await rt.github.snapshot(rt.owner, secrets.flatMap((s) => s.places)) : undefined;
  const views = secrets.map((s) => view(rt, s, today, live));
  const out = filter.status ? views.filter((v) => v.status === filter.status) : views;
  return out.sort((a, b) => (b.daysLeft === null ? -1 : a.daysLeft === null ? 1 : a.daysLeft - b.daysLeft));
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
  variables: number;
  pendingReviews: number;
  pendingApprovals: number;
}

export async function overview(rt: Runtime, today = new Date()): Promise<Overview> {
  const all = await listSecrets(rt, {}, today);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  const byStatus: Record<StatusLevel, number> = { ok: 0, unknown: 0, soon: 0, "no-date": 0, due: 0, missing: 0, expired: 0 };
  for (const v of all) {
    byStage[v.stage] += 1;
    byStatus[v.status] += 1;
  }
  return {
    total: all.length,
    byStage,
    byStatus,
    attention: all.filter((v) => ["expired", "due", "missing", "no-date", "soon"].includes(v.status)).slice(0, 25),
    variables: rt.inventory.data.variables.length,
    pendingReviews: rt.issuances.list().length,
    pendingApprovals: rt.approvals.list("pending").length,
  };
}

export function listProviders(rt: Runtime) {
  return rt.providers.list().map((p) => ({ id: p.id, label: p.label, kind: p.kind, connection: p.connection ?? null, guide: p.guide ? { url: p.guide.url, steps: p.guide.steps } : null }));
}

export async function listConnections(rt: Runtime) {
  const ids = [...new Set(["github", "github-app-key", ...rt.providers.list().flatMap((p) => (p.connection ? [p.connection] : []))])];
  const statuses = await rt.connections.statuses(ids);
  return statuses.map((s) => {
    const g = connectionGuide(s.id, rt.owner);
    const days = s.expires ? Math.ceil((Date.parse(`${s.expires}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
    return { ...s, daysLeft: days, label: g?.label ?? s.id, description: g?.description ?? null, url: g?.url ?? null, openUrl: g ? g.openUrl ?? g.url : null, steps: g?.steps ?? [], permissions: g?.permissions ?? [] };
  });
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

// ------------------------------------------------------------------------- Ausstellen und Bestaetigen

export interface IssuanceView {
  id: string;
  secretId: string;
  secretName: string;
  stage: Stage;
  provider: string;
  kind: VerificationReport["kind"];
  createdAt: string;
  expiresAt: string;
  overall: OverallStatus;
  report: VerificationReport;
}

function issuanceView(p: { id: string; secretId: string; createdAt: string; expiresAt: string; report: VerificationReport }): IssuanceView {
  return {
    id: p.id,
    secretId: p.secretId,
    secretName: p.report.secretName,
    stage: p.report.stage,
    provider: p.report.provider,
    kind: p.report.kind,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    overall: overallStatus(p.report.checks),
    report: p.report,
  };
}

export type IssuanceRequestResult =
  | { status: "awaiting-review"; issuance: IssuanceView; message: string }
  | { status: "pending-approval"; approvalId: string; secretId: string; message: string }
  | { status: "dry-run"; plan: ReturnType<typeof planRotation> };

/**
 * Bittet um einen neuen Wert. Menschen stossen sofort die Pruefung an. Agenten nur in freigegebenen Stages,
 * sonst entsteht eine Anfrage, die ein Mensch im Portal freigibt. In keinem Fall wird in GitHub geschrieben,
 * bevor ein Mensch den Pruefbericht bestaetigt hat.
 */
export async function requestIssuance(rt: Runtime, actor: Actor, secretId: string, options: { reason?: string; dryRun?: boolean } = {}): Promise<IssuanceRequestResult> {
  const secret = rt.inventory.getSecret(secretId);
  if (!secret) throw new InventoryError(`Secret nicht gefunden: ${secretId}`);
  if (options.dryRun) return { status: "dry-run", plan: planRotation(secretId, rt) };
  if (!agentMayRunNow(rt, actor, secret.stage, secret.places.length > 0)) {
    const approval = rt.approvals.create({ action: "issue", targetId: secretId, requestedBy: actor.name, reason: options.reason ?? null });
    return { status: "pending-approval", approvalId: approval.id, secretId, message: `Stage ${secret.stage} braucht eine Freigabe im Portal (Reiter Freigaben).` };
  }
  const pending = await prepareIssuance(secretId, issuanceDeps(rt));
  rt.issuances.add(pending);
  return { status: "awaiting-review", issuance: issuanceView(pending), message: "Wert erzeugt und geprueft. Ein Mensch bestaetigt ihn im Portal (Reiter Pruefen), erst dann wird geschrieben." };
}

/** Der Mensch gibt den Wert selbst ein (zum Beispiel ein Stripe-Key). Er wird geprueft und wartet auf Bestaetigung. */
export async function submitManualValue(rt: Runtime, actor: Actor, secretId: string, value: string): Promise<IssuanceView> {
  requireHuman(actor, "Werte eingeben");
  const pending = await prepareIssuance(secretId, issuanceDeps(rt), { manualValue: new SecretValue(value.trim()) });
  rt.issuances.add(pending);
  return issuanceView(pending);
}

export async function listIssuances(rt: Runtime): Promise<IssuanceView[]> {
  await rt.issuances.sweep(issuanceDeps(rt));
  return rt.issuances.list().map(issuanceView);
}

export async function getIssuance(rt: Runtime, id: string): Promise<IssuanceView> {
  await rt.issuances.sweep(issuanceDeps(rt));
  const p = rt.issuances.get(id);
  if (!p) throw new PolicyError(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
  return issuanceView(p);
}

export async function confirmIssuance(rt: Runtime, actor: Actor, id: string, input: { ticks: string[]; note?: string; force?: boolean }): Promise<CommitResult> {
  requireHuman(actor, "Bestaetigen");
  await rt.issuances.sweep(issuanceDeps(rt));
  const pending = rt.issuances.get(id);
  if (!pending) throw new PolicyError(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
  const result = await commitIssuance(pending, issuanceDeps(rt), { by: actor.name, ticks: input.ticks, ...(input.note ? { note: input.note } : {}) }, { force: Boolean(input.force) });
  if (result.ok) rt.issuances.delete(id);
  return result;
}

export async function rejectIssuance(rt: Runtime, actor: Actor, id: string, note?: string): Promise<{ revokedNew: boolean }> {
  requireHuman(actor, "Ablehnen");
  const pending = rt.issuances.get(id);
  if (!pending) throw new PolicyError(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
  rt.issuances.delete(id);
  return discardIssuance(pending, issuanceDeps(rt), { by: actor.name, why: "rejected", ...(note ? { note } : {}) });
}

// ------------------------------------------------------------------------------------- Belege, Anlagen

export async function listEvidence(rt: Runtime, secretId: string): Promise<VerificationReport[]> {
  return rt.evidence.list(secretId);
}

export async function getEvidence(rt: Runtime, secretId: string, reportId: string): Promise<VerificationReport> {
  const r = await rt.evidence.get(secretId, reportId);
  if (!r) throw new PolicyError("Bericht nicht gefunden");
  return r;
}

export async function evidenceSvg(rt: Runtime, secretId: string, reportId: string): Promise<string> {
  return renderEvidenceSvg(await getEvidence(rt, secretId, reportId));
}

export async function attachEvidence(rt: Runtime, actor: Actor, secretId: string, reportId: string, bytes: Uint8Array, mime: string, note?: string) {
  requireHuman(actor, "Anlagen hinzufuegen");
  return rt.evidence.attach(secretId, reportId, bytes, mime, note);
}

export async function readAttachment(rt: Runtime, secretId: string, reportId: string, file: string) {
  return rt.evidence.readAttachment(secretId, reportId, file);
}

// -------------------------------------------------------------------------------------------- Variablen

export interface VariableView {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  link: string | null;
  tags: string[];
  product: string | null;
  stage: Stage;
  value: string | null;
  places: Place[];
}

const variableView = (v: VariableEntry): VariableView => ({
  id: v.id,
  name: v.name,
  description: v.description ?? null,
  owner: v.owner ?? null,
  link: v.link ?? null,
  tags: v.tags,
  product: v.product ?? null,
  stage: v.stage,
  value: v.value,
  places: v.places,
});

export function listVariables(rt: Runtime, filter: { stage?: Stage; repo?: string; product?: string; q?: string; tag?: string } = {}): VariableView[] {
  let list = rt.inventory.data.variables;
  if (filter.tag) list = list.filter((v) => v.tags.includes(filter.tag!));
  if (filter.q) {
    const q = filter.q.toLowerCase();
    list = list.filter((v) => [v.id, v.name, v.description, v.owner, v.product, v.value, ...v.tags, ...v.places.map((p) => p.repo)].some((x) => x?.toLowerCase().includes(q)));
  }
  if (filter.stage) list = list.filter((v) => v.stage === filter.stage);
  if (filter.repo) list = list.filter((v) => v.places.some((p) => p.repo === filter.repo));
  if (filter.product) list = list.filter((v) => v.product === filter.product);
  return list.map(variableView);
}

export function getVariable(rt: Runtime, id: string): VariableView {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  return variableView(v);
}

/** Soll gegen Ist, live aus GitHub. */
export async function inspectVariableLive(rt: Runtime, id: string): Promise<{ variable: VariableView; drift: VariableDrift[] }> {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  return { variable: variableView(v), drift: await inspectVariable(rt.github, rt.owner, v) };
}

export async function addVariable(rt: Runtime, actor: Actor, entry: z.input<typeof VariableSchema>, options: { acknowledgedPublic?: boolean } = {}): Promise<VariableView> {
  if (entry.value !== null && entry.value !== undefined) assertPublicValue(entry.name, entry.value, actor.kind === "human" && Boolean(options.acknowledgedPublic));
  const created = rt.inventory.addVariable(entry);
  await rt.inventory.save();
  return variableView(created);
}

export async function updateVariable(rt: Runtime, actor: Actor, id: string, patch: { value?: string | null; description?: string | null; owner?: string | null; link?: string | null; tags?: string[] | null }, options: { acknowledgedPublic?: boolean } = {}): Promise<VariableView> {
  const current = rt.inventory.getVariable(id);
  if (!current) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  if (typeof patch.value === "string") assertPublicValue(current.name, patch.value, actor.kind === "human" && Boolean(options.acknowledgedPublic));
  const updated = rt.inventory.patchVariable(id, patch);
  await rt.inventory.save();
  return variableView(updated);
}

export async function removeVariable(rt: Runtime, actor: Actor, id: string): Promise<void> {
  requireHuman(actor, "Variablen entfernen");
  rt.inventory.removeVariable(id);
  await rt.inventory.save();
}

export type VariableApplyResult =
  | { status: "applied"; outcomes: { place: string; outcome: string; error?: string }[] }
  | { status: "pending-approval"; approvalId: string; message: string };

/** Setzt den Sollwert in GitHub. Agenten nur in freigegebenen Stages, sonst Freigabe. */
export async function requestApplyVariable(rt: Runtime, actor: Actor, id: string, options: { reason?: string; acknowledgedPublic?: boolean } = {}): Promise<VariableApplyResult> {
  const v = rt.inventory.getVariable(id);
  if (!v) throw new InventoryError(`Variable nicht gefunden: ${id}`);
  if (!agentMayRunNow(rt, actor, v.stage, v.places.length > 0)) {
    const approval = rt.approvals.create({ action: "apply-variable", targetId: id, requestedBy: actor.name, reason: options.reason ?? null });
    return { status: "pending-approval", approvalId: approval.id, message: `Stage ${v.stage} braucht eine Freigabe im Portal (Reiter Freigaben).` };
  }
  const outcomes = await applyVariable(rt.github, rt.owner, v, { acknowledgedPublic: actor.kind === "human" && Boolean(options.acknowledgedPublic) });
  return { status: "applied", outcomes };
}

export async function adoptVariableFromGitHub(rt: Runtime, actor: Actor, id: string): Promise<VariableView> {
  requireHuman(actor, "Werte uebernehmen");
  const v = await adoptVariable(rt.github, rt.owner, rt.inventory, id);
  await rt.inventory.save();
  return variableView(v);
}

// -------------------------------------------------------------------------------------------- Freigaben

export function listApprovals(rt: Runtime) {
  return rt.approvals.list();
}

export function getApproval(rt: Runtime, id: string): Approval {
  const a = rt.approvals.get(id);
  if (!a) throw new PolicyError(`Anfrage nicht gefunden: ${id}`);
  return a;
}

/** Freigabe oder Ablehnung durch einen Menschen. Eine Freigabe startet die Pruefung bzw. setzt die Variable. */
export async function resolveApproval(rt: Runtime, actor: Actor, id: string, decision: "approve" | "deny"): Promise<Approval> {
  requireHuman(actor, "Freigaben erteilen");
  const approval = rt.approvals.get(id);
  if (!approval) throw new PolicyError(`Anfrage nicht gefunden: ${id}`);
  if (decision === "deny") return rt.approvals.resolve(id, "denied");
  try {
    if (approval.action === "issue") {
      const pending = await prepareIssuance(approval.targetId, issuanceDeps(rt));
      rt.issuances.add(pending);
      return rt.approvals.resolve(id, "approved", `Pruefung ${pending.id} wartet auf Bestaetigung`);
    }
    const v = rt.inventory.getVariable(approval.targetId);
    if (!v) throw new InventoryError("Variable nicht gefunden");
    const outcomes = await applyVariable(rt.github, rt.owner, v, { acknowledgedPublic: false });
    const failed = outcomes.some((o) => o.outcome === "failed");
    return rt.approvals.resolve(id, failed ? "failed" : "approved", failed ? "Ziele fehlgeschlagen" : "gesetzt");
  } catch (err) {
    const message = err instanceof RotationError || err instanceof NotConnectedError || err instanceof InventoryError ? err.message : (err as Error).message;
    return rt.approvals.resolve(id, "failed", message.slice(0, 200));
  }
}

// -------------------------------------------------------------------------------------------- Dev-Env

export type DevEnvResult =
  | { status: "written"; path: string; keys: string[]; sources: Record<string, string>; gitIgnored: boolean | null; warnings: string[] }
  | { status: "needs-input"; keys: string[]; message: string };

/**
 * Erzeugt eine .env fuer eine Vorlage. Agenten bekommen nur Pfad, Schluessel und Herkunft zurueck,
 * nie einen Wert, und duerfen nur freigegebene Stages und nur in freigegebene Ordner schreiben.
 */
export async function exportEnv(
  rt: Runtime,
  actor: Actor,
  input: { repo: string; stage?: Stage; template?: string; path?: string; overwrite?: boolean; prompts?: Record<string, string> },
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
  const configured = rt.config.policy.envRoots;
  if (actor.kind === "agent" && configured.length === 0) {
    throw new PolicyError("policy.envRoots ist leer: Agenten duerfen keine Dateien schreiben.");
  }
  // Der verknuepfte Ordner des Repositories gilt als erlaubte Wurzel, aber nur fuer dieses Repository.
  const folder = await linkedFolder(rt, template.repo);
  let target = input.path?.trim() ? input.path.trim() : "";
  if (!target) {
    if (!folder) throw new EnvExportError(`Kein Pfad angegeben und kein Ordner fuer ${template.repo} verknuepft.`);
    target = join(folder, template.file);
    const rel = relative(folder, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new EnvExportError(`Die Vorlage ${template.id} verweist mit "${template.file}" aus dem verknuepften Ordner hinaus.`);
  }
  // Ohne envRoots gilt fuer Menschen keine Einschraenkung; mit envRoots kommt der verknuepfte Ordner hinzu.
  const roots = configured.length > 0 && folder ? [...configured, folder] : configured;
  try {
    const built = await buildEnvFile(template, { inventory: rt.inventory, providers: rt.providers, connections: rt.connections, fetch: rt.fetch, ...(input.prompts ? { prompts: input.prompts } : {}) });
    const written = await writeEnvFile(target, built.text, { overwrite: input.overwrite ?? false, allowedRoots: roots });
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
