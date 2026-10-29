import { mkdtemp, readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamSyncError, TeamSyncSchema, ensureConfigFile, exportTeamBundle, InventoryStore, readTeamSyncState, ConfigSchema } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import {
  MIN_PUSH_INTERVAL_MS,
  applyTeamSync,
  checkTeamSync,
  dismissTeamSetup,
  planTeamPush,
  previewTeamText,
  pushTeamSync,
  setupTeamSync,
  startupTeamSync,
  teamSyncStatus,
} from "../src/team-sync.js";

const TOKEN = "team_token_made_up_1";
const LOCAL_INVENTORY = `version: 1
secrets:
  - id: hmac-app
    name: APP_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    externalId: provider-internal-id-1
    rotatedAt: "2026-01-01"
    places:
      - { repo: app, scope: repository }
variables: []
`;
const REMOTE_OTHER = `version: 1
secrets:
  - id: hmac-app
    name: APP_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: app, scope: repository }
  - id: api-key
    name: API_KEY
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: app, scope: repository }
variables: []
`;

/** Kleines GitHub in Arbeitsspeicher: Zweige mit Dateien, Pull Requests, Zugriffspruefung. */
class FakeGitHub {
  branches = new Map<string, Map<string, { text: string; sha: string }>>([["main", new Map()]]);
  pulls: { number: number; head: string; base: string; title: string; body: string; state: string }[] = [];
  calls: string[] = [];
  bodies: string[] = [];
  fail: { status: number } | "network" | null = null;
  #n = 0;
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string>)["Authorization"];
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    if (init?.body) this.bodies.push(String(init.body));
    if (this.fail === "network") throw new TypeError("fetch failed");
    if (this.fail) return json({ message: "denied" }, this.fail.status);
    if (auth !== `Bearer ${TOKEN}`) return json({ message: "Bad credentials" }, 401);
    const m = /^\/repos\/acme\/team-config\/(.*)$/.exec(url.pathname);
    if (!m) return json({ message: "Not Found" }, 404);
    const rest = m[1]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let r: RegExpExecArray | null;
    if ((r = /^contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(r[1]!);
      if (method === "GET") {
        const f = this.branches.get(url.searchParams.get("ref") ?? "main")?.get(path);
        return f ? json({ type: "file", sha: f.sha, content: Buffer.from(f.text).toString("base64"), encoding: "base64" }) : json({ message: "Not Found" }, 404);
      }
      const files = this.branches.get(String(body["branch"]));
      if (!files) return json({ message: "Branch not found" }, 404);
      const cur = files.get(path);
      if (cur && body["sha"] !== cur.sha) return json({ message: "does not match" }, 409);
      const sha = `sha${++this.#n}`;
      files.set(path, { text: Buffer.from(String(body["content"]), "base64").toString("utf8"), sha });
      return json({ content: { sha } }, cur ? 200 : 201);
    }
    if ((r = /^git\/ref\/heads\/(.+)$/.exec(rest))) return this.branches.has(r[1]!) ? json({ object: { sha: `head-${r[1]}` } }) : json({ message: "Not Found" }, 404);
    if (rest === "git/refs" && method === "POST") {
      const name = String(body["ref"]).replace("refs/heads/", "");
      this.branches.set(name, new Map([...(this.branches.get("main") ?? new Map())]));
      return json({}, 201);
    }
    if (rest.startsWith("pulls") && method === "GET") return json(this.pulls.filter((p) => p.state === "open" && p.head === url.searchParams.get("head")?.split(":")[1] && p.base === url.searchParams.get("base")).map((p) => ({ number: p.number, html_url: `https://github.com/acme/team-config/pull/${p.number}` })));
    if (rest === "pulls" && method === "POST") {
      const p = { number: this.pulls.length + 1, head: String(body["head"]), base: String(body["base"]), title: String(body["title"]), body: String(body["body"]), state: "open" };
      this.pulls.push(p);
      return json({ number: p.number, html_url: `https://github.com/acme/team-config/pull/${p.number}` }, 201);
    }
    if ((r = /^pulls\/(\d+)$/.exec(rest)) && method === "PATCH") {
      const p = this.pulls.find((x) => x.number === Number(r![1]))!;
      p.title = String(body["title"]);
      p.body = String(body["body"]);
      return json({});
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  setMain(text: string, path = "secret-desk.team.yaml") {
    this.branches.get("main")!.set(path, { text, sha: `sha${++this.#n}` });
  }
  main(path = "secret-desk.team.yaml") {
    return this.branches.get("main")!.get(path);
  }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const TEAM_SYNC = "teamSync:\n  repo: acme/team-config\n";

async function setup(opts: { teamSync?: string; inventory?: string; gh?: FakeGitHub; token?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sd-ts-"));
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? LOCAL_INVENTORY);
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${opts.teamSync ?? TEAM_SYNC}`);
  const gh = opts.gh ?? new FakeGitHub();
  const env = { GH_TEST: "gh_main_token_made_up", ...(opts.token === false ? {} : { SECRET_DESK_TEAM_TOKEN: TOKEN }) } as unknown as NodeJS.ProcessEnv;
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env, fetch: gh.fetch, bundledRecipes: null });
  return { rt, gh, dir };
}
const t0 = new Date("2026-03-01T10:00:00Z");
const seen = (...vals: unknown[]) => JSON.stringify(vals);

describe("teamSync schema", () => {
  it("applies the defaults", () => {
    const c = TeamSyncSchema.parse({ repo: "acme/team-config" });
    expect(c).toEqual({ repo: "acme/team-config", path: "secret-desk.team.yaml", branch: "main", mode: "pull", push: { strategy: "pull-request", branch: "secret-desk/team-sync" }, pullOnStart: true });
  });
  it("rejects a repo without owner/name and an unknown mode", () => {
    expect(TeamSyncSchema.safeParse({ repo: "team-config" }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "a/b", mode: "push" }).success).toBe(false);
    expect(TeamSyncSchema.safeParse({ repo: "a/b", push: { strategy: "force" } }).success).toBe(false);
  });
  it("is optional in the configuration", () => {
    expect(ConfigSchema.parse({ inventory: "i.yaml", github: { owner: "a", auth: { type: "pat" } } }).teamSync).toBeUndefined();
  });
});

describe("pull: check", () => {
  it("not configured -> not-configured error", async () => {
    const { rt } = await setup({ teamSync: "" });
    await expect(checkTeamSync(rt)).rejects.toMatchObject({ code: "not-configured" });
    expect((await teamSyncStatus(rt)).configured).toBe(false);
  });

  it("missing file in the repository", async () => {
    const { rt } = await setup();
    expect((await checkTeamSync(rt, t0)).state).toBe("missing-remote");
  });

  it("new: remote has content, local inventory is empty", async () => {
    const { rt, gh } = await setup({ inventory: "version: 1\nsecrets: []\nvariables: []\n" });
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    expect(c.state).toBe("remote-new");
    expect(c.diff?.sections.secrets.added).toEqual(["hmac-app", "api-key"]);
  });

  it("unchanged: equal content is in-sync and remembers the blob sha", async () => {
    const { rt, gh, dir } = await setup();
    gh.setMain(exportTeamBundle(rt.inventory.data));
    const c = await checkTeamSync(rt, t0);
    expect(c.state).toBe("in-sync");
    expect((await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"))).remoteSha).toBe(gh.main()!.sha);
  });

  it("changed remote after a sync -> remote-changed, with a preview of ids only", async () => {
    const { rt, gh } = await setup();
    gh.setMain(exportTeamBundle(rt.inventory.data));
    await checkTeamSync(rt, t0);
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    expect(c.state).toBe("remote-changed");
    expect(c.diff?.sections.secrets.added).toEqual(["api-key"]);
  });

  it("both sides changed -> conflict, nothing is overwritten", async () => {
    const { rt, gh } = await setup();
    gh.setMain(exportTeamBundle(rt.inventory.data));
    await checkTeamSync(rt, t0);
    gh.setMain(REMOTE_OTHER);
    rt.inventory.addSecret({ id: "local-new", name: "LOCAL_NEW", stage: "shared", service: "intern", provider: "random-hex", expiry: "none", places: [{ repo: "app", scope: "repository" }] } as never);
    const c = await checkTeamSync(rt, t0);
    expect(c.state).toBe("conflict");
    expect(rt.inventory.getSecret("local-new")).toBeDefined();
  });

  it("local changes only -> local-changed", async () => {
    const { rt, gh } = await setup();
    gh.setMain(exportTeamBundle(rt.inventory.data));
    await checkTeamSync(rt, t0);
    rt.inventory.addSecret({ id: "local-new", name: "LOCAL_NEW", stage: "shared", service: "intern", provider: "random-hex", expiry: "none", places: [{ repo: "app", scope: "repository" }] } as never);
    expect((await checkTeamSync(rt, t0)).state).toBe("local-changed");
  });

  it("errors: 404, 403, 401 (wrong token) and network are explained without the token", async () => {
    const outputs: unknown[] = [];
    for (const [fail, code] of [[{ status: 404 }, "not-found"], [{ status: 403 }, "denied"], [{ status: 401 }, "denied"], ["network", "network"]] as const) {
      const { rt, gh } = await setup();
      gh.fail = fail;
      const err = await checkTeamSync(rt).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TeamSyncError);
      expect((err as TeamSyncError).code).toBe(code);
      outputs.push((err as Error).message, (await teamSyncStatus(rt)));
    }
    expect(seen(outputs)).not.toContain(TOKEN);
  });

  it("a wrong token gives the token-rejected message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-ts-"));
    await writeFile(join(dir, "inventory.yaml"), LOCAL_INVENTORY);
    await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n${TEAM_SYNC}`);
    const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: { GH_TEST: "x_made_up", SECRET_DESK_TEAM_TOKEN: "other_token_made_up_9" } as unknown as NodeJS.ProcessEnv, fetch: new FakeGitHub().fetch, bundledRecipes: null });
    await expect(checkTeamSync(rt)).rejects.toThrow(/abgelehnt/);
  });

  it("status exposes no token and only the connection state", async () => {
    const { rt } = await setup();
    const st = await teamSyncStatus(rt);
    expect(st).toMatchObject({ configured: true, connected: true, repo: "acme/team-config", mode: "pull" });
    expect(seen(st)).not.toContain(TOKEN);
  });

  it("without an own token the GitHub integration is used (see team-sync-github-auth.test.ts); without any token it is not connected", async () => {
    const { rt } = await setup({ token: false });
    const st = await teamSyncStatus(rt);
    expect(st.connected).toBe(true);
    expect(st.tokenSource).toBe("github-pat");
  });
});

