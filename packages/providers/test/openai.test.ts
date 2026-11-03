import { describe, expect, it } from "vitest";
import { NotConnectedError } from "@secret-desk/core";
import { createDefaultRegistry, openaiProvider as p, OPENAI_DEFAULT_ROTATION_DAYS } from "../src/index.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, byId, connections, expectNoLeak, issueCtx, mockFetch, revokeCtx, routeFetch, verifyCtx } from "./helpers.js";

const PROJECT = "proj_abc123";
const created = { object: "organization.project.service_account", id: "svc_acct_1", name: "n", api_key: { object: "organization.project.service_account.api_key", value: ISSUED, id: "key_1" } };

describe("openai provider", () => {
  it("is registered as an automatic provider on the openai connection", () => {
    const reg = createDefaultRegistry().get("openai")!;
    expect(reg).toBe(p);
    expect(p.kind).toBe("automatic");
    expect(p.connection).toBe("openai");
    expect(p.guide).toBeUndefined();
  });

  it("issues a service account key with the label as name, stores id and a filled expiry", async () => {
    const m = mockFetch({ body: created });
    const r = await p.issue!(issueCtx(m.fetch, { projectId: PROJECT }, { conns: ["openai"] }));
    expect(m.calls[0]).toMatchObject({ url: `https://api.openai.com/v1/organization/projects/${PROJECT}/service_accounts`, method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ name: "test-secret-2026-11-01" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("svc_acct_1");
    expect(r.expiresAt).toBe("2027-01-30T10:00:00Z");
    expect(OPENAI_DEFAULT_ROTATION_DAYS).toBe(90);
  });

  it("uses the entry's ttlDays when set", async () => {
    const m = mockFetch({ body: created });
    const r = await p.issue!(issueCtx(m.fetch, { projectId: PROJECT }, { conns: ["openai"], ttlDays: 30 }));
    expect(r.expiresAt).toBe("2026-12-01T10:00:00Z");
  });

  it("fails without the openai connection, without calling OpenAI", async () => {
    const m = mockFetch({ body: created });
    await expect(p.issue!(issueCtx(m.fetch, { projectId: PROJECT }))).rejects.toBeInstanceOf(NotConnectedError);
    expect(m.calls).toHaveLength(0);
  });

  it("rejects a missing or malformed project id before any call", async () => {
    const m = mockFetch({ body: created });
    await expect(p.issue!(issueCtx(m.fetch, {}, { conns: ["openai"] }))).rejects.toBeInstanceOf(ProviderError);
    await expect(p.issue!(issueCtx(m.fetch, { projectId: "../x" }, { conns: ["openai"] }))).rejects.toBeInstanceOf(ProviderError);
    expect(m.calls).toHaveLength(0);
  });

  it("maps 401 and 404 to provider errors without leaking values", async () => {
    for (const status of [401, 404]) {
      const m = mockFetch({ status, body: LEAK });
      const err = (await p.issue!(issueCtx(m.fetch, { projectId: PROJECT }, { conns: ["openai"] })).catch((e: unknown) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(status);
      expect(err.message).not.toContain(CONN_TOKEN);
      expect(err.message).not.toContain(ISSUED);
    }
  });

  it("rejects an answer without key value", async () => {
    const m = mockFetch({ body: { id: "svc_acct_1" } });
    await expect(p.issue!(issueCtx(m.fetch, { projectId: PROJECT }, { conns: ["openai"] }))).rejects.toThrow(/Unerwartete Antwort/);
  });

  it("revokes the service account and treats 404 as already gone", async () => {
    const m = mockFetch({ status: 200, body: {} });
    await p.revoke!(revokeCtx(m.fetch, { projectId: PROJECT }, "svc_acct_1", ["openai"]));
    expect(m.calls[0]).toMatchObject({ url: `https://api.openai.com/v1/organization/projects/${PROJECT}/service_accounts/svc_acct_1`, method: "DELETE" });
    const gone = mockFetch({ status: 404, body: {} });
    await expect(p.revoke!(revokeCtx(gone.fetch, { projectId: PROJECT }, "svc_acct_1", ["openai"]))).resolves.toBeUndefined();
    const denied = mockFetch({ status: 403, body: LEAK });
    await expect(p.revoke!(revokeCtx(denied.fetch, { projectId: PROJECT }, "svc_acct_1", ["openai"]))).rejects.toBeInstanceOf(ProviderError);
  });

  it("verify: 200 pass, 401 fail, 500 warn, with the issued key", async () => {
    const m = mockFetch({ body: { data: [] } });
    const run = (f: typeof fetch) => p.verify!(verifyCtx(f, { projectId: PROJECT }));
    expect(byId(await run(m.fetch))["works"]).toBe("pass");
    expect(m.calls[0]!.url).toBe("https://api.openai.com/v1/models?limit=1");
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${ISSUED}` });
    const f = await run(mockFetch({ status: 401, body: LEAK }).fetch);
    expect(byId(f)["works"]).toBe("fail");
    expectNoLeak(f);
    expect(byId(await run(mockFetch({ status: 500 }).fetch))["works"]).toBe("warn");
  });

  it("declares the project parameter as required, patterned and discoverable", () => {
    const spec = p.params!.find((s) => s.key === "projectId")!;
    expect(spec).toMatchObject({ required: true, discover: "openai.project" });
    expect(new RegExp(spec.pattern!).test(PROJECT)).toBe(true);
    expect(new RegExp(spec.pattern!).test("abc")).toBe(false);
  });
});

describe("openai discovery", () => {
  const dctx = (f: typeof fetch) => ({ connections: connections("openai"), fetch: f, params: {}, hint: { repos: [] as string[] } });
  it("lists projects with pagination and leaves out archived ones", async () => {
    const { fetch, calls } = routeFetch(
      { url: "after=proj_2", reply: { body: { data: [{ id: "proj_3", name: "Three", status: "archived" }], has_more: false } } },
      { url: "/v1/organization/projects?limit=100", reply: { body: { data: [{ id: "proj_1", name: "One", status: "active" }, { id: "proj_2", name: "Two" }], has_more: true } } },
    );
    const o = await p.discover!("openai.project", dctx(fetch));
    expect(o).toEqual([{ value: "proj_1", label: "One", detail: "proj_1" }, { value: "proj_2", label: "Two", detail: "proj_2" }]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
  });
  it("rejects an unknown kind", async () => {
    await expect(p.discover!("openai.other", dctx(mockFetch().fetch))).rejects.toThrow();
  });
});
