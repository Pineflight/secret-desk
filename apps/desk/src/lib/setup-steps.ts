/** The steps of the team setup form (repository, branch and file, mode, team token) and what each one shows. Pure, no React. */

export type StepId = "repo" | "file" | "mode" | "token";
export type StepStatus = "done" | "current" | "todo";

export const STEP_IDS: readonly StepId[] = ["repo", "file", "mode", "token"];

/** Which suggested steps the human has confirmed. A preselected value alone never completes a step. */
export interface StepConfirmations {
  repo: boolean;
  file: boolean;
  mode: boolean;
}

export const NO_CONFIRMATIONS: StepConfirmations = { repo: false, file: false, mode: false };

export interface StepperInput {
  repo: string;
  branch: string;
  path: string;
  /** The integration (or the team token) already allows the chosen mode. */
  modeAllowed: boolean;
  /** Steps the human confirmed ("Use this"); a step is only done after that. */
  confirmed: StepConfirmations;
}

export interface StepView {
  id: StepId;
  status: StepStatus;
}

/**
 * Steps in order: every step before the first unfinished one is done, that one is current, the rest wait. Repository, branch
 * and file and mode have suggestions, but each one is only done after the human confirmed it; the token step is done when the
 * mode is allowed.
 */
export function stepperState(input: StepperInput): StepView[] {
  const repo = Boolean(input.repo && input.confirmed.repo);
  const file = repo && Boolean(input.branch && input.path && input.confirmed.file);
  const mode = file && input.confirmed.mode;
  const complete: Record<StepId, boolean> = { repo, file, mode, token: mode && input.modeAllowed };
  let currentSet = false;
  return STEP_IDS.map((id) => {
    if (complete[id]) return { id, status: "done" as const };
    if (!currentSet) {
      currentSet = true;
      return { id, status: "current" as const };
    }
    return { id, status: "todo" as const };
  });
}

/**
 * The permission warning of a mode ("Needs Contents: Read and write, ..., Fix the GitHub token") is only useful when there is no
 * better fix. While a team token can be created, creating it is the fix, so the mode row stays calm.
 */
export const showPermissionWarning = (needsRights: boolean, teamTokenAvailable: boolean): boolean => needsRights && !teamTokenAvailable;

/** The sign-in check link is only offered when the last sign-in answer is not fresh. */
export function showSignInCheck(input: { available: boolean; signedIn: boolean | null; checkedAt: number | null; now: number; freshMs: number }): boolean {
  if (!input.available) return false;
  if (input.signedIn !== true || input.checkedAt === null) return true;
  return input.now - input.checkedAt > input.freshMs;
}