describe("pull: apply", () => {
  it("merge adds new entries and keeps existing ones", async () => {
    const { rt, gh } = await setup();
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    const r = await applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "merge" }, t0);
    expect(r.added).toEqual(["api-key"]);
    expect(rt.inventory.getSecret("hmac-app")?.externalId).toBe("provider-internal-id-1");
    expect((await checkTeamSync(rt, t0)).state).toBe("in-sync");
  });

  it("replace needs confirmReplace", async () => {
    const { rt, gh } = await setup();
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    await expect(applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "replace" })).rejects.toThrow(/confirmReplace/);
    expect(rt.inventory.getSecret("api-key")).toBeUndefined();
    await applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "replace", confirmReplace: true }, t0);
    expect(rt.inventory.getSecret("api-key")).toBeDefined();
    expect(rt.inventory.getSecret("hmac-app")?.externalId).toBe("provider-internal-id-1");
  });

  it("keep-local changes nothing locally and marks the remote state as seen", async () => {
    const { rt, gh } = await setup();
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    await applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "keep-local" }, t0);
    expect(rt.inventory.getSecret("api-key")).toBeUndefined();
    expect((await checkTeamSync(rt, t0)).state).toBe("local-changed");
  });

  it("refuses when the repository changed after the preview", async () => {
    const { rt, gh } = await setup();
    gh.setMain(REMOTE_OTHER);
    const c = await checkTeamSync(rt, t0);
    gh.setMain(REMOTE_OTHER.replace("API_KEY", "API_KEY_2"));
    await expect(applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "merge" })).rejects.toMatchObject({ code: "changed" });
    expect(rt.inventory.getSecret("api-key")).toBeUndefined();
  });

  it("an invalid team file is a clear error and changes nothing", async () => {
    const { rt, gh } = await setup();
    gh.setMain("version: 1\nsecrets: [ {nope: 1} ]\n");
    await expect(checkTeamSync(rt)).rejects.toThrow();
    expect(rt.inventory.data.secrets).toHaveLength(1);
  });

  it("previews an uploaded text without changing anything", async () => {
    const { rt } = await setup();
    const d = previewTeamText(rt, REMOTE_OTHER);
    expect(d.sections.secrets.added).toEqual(["api-key"]);
    expect(rt.inventory.getSecret("api-key")).toBeUndefined();
  });
});

