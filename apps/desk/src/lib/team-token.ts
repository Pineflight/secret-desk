/** Pure helpers for the team token (a separate GitHub token for team sync, created through the browser). No network, no React. */
import { isFinished, isRunning, type FacadeState, type StepState, type StepView } from "./facade";
import type { ModeAccess, PushStrategy, TeamMode } from "./team-picker";

export interface TeamTokenMeta {
  repo: string;
  mode: TeamMode;
  strategy: PushStrategy;
  tokenName: string;
  createdAt: string;
  expires: string | null;
  valid: boolean;
}

export interface TeamTokenInfo {
  available: boolean;
  reason: "automation-off" | "recipe-missing" | null;
  viewerUrl: string | null;
  timeoutMinutes: number;
  active: TeamTokenMeta | null;
  pendingRevocation: { tokenName: string; repo: string; since: string; url: string; reason?: string } | null;
  tokensUrl: string;
  days: number;
  rights: Record<TeamMode, string[]>;
  run: FacadeState;
}

export interface TeamTokenSessionCheck {
  signedIn: boolean;
  checkedAt: string;
  failure?: { code: string; message: string };
}

/** The phases of a run in the order the portal shows them. `signin`, `confirm` and `revoking` appear only when they happen. */
export const TEAM_TOKEN_PHASES = ["opening", "signin", "confirm", "creating", "testing", "revoking", "ready"] as const;
const OPTIONAL = new Set<string>(["signin", "confirm", "revoking"]);

/** The steps of the run's timeline: every fixed phase plus the optional ones GitHub asked for, with their state. */
export function teamTokenSteps(run: Pick<FacadeState, "status" | "timeline"> | null | undefined): StepView[] {
  const seen = new Map((run?.timeline ?? []).map((e) => [e.phase, e.state]));
  const out: StepView[] = [];
  for (const phase of TEAM_TOKEN_PHASES) {
    if (OPTIONAL.has(phase) && !seen.has(phase)) continue;
    const s = seen.get(phase);
    let st: StepState = "pending";
    if (s === "done") st = "done";
    else if (s === "failed") st = "failed";
    else if (s === "active") st = run?.status === "waiting-human" ? "waiting" : "active";
    out.push({ phase, state: st });
  }
  return isFinished(run) ? out.map((x) => (x.state === "active" || x.state === "waiting" ? { ...x, state: run?.status === "done" ? "done" : "failed" } : x)) : out;
}

/** What the control shows. */
export type TeamTokenView = "loading" | "unavailable" | "running" | "waiting" | "failed" | "done" | "idle";

export function teamTokenView(info: TeamTokenInfo | undefined): TeamTokenView {
  if (!info) return "loading";
  if (isRunning(info.run)) return info.run.status === "waiting-human" ? "waiting" : "running";
  if (info.run.status === "failed" || info.run.status === "cancelled") return "failed";
  if (info.run.status === "done") return "done";
  return info.available ? "idle" : "unavailable";
}

/** The team token covers this selection (the same repository, rights at least those of the mode) and has not expired. */
export function tokenCovers(active: TeamTokenMeta | null | undefined, repo: string, mode: TeamMode, strategy: PushStrategy): boolean {
  if (!active || !active.valid || active.repo !== repo) return false;
  if (mode === "pull") return true;
  return active.mode === "pull-push" && (strategy === "direct" || active.strategy === "pull-request");
}

/** The expiry date to show in "✓ Ready · team token, valid until …" when this mode is served by the team token. Else null. */
export function readyTokenExpiry(access: ModeAccess | undefined, info: TeamTokenInfo | undefined, repo: string): string | null {
  if (!access || access.source !== "own" || !info?.active?.valid || info.active.repo !== repo) return null;
  return info.active.expires ?? "";
}

/** The label of the button: a first token, or a new one when a token for another repository or mode exists. */
export const createLabelKey = (info: TeamTokenInfo | undefined): "teamToken.create" | "teamToken.createNew" => (info?.active ? "teamToken.createNew" : "teamToken.create");

/** The failure text for the interface language: the catalog first, the server's text as the fallback. */
export function teamTokenFailureText(f: { code: string; message: string; messageEn: string }, locale: "de" | "en", t: (key: string) => string): string {
  if (locale === "en") return f.messageEn;
  const key = `teamToken.fail.${f.code}`;
  const text = t(key);
  return text === key ? f.message : f.code === "test" || f.code === "store" ? `${text} (${f.messageEn})` : text;
}
