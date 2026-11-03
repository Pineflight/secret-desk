import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriver } from "@secret-desk/automation";
import { InventoryError, IssuanceError } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../src/agent-api.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { checkTeamSyncAccess, teamSyncStatus, teamTokenSource } from "../src/team-sync.js";
import { readTeamTokenRecord, retireTeamToken, writeTeamTokenRecord } from "../src/team-token-meta.js";
import { rightsCover, teamRights, teamRightsLabels, teamRightsList, teamRightsQuery } from "../src/team-token-rights.js";
import { cancelTeamToken, checkTeamTokenSession, dismissTeamTokenRevocation, getTeamTokenInfo, startTeamToken, teamTokenVars, verifyTeamToken } from "../src/team-token.js";

const NEW_TOKEN = "github_" + "pat_made_up_new_team_token_1";
const OLD_TOKEN = "github_" + "pat_made_up_old_team_token_0";
const MAIN_TOKEN = "gh_main_made_up_integration";
const REPO = "acme-org/team-config";
const FIELD = 'Feld "Token name"';

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

interface Site {
  /** false: GitHub redirects to its sign-in page until the test flips it. */
  signedIn: boolean;
  /** false: the form is hidden behind "Confirm access" until the test flips it. */
  confirmed: boolean;
  drivers: FakeDriver[];
}

/** A fake GitHub token form: the recipe's selectors, the new token shown after the second click. */
function formDriver(site: Site): FakeDriver {
  const d: FakeDriver = new FakeDriver({
    pollMs: 2,
    on: (e, drv) => {
      if (e.action === "goto") {
        drv.url = site.signedIn ? e.key : "https://github.com/login";
        if (site.signedIn && site.confirmed) for (const v of [FIELD, 'radio "Only select repositories"', 'button "Select repositories"', 'Platzhalter "Search for a repository"', 'button "Generate token"']) drv.visible.add(v);
        return;
      }
      if (e.action === "click" && e.key.startsWith("option ")) return;
      if (e.action === "click" && e.key === 'button "Select repositories"') {
        drv.visible.add('option "team-config"');
        return;
      }
      if (e.action === "click" && e.key === 'button "Generate token"') {
        drv.visible.add("css [role=dialog] button[type=submit]");
        return;
      }
      if (e.action === "click" && e.key === "css [role=dialog] button[type=submit]") {
        drv.visible.add("css #new-access-token");
        drv.texts.set("css #new-access-token", NEW_TOKEN);
      }
    },
  });
  site.drivers.push(d);
  return d;
}

interface Api {
  /** Bearer tokens GitHub saw, in order. */
  bearers: string[];
  paths: string[];
  repo: { private: boolean; permissions: { push: boolean } };
  /** Status returned to the new token. */
  newTokenStatus: number;
}

async function setup(opts: { automation?: boolean; teamSync?: string; signedIn?: boolean; confirmed?: boolean } = {}) {
  const site: Site = { signedIn: opts.signedIn ?? true, confirmed: opts.confirmed ?? true, drivers: [] };
  const api: Api = { bearers: [], paths: [], repo: { private: true, permissions: { push: true } }, newTokenStatus: 200 };
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const bearer = String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "").replace("Bearer ", "");
    api.bearers.push(bearer);
    api.paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (bearer === NEW_TOKEN && api.newTokenStatus !== 200) return j({ message: "Resource not accessible by personal access token" }, api.newTokenStatus);
    if (u.pathname === "/repos/acme-org/team-config") return j({ ...api.repo, default_branch: "main" });
    if (u.pathname.startsWith("/repos/acme-org/team-config/git/ref/heads/")) return j({ object: { sha: "head1" } });
    if (u.pathname.startsWith("/repos/acme-org/team-config/git/trees/")) return j({ tree: [{ type: "blob", path: "team.yaml" }] });
    if (u.pathname === "/repos/acme-org/team-config/pulls") return j([]);
    if (u.pathname.startsWith("/repos/acme-org/team-config/contents/")) return j({ message: "Not Found" }, 404);
    return j({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-team-token-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(
    join(dir, "secret-desk.config.yaml"),
    `inventory: ./inventory.yaml\ngithub:\n  owner: acme-org\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\nautomation:\n  enabled: ${opts.automation ?? true}\n${opts.teamSync ?? ""}`,
  );
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), {
    vault: null,
    env: { GH_TEST: MAIN_TOKEN } as unknown as NodeJS.ProcessEnv,
    fetch: fetchMock,
    automationDriver: () => formDriver(site),
  });
  return { rt, site, api };
}

