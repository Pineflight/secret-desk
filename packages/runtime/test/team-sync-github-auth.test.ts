import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listConnections } from "../src/agent-api.js";
import { checkConnection } from "../src/connection-check.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { checkTeamSync, checkTeamSyncAccess, neededRights, teamPermissions, teamSyncStatus } from "../src/team-sync.js";

const PAT = "github_pat_made_up_main_token";
const OWN = "team_token_made_up_own";
const INSTALL_TOKEN = "ghs_made_up_installation_token";
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FILE = "version: 1\nsecrets: []\nvariables: []\n";

/** Kleines GitHub: Zugriff nur mit dem erwarteten Token, Installationstokens mit einstellbaren Rechten. */
class Fake {
  auth: string[] = [];
  tokenRequests: { path: string; body: Record<string, unknown> }[] = [];
  granted: Record<string, string> = { contents: "write", pull_requests: "write", metadata: "read" };
  accessTokensStatus = 201;
  contentsStatus = 200;
  pullsStatus = 200;
  refCreateStatus = 201;
  refs: string[] = [];
  deleted: string[] = [];
  validTokens = new Set<string>();
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const bearer = ((init?.headers as Record<string, string>)["Authorization"] ?? "").replace("Bearer ", "");
    this.auth.push(bearer);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/app/installations") return j([{ id: 7, account: { login: "acme" } }]);
    if (/^\/app\/installations\/7\/access_tokens$/.test(url.pathname)) {
      this.tokenRequests.push({ path: url.pathname, body });
      if (this.accessTokensStatus !== 201) return j({ message: "The permissions requested are not granted to this installation." }, this.accessTokensStatus);
      this.validTokens.add(INSTALL_TOKEN);
      return j({ token: INSTALL_TOKEN, expires_at: "2099-01-01T00:00:00Z", permissions: this.granted, repositories: [{ name: "team-config" }] }, 201);
    }
    if (!this.validTokens.has(bearer)) return j({ message: "Bad credentials" }, 401);
    const m = /^\/repos\/acme\/team-config\/(.*)$/.exec(url.pathname);
    if (!m) return j({ message: "Not Found" }, 404);
    const rest = m[1]!;
    if (rest.startsWith("contents/")) return this.contentsStatus === 200 ? j({ type: "file", sha: "s1", content: Buffer.from(FILE).toString("base64") }) : j({ message: "x" }, this.contentsStatus);
    if (rest.startsWith("git/ref/heads/")) return this.contentsStatus === 404 ? j({ message: "Not Found" }, 404) : j({ object: { sha: "head1" } });
    if (rest === "git/refs" && method === "POST") { if (this.refCreateStatus !== 201) return j({ message: "Resource not accessible" }, this.refCreateStatus); this.refs.push(String(body["ref"])); return j({}, 201); }
    if (rest.startsWith("git/refs/heads/") && method === "DELETE") { this.deleted.push(rest); return new Response(null, { status: 204 }); }
    if (rest.startsWith("pulls")) return this.pullsStatus === 200 ? j([]) : j({ message: "Resource not accessible by integration" }, this.pullsStatus);
    return j({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

async function setup(opts: { auth: "pat" | "app"; ownToken?: boolean; teamSync?: string; fake?: Fake }) {
  const fake = opts.fake ?? new Fake();
  if (opts.auth === "pat") fake.validTokens.add(PAT);
  if (opts.ownToken) fake.validTokens.add(OWN);
  const dir = await mkdtemp(join(tmpdir(), "sd-tsauth-"));
  await writeFile(join(dir, "inventory.yaml"), FILE);
  await writeFile(join(dir, "app.pem"), PRIVATE_KEY);
  const authYaml = opts.auth === "pat" ? "{ type: pat, source: { type: env, name: GH_TEST } }" : "{ type: app, appId: \"123\", privateKey: { type: env, name: APP_KEY } }";
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: ${authYaml}\n${opts.teamSync ?? "teamSync:\n  repo: acme/team-config\n"}`);
  const env = { ...(opts.auth === "pat" ? { GH_TEST: PAT } : { APP_KEY: PRIVATE_KEY }), ...(opts.ownToken ? { SECRET_DESK_TEAM_TOKEN: OWN } : {}) } as unknown as NodeJS.ProcessEnv;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env, fetch: fake.fetch, bundledRecipes: null });
  return { rt, fake };
}
const all = (...v: unknown[]) => JSON.stringify(v);

describe("team sync token source", () => {
  it("without an own token the GitHub PAT is used", async () => {
    const { rt, fake } = await setup({ auth: "pat" });
    const st = await teamSyncStatus(rt);
    expect(st).toMatchObject({ connected: true, tokenSource: "github-pat" });
    expect((await checkTeamSync(rt)).state).toBe("in-sync");
    expect(new Set(fake.auth)).toEqual(new Set([PAT]));
  });

  it("an own team-sync token takes precedence over the GitHub integration", async () => {
    const { rt, fake } = await setup({ auth: "pat", ownToken: true });
    expect((await teamSyncStatus(rt)).tokenSource).toBe("own");
    await checkTeamSync(rt);
    expect(new Set(fake.auth)).toEqual(new Set([OWN]));
  });

  it("without any token the source is none and the check explains it", async () => {
    const fake = new Fake();
    const { rt } = await setup({ auth: "pat", fake });
    rt.connections.session.clear();
    const dir = await mkdtemp(join(tmpdir(), "sd-tsauth-"));
    await writeFile(join(dir, "inventory.yaml"), FILE);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\nteamSync:\n  repo: acme/team-config\n`);
    const bare = await createRuntime(join(dir, "c.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fake.fetch, bundledRecipes: null });
    expect((await teamSyncStatus(bare)).tokenSource).toBe("none");
    expect((await checkTeamSyncAccess(bare))[0]).toMatchObject({ id: "source", status: "fail" });
  });

  it("with a GitHub App an installation token is requested for exactly this repository and only the needed rights (read)", async () => {
    const { rt, fake } = await setup({ auth: "app" });
    expect((await teamSyncStatus(rt)).tokenSource).toBe("github-app");
    await checkTeamSync(rt);
    expect(fake.tokenRequests).toHaveLength(1);
    expect(fake.tokenRequests[0]!.body).toEqual({ repositories: ["team-config"], permissions: { contents: "read", metadata: "read" } });
    expect(fake.auth).toContain(INSTALL_TOKEN);
  });

  it("push with pull requests asks for contents write and pull requests write, nothing else", async () => {
    const { rt, fake } = await setup({ auth: "app", teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    await checkTeamSync(rt);
    expect(fake.tokenRequests[0]!.body).toEqual({ repositories: ["team-config"], permissions: { contents: "write", pull_requests: "write", metadata: "read" } });
  });

  it("direct push asks for contents write only", async () => {
    const { rt, fake } = await setup({ auth: "app", teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n  push: { strategy: direct }\n" });
    await checkTeamSync(rt);
    expect(fake.tokenRequests[0]!.body.permissions).toEqual({ contents: "write", metadata: "read" });
  });

  it("the needed rights follow mode and strategy", () => {
    const base = { repo: "a/b", path: "x", branch: "main", pullOnStart: true };
    expect(teamPermissions({ ...base, mode: "pull", push: { strategy: "pull-request", branch: "p" } })).toEqual({ contents: "read", metadata: "read" });
    expect(neededRights({ ...base, mode: "pull-push", push: { strategy: "pull-request", branch: "p" } })).toEqual(["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"]);
  });
});

describe("access findings", () => {
  it("a working PAT: source, read access and the file are reported", async () => {
    const { rt } = await setup({ auth: "pat" });
    const checks = await checkTeamSyncAccess(rt);
    expect(checks.map((c) => [c.id, c.status])).toEqual([["source", "info"], ["read", "pass"], ["file", "pass"]]);
    expect(checks[0]!.detail).toContain("GitHub-Integration");
  });

  it("404 gives a finding with the needed rights and how to extend a token", async () => {
    const fake = new Fake();
    fake.contentsStatus = 404;
    const { rt } = await setup({ auth: "pat", fake, teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const read = (await checkTeamSyncAccess(rt)).find((c) => c.id === "read")!;
    expect(read.status).toBe("fail");
    expect(read.detail).toContain("Contents: Read and write");
    expect(read.detail).toContain("Pull requests: Read and write");
    expect(read.detail).toContain("Repository access muss acme/team-config enthalten");
    expect(all(read)).not.toContain(PAT);
  });

  it("403 on pull requests is reported as a missing right", async () => {
    const fake = new Fake();
    fake.pullsStatus = 403;
    const { rt } = await setup({ auth: "pat", fake, teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const pulls = (await checkTeamSyncAccess(rt)).find((c) => c.id === "pulls")!;
    expect(pulls.status).toBe("fail");
    expect(pulls.detail).toContain("Pull requests");
  });

  it("App: granted rights are compared with the needed ones; a missing right is a finding with the App instructions", async () => {
    const fake = new Fake();
    fake.granted = { contents: "read", metadata: "read" };
    const { rt } = await setup({ auth: "app", fake, teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const granted = (await checkTeamSyncAccess(rt)).find((c) => c.id === "granted")!;
    expect(granted.status).toBe("fail");
    expect(granted.detail).toContain("contents: write");
    expect(granted.detail).toContain("pull_requests: write");
    expect(granted.detail).toContain("Installation auf acme/team-config erweitern");
  });

  it("App: GitHub refuses the installation token (422) with a clear finding", async () => {
    const fake = new Fake();
    fake.accessTokensStatus = 422;
    const { rt } = await setup({ auth: "app", fake });
    const err = await checkTeamSync(rt).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/GitHub App hat nicht die noetigen Rechte/);
    const read = (await checkTeamSyncAccess(rt)).find((c) => c.id === "read")!;
    expect(read.status).toBe("fail");
    expect(read.detail).toContain("GitHub App");
  });

  it("the write test creates a probe branch and deletes it again; a refusal is a finding", async () => {
    const { rt, fake } = await setup({ auth: "pat", teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const ok = (await checkTeamSyncAccess(rt, { deep: true })).find((c) => c.id === "write")!;
    expect(ok.status).toBe("pass");
    expect(fake.refs).toHaveLength(1);
    expect(fake.refs[0]).toMatch(/^refs\/heads\/secret-desk\/permission-probe-/);
    expect(fake.deleted).toHaveLength(1);
    const f2 = new Fake();
    f2.refCreateStatus = 403;
    const { rt: rt2 } = await setup({ auth: "pat", fake: f2, teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const bad = (await checkTeamSyncAccess(rt2, { deep: true })).find((c) => c.id === "write")!;
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("Contents: Read and write");
  });

  it("without the write test, writing is reported as not checked", async () => {
    const { rt, fake } = await setup({ auth: "pat", teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    expect((await checkTeamSyncAccess(rt)).find((c) => c.id === "write")!.status).toBe("info");
    expect(fake.refs).toEqual([]);
  });
});

describe("portal views", () => {
  it("the connection test returns the findings", async () => {
    const { rt } = await setup({ auth: "pat" });
    const r = await checkConnection(rt, "team-sync");
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(["source", "read", "file"]);
  });

  it("the Integrations list shows team-sync as connected through GitHub (PAT and App)", async () => {
    for (const auth of ["pat", "app"] as const) {
      const { rt } = await setup({ auth });
      const row = (await listConnections(rt)).find((c) => c.id === "team-sync")!;
      expect(row.connected).toBe(true);
      expect(row.source).toBe("github");
    }
    const { rt: own } = await setup({ auth: "pat", ownToken: true });
    expect((await listConnections(own)).find((c) => c.id === "team-sync")!.source).toBe("env");
  });

  it("the guided token page prefills name, owner and exactly the needed rights for the team repository", async () => {
    const { rt } = await setup({ auth: "pat", teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
    const row = (await listConnections(rt)).find((c) => c.id === "team-sync")!;
    const q = new URL(row.openUrl!).searchParams;
    expect(q.get("target_name")).toBe("acme");
    expect(q.get("contents")).toBe("write");
    expect(q.get("pull_requests")).toBe("write");
    expect(q.get("metadata")).toBe("read");
    expect(row.steps.join(" ")).toContain("team-config");
    expect(row.permissions).toEqual(["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"]);
  });
});

describe("no token anywhere", () => {
  it("responses, findings and status never contain a token or the private key", async () => {
    for (const auth of ["pat", "app"] as const) {
      const { rt } = await setup({ auth, teamSync: "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n" });
      const out = [await teamSyncStatus(rt), await checkTeamSync(rt), await checkTeamSyncAccess(rt, { deep: true }), await checkConnection(rt, "team-sync"), await listConnections(rt)];
      const text = all(out);
      for (const secret of [PAT, OWN, INSTALL_TOKEN, "BEGIN PRIVATE KEY", PRIVATE_KEY.slice(40, 80)]) expect(text).not.toContain(secret);
    }
  });
});

void ({} as Runtime);
