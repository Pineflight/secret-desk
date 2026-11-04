import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// secret-desk is public: internal product, repository, account and host names of the owner must not appear in the
// repository. Examples use neutral placeholders (acme-app, acme-org, example.com). Exceptions are listed with a reason in
// scripts/internal-names-allowlist.txt.
const NAMES = /pineflight|wake[-_ ]?miles|night[-_ ]?before|leitfaden|web[-_ ]?studio|inoweb|\blupe\b|staatsfaden|book[-_ ]?studio|kdp[-_ ]?buch|mission[-_ ]?control|ai[-_ ]?interlink|inotime|niklas|acct_1UTj|acct_1U8x|192\.168\.178\.88|secret-desk\.local/gi;
// The repository's own address is not an internal name.
const OWN_ADDRESS = /pineflight\/secret-desk(?:-browser)?/gi;
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", ".next", "coverage", ".turbo"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "internal-names-allowlist.txt"]);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js|json|md|ya?ml|txt|html|css|svg|sh)$|(^|\/)(Dockerfile|LICENSE)$/.test(p)) out.push(p);
  }
  return out;
}

async function allowlist(): Promise<Map<string, string>> {
  const text = await readFile(join(root, "scripts", "internal-names-allowlist.txt"), "utf8");
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [path, ...reason] = line.split("|");
    map.set(path!.trim(), reason.join("|").trim());
  }
  return map;
}

describe("no internal names in the public repository", () => {
  it("every allowlist entry has a reason and points to an existing file", async () => {
    const list = await allowlist();
    expect(list.size).toBeGreaterThan(0);
    for (const [path, reason] of list) {
      expect(reason.length, `${path} needs a reason`).toBeGreaterThan(5);
      await expect(readFile(join(root, path), "utf8"), `${path} does not exist`).resolves.toBeTypeOf("string");
    }
  });

  it("does not contain internal names outside the allowlist", async () => {
    const list = await allowlist();
    const files = await walk(root);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).split(sep).join("/");
      if (list.has(rel)) continue;
      const lines = (await readFile(f, "utf8")).split("\n");
      lines.forEach((line, i) => {
        const hit = line.replace(OWN_ADDRESS, "").match(NAMES);
        if (hit) offenders.push(`${rel}:${i + 1}: ${hit[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