const PUSH = "teamSync:\n  repo: acme/team-config\n  mode: pull-push\n";

describe("push", () => {
  it("is off in mode pull", async () => {
    const { rt } = await setup();
    await expect(planTeamPush(rt)).rejects.toMatchObject({ code: "forbidden-mode" });
  });

  it("pull-request: branch, commit, one PR; content has no values, externalId or rotatedAt", async () => {
    const { rt, gh } = await setup({ teamSync: PUSH });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    await checkTeamSync(rt, t0);
    const plan = await planTeamPush(rt);
    const r = await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha, lang: "en" }, t0);
    expect(r).toMatchObject({ pushed: true, strategy: "pull-request", pullRequest: { number: 1 } });
    const pushed = gh.branches.get("secret-desk/team-sync")!.get("secret-desk.team.yaml")!.text;
    expect(pushed).toContain("APP_HMAC_SECRET");
    expect(pushed).not.toContain("externalId");
    expect(pushed).not.toContain("provider-internal-id-1");
    expect(pushed).not.toContain("rotatedAt");
    expect(seen(gh.bodies)).not.toContain(TOKEN);
    expect(gh.pulls[0]).toMatchObject({ head: "secret-desk/team-sync", base: "main", title: "secret-desk: update team configuration" });
    expect(gh.main()!.text).not.toContain("rotatedAt");
  });

  it("updates the open PR instead of opening a second one (after the debounce time)", async () => {
    const { rt, gh } = await setup({ teamSync: PUSH, inventory: "version: 1\nsecrets: []\nvariables: []\n" });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    await checkTeamSync(rt, t0);
    rt.inventory.addSecret({ id: "s1", name: "S_ONE", stage: "shared", service: "intern", provider: "random-hex", expiry: "none", places: [{ repo: "app", scope: "repository" }] } as never);
    let plan = await planTeamPush(rt);
    await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, t0);
    rt.inventory.addSecret({ id: "s2", name: "S_TWO", stage: "shared", service: "intern", provider: "random-hex", expiry: "none", places: [{ repo: "app", scope: "repository" }] } as never);
    plan = await planTeamPush(rt);
    // Entprellung: zu frueh
    await expect(pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, new Date(t0.getTime() + 5_000))).rejects.toMatchObject({ code: "too-soon" });
    await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, new Date(t0.getTime() + MIN_PUSH_INTERVAL_MS + 1));
    expect(gh.pulls).toHaveLength(1);
    expect(gh.branches.get("secret-desk/team-sync")!.get("secret-desk.team.yaml")!.text).toContain("S_TWO");
  });

  it("direct: commits on the branch", async () => {
    const { rt, gh } = await setup({ teamSync: `${PUSH}  push:\n    strategy: direct\n` });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    await checkTeamSync(rt, t0);
    const plan = await planTeamPush(rt);
    const r = await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, t0);
    expect(r).toMatchObject({ pushed: true, strategy: "direct" });
    expect(gh.main()!.text).toContain("APP_HMAC_SECRET");
    expect(gh.pulls).toHaveLength(0);
  });

  it("direct: creates the file if the repository has none yet", async () => {
    const { rt, gh } = await setup({ teamSync: `${PUSH}  push:\n    strategy: direct\n` });
    const plan = await planTeamPush(rt);
    expect(plan.remoteSha).toBeNull();
    await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: null }, t0);
    expect(gh.main()!.text).toContain("APP_HMAC_SECRET");
  });

  it("needs the explicit confirmation and a matching preview", async () => {
    const { rt, gh } = await setup({ teamSync: `${PUSH}  push:\n    strategy: direct\n` });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    await checkTeamSync(rt, t0);
    const plan = await planTeamPush(rt);
    await expect(pushTeamSync(rt, { confirm: false, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha })).rejects.toThrow(/confirm/);
    await expect(pushTeamSync(rt, { confirm: true, expectLocalHash: "stale", expectRemoteSha: plan.remoteSha })).rejects.toMatchObject({ code: "changed" });
    expect(gh.main()!.text).not.toContain("APP_HMAC_SECRET");
  });

  it("refuses to push over remote changes that are missing locally (conflict)", async () => {
    const { rt, gh } = await setup({ teamSync: PUSH });
    gh.setMain(exportTeamBundle(rt.inventory.data));
    await checkTeamSync(rt, t0);
    gh.setMain(REMOTE_OTHER);
    await expect(planTeamPush(rt)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a rejected push (403) leaves no partial state and does not mention the token", async () => {
    const { rt, gh, dir } = await setup({ teamSync: `${PUSH}  push:\n    strategy: direct\n` });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    await checkTeamSync(rt, t0);
    const plan = await planTeamPush(rt);
    gh.fail = { status: 403 };
    const err = await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, t0).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(TeamSyncError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((await readTeamSyncState(join(dir, ".secret-desk-team-sync.json"))).lastPushAt).toBeNull();
  });

  it("the plan refuses a team file that contains the access token", async () => {
    const { rt } = await setup({ teamSync: PUSH, inventory: LOCAL_INVENTORY.replace("service: intern", `service: intern\n    notes: ${TOKEN}`) });
    await expect(planTeamPush(rt)).rejects.toThrow(/Zugangs-Token/);
  });
});

