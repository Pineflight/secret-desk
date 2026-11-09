import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitHubError, TeamSyncError } from "@secret-desk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route } from "../src/server/router.js";
import { BASE, HOST, routerFixture, uiRequest } from "./helpers/router-fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Json = Record<string, unknown>;
const call = async (deps: Parameters<typeof route>[1], method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await route(uiRequest(deps, method, path, body, extra), deps);
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Json & Json[] };
};

describe("list filters", () => {
  it("narrows secrets by every filter", async () => {
    const { deps } = await routerFixture();
    const ids = async (q: string) => (await call(deps, "GET", `secrets?${q}`)).json.map((s: Json) => s["id"]);
    expect(await ids("stage=dev")).toEqual(["manual-one"]);
    expect(await ids("stage=production")).toEqual([]);
    expect(await ids("repo=acme-docs")).toEqual(["manual-one"]);
    expect(await ids("repo=other")).toEqual([]);
    expect(await ids("provider=manual")).toEqual(["manual-one"]);
    expect(await ids("q=manual")).toEqual(["manual-one"]);
    expect(await ids("q=zzzz")).toEqual([]);
    expect(await ids("tag=core")).toEqual(["manual-one"]);
    expect(await ids("tag=other")).toEqual([]);
    expect(await ids("product=nothing")).toEqual([]);
    expect(await ids("status=expired")).toEqual([]);
  });
  it("narrows variables by every filter", async () => {
    const { deps } = await routerFixture();
    const ids = async (q: string) => (await call(deps, "GET", `variables?${q}`)).json.map((s: Json) => s["id"]);
    expect(await ids("stage=dev")).toEqual(["proj-id"]);
    expect(await ids("repo=acme-app")).toEqual(["proj-id"]);
    expect(await ids("repo=other")).toEqual([]);
    expect(await ids("q=acme")).toEqual(["proj-id"]);
    expect(await ids("tag=none")).toEqual([]);
    expect(await ids("product=none")).toEqual([]);
  });
  it("limits the comparison kinds to secrets and variables, singular or plural", async () => {
    const { deps } = await routerFixture();
    for (const kinds of ["secrets", "variables", "secret,variable", "other"]) {
      expect((await call(deps, "GET", `compare?kinds=${kinds}`)).status, kinds).toBe(200);
    }
  });
  it("plans the GitHub sync for one repository", async () => {
    const { deps } = await routerFixture();
    const plan = await call(deps, "POST", "compare/sync-plan", { repo: "acme-app" });
    expect(plan.status).toBe(200);
    expect(plan.json["lines"]).toHaveLength(1);
  });
});

describe("development templates", () => {
  it("describes each entry source with its own fields", async () => {
    const { deps } = await routerFixture();
    const { json } = await call(deps, "GET", "dev-templates");
    const entries = new Map((json[0]!["entries"] as Json[]).map((e) => [e["key"], e]));
    expect(entries.get("A_VAR")).toMatchObject({ source: "variable", variable: "proj-id", description: null });
    expect(entries.get("B_ISSUE")).toMatchObject({ source: "issue", secret: "manual-one", description: "from a secret" });
    expect(entries.get("C_DEFAULT")).toMatchObject({ source: "default", value: "x" });
    expect(entries.get("D_PROMPT")).toMatchObject({ source: "prompt", optional: true });
    expect(entries.get("E_REF")).toMatchObject({ source: "ref", refTemplate: "acme-other", refKey: "C_DEFAULT" });
    expect(entries.get("F_CMD")).toMatchObject({ source: "command", command: "supabase-status", commandKey: "API_URL", optional: true });
    expect(entries.get("G_GEN")).toMatchObject({ source: "generate" });
    expect(entries.get("G_GEN")).not.toHaveProperty("value");
  });
  it("creates providers, templates and entries or explains what is missing", async () => {
    const { deps } = await routerFixture();
    for (const path of ["providers", "env-templates", "env-templates/acme-dev/entries"]) {
      const r = await call(deps, "POST", path, {});
      expect(r.status, path).toBe(400);
      expect(r.json["error"]).toMatch(/expected/);
    }
    const added = await call(deps, "POST", "env-templates/acme-dev/entries", { key: "H_NEW", from: { type: "default", value: "1" } });
    expect(added.status).toBe(200);
    const provider = await call(deps, "POST", "providers", { id: "my-tool", label: "My tool", url: "https://example.org", steps: ["open", "copy"] });
    expect(provider.status).toBe(200);
    const template = await call(deps, "POST", "env-templates", { id: "third", repo: "acme-app", entries: [{ key: "ONE", from: { type: "default", value: "1" } }] });
    expect(template.status).toBe(200);
  });
});

