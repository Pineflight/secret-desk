import { createHash } from "node:crypto";

/**
 * Demo mode (SECRET_DESK_DEMO=1): the repository part of the simulated GitHub. It answers exactly what team sync and team discovery
 * ask (repositories visible to the user, branches, refs, tree, contents, pull requests) and keeps its state in memory. Nothing
 * here talks to a network; a pull request answers with a made-up URL under https://github.com/acme/team-config/pull/.
 */

interface Branch {
  commit: string;
  files: Map<string, string>;
}

interface Pull {
  number: number;
  head: string;
  base: string;
  title: string;
  state: "open";
}

interface Repo {
  private: boolean;
  pushedAt: string;
  branches: Map<string, Branch>;
  pulls: Pull[];
}

export interface DemoRepoOptions {
  /** Text of the team file the simulated team repository holds on its default branch, or none (the picker then offers a new file). Read once. */
  teamFile?: (() => string) | undefined;
}

export const DEMO_OWNER = "acme";
export const DEMO_TEAM_REPO = "team-config";
export const DEMO_TEAM_FILE = "secret-desk.team.yaml";
const DEFAULT_BRANCH = "main";
const PRIVATE_REPOS = ["acme-app", "acme-web", "acme-docs", "acme-lab", "acme-tools"] as const;
const PUBLIC_REPOS = ["open-samples"] as const;

/** The blob SHA GitHub reports for a file: SHA-1 over a git blob header and the text. */
export const blobSha = (text: string): string => createHash("sha1").update(`blob ${Buffer.byteLength(text, "utf8")}\0`).update(text).digest("hex");

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = (): Response => json({ message: "Not Found" }, 404);

type Handler = (method: string, url: URL, path: string, body: Record<string, unknown>) => Response | null;