const until = async (fn: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout in test");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const finished = (rt: Runtime) => ["done", "failed", "cancelled"].includes(rt.automation.state("team-token").status);
const TEAM_SYNC = "teamSync:\n  repo: acme-org/team-config\n  mode: pull\n";

describe("team token rights", () => {
  it("read only: contents read, metadata read", () => {
    const r = teamRights("pull", "pull-request");
    expect(r).toEqual({ contents: "read", metadata: "read" });
    expect(teamRightsQuery(r)).toBe("contents=read&metadata=read");
    expect(teamRightsList(r)).toBe("contents=read,metadata=read");
    expect(teamRightsLabels(r)).toEqual(["Contents: Read", "Metadata: Read"]);
  });

  it("read and push: contents write, pull requests write, metadata read", () => {
    const r = teamRights("pull-push", "pull-request");
    expect(r).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
    expect(teamRightsQuery(r)).toBe("contents=write&pull_requests=write&metadata=read");
    expect(teamRightsLabels(r)).toEqual(["Contents: Read and write", "Pull requests: Read and write", "Metadata: Read"]);
  });

  it("a direct push needs no pull request right", () => {
    expect(teamRights("pull-push", "direct")).toEqual({ contents: "write", metadata: "read" });
  });

  it("covers: write includes read, pull requests only by write", () => {
    expect(rightsCover(teamRights("pull-push", "pull-request"), teamRights("pull", "direct"))).toBe(true);
    expect(rightsCover(teamRights("pull", "direct"), teamRights("pull-push", "direct"))).toBe(false);
    expect(rightsCover(teamRights("pull-push", "direct"), teamRights("pull-push", "pull-request"))).toBe(false);
  });
});

describe("team token run parameters", () => {
  it("passes owner, repository, rights, name, description and 90 days to the recipe", async () => {
    const { rt } = await setup();
    const recipe = rt.automation.recipe("github-fine-grained-token")!;
    const now = new Date("2026-11-03T10:07:00Z");
    const v = teamTokenVars(recipe, { owner: "acme-org", name: "team-config", mode: "pull-push", strategy: "pull-request" }, now);
    expect(v["owner"]).toBe("acme-org");
    expect(v["repos"]).toBe("team-config");
    expect(v["days"]).toBe("90");
    expect(v["date"]).toBe("2026-11-03");
    expect(v["permissionsQuery"]).toBe("contents=write&pull_requests=write&metadata=read");
    expect(v["name"]).toBe("secret-desk-t~team-config-20261103-1007");
    expect(v["description"]).toBe("secret-desk team sync (read and push)");
    expect(teamTokenVars(recipe, { owner: "acme-org", name: "team-config", mode: "pull", strategy: "pull-request" }, now)["description"]).toBe("secret-desk team sync (read)");
  });

  it("keeps the name within 40 characters for a long repository name", async () => {
    const { rt } = await setup();
    const recipe = rt.automation.recipe("github-fine-grained-token")!;
    const v = teamTokenVars(recipe, { owner: "acme-org", name: "a-very-long-team-configuration-repository-name", mode: "pull", strategy: "pull-request" }, new Date("2026-11-03T10:07:00Z"));
    expect(v["name"]!.length).toBeLessThanOrEqual(40);
    expect(v["name"]).toMatch(/-20261103-1007$/);
  });
});

describe("team token run", () => {
  it("creates the token with the rights of the mode, tests it and stores it as the team sync connection", async () => {
    const { rt, site, api } = await setup({ teamSync: TEAM_SYNC });
    const state = startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    expect(state.status).toBe("running");
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("done");
    expect(run.timeline?.map((x) => x.phase)).toEqual(["opening", "creating", "testing", "ready"]);
    expect(run.timeline?.every((x) => x.state === "done")).toBe(true);

    const d = site.drivers[0]!;
    const goto = d.calls.find((c) => c.startsWith("goto https://github.com/settings/personal-access-tokens/new"))!;
    expect(goto).toContain("target_name=acme-org");
    expect(goto).toContain("expires_in=90");
    expect(goto).toContain("contents=read&metadata=read");
    expect(goto).not.toContain("pull_requests");
    expect(d.filled.get(FIELD)).toMatch(/^secret-desk-t~team-config-\d{8}-\d{4}$/);
    expect(d.calls).toContain('click option "team-config"');

    // Tested with the new token itself, before it was stored.
    expect(api.bearers).toContain(NEW_TOKEN);
    expect(api.bearers.filter((b) => b === NEW_TOKEN).length).toBeGreaterThan(0);
    const status = await rt.connections.status("team-sync");
    expect(status.connected).toBe(true);
    expect(status.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await rt.connections.token("team-sync")).reveal()).toBe(NEW_TOKEN);
    // The general integration connection is untouched.
    expect((await rt.connections.token("github")).reveal()).toBe(MAIN_TOKEN);

    const rec = await readTeamTokenRecord(rt);
    expect(rec.active).toMatchObject({ repo: REPO, mode: "pull", strategy: "pull-request" });
    expect(rec.active?.tokenName).toMatch(/^secret-desk-t~team-config-/);
    expect(rec.pendingRevocation).toBeNull();
  });

  it("team sync prefers the team token and falls back to the integration for another repository or more rights", async () => {
    const { rt, api } = await setup({ teamSync: TEAM_SYNC });
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull" })).toBe("github-pat");
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull" })).toBe("own");
    expect(await teamTokenSource(rt, { repo: REPO })).toBe("own");
    expect(await teamTokenSource(rt, { repo: "acme-org/other", mode: "pull" })).toBe("github-pat");
    // No repository named (the repository list of the setup page): the integration, not a one-repository token.
    expect(await teamTokenSource(rt)).toBe("github-pat");
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull-push", strategy: "pull-request" })).toBe("github-pat");
    expect((await teamSyncStatus(rt)).tokenSource).toBe("own");

    api.bearers.length = 0;
    await checkTeamSyncAccess(rt);
    expect(api.bearers.length).toBeGreaterThan(0);
    expect(new Set(api.bearers)).toEqual(new Set([NEW_TOKEN]));
  });

  it("a read and push token serves both modes", async () => {
    const { rt } = await setup();
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", strategy: "pull-request", branch: "main" });
    await until(() => finished(rt));
    expect(rt.automation.state("team-token").status).toBe("done");
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull" })).toBe("own");
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull-push", strategy: "pull-request" })).toBe("own");
    expect(await teamTokenSource(rt, { repo: REPO, mode: "pull-push", strategy: "direct" })).toBe("own");
  });

  it("asks the recipe for the pull request right in push mode and sends it in the form address", async () => {
    const { rt, site } = await setup();
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => finished(rt));
    expect(site.drivers[0]!.calls.find((c) => c.includes("personal-access-tokens/new"))).toContain("contents=write&pull_requests=write&metadata=read");
  });

  it("waits for sign-in and for the confirmation, shows both phases and goes on", async () => {
    const { rt, site } = await setup({ signedIn: false, confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").status === "waiting-human");
    expect(rt.automation.state("team-token").phase).toBe("signin");
    // The human signs in; GitHub now asks "Confirm access".
    site.signedIn = true;
    const d = site.drivers[0]!;
    d.url = "https://github.com/settings/profile";
    await until(() => rt.automation.state("team-token").phase === "confirm");
    expect(rt.automation.state("team-token").status).toBe("waiting-human");
    for (const v of [FIELD, 'radio "Only select repositories"', 'button "Select repositories"', 'Platzhalter "Search for a repository"', 'button "Generate token"']) d.visible.add(v);
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("done");
    expect(run.timeline?.map((x) => x.phase)).toEqual(["opening", "signin", "confirm", "creating", "testing", "ready"]);
  });

  it("a failed test keeps the previous state: the old token stays, the new one is not stored", async () => {
    const { rt, api } = await setup({ teamSync: TEAM_SYNC });
    rt.connections.session.set("team-sync", OLD_TOKEN, null);
    await writeTeamTokenRecord(rt, { active: { repo: REPO, mode: "pull", strategy: "pull-request", tokenName: "secret-desk-team-team-config-20260101-0000", createdAt: "2026-01-01T00:00:00Z", expires: "2099-01-01" }, pendingRevocation: null });
    api.newTokenStatus = 403;
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("failed");
    expect(run.failure?.code).toBe("test");
    expect(run.createdName).toMatch(/^secret-desk-t~team-config-/);
    expect(run.failure?.messageEn).toContain("github.com/settings/personal-access-tokens");
    expect((await rt.connections.token("team-sync")).reveal()).toBe(OLD_TOKEN);
    const rec = await readTeamTokenRecord(rt);
    expect(rec.active?.tokenName).toBe("secret-desk-team-team-config-20260101-0000");
    expect(rec.pendingRevocation).toBeNull();
    expect(JSON.stringify(run)).not.toContain(NEW_TOKEN);
  });

  it("refuses a repository that is not private and a push token without push permission", async () => {
    const a = await setup();
    a.api.repo.private = false;
    startTeamToken(a.rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(a.rt));
    expect(a.rt.automation.state("team-token").failure?.code).toBe("test");
    expect((await a.rt.connections.status("team-sync")).connected).toBe(false);

    const b = await setup();
    b.api.repo.permissions.push = false;
    startTeamToken(b.rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => finished(b.rt));
    expect(b.rt.automation.state("team-token").failure?.messageEn).toContain("cannot push");
    expect((await b.rt.connections.status("team-sync")).connected).toBe(false);
  });

  it("verifyTeamToken reads with the given token and never puts it into a problem text", async () => {
    const { rt, api } = await setup();
    api.newTokenStatus = 401;
    const { SecretValue } = await import("@secret-desk/core");
    const problem = await verifyTeamToken(rt, SecretValue.from(NEW_TOKEN), { owner: "acme-org", name: "team-config", branch: "main", mode: "pull", strategy: "pull-request" });
    expect(problem).toContain("GitHub refused the new token");
    expect(problem).not.toContain(NEW_TOKEN);
  });

  it("a second token marks the first one for deletion at GitHub and never claims it was revoked", async () => {
    const { rt } = await setup({ teamSync: TEAM_SYNC });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const first = (await readTeamTokenRecord(rt)).active!.tokenName;
    // Later the person wants push as well: a new token for the same repository.
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => rt.automation.state("team-token").status === "done" && !rt.automation.isBusy());
    const info = await getTeamTokenInfo(rt, human);
    expect(info.active).toMatchObject({ mode: "pull-push", valid: true });
    expect(info.pendingRevocation).toMatchObject({ tokenName: first, repo: REPO, url: "https://github.com/settings/personal-access-tokens" });
    expect(JSON.stringify(info)).not.toMatch(/revoked/i);
    const after = await dismissTeamTokenRevocation(rt, human);
    expect(after.pendingRevocation).toBeNull();
    expect(after.active).not.toBeNull();
  });

  it("a typed-in token retires the portal's token and lists it for deletion", async () => {
    const { rt } = await setup({ teamSync: TEAM_SYNC });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const name = (await readTeamTokenRecord(rt)).active!.tokenName;
    await retireTeamToken(rt);
    const rec = await readTeamTokenRecord(rt);
    expect(rec.active).toBeNull();
    expect(rec.pendingRevocation?.tokenName).toBe(name);
    // Without portal meta a team-sync token is used as before (no restriction).
    expect(await teamTokenSource(rt, { repo: "acme-org/other", mode: "pull-push" })).toBe("own");
  });

  it("the meta entry is not listed as a connection", async () => {
    const { rt } = await setup();
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    expect(await rt.connections.ids()).not.toContain("team-sync#meta");
  });

  it("no response, state or info carries the token or any sign-in", async () => {
    const { rt } = await setup({ teamSync: TEAM_SYNC });
    const started = startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const all = JSON.stringify([started, rt.automation.state("team-token"), await getTeamTokenInfo(rt, human), await teamSyncStatus(rt), await rt.connections.status("team-sync"), rt.automation.info()]);
    expect(all).not.toContain(NEW_TOKEN);
    expect(all).not.toContain(MAIN_TOKEN);
  });
});

