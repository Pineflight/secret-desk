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
import { cancelTeamToken, checkTeamTokenSession, dismissTeamTokenRevocation, getTeamTokenInfo, startTeamToken, submitTeamTokenAccess, submitTeamTokenCode, submitTeamTokenCredentials, teamTokenVars, verifyTeamToken } from "../src/team-token.js";

const NEW_TOKEN = "github_" + "pat_made_up_new_team_token_1";
const OLD_TOKEN = "github_" + "pat_made_up_old_team_token_0";
const MAIN_TOKEN = "gh_main_made_up_integration";
const REPO = "acme-org/team-config";
const FIELD = 'Feld "Token name"';

const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

interface Site {
  /** false: GitHub redirects to its sign-in page until the sign-in form is submitted (or the test flips it). */
  signedIn: boolean;
  /** false: the form is hidden behind "Confirm access" until the confirmation is accepted. */
  confirmed: boolean;
  drivers: FakeDriver[];
  /** What the sudo page accepts. */
  sudoCode: string;
  sudoPassword: string;
  /** Typed into the sign-in form, in order. */
  typed: string[];
  /** Tokens deleted at GitHub by the delete run. */
  deleted: string[];
  /** Names of tokens that exist at GitHub (listed on the tokens page). */
  existing: string[];
  /** The delete button throws. */
  deleteBroken: boolean;
  /** The delete button leads to "Confirm access" first. */
  deleteSudo: boolean;
  /** Called when the page shows the GitHub Mobile number; the test approves with `approve()`. */
  approve(): void;
}

const FORM_FIELDS = [FIELD, 'radio "Only select repositories"', 'button "Select repositories"', 'Platzhalter "Search for a repository"', 'button "Generate token"'];
const SUDO_VISIBLE = ['button "Use GitHub Mobile"', 'Text "Use your password"', 'Text "Use your authenticator app"'];
const SUDO_FIELDS = ['css input[name="sudo_app_otp"]', 'css input[name="sudo_password"]'];
const LIST = "https://github.com/settings/personal-access-tokens";

