/**
 * Validators for names that end up in GitHub API paths (owner, repository, file path, branch).
 * Used by the team sync configuration schema and, again, by GitHubClient before a URL is built (fail closed).
 */

/** Thrown when an owner, repository, path or branch name is not safe to put into an API URL. Never carries a token. */
export class GitHubInputError extends Error {
  readonly code = "invalid_github_input";
  constructor(message: string) {
    super(message);
    this.name = "GitHubInputError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Owner or repository name: letters, digits, "_", "." and "-", but never "." or "..". ".github" is fine. */
export function isSafeRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

/** "owner/name" with both parts safe. */
export function isSafeRepoSlug(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(isSafeRepoSegment);
}

/** Relative file path inside a repository: no leading "/", no backslash, no empty, "." or ".." segment, no control characters. */
export function isSafeContentPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || CONTROL.test(value)) return false;
  return value.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

/** Branch name following the rules of `git check-ref-format --branch`, plus no leading "-". */
export function isValidBranchName(value: string): boolean {
  if (value.length === 0 || value === "@" || value.startsWith("-")) return false;
  if (CONTROL.test(value) || /[ ~^:?*[\\]/.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  return value.split("/").every((s) => !s.startsWith(".") && !s.endsWith(".lock"));
}

export function assertSafeRepoSegment(value: string, what: "owner" | "repository"): void {
  if (!isSafeRepoSegment(value)) throw new GitHubInputError(`Invalid GitHub ${what} name.`);
}

export function assertSafeContentPath(value: string): void {
  if (!isSafeContentPath(value)) throw new GitHubInputError("Invalid repository file path.");
}

export function assertValidBranchName(value: string): void {
  if (!isValidBranchName(value)) throw new GitHubInputError("Invalid branch name.");
}
