import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DeskClient } from "./client.js";

interface ExportResponse {
  repo: string;
  stage: string;
  format: "dotenv" | "json";
  filename: string;
  content: string;
  keys: string[];
  missing: { name: string; reason: string }[];
}

const ENV_NAME = /^\.env(\..+)?$/;
const JSON_NAME = /^\.?env[.\w-]*\.json$/;

function tracked(path: string): Promise<boolean | null> {
  return new Promise((res) => {
    execFile("git", ["ls-files", "--error-unmatch", "--", path], { cwd: dirname(path), timeout: 5000, windowsHide: true }, (err) => {
      if (!err) return res(true);
      res((err as { code?: number | string }).code === 1 ? false : null);
    });
  });
}

/** realpath of the nearest existing ancestor plus the not yet existing rest. */
async function realpathLoose(path: string): Promise<string> {
  const rest: string[] = [];
  let cur = path;
  for (;;) {
    try {
      return resolve(await realpath(cur), ...rest);
    } catch {
      const up = dirname(cur);
      if (up === cur) return path;
      rest.unshift(basename(cur));
      cur = up;
    }
  }
}

/**
 * `desk_env_export`: asks the portal for the export (the portal enforces the agent policy). Without `out` the content
 * comes back (dev stages only, by policy). With `out` the file is written inside the working directory of the requesting
 * repository and only path, names and missing reasons come back: the values never reach the agent.
 */
export async function envExportTool(client: DeskClient, input: Record<string, unknown>, cwd: string = process.cwd()): Promise<unknown> {
  const format = input.format === "json" ? "json" : "dotenv";
  const res = await client.request<ExportResponse>("POST", "/env/export", {
    repo: input.repo,
    stage: input.stage ?? "dev",
    format,
    include: input.include ?? "variables",
  });
  if (typeof input.out !== "string" || input.out === "") return res;

  const target = resolve(cwd, input.out);
  const root = await realpath(cwd);
  // Resolve symlinks of the (possibly not yet existing) parent so a link cannot lead out of the working directory.
  const real = await realpathLoose(target);
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Pfad liegt ausserhalb des Arbeitsordners: ${target}`);
  const name = basename(target);
  if (!(format === "json" ? JSON_NAME.test(name) : ENV_NAME.test(name))) throw new Error("Nur Dateien namens .env oder .env.* (json: env.<name>.json) sind erlaubt.");
  if ((await tracked(target)) === true) throw new Error(`Git verfolgt diesen Pfad: ${target}. Keine Werte in eine verfolgte Datei schreiben.`);
  await mkdir(dirname(target), { recursive: true });
  try {
    // wx: never overwrite an existing file.
    await writeFile(target, res.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") throw new Error(`Datei existiert schon: ${target}. Agenten ueberschreiben nie.`);
    throw err;
  }
  return { status: "written", path: target, repo: res.repo, stage: res.stage, keys: res.keys, missing: res.missing };
}