/** A fake GitHub: sign-in page, "Confirm access", the token form and the token list. The recipes' selectors, the new token shown after the second click. */
function formDriver(site: Site): FakeDriver {
  const showSudo = (drv: FakeDriver): void => {
    drv.pageText.add("Confirm access");
    for (const v of SUDO_VISIBLE) drv.visible.add(v);
    for (const v of SUDO_FIELDS) drv.visible.delete(v);
    drv.pageText.delete("Enter the digits shown below");
    drv.visible.delete('button "Verify" (exact)');
    drv.visible.delete('button "Confirm" (exact)');
  };
  const leaveSudo = (drv: FakeDriver): void => {
    site.confirmed = true;
    drv.pageText.delete("Confirm access");
    for (const v of [...SUDO_VISIBLE, ...SUDO_FIELDS, 'button "Verify" (exact)', 'button "Confirm" (exact)']) drv.visible.delete(v);
    for (const v of FORM_FIELDS) drv.visible.add(v);
  };
  const d: FakeDriver = new FakeDriver({
    pollMs: 2,
    on: (e, drv) => {
      if (e.action === "goto") {
        if (e.key.startsWith("https://github.com/login")) {
          drv.url = site.signedIn ? "https://github.com/settings/profile" : e.key;
          if (!site.signedIn) for (const v of ["css #login_field", "css #password", 'css input[type=submit][value="Sign in"]']) drv.visible.add(v);
          return;
        }
        drv.url = site.signedIn ? e.key : "https://github.com/login";
        if (site.signedIn && e.key.startsWith("https://github.com/settings/personal-access-tokens/new")) {
          if (site.confirmed) for (const v of FORM_FIELDS) drv.visible.add(v);
          else showSudo(drv);
        }
        if (site.signedIn && e.key === LIST) for (const n of site.existing) if (!site.deleted.includes(n)) drv.visible.add(`link "${n}" (exact)`);
        return;
      }
      if (e.key === 'css input[type=submit][value="Sign in"]') {
        site.signedIn = true;
        drv.url = "https://github.com/settings/profile";
        return;
      }
      if (e.action === "click" && e.key === 'button "Use GitHub Mobile"') {
        drv.pageText.add("Enter the digits shown below");
        drv.texts.set("css main", "Confirm access Signed in as @someone We sent you a verification request on your GitHub Mobile app. Enter the digits shown below to enter sudo mode. 17");
        return;
      }
      if (e.action === "click" && e.key === 'Text "Use your authenticator app"') {
        drv.visible.add('css input[name="sudo_app_otp"]');
        drv.visible.add('button "Verify" (exact)');
        return;
      }
      if (e.action === "click" && e.key === 'Text "Use your password"') {
        drv.visible.add('css input[name="sudo_password"]');
        drv.visible.add('button "Confirm" (exact)');
        return;
      }
      if (e.action === "click" && e.key === 'button "Verify" (exact)') {
        if (drv.filled.get('css input[name="sudo_app_otp"]') === site.sudoCode) leaveSudo(drv);
        return;
      }
      if (e.action === "click" && e.key === 'button "Confirm" (exact)') {
        if (drv.filled.get('css input[name="sudo_password"]') === site.sudoPassword) leaveSudo(drv);
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
        return;
      }
      // The delete run: list, token page, delete, confirm.
      if (e.action === "click" && e.key.startsWith("link ")) {
        drv.visible.add('button "Delete" (exact)');
        return;
      }
      if (e.action === "click" && e.key === 'button "Delete" (exact)') {
        if (site.deleteBroken) throw new Error("broken");
        if (site.deleteSudo) {
          drv.visible.delete('button "Delete" (exact)');
          showSudo(drv);
          return;
        }
        drv.visible.add('button "I understand, delete this token"');
        return;
      }
      if (e.action === "click" && e.key === 'button "I understand, delete this token"') {
        for (const n of site.existing) if (!site.deleted.includes(n)) site.deleted.push(n);
        for (const n of site.existing) drv.visible.delete(`link "${n}" (exact)`);
        drv.url = LIST;
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
  const site: Site = {
    signedIn: opts.signedIn ?? true,
    confirmed: opts.confirmed ?? true,
    drivers: [],
    sudoCode: "424242",
    sudoPassword: "made-up-sudo-pw-1",
    typed: [],
    deleted: [],
    existing: [],
    deleteBroken: false,
    deleteSudo: false,
    approve: () => {
      for (const d of site.drivers) {
        d.pageText.delete("Confirm access");
        for (const v of [...SUDO_VISIBLE, ...SUDO_FIELDS]) d.visible.delete(v);
        for (const v of FORM_FIELDS) d.visible.add(v);
      }
      site.confirmed = true;
    },
  };
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
    automationAccess: { mobileTimeoutMs: 150, submitTimeoutMs: 100 },
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

  it("asks for the sign-in in the portal, types it on GitHub, wipes it and goes on", async () => {
    const { rt, site } = await setup({ signedIn: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "credentials");
    const asked = rt.automation.state("team-token");
    expect(asked.status).toBe("waiting-human");
    expect(asked.phase).toBe("signin");
    expect(asked.ask).toMatchObject({ type: "credentials", methods: [{ id: "email" }, { id: "google" }, { id: "apple" }] });
    // Wrong method, missing password and an unknown method are refused before anything is typed.
    expect(() => submitTeamTokenCredentials(rt, human, { method: "microsoft", username: "me@example.test", password: "x" })).toThrow(InventoryError);
    expect(() => submitTeamTokenCredentials(rt, human, { method: "email", username: "me@example.test" })).toThrow(InventoryError);
    expect(() => submitTeamTokenCredentials(rt, agent, { method: "email", username: "me@example.test", password: "x" })).toThrow(PolicyError);
    const body = { method: "email", username: "me@example.test", password: "made-up-gh-password" };
    submitTeamTokenCredentials(rt, human, body);
    expect(body.password).toBe("");
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("done");
    expect(run.timeline?.map((x) => x.phase)).toEqual(["opening", "signin", "creating", "testing", "ready"]);
    const d = site.drivers[0]!;
    expect(d.filled.get("css #login_field")).toBe("me@example.test");
    expect(d.filled.get("css #password")).toBe("made-up-gh-password");
    expect(d.closed).toBe(true);
    expect(JSON.stringify([asked, run, await getTeamTokenInfo(rt, human)])).not.toContain("made-up-gh-password");
    // Nothing is waiting any more.
    expect(() => submitTeamTokenCredentials(rt, human, body)).toThrow(IssuanceError);
  });

  it("a GitHub sign-in that asks for a code is answered in the portal", async () => {
    const { rt, site } = await setup({ signedIn: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "credentials");
    const d = site.drivers[0]!;
    // After the password GitHub shows the authenticator page instead of letting the browser in.
    const submit = d.click.bind(d);
    d.click = async (sel) => {
      if (sel.css === 'input[type=submit][value="Sign in"]') {
        d.visible.add("css #app_totp, #sms_totp, #otp");
        d.visible.add("css button[type=submit]");
        return;
      }
      if (sel.css === "button[type=submit]") {
        site.signedIn = true;
        d.visible.delete("css #app_totp, #sms_totp, #otp");
        d.url = "https://github.com/settings/profile";
        return;
      }
      return submit(sel);
    };
    submitTeamTokenCredentials(rt, human, { method: "email", username: "me@example.test", password: "made-up-gh-password" });
    await until(() => rt.automation.state("team-token").needs === "mfa-code");
    expect(rt.automation.state("team-token").status).toBe("waiting-human");
    expect(() => submitTeamTokenCode(rt, human, { code: "x" })).toThrow(InventoryError);
    submitTeamTokenCode(rt, human, { code: "123 456" });
    await until(() => finished(rt));
    expect(d.filled.get("css #app_totp, #sms_totp, #otp")).toBe("123456");
    expect(rt.automation.state("team-token").status).toBe("done");
  });

  it("a refused sign-in ends the run with the reason and no password in it", async () => {
    const { rt, site } = await setup({ signedIn: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "credentials");
    const d = site.drivers[0]!;
    const click = d.click.bind(d);
    d.click = async (sel) => {
      if (sel.css === 'input[type=submit][value="Sign in"]') return void d.pageText.add("Incorrect username or password");
      return click(sel);
    };
    submitTeamTokenCredentials(rt, human, { method: "email", username: "me@example.test", password: "made-up-gh-password" });
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("failed");
    expect(run.failure?.code).toBe("rejected");
    expect(JSON.stringify(run)).not.toContain("made-up-gh-password");
  });

  it("Confirm access with GitHub Mobile: the number is shown, the run goes on once the page leaves", async () => {
    const { rt, site } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    const q = rt.automation.state("team-token");
    expect(q.phase).toBe("confirm");
    expect(q.status).toBe("waiting-human");
    expect(q.ask).toMatchObject({ type: "access", stage: "choose", methods: ["mobile", "code", "password"], attempt: 1 });
    expect(() => submitTeamTokenAccess(rt, human, { method: "passkey" })).toThrow(InventoryError);
    expect(() => submitTeamTokenAccess(rt, human, { method: "code", code: "no" })).toThrow(InventoryError);
    expect(() => submitTeamTokenAccess(rt, agent, { method: "mobile" })).toThrow(PolicyError);
    submitTeamTokenAccess(rt, human, { method: "mobile" });
    await until(() => (rt.automation.state("team-token").ask as { stage?: string } | null)?.stage === "mobile");
    expect(rt.automation.state("team-token").ask).toEqual({ type: "access", stage: "mobile", number: "17" });
    site.approve();
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("done");
    expect(run.timeline?.map((x) => x.phase)).toEqual(["opening", "confirm", "creating", "testing", "ready"]);
    expect(run.ask ?? null).toBeNull();
  });

  it("GitHub Mobile not approved in time: a clear message and Try again, then another way works", async () => {
    const { rt, site } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    submitTeamTokenAccess(rt, human, { method: "mobile" });
    await until(() => {
      const a = rt.automation.state("team-token").ask as { stage?: string; attempt?: number; problem?: string } | null;
      return a?.stage === "choose" && a.attempt === 2;
    });
    expect(rt.automation.state("team-token").ask).toMatchObject({ problem: "timeout", attempt: 2 });
    const body = { method: "password", password: site.sudoPassword };
    submitTeamTokenAccess(rt, human, body);
    expect(body.password).toBe("");
    await until(() => finished(rt));
    expect(rt.automation.state("team-token").status).toBe("done");
  });

  it("Confirm access with a code: a wrong code asks again, the right one goes on, the code is never kept", async () => {
    const { rt, site } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    submitTeamTokenAccess(rt, human, { method: "code", code: "000000" });
    await until(() => {
      const a = rt.automation.state("team-token").ask as { stage?: string; attempt?: number } | null;
      return a?.stage === "choose" && a.attempt === 2;
    });
    expect(rt.automation.state("team-token").ask).toMatchObject({ problem: "rejected" });
    submitTeamTokenAccess(rt, human, { method: "code", code: site.sudoCode });
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("done");
    expect(site.drivers[0]!.filled.get('css input[name="sudo_app_otp"]')).toBe(site.sudoCode);
    expect(JSON.stringify(run)).not.toContain(site.sudoCode);
  });

  it("Confirm access with the password: typed once, masked in the screenshots, absent from state and info", async () => {
    const { rt, site } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    submitTeamTokenAccess(rt, human, { method: "password", password: site.sudoPassword });
    await until(() => finished(rt));
    const d = site.drivers[0]!;
    expect(rt.automation.state("team-token").failure ?? "ok").toBe("ok");
    expect(d.filled.get('css input[name="sudo_password"]')).toBe(site.sudoPassword);
    expect(d.shots.length).toBeGreaterThan(0);
    expect(d.shots.every((s) => s.masks.includes('css input[name="sudo_password"]'))).toBe(true);
    expect(JSON.stringify([rt.automation.state("team-token"), await getTeamTokenInfo(rt, human), rt.automation.info()])).not.toContain(site.sudoPassword);
    expect(d.calls.join("\n")).not.toContain(site.sudoPassword);
  });

  it("Confirm access that fails every time ends the run with a clear message", async () => {
    const { rt } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => {
        const a = rt.automation.state("team-token").ask as { stage?: string; attempt?: number } | null;
        return a?.stage === "choose" && a.attempt === attempt;
      });
      submitTeamTokenAccess(rt, human, { method: "password", password: "wrong-one" });
    }
    await until(() => finished(rt));
    const run = rt.automation.state("team-token");
    expect(run.status).toBe("failed");
    expect(run.failure?.code).toBe("step");
    expect(run.failure?.messageEn).toContain("did not accept");
  });

  it("cancelling while a question is open ends the run", async () => {
    const { rt } = await setup({ confirmed: false });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    cancelTeamToken(rt, human);
    await until(() => finished(rt));
    expect(rt.automation.state("team-token").status).toBe("cancelled");
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

  it("a second token deletes the first one at GitHub with the recipe and shows the extra step", async () => {
    const { rt, site } = await setup({ teamSync: TEAM_SYNC });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const first = (await readTeamTokenRecord(rt)).active!.tokenName;
    site.existing.push(first);
    // Later the person wants push as well: a new token for the same repository.
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => rt.automation.state("team-token").status === "done" && !rt.automation.isBusy());
    const run = rt.automation.state("team-token");
    expect(run.timeline?.map((x) => x.phase)).toEqual(["opening", "creating", "testing", "revoking", "ready"]);
    expect(run.result).toMatchObject({ revoked: true });
    expect(site.deleted).toEqual([first]);
    const info = await getTeamTokenInfo(rt, human);
    expect(info.active).toMatchObject({ mode: "pull-push", valid: true });
    expect(info.pendingRevocation).toBeNull();
  });

  it("the delete run asks to confirm access in the portal, inside the revoking step", async () => {
    const { rt, site } = await setup({ teamSync: TEAM_SYNC });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    site.existing.push((await readTeamTokenRecord(rt)).active!.tokenName);
    site.deleteSudo = true;
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => rt.automation.state("team-token").ask?.type === "access");
    expect(rt.automation.state("team-token").phase).toBe("revoking");
    submitTeamTokenAccess(rt, human, { method: "mobile" });
    await until(() => (rt.automation.state("team-token").ask as { stage?: string } | null)?.stage === "mobile");
    // The person taps the number: the page leaves "Confirm access" and shows the confirmation of the delete.
    const page = site.drivers.at(-1)!;
    page.pageText.delete("Confirm access");
    for (const v of SUDO_VISIBLE) page.visible.delete(v);
    page.visible.add('button "I understand, delete this token"');
    await until(() => finished(rt));
    expect(rt.automation.state("team-token").status).toBe("done");
    expect(rt.automation.state("team-token").result).toMatchObject({ revoked: true });
  });

  it("a failed delete run keeps the new token and lists the old one for deletion by hand, with the reason", async () => {
    const { rt, site } = await setup({ teamSync: TEAM_SYNC });
    startTeamToken(rt, human, { repo: REPO, mode: "pull", branch: "main" });
    await until(() => finished(rt));
    const first = (await readTeamTokenRecord(rt)).active!.tokenName;
    site.existing.push(first);
    site.deleteBroken = true;
    startTeamToken(rt, human, { repo: REPO, mode: "pull-push", branch: "main" });
    await until(() => rt.automation.state("team-token").status === "done" && !rt.automation.isBusy());
    expect(rt.automation.state("team-token").result).toMatchObject({ revoked: false });
    const info = await getTeamTokenInfo(rt, human);
    expect(info.active).toMatchObject({ mode: "pull-push", valid: true });
    expect(info.pendingRevocation).toMatchObject({ tokenName: first, repo: REPO, url: "https://github.com/settings/personal-access-tokens" });
    expect(info.pendingRevocation?.reason).toMatch(/Schritt \d+/);
    expect(JSON.stringify(info.pendingRevocation)).not.toMatch(/revoked/i);
    const after = await dismissTeamTokenRevocation(rt, human);
    expect(after.pendingRevocation).toBeNull();
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