describe("reading single records", () => {
  it("answers unknown reviews, reports and approvals with a clear refusal", async () => {
    const { deps } = await routerFixture();
    expect((await call(deps, "GET", "reviews/nope")).json["error"]).toMatch(/nicht gefunden/);
    expect((await call(deps, "GET", "evidence/a/b")).json["error"]).toMatch(/nicht gefunden/);
    expect((await call(deps, "GET", "approvals/nope")).json["error"]).toMatch(/nicht gefunden/);
  });
  it("shows the live status of a variable without a network answer", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "GET", "variables/proj-id/status");
    expect(r.status).toBe(200);
    expect(r.json["variable"]).toMatchObject({ id: "proj-id", value: "proj-1" });
  });
  it("plans a renewal with a reason as a dry run", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "renewal-requests", { secretId: "manual-one", reason: "rotation", dryRun: true });
    expect(r.json).toMatchObject({ status: "dry-run", plan: { secretId: "manual-one" } });
  });
});

describe("environment export", () => {
  it("asks for a path when the repository has no linked folder", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "env-export", { repo: "acme-app", template: "acme-other" });
    expect(r).toMatchObject({ status: 400 });
    expect(r.json["error"]).toMatch(/Kein Pfad/);
  });
  it("writes the file of a template, taking prompts from the request", async () => {
    const { deps, dir } = await routerFixture();
    const path = join(dir, ".env.test-export");
    const r = await call(deps, "POST", "env-export", { repo: "acme-app", template: "acme-other", stage: "dev", path, overwrite: true, prompts: {} });
    expect(r.status, r.text).toBe(200);
    expect(await readFile(path, "utf8")).toContain("C_DEFAULT=y");
    const again = await call(deps, "POST", "env-export", { repo: "acme-app", template: "acme-other", path, overwrite: true });
    expect(again.status, again.text).toBe(200);
    const oddPrompts = await call(deps, "POST", "env-export", { repo: "acme-app", template: "acme-other", path, overwrite: true, prompts: "not an object" });
    expect(oddPrompts.status, oddPrompts.text).toBe(200);
  });
});

describe("team sync routes", () => {
  it("refuses an unknown resolution", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "team-sync/apply", { expectSha: "x", resolution: "nope" });
    expect(r).toMatchObject({ status: 400 });
    expect(r.json["error"]).toMatch(/resolution/);
  });
  it("passes the push strategy to the access check", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "GET", "team-sync/discovery/access?repo=acme/config&branch=main&path=t.yaml&mode=pull-push&strategy=direct");
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(500);
  });
  it("answers each team token step without a running sign-in", async () => {
    const { deps } = await routerFixture();
    for (const step of ["credentials", "code", "confirm", "access", "cancel"]) {
      const r = await call(deps, "POST", `team-sync/token/${step}`, {});
      expect(r.status, step).toBe(409);
    }
    expect((await call(deps, "POST", "team-sync/token/check", {})).status).toBe(400);
  });
  it("needs a configured team sync to plan and a confirmation to push", async () => {
    const { deps } = await routerFixture();
    const plan = await call(deps, "POST", "team-sync/push-plan", {});
    expect(plan).toMatchObject({ status: 400 });
    expect(plan.json["code"]).toBe("not-configured");
    const push = await call(deps, "POST", "team-sync/push", { expectLocalHash: "h", expectRemoteSha: "s" }, { "x-secret-desk-lang": "en" });
    expect(push.status).toBe(400);
    expect(push.json["error"]).toMatch(/confirm: true/);
    const noSha = await call(deps, "POST", "team-sync/push", { expectLocalHash: "h" });
    expect(noSha.status).toBe(400);
  });
  it("dismisses the setup hint and reports the status", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "team-sync/dismiss-setup", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ configured: false });
  });
});

describe("facade and recipe routes", () => {
  it("answers steps without a running sign-in", async () => {
    const { deps } = await routerFixture();
    for (const step of ["access", "confirm"]) expect((await call(deps, "POST", `facades/stripe/${step}`, {})).status, step).toBe(409);
    for (const [path, body] of [["facades/stripe/connect", {}], ["facades/stripe/check", { host: "h.example" }], ["facades/stripe/check", {}]] as const) {
      expect((await call(deps, "POST", path, body)).status, path).toBe(400);
    }
    expect((await call(deps, "POST", "recipes/nope/sign-in/confirm", {})).json["error"]).toMatch(/Unknown recipe/);
    expect((await call(deps, "POST", "recipes/nope/check", { host: "h" })).status).toBe(400);
  });
  it("answers an unknown review confirmation with a refusal", async () => {
    const { deps } = await routerFixture();
    expect((await call(deps, "POST", "reviews/x/confirm", { ticks: ["a"], note: "n", force: true })).status).toBe(403);
    expect((await call(deps, "POST", "reviews/x/confirm", {})).status).toBe(403);
  });
});

