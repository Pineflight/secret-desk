import {
  GitHubError,
  InventoryError,
  NotConnectedError,
  placeToTarget,
  sealForGitHub,
  stageKind,
  type CheckStatus,
  type GitHubTarget,
  type Place,
} from "@secret-desk/core";
import { safeText } from "@secret-desk/providers";
import type { Runtime } from "./runtime.js";

/** Feste Namen der Probe-Eintraege des Schreibtests. */
export const WRITE_PROBE_SECRET = "SD_WRITE_PROBE";
export const WRITE_PROBE_VARIABLE = "SD_WRITE_PROBE_VAR";

export interface ConnectionCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface ConnectionCheckResult {
  id: string;
  /** false, sobald ein Pruefpunkt fehlgeschlagen ist. */
  ok: boolean;
  checks: ConnectionCheckItem[];
  /** Tag (YYYY-MM-DD), bis zu dem der Token gilt, wenn der Anbieter es nennt; null = laut Anbieter ohne Ablauf. Fehlt: unbekannt. */
  expires?: string | null;
  /** Rechte (Scopes), wenn der Anbieter sie nennt. */
  scopes?: string[];
}

export interface ConnectionCheckOptions {
  /** Nur GitHub: zusaetzlich ein Probe-Eintrag anlegen und sofort loeschen. */
  deep?: boolean;
  /** Nur GitHub, nur mit deep: die Ziele (Ids aus listWriteTargets), die den Schreibtest bekommen. */
  targets?: string[];
}

export interface WriteTarget {
  id: string;
  repo: string;
  scope: Place["scope"];
  environment: string | null;
  /** Mindestens ein Eintrag mit einer Stage der Art live (oder unbekannt) liegt hier. */
  live: boolean;
  /** Stages der Eintraege, die dieses Ziel nutzen. */
  stages: string[];
}

const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const MAX_TARGETS = 40;

export const targetId = (p: Pick<Place, "repo" | "scope" | "environment">): string => `${p.scope}:${p.repo}${p.environment ? `/${p.environment}` : ""}`;

