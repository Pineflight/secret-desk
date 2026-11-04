/**
 * What the person chose in the team setup form, kept per viewer so a reload (or a data refresh) never throws the choice back to
 * the preselected suggestion. Pure helpers plus a guarded storage access; no React.
 */
import type { PushStrategy, TeamMode } from "./team-picker";
import { NO_CONFIRMATIONS, type StepConfirmations } from "./setup-steps";

export interface SetupChoice {
  repo: string;
  branch: string;
  /** The file select value (a path or the "create" marker). */
  file: string;
  mode: TeamMode;
  strategy: PushStrategy;
  confirmed: StepConfirmations;
}

export const EMPTY_CHOICE: SetupChoice = { repo: "", branch: "", file: "", mode: "pull", strategy: "pull-request", confirmed: NO_CONFIRMATIONS };

export const CHOICE_STORAGE_KEY = "sd:team-setup";

const text = (v: unknown): string => (typeof v === "string" && v.length <= 300 ? v : "");

/** Reads a stored choice defensively: anything unexpected gives the empty choice (or the empty field). */
export function parseChoice(raw: unknown): SetupChoice {
  if (!raw || typeof raw !== "object") return EMPTY_CHOICE;
  const o = raw as Record<string, unknown>;
  const c = (o.confirmed && typeof o.confirmed === "object" ? o.confirmed : {}) as Record<string, unknown>;
  const repo = text(o.repo);
  const branch = repo ? text(o.branch) : "";
  const file = branch ? text(o.file) : "";
  const confirmed: StepConfirmations = {
    repo: Boolean(repo) && c.repo === true,
    file: Boolean(repo && branch && file) && c.repo === true && c.file === true,
    mode: Boolean(repo && branch && file) && c.repo === true && c.file === true && c.mode === true,
  };
  return {
    repo,
    branch,
    file,
    mode: o.mode === "pull-push" ? "pull-push" : "pull",
    strategy: o.strategy === "direct" ? "direct" : "pull-request",
    confirmed,
  };
}

/** The value to keep: the human's choice wins; the suggestion only fills an empty field. */
export const keepChoice = (current: string, suggestion: string): string => current || suggestion;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem" | "removeItem">;

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readChoice(storage: ReadStorage | null = localStore()): SetupChoice {
  try {
    const raw = storage?.getItem(CHOICE_STORAGE_KEY);
    return raw ? parseChoice(JSON.parse(raw)) : EMPTY_CHOICE;
  } catch {
    return EMPTY_CHOICE;
  }
}

export function writeChoice(choice: SetupChoice, storage: WriteStorage | null = localStore()): void {
  try {
    if (!choice.repo) storage?.removeItem(CHOICE_STORAGE_KEY);
    else storage?.setItem(CHOICE_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    /* storage blocked or full: the choice then lasts until the page is left */
  }
}

/** A different repository invalidates everything below it; the same one changes nothing. */
export function withRepo(choice: SetupChoice, repo: string): SetupChoice {
  if (choice.repo === repo) return choice;
  return { ...choice, repo, branch: "", file: "", confirmed: NO_CONFIRMATIONS };
}

/** A different branch invalidates the file and the mode confirmation. */
export function withBranch(choice: SetupChoice, branch: string): SetupChoice {
  if (choice.branch === branch) return choice;
  return { ...choice, branch, file: "", confirmed: { ...choice.confirmed, file: false, mode: false } };
}

export function withFile(choice: SetupChoice, file: string): SetupChoice {
  if (choice.file === file) return choice;
  return { ...choice, file, confirmed: { ...choice.confirmed, file: false, mode: false } };
}

export function withMode(choice: SetupChoice, mode: TeamMode, strategy: PushStrategy): SetupChoice {
  if (choice.mode === mode && choice.strategy === strategy) return choice;
  return { ...choice, mode, strategy, confirmed: { ...choice.confirmed, mode: false } };
}

export const confirmStep = (choice: SetupChoice, step: keyof StepConfirmations): SetupChoice => ({ ...choice, confirmed: { ...choice.confirmed, [step]: true } });
