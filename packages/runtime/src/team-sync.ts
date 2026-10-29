import { dirname, join } from "node:path";
import {
  GitHubClient,
  GitHubError,
  InventoryError,
  NotConnectedError,
  TEAM_SYNC_CONNECTION,
  TeamBundleError,
  TeamSyncError,
  TeamSyncSchema,
  assertTeamFileClean,
  diffBundles,
  exportTeamBundle,
  mergeTeamBundle,
  parseTeamBundle,
  readTeamSyncState,
  textHash,
  writeTeamSyncConfig,
  writeTeamSyncState,
  type BundleDiff,
  type TeamSyncConfig,
} from "@secret-desk/core";
import type { Runtime } from "./runtime.js";

/** Mindestabstand zwischen zwei Pushs (Entprellung): schnelle Folgeklicks erzeugen keine Folge-Commits. */
export const MIN_PUSH_INTERVAL_MS = 30_000;

export type TeamSyncStateName = "not-configured" | "not-connected" | "in-sync" | "remote-new" | "remote-changed" | "local-changed" | "conflict" | "missing-remote";

export interface TeamSyncStatus {
  configured: boolean;
  connected: boolean;
  repo: string | null;
  path: string | null;
  branch: string | null;
  mode: TeamSyncConfig["mode"] | null;
  pushStrategy: TeamSyncConfig["push"]["strategy"] | null;
  pushBranch: string | null;
  pullOnStart: boolean | null;
  lastSyncAt: string | null;
  lastPushAt: string | null;
  pendingPullUrl: string | null;
  /** Ergebnis der letzten Abfrage (Start oder Button) oder null. Kein Netzwerkzugriff in dieser Funktion. */
  lastCheck: { state: TeamSyncStateName; checkedAt: string } | null;
  lastError: string | null;
  setupNeeded: boolean;
}

export interface TeamSyncCheck {
  state: TeamSyncStateName;
  remoteSha: string | null;
  /** Remote gegenueber lokal: added = nur im Repository, removed = nur lokal. Nur Ids. */
  diff: BundleDiff | null;
  checkedAt: string;
}

const statePath = (rt: Runtime): string => join(dirname(rt.configPath), ".secret-desk-team-sync.json");
const inventoryEmpty = (rt: Runtime): boolean => rt.inventory.data.secrets.length === 0 && rt.inventory.data.variables.length === 0;

function requireConfig(rt: Runtime): TeamSyncConfig {
  const c = rt.config.teamSync;
  if (!c) throw new TeamSyncError("Team-Sync ist nicht eingerichtet (Abschnitt teamSync in der Konfiguration).", "not-configured");
  return c;
}

const client = (rt: Runtime): GitHubClient => new GitHubClient({ auth: () => rt.connections.token(TEAM_SYNC_CONNECTION), fetch: rt.fetch });
const split = (repo: string): [string, string] => {
  const [owner, name] = repo.split("/");
  return [owner!, name!];
};

/** GitHub-Fehler in verstaendliche Meldungen uebersetzen. Meldungen enthalten nie den Token. */
export function mapTeamSyncError(e: unknown): Error {
  if (e instanceof TeamSyncError || e instanceof TeamBundleError || e instanceof NotConnectedError || e instanceof InventoryError) return e;
  if (e instanceof GitHubError) {
    if (e.status === 401) return new TeamSyncError("GitHub hat den Token fuer das Team-Repository abgelehnt (abgelaufen oder ungueltig). Neuen Token unter Verbindungen eintragen.", "denied");
    if (e.status === 403) return new TeamSyncError("Der Token hat nicht die noetigen Rechte fuer das Team-Repository (Contents lesen, zum Schieben auch schreiben, bei Pull Requests Pull requests schreiben).", "denied");
    if (e.status === 404) return new TeamSyncError("Repository, Zweig oder Datei nicht gefunden, oder der Token hat keinen Zugriff auf dieses Repository.", "not-found");
    if (e.status === 409 || e.status === 422) return new TeamSyncError("Das Repository hat sich waehrenddessen geaendert oder lehnt die Aenderung ab. Bitte neu abgleichen.", "conflict");
    return new TeamSyncError(`GitHub-Fehler (${e.status}) beim Team-Sync.`, "network");
  }
  if (e instanceof TypeError) return new TeamSyncError("Keine Verbindung zu GitHub. Netzwerk pruefen und erneut versuchen.", "network");
  return e as Error;
}