/** Returns a handler for the repository endpoints, or null when the request is not one of them (the caller answers 404). */
export function createDemoRepos(options: DemoRepoOptions = {}): Handler {
  let counter = 0;
  const commitSha = (): string => createHash("sha1").update(`demo-commit-${(counter += 1)}`).digest("hex");
  const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();
  const fresh = (pushedAt: string, files: [string, string][]): Repo => ({ private: true, pushedAt, branches: new Map([[DEFAULT_BRANCH, { commit: commitSha(), files: new Map(files) }]]), pulls: [] });

  const repos = new Map<string, Repo>();
  PRIVATE_REPOS.forEach((name, i) => repos.set(`${DEMO_OWNER}/${name}`, fresh(minutesAgo(600 + i * 120), [["README.md", `# ${name}\n`]])));
  repos.set(`${DEMO_OWNER}/${DEMO_TEAM_REPO}`, fresh(minutesAgo(30), [["README.md", "# Team configuration\n\nStructure only, no values.\n"]]));
  const open = fresh(minutesAgo(2000), [["README.md", "# open-samples\n"]]);
  open.private = false;
  repos.set(`${DEMO_OWNER}/${PUBLIC_REPOS[0]}`, open);

  let teamFileSeeded = false;
  const seedTeamFile = (): void => {
    if (teamFileSeeded) return;
    teamFileSeeded = true;
    if (options.teamFile) repos.get(`${DEMO_OWNER}/${DEMO_TEAM_REPO}`)!.branches.get(DEFAULT_BRANCH)!.files.set(DEMO_TEAM_FILE, options.teamFile());
  };
  const meta = (full: string, r: Repo) => ({ name: full.split("/")[1], full_name: full, owner: { login: DEMO_OWNER }, private: r.private, archived: false, default_branch: DEFAULT_BRANCH, pushed_at: r.pushedAt });

  return (method, url, path, body) => {
    if (method === "GET" && path === "/user/repos") {
      seedTeamFile();
      return json([...repos].map(([full, r]) => meta(full, r)).sort((a, b) => b.pushed_at.localeCompare(a.pushed_at)));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return null;
    const [, owner, name, rest = ""] = m;
    const full = `${owner}/${name}`;
    const repo = repos.get(full);
    if (!repo) return null;
    seedTeamFile();
    const branchOf = (b: string): Branch | undefined => repo.branches.get(b);

    if (method === "GET" && rest === "") return json({ ...meta(full, repo), permissions: { admin: false, push: true, pull: true } });
    if (method === "GET" && rest === "/branches") return json([...repo.branches.keys()].map((b) => ({ name: b })));

    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === "GET" && ref) {
      const b = branchOf(ref[1]!);
      return b ? json({ ref: `refs/heads/${ref[1]}`, object: { type: "commit", sha: b.commit } }) : notFound();
    }
    if (method === "POST" && rest === "/git/refs") {
      const branch = String(body["ref"] ?? "").replace(/^refs\/heads\//, "");
      const from = [...repo.branches.values()].find((b) => b.commit === body["sha"]);
      if (!branch || repo.branches.has(branch)) return json({ message: "Reference already exists" }, 422);
      if (!from) return json({ message: "Object does not exist" }, 422);
      repo.branches.set(branch, { commit: from.commit, files: new Map(from.files) });
      return json({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: from.commit } }, 201);
    }
    const del = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === "DELETE" && del) {
      if (!repo.branches.has(del[1]!)) return notFound();
      if (del[1] === DEFAULT_BRANCH) return json({ message: "Cannot delete the default branch" }, 422);
      repo.branches.delete(del[1]!);
      return new Response(null, { status: 204 });
    }
    const tree = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest);
    if (method === "GET" && tree) {
      const b = [...repo.branches.values()].find((x) => x.commit === tree[1]);
      return b ? json({ sha: b.commit, truncated: false, tree: [...b.files.keys()].sort().map((p) => ({ path: p, type: "blob", sha: blobSha(b.files.get(p)!) })) }) : notFound();
    }

    const file = /^\/contents\/(.+)$/.exec(rest);
    if (file) {
      const filePath = file[1]!;
      if (method === "GET") {
        const text = branchOf(url.searchParams.get("ref") ?? DEFAULT_BRANCH)?.files.get(filePath);
        return text === undefined ? notFound() : json({ type: "file", path: filePath, sha: blobSha(text), encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") });
      }
      if (method === "PUT") {
        const branch = branchOf(String(body["branch"] ?? DEFAULT_BRANCH));
        if (!branch) return notFound();
        const existing = branch.files.get(filePath);
        if (existing !== undefined && body["sha"] === undefined) return json({ message: "Invalid request: sha wasn't supplied" }, 422);
        if (existing !== undefined && body["sha"] !== blobSha(existing)) return json({ message: "File does not match the supplied sha" }, 409);
        const text = Buffer.from(String(body["content"] ?? ""), "base64").toString("utf8");
        branch.files.set(filePath, text);
        branch.commit = commitSha();
        repo.pushedAt = new Date().toISOString();
        return json({ content: { path: filePath, sha: blobSha(text) }, commit: { sha: branch.commit } }, existing === undefined ? 201 : 200);
      }
      return null;
    }

    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      const base = url.searchParams.get("base");
      return json(repo.pulls.filter((p) => `${owner}:${p.head}` === head && (base === null || p.base === base)).map((p) => pullBody(full, p)));
    }
    if (method === "POST" && rest === "/pulls") {
      const head = String(body["head"] ?? "");
      const base = String(body["base"] ?? "");
      if (!branchOf(head) || !branchOf(base)) return json({ message: "Validation Failed" }, 422);
      const pull: Pull = { number: 12 + repo.pulls.length, head, base, title: String(body["title"] ?? ""), state: "open" };
      repo.pulls.push(pull);
      return json(pullBody(full, pull), 201);
    }
    const pullPatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (method === "PATCH" && pullPatch) {
      const pull = repo.pulls.find((p) => p.number === Number(pullPatch[1]));
      if (!pull) return notFound();
      pull.title = String(body["title"] ?? pull.title);
      return json(pullBody(full, pull));
    }
    return null;
  };
}

const pullBody = (full: string, p: Pull) => ({ number: p.number, state: p.state, title: p.title, html_url: `https://github.com/${full}/pull/${p.number}` });
