import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StageSchema, localPathProblem, writePrivateFile, type Stage } from "@secret-desk/core";
import { createLocalRuntime, exportEnvContent, translateEn, type EnvExportFormat, type EnvExportInclude } from "@secret-desk/runtime";

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** true = Git tracks the file, false = it does not, null = cannot tell (no repository, no git). */
export function isTrackedByGit(path: string): Promise<boolean | null> {
  return new Promise((res) => {
    execFile("git", ["ls-files", "--error-unmatch", "--", path], { cwd: dirname(path), timeout: 5000, windowsHide: true }, (err) => {
      if (!err) return res(true);
      const code = (err as { code?: number | string }).code;
      res(code === 1 ? false : null);
    });
  });
}

/**
 * `secret-desk env export` content mode: one file with the variables (and, with `--include all`, the dev secrets that
 * have a value) of a repository and stage. Mode 0600, no overwrite and no tracked path without `--force`.
 */
export async function envExportContent(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string" }, repo: { type: "string" }, stage: { type: "string" }, out: { type: "string" }, format: { type: "string" }, include: { type: "string" }, force: { type: "boolean" } },
  });
  if (!values.config || !values.repo) throw new Error("env export --config <file> --repo <repo> [--stage <s>] [--out <path>] [--format dotenv|json] [--include variables|all] [--force]");
  const format = values.format ?? "dotenv";
  const include = values.include ?? "variables";
  if (format !== "dotenv" && format !== "json") throw new Error("--format: dotenv or json");
  if (include !== "variables" && include !== "all") throw new Error("--include: variables or all");
  const rt = await createLocalRuntime(values.config);
  const stage: Stage = values.stage ? StageSchema.parse(values.stage) : (rt.inventory.stages.find((d) => d.kind === "dev")?.id ?? "dev");
  const r = await exportEnvContent(rt, { kind: "human", name: "cli" }, { repo: values.repo, stage, format: format as EnvExportFormat, include: include as EnvExportInclude });
  const target = resolve(values.out ?? r.filename);
  const problem = localPathProblem(target);
  if (problem) throw new Error(translateEn(problem));
  const exists = await stat(target).then(() => true, () => false);
  if (exists && !values.force) {
    io.err(`File exists already: ${target}. Use --force to overwrite.`);
    return 1;
  }
  const tracked = await isTrackedByGit(target);
  if (tracked === true && !values.force) {
    io.err(`Git tracks this path: ${target}. Do not write values into a tracked file (--force writes anyway).`);
    return 1;
  }
  if (tracked === true) io.err(`Warning: Git tracks this path (${target}).`);
  await mkdir(dirname(target), { recursive: true });
  // Replace instead of rewrite in place: an existing file with a broad mode must not stay readable while the values land in it.
  if (exists) await rm(target, { force: true });
  await writePrivateFile(target, r.content);
  io.out(`written: ${target} (${r.keys.length} values, ${r.missing.length} missing, mode 600)`);
  for (const m of r.missing) io.err(`missing: ${m.name} (${m.reason})`);
  return 0;
}