async function guarded<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    rt.teamSyncMemo.lastError = null;
    return r;
  } catch (e) {
    const mapped = mapTeamSyncError(e);
    rt.teamSyncMemo.lastError = mapped instanceof NotConnectedError ? null : mapped.message;
    throw mapped;
  }
}

export async function teamSyncStatus(rt: Runtime): Promise<TeamSyncStatus> {
  const c = rt.config.teamSync;
  const st = await readTeamSyncState(statePath(rt));
  const connected = c ? (await rt.connections.status(TEAM_SYNC_CONNECTION)).connected : false;
  const last = rt.teamSyncMemo.lastCheck as TeamSyncCheck | null;
  return {
    configured: Boolean(c),
    connected,
    repo: c?.repo ?? null,
    path: c?.path ?? null,
    branch: c?.branch ?? null,
    mode: c?.mode ?? null,
    pushStrategy: c?.push.strategy ?? null,
    pushBranch: c?.push.branch ?? null,
    pullOnStart: c?.pullOnStart ?? null,
    lastSyncAt: st.lastSyncAt,
    lastPushAt: st.lastPushAt,
    pendingPullUrl: st.pendingPullUrl,
    lastCheck: last ? { state: last.state, checkedAt: last.checkedAt } : null,
    lastError: rt.teamSyncMemo.lastError,
    setupNeeded: !c && inventoryEmpty(rt) && !st.setupDismissed,
  };
}

async function fetchRemote(rt: Runtime, c: TeamSyncConfig) {
  const [owner, name] = split(c.repo);
  const gh = client(rt);
  const file = await gh.getContentFile(owner, name, c.path, c.branch);
  // 404 heisst "Datei fehlt" nur, wenn Repository und Zweig erreichbar sind; sonst ist es ein Zugriffs- oder Namensfehler.
  if (!file && (await gh.getBranchHead(owner, name, c.branch)) === null) throw new GitHubError(404, "Repository oder Zweig nicht gefunden");
  return file;
}

/** Fragt das Repository ab (nur lesend) und vergleicht mit dem lokalen Stand. Ueberschreibt nichts. */
export async function checkTeamSync(rt: Runtime, now: Date = new Date()): Promise<TeamSyncCheck> {
  const c = requireConfig(rt);
  return guarded(rt, async () => {
    const remote = await fetchRemote(rt, c);
    const st = await readTeamSyncState(statePath(rt));
    const localHash = textHash(exportTeamBundle(rt.inventory.data));
    let check: TeamSyncCheck;
    if (!remote) {
      check = { state: "missing-remote", remoteSha: null, diff: null, checkedAt: now.toISOString() };
    } else {
      const diff = diffBundles(rt.inventory.data, parseTeamBundle(remote.text));
      let state: TeamSyncStateName;
      if (diff.empty) {
        state = "in-sync";
        await writeTeamSyncState(statePath(rt), { ...st, remoteSha: remote.sha, localHash, lastSyncAt: now.toISOString() });
      } else {
        const remoteChanged = st.remoteSha !== remote.sha;
        const localChanged = st.localHash !== localHash && !(st.localHash === null && inventoryEmpty(rt));
        if (remoteChanged && localChanged) state = "conflict";
        else if (remoteChanged) state = st.remoteSha === null ? "remote-new" : "remote-changed";
        else state = "local-changed";
      }
      check = { state, remoteSha: remote.sha, diff, checkedAt: now.toISOString() };
    }
    rt.teamSyncMemo.lastCheck = check;
    return check;
  });
}

