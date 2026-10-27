import { join, posix } from "node:path";
import { connectionGuide } from "./connection-guides.js";
import {
  EnvEntrySchema,
  EnvExportError,
  EnvTemplateSchema,
  InventoryError,
  NotConnectedError,
  PromptsRequiredError,
  RotationError,
  SecretAgentCreateSchema,
  SecretAgentPatchSchema,
  SecretHumanPatchSchema,
  SecretValue,
  StaleIssuanceError,
  VariableAgentCreateSchema,
  parseInput,
  secretApprovalSnapshot,
  variableApprovalSnapshot,
  agentStageIds,
  adoptVariable,
  applyVariable,
  assertPublicValue,
  buildEnvFile,
  commitIssuance,
  computeStatus,
  discardIssuance,
  exportTeamBundle,
  inspectVariable,
  isPathInside,
  overallStatus,
  planRotation,
  prepareIssuance,
  renderEvidenceSvg,
  writeEnvFile,
  type CommitResult,
  type OverallStatus,
  type PendingIssuance,
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
import type { AutomationInfo, AutomationRunState } from "./automation.js";
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
  actor.kind === "human" || (agentStageIds(rt.config, rt.inventory.stages).includes(stage) && hasPlaces);

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
  /** Der Wert entsteht ueber ein Browserfenster (Rezept), nicht ueber eine API. */
  browser: boolean;
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
    browser: rt.automation.isBrowserProvider(provider),
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
  const byStage: Record<Stage, number> = Object.fromEntries(rt.inventory.stages.map((d) => [d.id, 0]));
  const byStatus: Record<StatusLevel, number> = { ok: 0, unknown: 0, soon: 0, "no-date": 0, due: 0, missing: 0, expired: 0 };
  for (const v of all) {
    byStage[v.stage] = (byStage[v.stage] ?? 0) + 1;
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
  return rt.providers.list().map((p) => ({ id: p.id, label: p.label, kind: p.kind, browser: rt.automation.isBrowserProvider(p), connection: p.connection ?? null, guide: p.guide ? { url: p.guide.url, steps: p.guide.steps } : null }));
}

export async function listConnections(rt: Runtime) {
  const ids = [...new Set(["github", "github-app-key", ...rt.providers.list().flatMap((p) => (p.connection ? [p.connection] : []))])];
  const statuses = await rt.connections.statuses(ids);
  return statuses.map((s) => {
    const g = connectionGuide(s.id, rt.owner);
    const days = s.expires ? Math.ceil((Date.parse(`${s.expires}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
    return { ...s, canRemember: Boolean(rt.connections.vault), daysLeft: days, label: g?.label ?? s.id, description: g?.description ?? null, url: g?.url ?? null, openUrl: g ? g.openUrl ?? g.url : null, steps: g?.steps ?? [], permissions: g?.permissions ?? [] };
  });
}

/** Dateinamen, die Agenten als .env-Ziel nutzen duerfen: .env, .env.local, .env.development ... (nicht .envrc, .npmrc, Makefile, *.sh). */
export const AGENT_ENV_FILENAME = /^\.env(?:\.(?!(?:sh|bash|zsh|fish|ksh|csh|command|ps1|bat|cmd|py|js|mjs|cjs|rb|pl|php)$)[A-Za-z0-9_-]+)*$/i;
const agentMayWriteEnvFile = (path: string): boolean => AGENT_ENV_FILENAME.test(posix.basename(path.replace(/\\/g, "/")));

/** Parameter-Namen, ueber die ein Anbieter ein Netzwerkziel bekommen koennte. Agenten setzen sie nie; ein Mensch im Portal. */
const NETWORK_PARAM_KEYS = new Set(["baseurl", "url", "endpoint", "host", "hostname", "origin", "webhookurl", "server"]);

const agentStages = (rt: Runtime): string[] => agentStageIds(rt.config, rt.inventory.stages);

/**
 * Neue Eintraege. Menschen: alles, was das Schema erlaubt. Agenten: nur Stages der Art dev, nur bekannte Anbieter,
 * keine Netzwerkziele in params, keine Pruefstempel und keine Anbieter-Kennung. Ausgeloest wird dadurch nichts.
 */
export async function addSecret(rt: Runtime, actor: Actor, entry: unknown): Promise<SecretView> {
  if (actor.kind === "agent") {
    const e = parseInput(SecretAgentCreateSchema, entry);
    if (!agentStages(rt).includes(e.stage)) throw new PolicyError(`Agenten legen Eintraege nur in Stages der Art dev an (Stage ${e.stage}). Stage angeben.`);
    if (e.provider !== "manual" && !rt.providers.get(e.provider)) throw new InventoryError(`Unbekannter Anbieter: ${e.provider}`);
    const bad = Object.keys(e.params).filter((k) => NETWORK_PARAM_KEYS.has(k.toLowerCase()));
    if (bad.length > 0) throw new PolicyError(`Agenten setzen keine Adressen in params (${bad.join(", ")}). Das macht ein Mensch im Portal.`);
  }
  const created = rt.inventory.addSecret(entry as z.input<typeof SecretSchema>);
  await rt.inventory.save();
  return view(rt, created, new Date());
}

/**
 * Aenderung an einem bestehenden Eintrag. Mensch: ausdruecklich benannte, bearbeitbare Felder.
 * Agent: nur title, description, owner, link, tags, notes, product. Alles andere ist ein Fehler (nicht ignoriert).
 */
export async function updateSecretMeta(rt: Runtime, actor: Actor, id: string, patch: unknown): Promise<SecretView> {
  const parsed = actor.kind === "agent" ? parseInput(SecretAgentPatchSchema, patch) : parseInput(SecretHumanPatchSchema, patch);
  const updated = rt.inventory.patchSecret(id, parsed as Parameters<Runtime["inventory"]["patchSecret"]>[1]);
  await rt.inventory.save();
  return view(rt, updated, new Date());
}

export async function addManualProvider(rt: Runtime, _actor: Actor, def: z.input<typeof ProviderDefSchema>) {
  // Ein neuer Anbieter darf keinen bestehenden ersetzen (auch keinen eingebauten): sonst waere ein automatischer ploetzlich ein manueller.
  const wanted = (def as { id?: unknown }).id;
  if (typeof wanted === "string" && rt.providers.get(wanted)) throw new InventoryError(`Anbieter existiert schon: ${wanted}`);
  const created = rt.inventory.addProvider(def);
  await rt.inventory.save();
  rt.providers.register({ id: created.id, label: created.label, kind: "manual", guide: { url: created.url, steps: created.steps } });
  return created;
}

/** Agenten: nur Dev-Stages, nur .env-Dateinamen, `issue`-Quellen nur aus Dev-Stages. */
function assertAgentTemplate(rt: Runtime, stage: string, file: string | undefined, entries: z.output<typeof EnvEntrySchema>[]): void {
  if (!agentStages(rt).includes(stage)) throw new PolicyError(`Agenten legen Vorlagen nur fuer Stages der Art dev an (Stage ${stage}).`);
  if (file !== undefined && !agentMayWriteEnvFile(file)) throw new PolicyError("Agenten duerfen nur Dateien namens .env oder .env.* als Ziel einer Vorlage setzen.");
  for (const e of entries) {
    if (e.from.type !== "issue") continue;
    const s = rt.inventory.getSecret(e.from.secret);
    if (s && !agentStages(rt).includes(s.stage)) throw new PolicyError(`Agenten duerfen kein Secret aus Stage ${s.stage} in eine Vorlage aufnehmen.`);
  }
}

export async function addEnvTemplate(rt: Runtime, actor: Actor, template: z.input<typeof EnvTemplateSchema>) {
  if (actor.kind === "agent") {
    const t = parseInput(EnvTemplateSchema, template);
    assertAgentTemplate(rt, t.stage, t.file, t.entries);
  }
  const created = rt.inventory.addEnvTemplate(template);
  await rt.inventory.save();
  return created;
}

export async function addEnvEntry(rt: Runtime, actor: Actor, templateId: string, entry: z.input<typeof EnvEntrySchema>) {
  if (actor.kind === "agent") {
    const t = rt.inventory.data.envTemplates.find((x) => x.id === templateId);
    if (!t) throw new InventoryError(`Vorlage nicht gefunden: ${templateId}`);
    assertAgentTemplate(rt, t.stage, t.file, [parseInput(EnvEntrySchema, entry)]);
  }
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

/**
 * prepareIssuance; bei einem Browser-Anbieter als verfolgter Lauf (Zustand, Abbruch, nur einer gleichzeitig)
 * und mit den Belegen des Browsers als Anlagen am Bericht.
 */
async function prepareTracked(rt: Runtime, secretId: string): Promise<PendingIssuance> {
  const secret = rt.inventory.getSecret(secretId);
  const provider = secret ? rt.providers.get(secret.provider) : undefined;
  if (!rt.automation.isBrowserProvider(provider)) return prepareIssuance(secretId, issuanceDeps(rt));
  return rt.automation.run(
    secretId,
    provider,
    async () => {
      const pending = await prepareIssuance(secretId, issuanceDeps(rt));
      await rt.automation.attach(provider, secretId, pending.report.id);
      return pending;
    },
    (p) => p.id,
  );
}

// ------------------------------------------------------------------------------ Browser-Automatisierung

export function getAutomation(rt: Runtime, actor: Actor): AutomationInfo {
  requireHuman(actor, "Die Browser-Automatisierung ansehen");
  return rt.automation.info();
}

export function getAutomationRun(rt: Runtime, actor: Actor, secretId: string): AutomationRunState {
  requireHuman(actor, "Browser-Laeufe ansehen");
  return rt.automation.state(secretId);
}

export function cancelAutomationRun(rt: Runtime, actor: Actor, secretId: string): AutomationRunState {
  requireHuman(actor, "Browser-Laeufe abbrechen");
  return rt.automation.cancel(secretId);
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
  // Ein Browser-Lauf oeffnet ein Fenster am Rechner des Menschen: Agenten brauchen dafuer in jeder Stage eine Freigabe.
  const browser = actor.kind === "agent" && rt.automation.isBrowserProvider(rt.providers.get(secret.provider));
  if (browser || !agentMayRunNow(rt, actor, secret.stage, secret.places.length > 0)) {
    const approval = rt.approvals.create({ action: "issue", targetId: secretId, requestedBy: actor.name, reason: options.reason ?? null, snapshot: secretApprovalSnapshot(secret) });
    return {
      status: "pending-approval",
      approvalId: approval.id,
      secretId,
      message: browser ? "Dieser Anbieter oeffnet ein Browserfenster. Das braucht immer eine Freigabe im Portal (Reiter Freigaben)." : `Stage ${secret.stage} braucht eine Freigabe im Portal (Reiter Freigaben).`,
    };
  }
  // Aufraeumen abgelaufener Pruefungen passiert beim Start einer neuen Ausstellung (und im Takt des Portals), nie beim Lesen.
  await rt.issuances.sweep(issuanceDeps(rt));
  const pending = await prepareTracked(rt, secretId);
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

/** Lesend und ohne Nebenwirkung: Abgelaufene werden nur ausgeblendet. Verworfen (und beim Anbieter widerrufen) werden sie im Takt, nicht hier. */
const alive = (p: { expiresAt: string }): boolean => Date.parse(p.expiresAt) > Date.now();

export async function listIssuances(rt: Runtime): Promise<IssuanceView[]> {
  return rt.issuances.list().filter(alive).map(issuanceView);
}

export async function getIssuance(rt: Runtime, id: string): Promise<IssuanceView> {
  const p = rt.issuances.get(id);
  if (!p || !alive(p)) throw new PolicyError(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
  return issuanceView(p);
}

export async function confirmIssuance(rt: Runtime, actor: Actor, id: string, input: { ticks: string[]; note?: string; force?: boolean }): Promise<CommitResult> {
  requireHuman(actor, "Bestaetigen");
  await rt.issuances.sweep(issuanceDeps(rt));
  const pending = rt.issuances.get(id);
  if (!pending) throw new PolicyError(`Pruefung nicht gefunden oder abgelaufen: ${id}`);
  try {
    const result = await commitIssuance(pending, issuanceDeps(rt), { by: actor.name, ticks: input.ticks, ...(input.note ? { note: input.note } : {}) }, { force: Boolean(input.force) });
    if (result.ok) rt.issuances.delete(id);
    return result;
  } catch (err) {
    // Der neue Wert ist beim Anbieter schon widerrufen: die Pruefung ist nicht mehr zu retten.
    if (err instanceof StaleIssuanceError) rt.issuances.delete(id);
    throw err;
  }
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
  if (actor.kind === "agent") parseInput(VariableAgentCreateSchema, entry);
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
    const approval = rt.approvals.create({ action: "apply-variable", targetId: id, requestedBy: actor.name, reason: options.reason ?? null, snapshot: variableApprovalSnapshot(v) });
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
  if (approval.state !== "pending") throw new PolicyError(`Anfrage ist schon erledigt: ${approval.state}`);
  if (decision === "deny") return rt.approvals.resolve(id, "denied");
  // Die Freigabe gilt fuer den Inhalt von damals. Hat sich der Eintrag (Ziele, Sollwert, Stage, Anbieter, Parameter) geaendert, verfaellt sie.
  const target = approval.action === "issue" ? rt.inventory.getSecret(approval.targetId) : rt.inventory.getVariable(approval.targetId);
  const nowHash = !target ? null : approval.action === "issue" ? secretApprovalSnapshot(target as SecretEntry).hash : variableApprovalSnapshot(target as VariableEntry).hash;
  if (nowHash !== approval.snapshotHash) return rt.approvals.resolve(id, "stale", "Der Eintrag hat sich seit der Anfrage geaendert, Freigabe verworfen.");
  try {
    if (approval.action === "issue") {
      const pending = await prepareTracked(rt, approval.targetId);
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
  if (actor.kind === "agent" && input.overwrite) throw new PolicyError("Bestehende Dateien ueberschreiben darf nur ein Mensch.");
  const stage: Stage = input.stage ?? (rt.inventory.stages.find((d) => d.kind === "dev")?.id ?? "dev");
  if (actor.kind === "agent" && !agentStageIds(rt.config, rt.inventory.stages).includes(stage)) {
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
    if (!isPathInside(folder, target)) throw new EnvExportError(`Die Vorlage ${template.id} verweist mit "${template.file}" aus dem verknuepften Ordner hinaus.`);
  }
  if (actor.kind === "agent" && !agentMayWriteEnvFile(target)) throw new PolicyError("Agenten duerfen nur Dateien namens .env oder .env.* schreiben (nicht .envrc, .npmrc, Makefile, *.sh).");
  // Ohne envRoots gilt fuer Menschen keine Einschraenkung; mit envRoots kommt der verknuepfte Ordner hinzu.
  const roots = configured.length > 0 && folder ? [...configured, folder] : configured;
  try {
    const built = await buildEnvFile(template, { inventory: rt.inventory, providers: rt.providers, connections: rt.connections, fetch: rt.fetch, providerConfig: rt.config.providers, ...(actor.kind === "agent" ? { allowedIssueStages: agentStages(rt) } : {}), ...(input.prompts ? { prompts: input.prompts } : {}) });
    const written = await writeEnvFile(target, built.text, { overwrite: actor.kind === "human" && (input.overwrite ?? false), allowedRoots: roots });
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
