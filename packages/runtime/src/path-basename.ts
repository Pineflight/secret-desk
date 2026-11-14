/**
 * The last segment of a path with `/` as the separator, the same answer as `path.posix.basename(path)` for a path without a suffix
 * argument: trailing slashes are ignored, and a path that is only slashes or empty has no name (""). Plain string work, so it runs
 * where `node:path` does not exist.
 */
export function posixBasename(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(path.lastIndexOf("/", end - 1) + 1, end);
}