export type TeamSyncResolution = "merge" | "replace" | "keep-local";

/**
 * Uebernimmt den Stand aus dem Repository. Vorher hat der Mensch die Vorschau gesehen (checkTeamSync); `expectSha` stellt sicher,
 * dass genau dieser Stand uebernommen wird. merge = Neues kommt dazu, Vorhandenes bleibt. replace = Repository gewinnt (braucht confirmReplace).
 * keep-local = den Repository-Stand als gesehen markieren und lokal nichts aendern.
 */
export async function applyTeamSync(rt: Runtime, options: { expectSha: string; resolution: TeamSyncResolution; confirmReplace?: boolean }, now: Date = new Date()) {
  const c = requireConfig(rt);
  if (options.resolution === "replace" && options.confirmReplace !== true) throw new InventoryError("Ersetzen braucht die ausdrueckliche Bestaetigung confirmReplace: true.");
  return guarded(rt, async () => {
    const remote = await fetchRemote(rt, c);
    if (!remote) throw new TeamSyncError("Die Team-Datei gibt es im Repository nicht (mehr).", "not-found");
    if (remote.sha !== options.expectSha) throw new TeamSyncError("Das Repository hat sich seit der Vorschau geaendert. Bitte neu abgleichen.", "changed");
    const bundle = parseTeamBundle(remote.text);
    const st = await readTeamSyncState(statePath(rt));
    let result: { added: string[]; skipped: string[] } = { added: [], skipped: [] };
    if (options.resolution !== "keep-local") {
      result = mergeTeamBundle(rt.inventory, bundle, options.resolution);
      await rt.inventory.save();
    }
    const localHash = options.resolution === "keep-local" ? null : textHash(exportTeamBundle(rt.inventory.data));
    await writeTeamSyncState(statePath(rt), { ...st, remoteSha: remote.sha, localHash, lastSyncAt: now.toISOString(), setupDismissed: true });
    rt.teamSyncMemo.lastCheck = null;
    return { ...result, resolution: options.resolution };
  });
}

export interface TeamPushPlan {
  /** Was das Repository nach dem Push bekommt: added = neu im Repository, removed = fehlt danach. Nur Ids. */
  diff: BundleDiff;
  remoteSha: string | null;
  localHash: string;
  strategy: TeamSyncConfig["push"]["strategy"];
  targetBranch: string;
}

async function teamTokenText(rt: Runtime): Promise<string[]> {
  try {
    return [(await rt.connections.token(TEAM_SYNC_CONNECTION)).reveal()];
  } catch {
    return [];
  }
}

/** Vorschau eines Pushs: Diff und Pruefung, dass die Datei keine Werte enthaelt. Schreibt nichts. */
export async function planTeamPush(rt: Runtime): Promise<TeamPushPlan> {
  const c = requireConfig(rt);
  if (c.mode !== "pull-push") throw new TeamSyncError('Schieben ist ausgeschaltet (teamSync.mode ist "pull"). Auf "pull-push" stellen.', "forbidden-mode");
  return guarded(rt, async () => {
    const text = exportTeamBundle(rt.inventory.data);
    assertTeamFileClean(text, await teamTokenText(rt));
    const remote = await fetchRemote(rt, c);
    const st = await readTeamSyncState(statePath(rt));
    const incoming = remote ? diffBundles(rt.inventory.data, parseTeamBundle(remote.text)) : null;
    // Das Repository hat Neues oder Anderes, das lokal fehlt (nur lokale Zusaetze sind kein Konflikt: genau die werden geschoben).
    if (remote && incoming && st.remoteSha !== remote.sha && Object.values(incoming.sections).some((d) => d.added.length > 0 || d.changed.length > 0)) {
      throw new TeamSyncError("Das Repository hat Aenderungen, die lokal fehlen. Erst abgleichen (Uebernehmen oder Lokal behalten), dann schieben.", "conflict");
    }
    const diff = remote ? diffBundles(parseTeamBundle(remote.text), rt.inventory.data) : diffBundles({ version: 1, secrets: [], variables: [], providers: [], envTemplates: [], stages: [] } as never, rt.inventory.data);
    return { diff, remoteSha: remote?.sha ?? null, localHash: textHash(text), strategy: c.push.strategy, targetBranch: c.push.strategy === "direct" ? c.branch : c.push.branch };
  });
}