describe("GitHub sync run", () => {
  it("refuses lines that are not in the current plan, ignoring non-string keys", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "compare/sync", { keys: ["x", 1], repo: "acme-app" });
    expect(r).toMatchObject({ status: 400 });
    expect(r.json["code"]).toBe("unknown-line");
    const empty = await call(deps, "POST", "compare/sync", {});
    expect(empty.status).toBe(400);
  });
});

describe("connection tokens", () => {
  it("rejects an impossible expiry date", async () => {
    const { deps } = await routerFixture();
    const r = await call(deps, "POST", "connections/github/token", { token: "value-for-tests", expires: "2026-13-45" });
    expect(r).toMatchObject({ status: 400 });
    expect(r.json["error"]).toMatch(/ungueltig/);
  });
  it("keeps a remembered token in the vault and forgets the session copy", async () => {
    const { deps, rt } = await routerFixture({ withVault: true });
    rt.connections.session.set("github", "old-for-tests", null);
    const r = await call(deps, "POST", "connections/github/token", { token: "value-for-tests", neverExpires: true, remember: true });
    expect(r.json).toMatchObject({ id: "github", connected: true, source: "vault" });
    expect((await rt.connections.vault!.get("github"))?.reveal()).toBe("value-for-tests");
    expect(rt.connections.session.get("github")).toBeUndefined();
  });
  it("retires the team token when the team sync token is replaced or deleted", async () => {
    const { deps } = await routerFixture();
    const set = await call(deps, "POST", "connections/team-sync/token", { token: "value-for-tests", neverExpires: true });
    expect(set.json).toMatchObject({ id: "team-sync", connected: true, source: "session" });
    const del = await call(deps, "DELETE", "connections/team-sync/token");
    expect(del.json).toMatchObject({ id: "team-sync", connected: false });
  });
});

describe("inventory version problem", () => {
  it("reports a file that stays unreadable only after the grace period", async () => {
    const { deps, dir } = await routerFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await call(deps, "GET", "inventory/version")).json["problem"]).toBeNull();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "inventory.yaml"), "not: [valid");
    expect((await call(deps, "GET", "inventory/version")).json["problem"]).toBeNull();
    vi.setSystemTime(Date.now() + 5000);
    const later = await call(deps, "GET", "inventory/version");
    expect(later.json["problem"]).toMatchObject({ persistent: true });
  });
});

describe("evidence attachments with a note", () => {
  it("stores the note of an upload", async () => {
    const { deps } = await routerFixture();
    const view = await call(deps, "POST", "secrets/manual-one/manual-value", { value: "hand-value-for-tests-123" });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" }), "bild.png");
    form.set("note", "screenshot of the dashboard");
    const res = await route(new Request(`${BASE}/api/ui/evidence/manual-one/${view.json["id"]}/attachments`, { method: "POST", headers: { host: HOST, origin: BASE, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf }, body: form }), deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ note: "screenshot of the dashboard" });
  });
});

describe("routing and error mapping", () => {
  it("answers an address outside /api/agent and /api/ui with 404", async () => {
    const { deps } = await routerFixture();
    const res = await route(new Request(`${BASE}/somewhere/else`, { headers: { host: HOST, origin: BASE } }), deps);
    expect(res.status).toBe(404);
  });
  const failWith = async (error: unknown) => {
    const { rt, deps } = await routerFixture();
    rt.connections.statuses = async () => {
      throw error;
    };
    return call(deps, "GET", "connections");
  };
  it("maps team sync errors to their status", async () => {
    for (const [code, status] of [["conflict", 409], ["changed", 409], ["too-soon", 409], ["denied", 502], ["not-found", 502], ["network", 502], ["other", 400]] as const) {
      const r = await failWith(new TeamSyncError("x", code as never));
      expect(r.status, code).toBe(status);
      expect(r.json["code"]).toBe(code);
    }
  });
  it("maps GitHub rejections that are neither a rate limit nor a refusal to 502 and a provider error without status to 502", async () => {
    expect((await failWith(new GitHubError(500, "kaputt"))).status).toBe(502);
    const provider = Object.assign(new Error("no status"), { name: "ProviderError" });
    const r = await failWith(provider);
    expect(r.status).toBe(502);
    expect(r.json["code"]).toBe("provider-error");
  });
  it("logs a thrown value that is not an Error and hides it from the client", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await failWith("plain text");
    expect(r.status).toBe(500);
    expect(spy).toHaveBeenCalledWith("[secret-desk] unerwarteter Fehler:", "plain text");
  });
  it("logs an Error without a stack by name and message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("no stack here");
    delete error.stack;
    const r = await failWith(error);
    expect(r.status).toBe(500);
    expect(spy).toHaveBeenCalledWith("[secret-desk] unerwarteter Fehler:", "Error: no stack here");
  });
});
