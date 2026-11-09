import { describe, expect, it } from "vitest";
import { NotConnectedError } from "@secret-desk/core";
import { supabaseProviders } from "../src/supabase.js";
import { connections, issueCtx, mockFetch, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const apiKey = supabaseProviders.find((p) => p.id === "supabase-api-key")!;
const serviceRole = supabaseProviders.find((p) => p.id === "supabase-service-role")!;
const dbPassword = supabaseProviders.find((p) => p.id === "supabase-db-password")!;

const projects = (list: unknown[]): Route => ({ url: "/v1/projects", reply: { body: list } });
const dctx = (f: typeof fetch) => ({ connections: connections("supabase"), fetch: f, params: {}, hint: { repos: [] as string[] } });
const pctx = (f: typeof fetch, params: Record<string, unknown>, stageKind: "live" | "test" | "dev", conns = connections("supabase")) => ({
  params,
  stage: "dev" as const,
  stageKind,
  connections: conns,
  fetch: f,
  secret: secretEntry(),
  now: new Date("2026-11-01T10:00:00Z"),
});
const jwt = (payload: unknown) => ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

describe("supabase discovery", () => {
  it("lists projects by ref or id, with name, region and status, skipping entries without either", async () => {
    const m = routeFetch(projects([{ ref: "r1", name: "One", region: "eu", status: "ACTIVE_HEALTHY" }, { id: "i2" }, { name: "none" }]));
    for (const p of [apiKey, serviceRole, dbPassword]) {
      expect(await p.discover!("supabase.project", dctx(m.fetch))).toEqual([
        { value: "r1", label: "One", detail: "r1, eu, ACTIVE_HEALTHY" },
        { value: "i2", label: "i2", detail: "i2" },
      ]);
    }
    await expect(apiKey.discover!("supabase.other", dctx(m.fetch))).rejects.toThrow();
  });
});

describe("supabase preflight", () => {
  const list = [
    { id: "paused", name: "app-staging", status: "PAUSED" },
    { id: "sick", name: "app-prod", status: "UNHEALTHY" },
    { id: "fine", name: "app-dev", status: "ACTIVE_HEALTHY" },
    { id: "nostatus", name: "plain" },
  ];
  const run = (p: typeof apiKey, params: Record<string, unknown>, kind: "live" | "test" | "dev" = "dev") => p.preflight!(pctx(routeFetch(projects(list)).fetch, params, kind));
  const finding = (r: { findings: { id: string; level: string; label: string }[] }, id: string) => r.findings.find((f) => f.id === id);

  it("password provider: a paused project fails, an unhealthy one warns, healthy and unknown status add nothing", async () => {
    expect(finding(await run(dbPassword, { projectRef: "paused" }), "health")).toMatchObject({ level: "fail" });
    expect(finding(await run(dbPassword, { projectRef: "sick" }), "health")).toMatchObject({ level: "warn" });
    expect(finding(await run(dbPassword, { projectRef: "fine" }), "health")).toBeUndefined();
    expect(finding(await run(dbPassword, { projectRef: "nostatus" }), "health")).toBeUndefined();
  });
  it("other providers do not look at the health", async () => {
    expect(finding(await run(serviceRole, { projectRef: "paused" }), "health")).toBeUndefined();
    expect(finding(await run(apiKey, { projectRef: "paused" }), "health")).toBeUndefined();
  });
  it("warns when the project name points at the other stage kind", async () => {
    expect(finding(await run(apiKey, { projectRef: "paused" }, "live"), "stage")!.label).toContain("deutet auf Staging");
    expect(finding(await run(apiKey, { projectRef: "sick" }, "test"), "stage")!.label).toContain("deutet auf Produktion");
    expect(finding(await run(apiKey, { projectRef: "sick" }, "live"), "stage")).toBeUndefined();
    expect(finding(await run(apiKey, { projectRef: "paused" }, "test"), "stage")).toBeUndefined();
  });
  it("warns when the connection lists no projects and reports an unreadable list", async () => {
    const none = await apiKey.preflight!(pctx(routeFetch(projects([])).fetch, { projectRef: "x" }, "dev"));
    expect(finding(none, "project")!.level).toBe("warn");
    const bad = await apiKey.preflight!(pctx(routeFetch({ url: "/v1/projects", reply: { status: 500, body: "x" } }).fetch, { projectRef: "x" }, "dev"));
    expect(finding(bad, "read")!.label).toBe("Projekte nicht lesbar");
    await expect(apiKey.preflight!(pctx(routeFetch().fetch, { projectRef: "x" }, "dev", connections()))).rejects.toThrow(NotConnectedError);
  });
});

describe("supabase key shape", () => {
  const check = async (p: typeof apiKey, value: string, params: Record<string, unknown> = {}) => (await p.verify!(verifyCtx(mockFetch().fetch, params, { value })))[0]!;
  it("service_role accepts a JWT or a secret key and rejects a publishable one", async () => {
    expect((await check(serviceRole, jwt({ role: "service_role" }))).status).toBe("info");
    expect((await check(serviceRole, ["sb", "secret", "abcdef"].join("_") + "_x")).status).toBe("info");
    expect((await check(serviceRole, ["sb", "publishable", "abcdef"].join("_") + "_x")).status).toBe("fail");
  });
  it("warns about an unknown format", async () => {
    expect((await check(apiKey, "something-else")).status).toBe("warn");
  });
  it("a legacy JWT must carry the matching role", async () => {
    const wrongRole = await check(apiKey, jwt({ role: "anon" }), { type: "secret" });
    expect(wrongRole).toMatchObject({ status: "fail", expected: "JWT mit Rolle service_role oder passender Praefix" });
    expect(wrongRole.actual).toContain("Rolle anon");
    const noRole = await check(apiKey, jwt({ role: 5 }), { type: "secret" });
    expect(noRole.actual).toContain("Rolle unbekannt");
    const brokenPayload = await check(apiKey, jwt("not json"), { type: "secret" });
    expect(brokenPayload.actual).toContain("Rolle unbekannt");
    expect((await check(apiKey, jwt({ role: "service_role" }), { type: "secret" })).status).toBe("info");
    expect((await check(apiKey, jwt({ role: "anon" }), { type: "publishable" })).status).toBe("info");
  });
  it("a prefixed key of the wrong kind fails, the right kind is only informational", async () => {
    const publishable = ["sb", "publishable", "abcdef"].join("_") + "_x";
    expect(await check(apiKey, publishable, { type: "secret" })).toMatchObject({ status: "fail", expected: "Praefix sb_secret_" });
    expect(await check(apiKey, ["sb", "secret", "abcdef"].join("_") + "_x", { type: "publishable" })).toMatchObject({ status: "fail", expected: "Praefix sb_publishable_" });
    expect((await check(apiKey, publishable, { type: "publishable" })).status).toBe("info");
  });
  it("warns about a project url that cannot be parsed and does not probe it", async () => {
    const m = mockFetch();
    const checks = await apiKey.verify!(verifyCtx(m.fetch, { url: "not a url" }, { value: ["sb", "secret", "abcdef"].join("_") + "_x" }));
    expect(checks.find((c) => c.id === "rest")).toMatchObject({ status: "warn", detail: "Parameter url ist keine gueltige URL" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("supabase issue edge cases", () => {
  it("api key: rejects an answer without key or id", async () => {
    const m = routeFetch({ method: "POST", url: "/api-keys", reply: { body: { id: "k1" } } });
    await expect(apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow("Unerwartete Antwort");
    const empty = routeFetch({ method: "POST", url: "/api-keys", reply: { status: 204 } });
    await expect(apiKey.issue!(issueCtx(empty.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow("Unerwartete Antwort");
  });
  it("service role: rejects an answer that is not a list, and a key entry without a value", async () => {
    const notList = routeFetch({ url: "/api-keys", reply: { body: { a: 1 } } });
    await expect(serviceRole.issue!(issueCtx(notList.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow("Unerwartete Antwort");
    const noValue = routeFetch({ url: "/api-keys", reply: { body: [{ name: "service_role" }] } });
    await expect(serviceRole.issue!(issueCtx(noValue.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow('Kein Schluessel "service_role"');
  });
  it("db password: a missing connection and a network error pass through unchanged", async () => {
    const params = { projectRef: "abc" };
    await expect(dbPassword.issue!(issueCtx(mockFetch().fetch, params, { conns: [] }))).rejects.toThrow(NotConnectedError);
    const down = (async () => { throw new Error("socket closed"); }) as unknown as typeof fetch;
    const err = await dbPassword.issue!(issueCtx(down, params, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err.message).toContain("Anfrage fehlgeschlagen: socket closed");
  });
  it("db password: server errors and rate limits get their own hint", async () => {
    const params = { projectRef: "abc" };
    const err500 = await dbPassword.issue!(issueCtx(mockFetch({ status: 500, body: "boom" }).fetch, params, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err500.message).toContain("das Projekt muss gesund sein");
    const err429 = await dbPassword.issue!(issueCtx(mockFetch({ status: 429, body: "slow down" }).fetch, params, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err429.message).toContain("Rate-Limit erreicht");
  });
  it("checklist: stage kinds and the db url target", () => {
    expect(apiKey.reviewChecklist!(secretEntry(), { stageKind: "test" })).toContain("Es ist das Staging-Projekt, nicht das Produktionsprojekt");
    expect(apiKey.reviewChecklist!(secretEntry(), { stageKind: "live" })).toContain("Es ist das Produktionsprojekt");
    expect(apiKey.reviewChecklist!(secretEntry(), { stageKind: "shared" })).toContain("Das Projekt passt zur Stage");
    expect(dbPassword.reviewChecklist!(secretEntry({ params: { dbUrlTarget: "db-url" } }))).toContain("Die Verbindungs-URL mit dem neuen Passwort geht an den Eintrag db-url und an keinen anderen");
  });
});