/** Vorschau fuer eine hochgeladene Team-Datei: was sie gegenueber dem lokalen Stand hinzufuegt. Aendert nichts. */
export function previewTeamText(rt: Runtime, text: string): BundleDiff {
  return diffBundles(rt.inventory.data, parseTeamBundle(text));
}

const messages = {
  de: { commit: "secret-desk: Team-Konfiguration aktualisiert", title: "secret-desk: Team-Konfiguration aktualisieren", body: "Automatisch vom secret-desk Portal erstellt. Enthaelt nur Struktur, keine Werte. Bitte die Aenderungen pruefen." },
  en: { commit: "secret-desk: update team configuration", title: "secret-desk: update team configuration", body: "Created by the secret-desk portal. Contains structure only, no values. Please review the changes." },
};

/**
 * Schiebt die Team-Datei (ohne Werte) ins Repository. Nur nach ausdruecklicher Bestaetigung eines Menschen (`confirm: true`) und nur,
 * wenn Vorschau und Stand noch passen. Eine einzige Datei pro Commit: es entsteht nie ein halber Stand.
 */
export async function pushTeamSync(rt: Runtime, options: { confirm: boolean; expectLocalHash: string; expectRemoteSha: string | null; lang?: "de" | "en" }, now: Date = new Date()) {
  if (options.confirm !== true) throw new InventoryError("Schieben braucht die ausdrueckliche Bestaetigung confirm: true.");
  const c = requireConfig(rt);
  const plan = await planTeamPush(rt);
  if (plan.localHash !== options.expectLocalHash || plan.remoteSha !== options.expectRemoteSha) throw new TeamSyncError("Der Stand hat sich seit der Vorschau geaendert. Bitte Vorschau neu laden.", "changed");
  const st = await readTeamSyncState(statePath(rt));
  if (st.lastPushAt && now.getTime() - Date.parse(st.lastPushAt) < MIN_PUSH_INTERVAL_MS) throw new TeamSyncError("Der letzte Push ist erst wenige Sekunden her. Bitte kurz warten.", "too-soon");
  if (plan.diff.empty) return { pushed: false as const, strategy: c.push.strategy };
  const text = exportTeamBundle(rt.inventory.data);
  const m = messages[options.lang ?? "de"];
  return guarded(rt, async () => {
    const gh = client(rt);
    const [owner, name] = split(c.repo);
    let remoteSha = st.remoteSha;
    let pendingPullUrl: string | null = null;
    let pullNumber: number | null = null;
    if (c.push.strategy === "direct") {
      remoteSha = await gh.putContentFile(owner, name, c.path, c.branch, text, m.commit, plan.remoteSha ?? undefined);
    } else {
      if ((await gh.getBranchHead(owner, name, c.push.branch)) === null) {
        const base = await gh.getBranchHead(owner, name, c.branch);
        if (base === null) throw new TeamSyncError("Der Zielzweig existiert im Repository nicht.", "not-found");
        await gh.createBranch(owner, name, c.push.branch, base);
      }
      const onBranch = await gh.getContentFile(owner, name, c.path, c.push.branch);
      await gh.putContentFile(owner, name, c.path, c.push.branch, text, m.commit, onBranch?.sha);
      const open = await gh.findOpenPull(owner, name, c.push.branch, c.branch);
      if (open) {
        await gh.updatePull(owner, name, open.number, m.title, m.body);
        pendingPullUrl = open.url;
        pullNumber = open.number;
      } else {
        const created = await gh.createPull(owner, name, c.push.branch, c.branch, m.title, m.body);
        pendingPullUrl = created.url;
        pullNumber = created.number;
      }
    }
    await writeTeamSyncState(statePath(rt), { ...st, remoteSha, localHash: plan.localHash, lastPushAt: now.toISOString(), lastSyncAt: now.toISOString(), pendingPullUrl, setupDismissed: true });
    rt.teamSyncMemo.lastCheck = null;
    return { pushed: true as const, strategy: c.push.strategy, ...(pendingPullUrl ? { pullRequest: { number: pullNumber, url: pendingPullUrl } } : {}) };
  });
}

