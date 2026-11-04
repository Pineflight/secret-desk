import { dirname, join } from "node:path";
import {
  GitHubClient,
  GitHubError,
  GitHubInputError,
  githubAppProvider,
  type TokenProvider,
  InventoryError,
  NotConnectedError,
  TEAM_SYNC_CONNECTION,
  TeamBundleError,
  MAX_TEAM_FILE_BYTES,
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
import { GITHUB_APP_KEY_CONNECTION, GITHUB_CONNECTION, type Runtime } from "./runtime.js";
import { metaFits, readTeamTokenMeta, type TeamTokenScope } from "./team-token-meta.js";
import { teamRights, teamRightsLabels, type TeamRights } from "./team-token-rights.js";

/** Mindestabstand zwischen zwei Pushs (Entprellung): schnelle Folgeklicks erzeugen keine Folge-Commits. */
export const MIN_PUSH_INTERVAL_MS = 30_000;

export type TeamSyncStateName = "not-configured" | "not-connected" | "in-sync" | "remote-new" | "remote-changed" | "local-changed" | "conflict" | "missing-remote";

export interface TeamSyncStatus {
  configured: boolean;
  connected: boolean;
  /** Woher das Token kommt: eigenes team-sync-Token oder die GitHub-Integration (PAT/App). Nie der Wert. */
  tokenSource: TeamTokenSource;
  /** Rechte, die das Token fuer die gewaehlte Einstellung braucht. */
  neededRights: string[];
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

/** Woher das Token fuer das Team-Repository kommt. own = eigenes team-sync-Token, github-pat/github-app = die GitHub-Integration. */
export type TeamTokenSource = "own" | "github-pat" | "github-app" | "none";

/** Rechte, die Team-Sync braucht (genau diese, nicht mehr): Lesen reicht fuer mode pull. */
export function teamPermissions(c: { mode: TeamSyncConfig["mode"]; push: { strategy: TeamSyncConfig["push"]["strategy"] } }): TeamRights {
  return teamRights(c.mode, c.push.strategy);
}

/** Rechte als lesbare Liste fuer Befunde und Anleitungen. */
export function neededRights(c: { mode: TeamSyncConfig["mode"]; push: { strategy: TeamSyncConfig["push"]["strategy"] } }): string[] {
  return teamRightsLabels(teamPermissions(c));
}

/** The scope a configured team sync asks the token source about. */
export const scopeOf = (c: { repo: string; mode: TeamSyncConfig["mode"]; push: { strategy: TeamSyncConfig["push"]["strategy"] } }): TeamTokenScope => ({ repo: c.repo, mode: c.mode, strategy: c.push.strategy });

/**
 * Quelle des Tokens: eigenes team-sync-Token (Sitzung, Tresor, Umgebung, op) hat Vorrang vor der GitHub-Integration.
 * A team token the portal created is valid for one repository and one set of rights: it counts only when `scope` names that
 * repository (and, with a mode, rights it covers). A typed-in token has no such limit.
 */
export async function teamTokenSource(rt: Runtime, scope: TeamTokenScope = {}): Promise<TeamTokenSource> {
  if ((await rt.connections.status(TEAM_SYNC_CONNECTION)).connected && metaFits(await readTeamTokenMeta(rt), scope)) return "own";
  const auth = rt.config.github.auth;
  if (auth.type === "pat") return (await rt.connections.status(GITHUB_CONNECTION)).connected ? "github-pat" : "none";
  return (await rt.connections.status(GITHUB_APP_KEY_CONNECTION)).connected ? "github-app" : "none";
}

/** One team sync operation (one check, pull or push): one client and, with a GitHub App, one installation token provider. */
export interface TeamSession {
  gh: GitHubClient;
  source: TeamTokenSource;
  /** Permissions GitHub granted to the installation token minted in this operation, or null (no App token yet / not an App). */
  granted(): Record<string, string> | null;
  /** Secret texts seen in this operation (installation token, App private key). Used only to keep them out of the team file. */
  secrets(): string[];
}

/**
 * Opens a session for the team repository. Own token first; otherwise the GitHub integration: a PAT is used as it is (its rights and
 * repository selection apply). With a GitHub App an installation token for this one repository with exactly the needed rights
 * (contents, pull_requests, metadata) is requested **per operation**: the provider, the private key read and the granted permissions
 * live only as long as this session, nothing is cached across operations or repositories.
 */
async function openSession(rt: Runtime, c: TeamSyncConfig): Promise<TeamSession> {
  const [owner, name] = split(c.repo);
  return openScopedSession(rt, { owner, repositories: [name], permissions: teamPermissions(c), need: { mode: c.mode, strategy: c.push.strategy } });
}

/** What one session may touch: with a GitHub App the installation token is limited to exactly this. */
export interface SessionScope {
  /** Owner (organization or user) the GitHub App installation belongs to. */
  owner: string;
  /** Repository names (without owner). Empty or missing = every repository of the installation. */
  repositories?: string[];
  permissions: Record<string, "read" | "write">;
  /** The mode (and push strategy) the token must serve: a team token made for fewer rights is then not used. */
  need?: { mode: TeamSyncConfig["mode"]; strategy: TeamSyncConfig["push"]["strategy"] };
}

/** Same token resolution as {@link openSession}, for a scope that is not a configured team repository (used by discovery). */
export async function openScopedSession(rt: Runtime, scope: SessionScope): Promise<TeamSession> {
  const only = scope.repositories?.length === 1 ? `${scope.owner}/${scope.repositories[0]}` : undefined;
  const source = await teamTokenSource(rt, { ...(only ? { repo: only } : {}), ...(scope.need ? { mode: scope.need.mode, strategy: scope.need.strategy } : {}) });
  const auth = rt.config.github.auth;
  let granted: Record<string, string> | null = null;
  const seenSecrets: string[] = [];
  let provider: TokenProvider;
  let effective: TeamTokenSource = source;
  if (source === "own" || source === "none") provider = () => rt.connections.token(TEAM_SYNC_CONNECTION);
  else if (source === "github-pat" || auth.type === "pat") {
    provider = () => rt.connections.token(GITHUB_CONNECTION);
    effective = "github-pat";
  } else {
    effective = "github-app";
    let inner: TokenProvider | null = null;
    provider = async () => {
      if (!inner) {
        const privateKey = await rt.connections.token(GITHUB_APP_KEY_CONNECTION);
        seenSecrets.push(privateKey.reveal());
        inner = githubAppProvider({
          appId: auth.appId,
          privateKey,
          owner: scope.owner,
          ...(scope.repositories?.length ? { repositories: scope.repositories } : {}),
          permissions: scope.permissions,
          fetch: rt.fetch,
          onToken: (info) => { granted = info.permissions; },
        });
      }
      const token = await inner();
      const text = token.reveal();
      if (!seenSecrets.includes(text)) seenSecrets.push(text);
      return token;
    };
  }
  return { gh: new GitHubClient({ auth: provider, fetch: rt.fetch }), source: effective, granted: () => granted, secrets: () => [...seenSecrets] };
}

export const split = (repo: string): [string, string] => {
  const [owner, name] = repo.split("/");
  return [owner!, name!];
};

/** GitHub-Fehler in verstaendliche Meldungen uebersetzen. Meldungen enthalten nie den Token. */
export function mapTeamSyncError(e: unknown): Error {
  if (e instanceof TeamSyncError || e instanceof TeamBundleError || e instanceof NotConnectedError || e instanceof InventoryError) return e;
  if (e instanceof GitHubInputError) return new TeamSyncError("Das Team-Repository, der Pfad oder der Zweig enthaelt ungueltige Zeichen oder Pfadbestandteile.", "invalid");
  if (e instanceof GitHubError) {
    if (/access_tokens/.test(e.message) && (e.status === 422 || e.status === 403)) return new TeamSyncError("Die GitHub App hat nicht die noetigen Rechte fuer das Team-Repository oder ist dort nicht installiert. In den Einstellungen der App Contents (und fuer Pull Requests Pull requests) freigeben und die Installation auf das Team-Repository erweitern.", "denied");
    if (/nicht installiert/.test(e.message)) return new TeamSyncError("Die GitHub App ist auf dem Besitzer des Team-Repositories nicht installiert. App dort installieren und das Team-Repository auswaehlen.", "denied");
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
  const tokenSource = c ? await teamTokenSource(rt, scopeOf(c)) : "none";
  const connected = tokenSource !== "none";
  const last = rt.teamSyncMemo.lastCheck as TeamSyncCheck | null;
  return {
    configured: Boolean(c),
    connected,
    tokenSource,
    neededRights: c ? neededRights(c) : [],
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

async function fetchRemote(c: TeamSyncConfig, sess: TeamSession) {
  const [owner, name] = split(c.repo);
  const gh = sess.gh;
  const file = await gh.getContentFile(owner, name, c.path, c.branch);
  // 404 heisst "Datei fehlt" nur, wenn Repository und Zweig erreichbar sind; sonst ist es ein Zugriffs- oder Namensfehler.
  if (!file && (await gh.getBranchHead(owner, name, c.branch)) === null) throw new GitHubError(404, "Repository oder Zweig nicht gefunden");
  if (file && Buffer.byteLength(file.text, "utf8") > MAX_TEAM_FILE_BYTES) throw new TeamBundleError("Team-Datei ist groesser als 1 MiB: wird nicht gelesen.");
  return file;
}

/** Fragt das Repository ab (nur lesend) und vergleicht mit dem lokalen Stand. Ueberschreibt nichts. */
export async function checkTeamSync(rt: Runtime, now: Date = new Date()): Promise<TeamSyncCheck> {
  const c = requireConfig(rt);
  return guarded(rt, async () => {
    const remote = await fetchRemote(c, await openSession(rt, c));
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
 * `onlyAdded` (Start ohne Mensch): nur neue Eintraege kommen dazu; sind geaenderte oder entfernte Eintraege offen, bleibt der Repository-Stand
 * ungesehen, damit die Vorschau sie weiter zur Bestaetigung zeigt.
 */
export async function applyTeamSync(rt: Runtime, options: { expectSha: string; resolution: TeamSyncResolution; confirmReplace?: boolean; onlyAdded?: boolean }, now: Date = new Date()) {
  const c = requireConfig(rt);
  if (options.resolution === "replace" && options.confirmReplace !== true) throw new InventoryError("Ersetzen braucht die ausdrueckliche Bestaetigung confirmReplace: true.");
  return guarded(rt, async () => {
    const remote = await fetchRemote(c, await openSession(rt, c));
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
    let pending = false;
    if (options.onlyAdded) {
      const left = diffBundles(rt.inventory.data, bundle);
      pending = Object.values(left.sections).some((d) => d.changed.length > 0 || d.removed.length > 0);
    }
    await writeTeamSyncState(statePath(rt), { ...st, remoteSha: pending ? st.remoteSha : remote.sha, localHash, lastSyncAt: now.toISOString(), setupDismissed: true });
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

/** Every secret text the team file must never contain: own token, GitHub PAT, App private key, the tokens of every connected provider and the installation token of this operation. */
async function teamTokenText(rt: Runtime, sess?: TeamSession): Promise<string[]> {
  const out: string[] = [];
  for (const id of [TEAM_SYNC_CONNECTION, GITHUB_CONNECTION, GITHUB_APP_KEY_CONNECTION]) {
    try {
      out.push((await rt.connections.token(id)).reveal());
    } catch {
      /* not connected */
    }
  }
  // Every other connected provider (vault, session, env, 1Password): read in memory, compared by the caller, never logged.
  const known = new Set([TEAM_SYNC_CONNECTION, GITHUB_CONNECTION, GITHUB_APP_KEY_CONNECTION]);
  try {
    for (const id of await rt.connections.ids()) {
      if (known.has(id)) continue;
      try {
        out.push((await rt.connections.token(id)).reveal());
      } catch {
        /* configured but not readable */
      }
    }
  } catch {
    /* an unreadable store lists nothing; the exact ids above and the shape patterns still apply */
  }
  if (sess) out.push(...sess.secrets());
  return out;
}

/** Vorschau eines Pushs: Diff und Pruefung, dass die Datei keine Werte enthaelt. Schreibt nichts. */
export async function planTeamPush(rt: Runtime): Promise<TeamPushPlan> {
  const c = requireConfig(rt);
  if (c.mode !== "pull-push") throw new TeamSyncError('Schieben ist ausgeschaltet (teamSync.mode ist "pull"). Auf "pull-push" stellen.', "forbidden-mode");
  return guarded(rt, async () => planWith(rt, c, await openSession(rt, c)));
}

async function planWith(rt: Runtime, c: TeamSyncConfig, sess: TeamSession): Promise<TeamPushPlan> {
  const text = exportTeamBundle(rt.inventory.data);
  assertTeamFileClean(text, await teamTokenText(rt, sess));
  const remote = await fetchRemote(c, sess);
  // Check again: the installation token of this operation exists only after the first request.
  assertTeamFileClean(text, await teamTokenText(rt, sess));
  const st = await readTeamSyncState(statePath(rt));
  const incoming = remote ? diffBundles(rt.inventory.data, parseTeamBundle(remote.text)) : null;
  // Das Repository hat Neues oder Anderes, das lokal fehlt (nur lokale Zusaetze sind kein Konflikt: genau die werden geschoben).
  if (remote && incoming && st.remoteSha !== remote.sha && Object.values(incoming.sections).some((d) => d.added.length > 0 || d.changed.length > 0)) {
    throw new TeamSyncError("Das Repository hat Aenderungen, die lokal fehlen. Erst abgleichen (Uebernehmen oder Lokal behalten), dann schieben.", "conflict");
  }
  const diff = remote ? diffBundles(parseTeamBundle(remote.text), rt.inventory.data) : diffBundles({ version: 1, secrets: [], variables: [], providers: [], envTemplates: [], stages: [] } as never, rt.inventory.data);
  return { diff, remoteSha: remote?.sha ?? null, localHash: textHash(text), strategy: c.push.strategy, targetBranch: c.push.strategy === "direct" ? c.branch : c.push.branch };
}

/**
 * Before any write: the team repository must be private and the token must be able to push. Fails closed, no override.
 * GET /repos must return `permissions.push` for every token type, GitHub App installation tokens included; an absent field fails
 * closed. For a GitHub App the granted installation permissions (contents: write, pull_requests: write for pull-request mode) must
 * also match.
 */
async function assertPushable(c: TeamSyncConfig, sess: TeamSession): Promise<void> {
  const [owner, name] = split(c.repo);
  const info = await sess.gh.getRepo(owner, name);
  if (info.private !== true) throw new TeamSyncError("Das Team-Repository ist nicht privat. Es wird nichts geschrieben.", "team_repo_not_private");
  const problem = pushProblem(c, sess, info);
  if (problem) throw problem;
}

/** The "token cannot push" error, or null when GitHub says the token can (see assertPushable). Pure: no request. */
export function pushProblem(c: Pick<TeamSyncConfig, "push">, sess: Pick<TeamSession, "source" | "granted">, info: { permissions: { push: boolean | null } | null }): TeamSyncError | null {
  const noPush = new TeamSyncError("Der Token darf in das Team-Repository nicht schreiben (oder das Recht laesst sich nicht feststellen). Es wird nichts geschrieben.", "team_repo_no_push");
  if (info.permissions && info.permissions.push !== true) return noPush;
  if (sess.source === "github-app") {
    // Fail closed: GitHub must report permissions.push for the installation token; absent means the right cannot be established.
    if (!info.permissions) return new TeamSyncError("GitHub meldet fuer das Installations-Token kein Schreibrecht (permissions.push fehlt). Es wird nichts geschrieben.", "team_repo_no_push");
    const g = sess.granted();
    if (!g || g["contents"] !== "write" || (c.push.strategy === "pull-request" && g["pull_requests"] !== "write")) return noPush;
  } else if (!info.permissions) return noPush;
  return null;
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
  if (c.mode !== "pull-push") throw new TeamSyncError('Schieben ist ausgeschaltet (teamSync.mode ist "pull"). Auf "pull-push" stellen.', "forbidden-mode");
  // One operation = one session = one installation token.
  const sess = await openSession(rt, c);
  const plan = await guarded(rt, () => planWith(rt, c, sess));
  if (plan.localHash !== options.expectLocalHash || plan.remoteSha !== options.expectRemoteSha) throw new TeamSyncError("Der Stand hat sich seit der Vorschau geaendert. Bitte Vorschau neu laden.", "changed");
  const st = await readTeamSyncState(statePath(rt));
  if (st.lastPushAt && now.getTime() - Date.parse(st.lastPushAt) < MIN_PUSH_INTERVAL_MS) throw new TeamSyncError("Der letzte Push ist erst wenige Sekunden her. Bitte kurz warten.", "too-soon");
  if (plan.diff.empty) return { pushed: false as const, strategy: c.push.strategy };
  const text = exportTeamBundle(rt.inventory.data);
  const m = messages[options.lang ?? "de"];
  return guarded(rt, async () => {
    const gh = sess.gh;
    await assertPushable(c, sess);
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

/** The startup log line: ids (never values) of applied entries and of entries that stay pending for the portal preview. */
export function startupSyncLine(applied: readonly string[], diff: BundleDiff | null | undefined): string {
  const pending = (k: "changed" | "removed") => (diff ? Object.values(diff.sections).flatMap((x) => x[k]) : []);
  const list = (ids: string[]) => `${ids.length}${ids.length ? ` (${ids.join(", ")})` : ""}`;
  return `team sync startup: applied ${applied.length} new entries (${applied.join(", ")}); pending for confirmation: ${list(pending("changed"))} changed, ${list(pending("removed"))} removed`;
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
      if (inventoryEmpty(rt) && (await teamTokenSource(rt, rt.config.teamSync ? scopeOf(rt.config.teamSync) : {})) !== "none") {
        const check = await checkTeamSync(rt);
        // Unattended: only entries that are new are applied. Changed or removed entries stay pending for the portal preview.
        if (check.remoteSha && (check.state === "remote-new" || check.state === "remote-changed")) {
          const r = await applyTeamSync(rt, { expectSha: check.remoteSha, resolution: "merge", onlyAdded: true });
          console.info(startupSyncLine(r.added, check.diff));
        }
      }
      return;
    }
    const c = rt.config.teamSync;
    if (c?.pullOnStart && (await teamTokenSource(rt, scopeOf(c))) !== "none") await checkTeamSync(rt);
  } catch (e) {
    rt.teamSyncMemo.lastError = mapTeamSyncError(e).message;
  }
}




export interface TeamAccessCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail?: string;
}

/** Wie man fehlende Rechte erweitert, je nach Quelle des Tokens. */
function howToExtend(source: TeamTokenSource, c: TeamSyncConfig): string {
  const rights = neededRights(c).join(", ");
  if (source === "github-app") return `GitHub App: In den App-Einstellungen die Rechte ${rights} freigeben und die Installation auf ${c.repo} erweitern (Repository access). Danach den neuen Rechten zustimmen.`;
  return `Token: Bei GitHub unter Settings, Developer settings, Fine-grained tokens das Token bearbeiten: Repository access muss ${c.repo} enthalten, Rechte ${rights}.`;
}

/**
 * Prueft lesend, ob das Token (eigenes oder GitHub-Integration) auf das Team-Repository zugreifen kann und welche Rechte es hat.
 * Bei einer GitHub App steht das Gewaehrte exakt in der Antwort; bei Tokens zeigt nur ein Schreibtest (`deep`: legt einen Probe-Zweig an und loescht
 * ihn wieder) ob Schreiben geht. Zeigt nie einen Tokenwert.
 */
export async function checkTeamSyncAccess(rt: Runtime, options: { deep?: boolean } = {}): Promise<TeamAccessCheck[]> {
  return checkTeamSyncAccessFor(rt, requireConfig(rt), options);
}

/** Same checks for a team sync setting that is not saved yet (the setup pickers check a mode before it is chosen). */
export async function checkTeamSyncAccessFor(rt: Runtime, c: TeamSyncConfig, options: { deep?: boolean } = {}): Promise<TeamAccessCheck[]> {
  const source = await teamTokenSource(rt, scopeOf(c));
  const out: TeamAccessCheck[] = [];
  const label: Record<TeamTokenSource, string> = { own: "eigenes Team-Sync-Token", "github-pat": "GitHub-Integration (Token)", "github-app": "GitHub-Integration (App, Installationstoken nur fuer dieses Repository)", none: "keine" };
  out.push({ id: "source", label: "Token-Quelle", status: source === "none" ? "fail" : "info", detail: label[source] });
  if (source === "none") return out;
  const [owner, name] = split(c.repo);
  const needed = `Noetig: ${neededRights(c).join(", ")}. ${howToExtend(source, c)}`;
  let repoInfo: { permissions: { push: boolean | null } | null } | null = null;
  const sess = await openSession(rt, c);
  const gh = sess.gh;
  try {
    const head = await gh.getBranchHead(owner, name, c.branch);
    out.push(head === null ? { id: "read", label: "Repository lesen", status: "fail", detail: `Repository oder Zweig nicht gefunden, oder kein Zugriff. ${needed}` } : { id: "read", label: "Repository lesen", status: "pass", detail: `${c.repo}, Zweig ${c.branch}` });
    if (head === null) return out;
    try {
      const info = await gh.getRepo(owner, name);
      repoInfo = info;
      out.push(info.private === true ? { id: "private", label: "Repository privat", status: "pass", detail: c.repo } : { id: "private", label: "Repository privat", status: "fail", detail: "Das Team-Repository ist nicht privat. Schieben ist gesperrt, bis es privat ist." });
    } catch (e) {
      out.push({ id: "private", label: "Repository privat", status: "fail", detail: mapTeamSyncError(e).message });
    }
    const file = await gh.getContentFile(owner, name, c.path, c.branch);
    out.push({ id: "file", label: "Team-Datei", status: file ? "pass" : "warn", detail: file ? c.path : `${c.path} fehlt noch im Repository` });
  } catch (e) {
    const err = mapTeamSyncError(e);
    out.push({ id: "read", label: "Repository lesen", status: "fail", detail: `${err.message} ${needed}` });
    return out;
  }
  if (c.mode === "pull-push" && c.push.strategy === "pull-request") {
    try {
      await gh.findOpenPull(owner, name, c.push.branch, c.branch);
      out.push({ id: "pulls", label: "Pull Requests lesen", status: "pass" });
    } catch (e) {
      out.push({ id: "pulls", label: "Pull Requests", status: "fail", detail: `${mapTeamSyncError(e).message} ${needed}` });
    }
  }
  const granted = sess.granted();
  if (source === "github-app" && granted) {
    const want = teamPermissions(c) as Record<string, string>;
    const missing = Object.entries(want).filter(([k, v]) => granted[k] !== v && !(v === "read" && granted[k] === "write"));
    out.push(missing.length === 0 ? { id: "granted", label: "Rechte der App-Installation", status: "pass", detail: Object.entries(granted).map(([k, v]) => `${k}: ${v}`).join(", ") } : { id: "granted", label: "Rechte der App-Installation", status: "fail", detail: `Fehlt: ${missing.map(([k, v]) => `${k}: ${v}`).join(", ")}. ${howToExtend(source, c)}` });
  }
  if (c.mode === "pull-push" && repoInfo) {
    const problem = pushProblem(c, sess, repoInfo);
    out.push(problem ? { id: "push", label: "Schieben erlaubt", status: "fail", detail: `${problem.message} ${needed}` } : { id: "push", label: "Schieben erlaubt", status: "pass" });
  }
  if (c.mode === "pull-push") {
    if (!options.deep) out.push({ id: "write", label: "Schreiben", status: "info", detail: "Nicht geprueft (Schreibtest legt kurz einen Probe-Zweig an und loescht ihn wieder). Mit Schreibtest pruefen." });
    else {
      const probe = `secret-desk/permission-probe-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const base = await gh.getBranchHead(owner, name, c.branch);
        if (base === null) throw new TeamSyncError("Zielzweig nicht gefunden.", "not-found");
        await gh.createBranch(owner, name, probe, base);
        out.push({ id: "write", label: "Schreiben (Contents)", status: "pass", detail: "Probe-Zweig angelegt und wieder geloescht" });
      } catch (e) {
        out.push({ id: "write", label: "Schreiben (Contents)", status: "fail", detail: `${mapTeamSyncError(e).message} ${needed}` });
      } finally {
        await gh.deleteBranch(owner, name, probe).catch(() => undefined);
      }
    }
  }
  return out;
}
