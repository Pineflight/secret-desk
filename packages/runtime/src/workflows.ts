import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GitHubError, NotConnectedError, isWorkflowFileName, type RepoNote, type WorkflowFile } from "@secret-desk/core";
import { linkedFolder } from "./repos.js";
import type { Runtime } from "./runtime.js";

/** Hoechstens so viele Workflow-Dateien je Repository, und so gross darf eine sein. */
const MAX_FILES = 40;
const MAX_BYTES = 512 * 1024;

export interface WorkflowSource {
  files: WorkflowFile[];
  source: "local" | "github" | "none";
  note?: RepoNote;
}

async function fromFolder(folder: string): Promise<WorkflowFile[]> {
  const dir = join(folder, ".github", "workflows");
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isWorkflowFileName).sort().slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const out: WorkflowFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      // Nur regulaere Dateien, keine Verknuepfungen aus dem Repository heraus.
      const st = await lstat(path);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      out.push({ name, content: await readFile(path, "utf8") });
    } catch {
      /* unlesbare Datei: auslassen */
    }
  }
  return out;
}

/**
 * Workflow-Dateien eines Repositories: bevorzugt aus dem lokal verknuepften Ordner, sonst (nur mit `github`) ueber die
 * Contents-API. Ein Fehler je Repository wird zum Hinweis, nie zum Gesamtfehler. Liest nur, schreibt nichts.
 */
export async function readWorkflowFiles(rt: Runtime, repo: string, options: { github: boolean }): Promise<WorkflowSource> {
  const folder = await linkedFolder(rt, repo);
  if (folder) return { files: await fromFolder(folder), source: "local" };
  if (!options.github) return { files: [], source: "none" };
  try {
    const listed = (await rt.github.listWorkflowFiles(rt.owner, repo)).filter((f) => isWorkflowFileName(f.name) && f.size <= MAX_BYTES).slice(0, MAX_FILES);
    const files: WorkflowFile[] = [];
    for (const f of listed) files.push({ name: f.name, content: await rt.github.readTextFile(rt.owner, repo, `.github/workflows/${f.name}`) });
    return { files, source: "github" };
  } catch (err) {
    if (err instanceof NotConnectedError) throw err;
    if (err instanceof GitHubError && (err.status === 403 || err.status === 401)) return { files: [], source: "none", note: { code: "contents-forbidden", status: err.status } };
    return { files: [], source: "none", note: { code: "contents-error", message: err instanceof Error ? err.message : String(err), ...(err instanceof GitHubError ? { status: err.status } : {}) } };
  }
}