/** Richtet Team-Sync ein (Assistent oder Umgebungsvariablen): validiert, schreibt teamSync in die Konfigurationsdatei und uebernimmt es sofort. */
export async function setupTeamSync(rt: Runtime, input: unknown): Promise<TeamSyncConfig> {
  const parsed = TeamSyncSchema.safeParse(input);
  if (!parsed.success) throw new InventoryError(`Team-Sync ungueltig: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  try {
    await writeTeamSyncConfig(rt.configPath, parsed.data);
  } catch (e) {
    if (e instanceof TeamSyncError) throw e;
    throw new TeamSyncError("Die Konfigurationsdatei laesst sich nicht schreiben (Rechte des Ordners pruefen).", "unwritable");
  }
  rt.config.teamSync = parsed.data;
  rt.teamSyncMemo.lastCheck = null;
  return parsed.data;
}

/** "Leer starten": der Assistent erscheint nicht mehr. */
export async function dismissTeamSetup(rt: Runtime): Promise<void> {
  const st = await readTeamSyncState(statePath(rt));
  await writeTeamSyncState(statePath(rt), { ...st, setupDismissed: true });
}

/** Umgebungsvariablen fuer den Erststart ohne Klicken (Token nur ueber SECRET_DESK_TEAM_TOKEN, siehe createRuntime). */
export function teamSyncFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
  const repo = env["SECRET_DESK_TEAM_REPO"]?.trim();
  if (!repo) return null;
  return { repo, ...(env["SECRET_DESK_TEAM_PATH"]?.trim() ? { path: env["SECRET_DESK_TEAM_PATH"]!.trim() } : {}), ...(env["SECRET_DESK_TEAM_BRANCH"]?.trim() ? { branch: env["SECRET_DESK_TEAM_BRANCH"]!.trim() } : {}) };
}

/**
 * Beim Start des Portals: Headless-Einrichtung aus der Umgebung (nur wenn noch nichts eingerichtet und das Inventar leer ist,
 * dann wird der Stand einmal uebernommen) und die Abfrage des Repositories bei pullOnStart. Fehler brechen den Start nie ab.
 */
export async function startupTeamSync(rt: Runtime, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const fromEnv = teamSyncFromEnv(env);
    if (fromEnv && !rt.config.teamSync) {
      await setupTeamSync(rt, fromEnv);
      if (inventoryEmpty(rt) && (await rt.connections.status(TEAM_SYNC_CONNECTION)).connected) {
        const check = await checkTeamSync(rt);
        if (check.remoteSha && (check.state === "remote-new" || check.state === "remote-changed")) await applyTeamSync(rt, { expectSha: check.remoteSha, resolution: "merge" });
      }
      return;
    }
    const c = rt.config.teamSync;
    if (c?.pullOnStart && (await rt.connections.status(TEAM_SYNC_CONNECTION)).connected) await checkTeamSync(rt);
  } catch (e) {
    rt.teamSyncMemo.lastError = mapTeamSyncError(e).message;
  }
}