describe("team token policy and input", () => {
  it("agents can neither start, cancel, check nor read the team token", async () => {
    const { rt, site } = await setup();
    expect(() => startTeamToken(rt, agent, { repo: REPO, mode: "pull" })).toThrow(PolicyError);
    expect(() => cancelTeamToken(rt, agent)).toThrow(PolicyError);
    await expect(checkTeamTokenSession(rt, agent)).rejects.toThrow(PolicyError);
    await expect(getTeamTokenInfo(rt, agent)).rejects.toThrow(PolicyError);
    await expect(dismissTeamTokenRevocation(rt, agent)).rejects.toThrow(PolicyError);
    expect(site.drivers).toHaveLength(0);
  });

  it("browser automation off: a clear refusal, nothing is opened", async () => {
    const { rt, site } = await setup({ automation: false });
    expect(() => startTeamToken(rt, human, { repo: REPO, mode: "pull" })).toThrow(InventoryError);
    const info = await getTeamTokenInfo(rt, human);
    expect(info).toMatchObject({ available: false, reason: "automation-off" });
    expect(site.drivers).toHaveLength(0);
  });

  it("rejects a bad repository, mode, strategy or branch before any browser is opened", async () => {
    const { rt, site } = await setup();
    for (const body of [{ repo: "no-slash", mode: "pull" }, { repo: "a/b/c", mode: "pull" }, { repo: "../x", mode: "pull" }, { repo: REPO, mode: "write" }, { repo: REPO, mode: "pull", strategy: "force" }, { repo: REPO, mode: "pull", branch: "bad branch" }, {}]) {
      expect(() => startTeamToken(rt, human, body), JSON.stringify(body)).toThrow(InventoryError);
    }
    expect(site.drivers).toHaveLength(0);
  });

  it("only one browser run at a time", async () => {
    const { rt } = await setup({ signedIn: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    expect(() => startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" })).toThrow(IssuanceError);
    cancelTeamToken(rt, human);
    await until(() => finished(rt));
    expect(rt.automation.state("team-token").status).toBe("cancelled");
  });

  it("check sign-in: signed in and signed out", async () => {
    const out = await setup({ signedIn: false });
    expect((await checkTeamTokenSession(out.rt, human)).signedIn).toBe(false);
    const inn = await setup({ signedIn: true });
    expect((await checkTeamTokenSession(inn.rt, human)).signedIn).toBe(true);
    expect(inn.site.drivers[0]!.closed).toBe(true);
  });
});