describe("first start: configuration and wizard", () => {
  it("creates a minimal configuration and inventory when the file is missing (no ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-boot-"));
    const path = join(dir, "config", "secret-desk.config.yaml");
    expect(await ensureConfigFile(path)).toBe(true);
    const rt = await createRuntime(path, { vault: null, env: {} as NodeJS.ProcessEnv, bundledRecipes: null });
    expect(rt.inventory.data.secrets).toEqual([]);
    expect((await readFile(path, "utf8"))).not.toMatch(/token|secret_|ghp_/i);
    expect((await teamSyncStatus(rt)).setupNeeded).toBe(true);
  });

  it("leaves an existing configuration alone", async () => {
    const { dir } = await setup();
    const before = await readFile(join(dir, "c.yaml"), "utf8");
    expect(await ensureConfigFile(join(dir, "c.yaml"))).toBe(false);
    expect(await readFile(join(dir, "c.yaml"), "utf8")).toBe(before);
  });

  it("explains an unwritable directory instead of crashing", async () => {
    if (process.getuid?.() === 0) return;
    const dir = await mkdtemp(join(tmpdir(), "sd-ro-"));
    await mkdir(join(dir, "ro"));
    await chmod(join(dir, "ro"), 0o500);
    await expect(ensureConfigFile(join(dir, "ro", "c.yaml"))).rejects.toMatchObject({ code: "unwritable" });
  });

  it("wizard path GitHub: setup writes teamSync (no token), check, apply, setup no longer needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-wiz-"));
    const path = join(dir, "c.yaml");
    await ensureConfigFile(path);
    const gh = new FakeGitHub();
    gh.setMain(REMOTE_OTHER);
    const rt = await createRuntime(path, { vault: null, env: { SECRET_DESK_TEAM_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv, fetch: gh.fetch, bundledRecipes: null });
    await setupTeamSync(rt, { repo: "acme/team-config" });
    const written = await readFile(path, "utf8");
    expect(written).toContain("repo: acme/team-config");
    expect(written).not.toContain(TOKEN);
    const c = await checkTeamSync(rt, t0);
    await applyTeamSync(rt, { expectSha: c.remoteSha!, resolution: "merge" }, t0);
    expect(rt.inventory.data.secrets).toHaveLength(2);
    const reopened = await createRuntime(path, { vault: null, env: {} as NodeJS.ProcessEnv, bundledRecipes: null });
    expect(reopened.config.teamSync?.repo).toBe("acme/team-config");
    expect((await teamSyncStatus(rt)).setupNeeded).toBe(false);
  });

  it("wizard path upload: the preview does not write, the import does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-wiz-"));
    const path = join(dir, "c.yaml");
    await ensureConfigFile(path);
    const rt = await createRuntime(path, { vault: null, env: {} as NodeJS.ProcessEnv, bundledRecipes: null });
    expect(previewTeamText(rt, REMOTE_OTHER).sections.secrets.added).toEqual(["hmac-app", "api-key"]);
    expect(rt.inventory.data.secrets).toHaveLength(0);
  });

  it("wizard path empty: dismiss hides the wizard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-wiz-"));
    const path = join(dir, "c.yaml");
    await ensureConfigFile(path);
    const rt = await createRuntime(path, { vault: null, env: {} as NodeJS.ProcessEnv, bundledRecipes: null });
    expect((await teamSyncStatus(rt)).setupNeeded).toBe(true);
    await dismissTeamSetup(rt);
    expect((await teamSyncStatus(rt)).setupNeeded).toBe(false);
  });

  it("a rejected setup input changes nothing", async () => {
    const { rt, dir } = await setup({ teamSync: "" });
    const before = await readFile(join(dir, "c.yaml"), "utf8");
    await expect(setupTeamSync(rt, { repo: "nonsense" })).rejects.toThrow(/Team-Sync ungueltig/);
    expect(await readFile(join(dir, "c.yaml"), "utf8")).toBe(before);
  });

  it("headless start: env variables set up team sync and take over once into an empty inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-env-"));
    const path = join(dir, "c.yaml");
    await ensureConfigFile(path);
    const gh = new FakeGitHub();
    gh.setMain(REMOTE_OTHER, "team/desk.yaml");
    const env = { SECRET_DESK_TEAM_REPO: "acme/team-config", SECRET_DESK_TEAM_PATH: "team/desk.yaml", SECRET_DESK_TEAM_BRANCH: "main", SECRET_DESK_TEAM_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv;
    const rt = await createRuntime(path, { vault: null, env, fetch: gh.fetch, bundledRecipes: null });
    await startupTeamSync(rt, env);
    expect(rt.config.teamSync).toMatchObject({ repo: "acme/team-config", path: "team/desk.yaml" });
    expect(rt.inventory.data.secrets).toHaveLength(2);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(seen(await teamSyncStatus(rt))).not.toContain(TOKEN);
  });

  it("start with pullOnStart only looks (nothing is taken over) and errors never abort the start", async () => {
    const { rt, gh } = await setup({ inventory: "version: 1\nsecrets: []\nvariables: []\n" });
    gh.setMain(REMOTE_OTHER);
    await startupTeamSync(rt, {} as NodeJS.ProcessEnv);
    expect(rt.inventory.data.secrets).toHaveLength(0);
    expect((await teamSyncStatus(rt)).lastCheck?.state).toBe("remote-new");
    gh.fail = { status: 403 };
    await startupTeamSync(rt, {} as NodeJS.ProcessEnv);
    expect((await teamSyncStatus(rt)).lastError).toMatch(/Rechte/);
  });

  it("pullOnStart false does not call GitHub", async () => {
    const { rt, gh } = await setup({ teamSync: "teamSync:\n  repo: acme/team-config\n  pullOnStart: false\n" });
    await startupTeamSync(rt, {} as NodeJS.ProcessEnv);
    expect(gh.calls).toEqual([]);
  });
});

describe("no token anywhere", () => {
  it("outputs of all steps never contain the token", async () => {
    const { rt, gh } = await setup({ teamSync: `${PUSH}  push:\n    strategy: direct\n` });
    gh.setMain("version: 1\nsecrets: []\nvariables: []\n");
    const out: unknown[] = [];
    const c = await checkTeamSync(rt, t0);
    out.push(c);
    const plan = await planTeamPush(rt);
    out.push(plan);
    out.push(await pushTeamSync(rt, { confirm: true, expectLocalHash: plan.localHash, expectRemoteSha: plan.remoteSha }, t0));
    out.push(await teamSyncStatus(rt));
    out.push(rt.inventory.toString(), exportTeamBundle(rt.inventory.data));
    expect(seen(out)).not.toContain(TOKEN);
    expect(seen(out)).not.toContain("gh_main_token_made_up");
    void InventoryStore;
  });
});