/** Alle Ziele (Repository, Environment, Organisation), die im Inventar vorkommen. Nur Namen. */
export function listWriteTargets(rt: Runtime): WriteTarget[] {
  const map = new Map<string, WriteTarget & { _stages: Set<string> }>();
  const entries = [...rt.inventory.data.secrets, ...rt.inventory.data.variables];
  for (const e of entries) {
    const live = stageKind(rt.inventory.stages, e.stage) === "live";
    for (const p of e.places) {
      const id = targetId(p);
      const cur = map.get(id) ?? { id, repo: p.repo, scope: p.scope, environment: p.environment ?? null, live: false, stages: [], _stages: new Set<string>() };
      cur.live = cur.live || live;
      cur._stages.add(e.stage);
      map.set(id, cur);
    }
  }
  return [...map.values()]
    .map(({ _stages, ...t }) => ({ ...t, stages: [..._stages].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const tk = (t: string): string[] => (t ? [t] : []);

const item = (id: string, label: string, status: CheckStatus, detail?: string): ConnectionCheckItem => ({ id, label, status, ...(detail ? { detail } : {}) });

interface Reply {
  status: number;
  headers: Headers;
  json: unknown;
}

class CheckFetchError extends Error {}

/** Lesender Aufruf mit Bearer-Token. Keine Weiterleitung, Zeitlimit, Meldungen ohne den Token. */
async function get(rt: Runtime, token: string, url: string, headers: Record<string, string> = {}): Promise<Reply> {
  let res: Response;
  try {
    res = await rt.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "secret-desk", ...headers }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = (err as Error).name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "Zeitueberschreitung nach 15 s" : safeText((err as Error).message ?? "Fehler", tk(token));
    throw new CheckFetchError(`Anfrage fehlgeschlagen: ${reason}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json };
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function daysFromNow(day: string, now: Date): number {
  return Math.ceil((Date.parse(`${day}T00:00:00Z`) - now.getTime()) / DAY_MS);
}

/** "2026-12-01 10:00:00 UTC" oder ISO-Zeitpunkt -> "2026-12-01"; sonst null. */
function toDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1]! : null;
}

function expiryItem(day: string, now: Date, recommendMaxDays?: number): ConnectionCheckItem {
  const days = daysFromNow(day, now);
  if (days < 0) return item("expiry", "Ablauf", "fail", `Der Token ist am ${day} abgelaufen. Neu verbinden.`);
  if (days <= 7) return item("expiry", "Ablauf", "warn", `Der Token laeuft in ${days} Tagen ab (${day}).`);
  if (recommendMaxDays !== undefined && days > recommendMaxDays) return item("expiry", "Ablauf", "warn", `Der Token gilt noch ${days} Tage (bis ${day}). Empfohlen sind hoechstens ${recommendMaxDays} Tage.`);
  return item("expiry", "Ablauf", "pass", `Der Token gilt noch ${days} Tage (bis ${day}).`);
}

function httpFail(status: number): string {
  return `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Anbieter
// ---------------------------------------------------------------------------

async function checkCloudflare(rt: Runtime, id: string, token: string, now: Date): Promise<ConnectionCheckResult> {
  const checks: ConnectionCheckItem[] = [];
  const r = await get(rt, token, "https://api.cloudflare.com/client/v4/user/tokens/verify");
  const result = rec(rec(r.json)["result"]);
  let expires: string | null | undefined;
  if (r.status === 200 && rec(r.json)["success"] === true) {
    const active = result["status"] === "active";
    checks.push(item("token", "Token gueltig", active ? "pass" : "fail", active ? undefined : `Status beim Anbieter: ${safeText(String(result["status"] ?? "unbekannt"), tk(token))}`));
    const day = toDay(typeof result["expires_on"] === "string" ? result["expires_on"] : null);
    if (day) {
      expires = day;
      checks.push(expiryItem(day, now, id === "cloudflare" ? 7 : undefined));
    } else {
      expires = null;
      checks.push(item("expiry", "Ablauf", id === "cloudflare" ? "warn" : "info", id === "cloudflare" ? "Der Token hat keinen Ablauf. Empfohlen: 1 bis 7 Tage." : "Der Token hat keinen Ablauf."));
    }
  } else if (r.status === 401 || r.status === 403) {
    checks.push(item("token", "Token gueltig", "fail", `Der Anbieter lehnt den Token ab (${httpFail(r.status)}). Neu verbinden.`));
  } else {
    checks.push(item("token", "Token gueltig", "fail", `Unerwartete Antwort (${httpFail(r.status)})`));
  }
  return { id, ok: !checks.some((c) => c.status === "fail"), checks, ...(expires !== undefined ? { expires } : {}) };
}

async function checkSupabase(rt: Runtime, token: string): Promise<ConnectionCheckItem[]> {
  const r = await get(rt, token, "https://api.supabase.com/v1/organizations");
  if (r.status === 200) return [item("token", "Token gueltig", "pass", "Organisationen lassen sich lesen.")];
  if (r.status === 401) return [item("token", "Token gueltig", "fail", "Der Token ist ungueltig oder abgelaufen (HTTP 401). Neu verbinden.")];
  if (r.status === 403) return [item("token", "Token gueltig", "fail", "Dem Token fehlen Rechte (HTTP 403). Organisation und Rechte pruefen.")];
  return [item("token", "Token gueltig", "fail", `Unerwartete Antwort (${httpFail(r.status)})`)];
}

async function checkStripe(rt: Runtime, id: string, token: string): Promise<ConnectionCheckItem[]> {
  const out: ConnectionCheckItem[] = [];
  const mode = /^[rs]k_(test|live)_/.exec(token)?.[1];
  if (mode) {
    out.push(item("mode", "Modus", "info", mode === "live" ? "Live" : "Sandbox"));
    if ((id === "stripe-test" && mode === "live") || (id === "stripe-live" && mode === "test")) {
      out.push(item("mode-match", "Modus passt zur Verbindung", "fail", mode === "live" ? "Ein Live-Schluessel gehoert nicht in die Sandbox-Verbindung." : "Ein Sandbox-Schluessel gehoert nicht in die Live-Verbindung."));
    }
  }
  const r = await get(rt, token, "https://api.stripe.com/v1/balance");
  if (r.status === 200) out.push(item("token", "Schluessel gueltig", "pass", "Der Schluessel darf das Guthaben lesen."));
  else if (r.status === 401) out.push(item("token", "Schluessel gueltig", "fail", "Der Schluessel ist ungueltig oder widerrufen (HTTP 401). Neu verbinden."));
  else if (r.status === 403) out.push(item("token", "Schluessel gueltig", "info", "Der Schluessel hat kein Recht auf Balance (HTTP 403). Bei einem eingeschraenkten Schluessel ist das normal."));
  else out.push(item("token", "Schluessel gueltig", "fail", `Unerwartete Antwort (${httpFail(r.status)})`));
  return out;
}

async function checkResend(rt: Runtime, token: string): Promise<ConnectionCheckItem[]> {
  const r = await get(rt, token, "https://api.resend.com/api-keys");
  if (r.status === 200) return [item("token", "Schluessel gueltig", "pass", "API-Keys lassen sich lesen: Full access ist plausibel.")];
  if (r.status === 401 || r.status === 403) return [item("token", "Schluessel gueltig", "fail", `Der Schluessel wird abgelehnt (${httpFail(r.status)}). Er braucht Full access, nicht Sending access.`)];
  return [item("token", "Schluessel gueltig", "fail", `Unerwartete Antwort (${httpFail(r.status)})`)];
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function githubProblem(err: unknown, token: string, what: string): ConnectionCheckItem {
  if (err instanceof GitHubError) {
    if (err.status === 401) return item(what, "", "fail", "GitHub lehnt den Token ab (HTTP 401). Neu verbinden.");
    if (err.status === 403 && /not accessible by (personal access )?token|not accessible by integration/i.test(err.message)) {
      return item(what, "", "fail", "Dem Token fehlt ein Recht (Resource not accessible by personal access token). Noetig: Secrets und Environments jeweils Read and write, dazu Variables (HTTP 403).");
    }
    if (err.status === 403) return item(what, "", "fail", `GitHub verweigert den Zugriff (HTTP 403): ${safeText(err.message, tk(token))}`);
    if (err.status === 404) return item(what, "", "fail", "Nicht gefunden oder nicht freigegeben (HTTP 404). Das Repository oder Environment muss existieren und dem Token freigegeben sein.");
    return item(what, "", "fail", `GitHub meldet HTTP ${err.status}`);
  }
  if (err instanceof NotConnectedError) return item(what, "", "fail", "Nicht verbunden");
  return item(what, "", "fail", `Anfrage fehlgeschlagen: ${safeText(err instanceof Error ? err.message : "Fehler", tk(token))}`);
}

const where = (t: GitHubTarget): string => (t.scope === "environment" ? `${t.repo}/${t.environment}` : t.scope === "organization" ? `Organisation ${t.owner}` : t.repo);

async function checkGitHub(rt: Runtime, opts: ConnectionCheckOptions, now: Date): Promise<ConnectionCheckResult> {
  const checks: ConnectionCheckItem[] = [];
  let expires: string | null | undefined;
  let scopes: string[] | undefined;
  const pat = rt.config.github.auth.type === "pat";
  let token = "";
  if (pat) {
    token = (await rt.connections.token("github")).reveal();
    const r = await get(rt, token, "https://api.github.com/user", { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    if (r.status === 200) {
      const login = rec(r.json)["login"];
      checks.push(item("login", "Anmeldung", "pass", typeof login === "string" ? `Angemeldet als ${safeText(login, tk(token))}` : "Angemeldet"));
      const day = toDay(r.headers.get("github-authentication-token-expiration"));
      if (day) {
        expires = day;
        checks.push(expiryItem(day, now));
      } else {
        expires = null;
        checks.push(item("expiry", "Ablauf", "warn", "GitHub nennt keinen Ablauf: Der Token laeuft nie ab. Empfohlen: 90 Tage."));
      }
      const sc = r.headers.get("x-oauth-scopes");
      if (sc) scopes = sc.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (r.status === 401) {
      checks.push(item("login", "Anmeldung", "fail", "GitHub lehnt den Token ab (HTTP 401): ungueltig oder abgelaufen. Neu verbinden."));
    } else {
      checks.push(item("login", "Anmeldung", "fail", `Unerwartete Antwort (${httpFail(r.status)})`));
    }
  } else {
    checks.push(item("login", "Anmeldung", "info", "Die Anmeldung laeuft ueber eine GitHub App: kein Benutzer-Test."));
  }

  const loginFailed = checks.some((c) => c.id === "login" && c.status === "fail");
  const all = listWriteTargets(rt).slice(0, MAX_TARGETS);
  if (!loginFailed) {
    for (const t of all) {
      const target = placeToTarget(rt.owner, { repo: t.repo, scope: t.scope, ...(t.environment ? { environment: t.environment } : {}) });
      const label = `Ziel ${where(target)}`;
      try {
        await rt.github.publicKey(target);
        checks.push(item(`target:${t.id}`, label, "pass", "Public Key lesbar: Secrets koennen hier abgelegt werden."));
      } catch (err) {
        const p = githubProblem(err, token, `target:${t.id}`);
        checks.push({ ...p, label });
      }
    }
    if (all.length === 0) checks.push(item("targets", "Ziele", "info", "Im Inventar ist noch kein Ziel eingetragen."));
  }

  // Optional: Contents: Read, damit der Vergleich Workflow-Dateien lesen kann. Fehlt es, ist das nur ein Hinweis.
  if (!loginFailed && all[0]) {
    try {
      await rt.github.listWorkflowFiles(rt.owner, all[0].repo);
      checks.push(item("contents", "Workflow-Dateien (optional)", "pass", "Contents ist lesbar: Der Vergleich kann zeigen, was Workflows brauchen."));
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 403 || err.status === 401)) {
        checks.push(item("contents", "Workflow-Dateien (optional)", "info", "Dem Token fehlt Contents: Read (optional). Ohne das liest der Vergleich keine Workflow-Dateien aus GitHub; lokal verknuepfte Repositories gehen trotzdem."));
      } else if (!(err instanceof GitHubError && err.status === 404)) {
        checks.push(item("contents", "Workflow-Dateien (optional)", "info", "Workflow-Dateien konnten nicht geprueft werden."));
      }
    }
  }

  if (opts.deep && !loginFailed) {
    const wanted = opts.targets ?? [];
    if (wanted.length === 0) checks.push(item("write", "Schreibtest", "info", "Kein Ziel ausgewaehlt: nichts geschrieben."));
    for (const id of wanted) {
      const t = all.find((x) => x.id === id);
      if (!t) {
        checks.push(item(`write:${id}`, "Schreibtest", "warn", "Dieses Ziel kommt im Inventar nicht vor: uebersprungen."));
        continue;
      }
      const target = placeToTarget(rt.owner, { repo: t.repo, scope: t.scope, ...(t.environment ? { environment: t.environment } : {}) });
      checks.push(...(await writeProbe(rt, target, t.id, token)));
    }
  }
  return { id: "github", ok: !checks.some((c) => c.status === "fail"), checks, ...(expires !== undefined ? { expires } : {}), ...(scopes ? { scopes } : {}) };
}

/** Legt ein Probe-Secret und eine Probe-Variable an und loescht beide sofort. Bestehende Eintraege gleichen Namens bleiben unberuehrt. */
async function writeProbe(rt: Runtime, target: GitHubTarget, id: string, token: string): Promise<ConnectionCheckItem[]> {
  const out: ConnectionCheckItem[] = [];
  const place = where(target);
  // Secret
  const sid = `write-secret:${id}`;
  const slabel = `Schreibtest Secret in ${place}`;
  try {
    const existing = (await rt.github.listSecrets(target)).some((s) => s.name === WRITE_PROBE_SECRET);
    if (existing) {
      out.push(item(sid, slabel, "warn", `Ein Secret ${WRITE_PROBE_SECRET} existiert schon: nichts geschrieben, bitte von Hand loeschen.`));
    } else {
      const { keyId, key } = await rt.github.publicKey(target);
      await rt.github.putEncrypted(target, WRITE_PROBE_SECRET, await sealForGitHub(key, "probe"), keyId);
      try {
        await rt.github.deleteSecret(target, WRITE_PROBE_SECRET);
        out.push(item(sid, slabel, "pass", "Anlegen und Loeschen eines Probe-Secrets hat funktioniert."));
      } catch (err) {
        out.push(item(sid, slabel, "fail", `Das Probe-Secret ${WRITE_PROBE_SECRET} wurde angelegt, konnte aber nicht geloescht werden: ${safeText(err instanceof Error ? err.message : "Fehler", tk(token))}. Bitte von Hand loeschen.`));
      }
    }
  } catch (err) {
    out.push({ ...githubProblem(err, token, sid), label: slabel });
  }
  // Variable
  const vid = `write-variable:${id}`;
  const vlabel = `Schreibtest Variable in ${place}`;
  try {
    const existing = (await rt.github.listVariables(target)).some((v) => v.name === WRITE_PROBE_VARIABLE);
    if (existing) {
      out.push(item(vid, vlabel, "warn", `Eine Variable ${WRITE_PROBE_VARIABLE} existiert schon: nichts geschrieben, bitte von Hand loeschen.`));
    } else {
      await rt.github.putVariable(target, WRITE_PROBE_VARIABLE, "probe");
      try {
        await rt.github.deleteVariable(target, WRITE_PROBE_VARIABLE);
        out.push(item(vid, vlabel, "pass", "Anlegen und Loeschen einer Probe-Variable hat funktioniert."));
      } catch (err) {
        out.push(item(vid, vlabel, "fail", `Die Probe-Variable ${WRITE_PROBE_VARIABLE} wurde angelegt, konnte aber nicht geloescht werden: ${safeText(err instanceof Error ? err.message : "Fehler", tk(token))}. Bitte von Hand loeschen.`));
      }
    }
  } catch (err) {
    out.push({ ...githubProblem(err, token, vid), label: vlabel });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

const KNOWN = new Set(["github", "team-sync", "github-app-key", "cloudflare", "cloudflare-turnstile", "supabase", "stripe", "stripe-test", "stripe-live", "resend", "grafana"]);

/**
 * Prueft eine Verbindung mit rein lesenden Aufrufen. Nur GitHub schreibt, und nur mit `deep` und nur in die gewaehlten Ziele.
 * Liefert Befunde, nie einen Token-Wert.
 */
export async function checkConnection(rt: Runtime, id: string, options: ConnectionCheckOptions = {}, now: Date = new Date()): Promise<ConnectionCheckResult> {
  if (!KNOWN.has(id) && !rt.providers.list().some((p) => p.connection === id)) throw new InventoryError(`Unbekannte Verbindung: ${id}`);
  if (id === "grafana") {
    const st = await rt.connections.status(id);
    if (!st.connected) return { id, ok: false, checks: [item("connected", "Verbunden", "fail", "Nicht verbunden")] };
    return { id, ok: true, checks: [item("token", "Token", "info", "Nicht pruefbar ohne Stack-Adresse. Der Token wird beim Ausstellen geprueft.")] };
  }
  if (id === "github-app-key") {
    const st = await rt.connections.status(id);
    if (!st.connected) return { id, ok: false, checks: [item("connected", "Verbunden", "fail", "Nicht verbunden")] };
    return { id, ok: true, checks: [item("token", "Schluessel", "info", "Der App-Schluessel wird beim ersten Zugriff geprueft: Test ueber die Verbindung GitHub.")] };
  }
  if (id === "team-sync") {
    const st = await rt.connections.status(id);
    if (!st.connected) return { id, ok: false, checks: [item("connected", "Verbunden", "fail", "Nicht verbunden")] };
    if (!rt.config.teamSync) return { id, ok: true, checks: [item("token", "Token", "info", "Team-Sync ist noch nicht eingerichtet (teamSync in der Konfiguration).")] };
    try {
      const { checkTeamSync } = await import("./team-sync.js");
      const r = await checkTeamSync(rt, now);
      return { id, ok: true, checks: [item("repo", "Team-Repository", r.state === "missing-remote" ? "warn" : "pass", r.state === "missing-remote" ? "Zugriff ok, die Team-Datei fehlt noch im Repository." : "Zugriff ok, Team-Datei gelesen.")] };
    } catch (err) {
      return { id, ok: false, checks: [item("repo", "Team-Repository", "fail", (err as Error).message)] };
    }
  }
  const connectedId = id === "github" ? "github" : id;
  const st = await rt.connections.status(connectedId);
  if (!st.connected) return { id, ok: false, checks: [item("connected", "Verbunden", "fail", "Nicht verbunden")] };
  try {
    if (id === "github") return await checkGitHub(rt, options, now);
    const token = (await rt.connections.token(id)).reveal();
    if (id === "cloudflare" || id === "cloudflare-turnstile") return await checkCloudflare(rt, id, token, now);
    let checks: ConnectionCheckItem[];
    if (id === "supabase") checks = await checkSupabase(rt, token);
    else if (id === "stripe" || id === "stripe-test" || id === "stripe-live") checks = await checkStripe(rt, id, token);
    else if (id === "resend") checks = await checkResend(rt, token);
    else checks = [item("token", "Token", "info", "Fuer diese Verbindung gibt es keinen Test.")];
    return { id, ok: !checks.some((c) => c.status === "fail"), checks };
  } catch (err) {
    if (err instanceof NotConnectedError) return { id, ok: false, checks: [item("connected", "Verbunden", "fail", "Nicht verbunden")] };
    if (err instanceof CheckFetchError) return { id, ok: false, checks: [item("request", "Anfrage", "fail", err.message)] };
    if (err instanceof GitHubError) return { id, ok: false, checks: [{ ...githubProblem(err, "", "request"), label: "Anfrage" }] };
    throw err;
  }
}
