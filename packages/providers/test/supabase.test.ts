import { describe, expect, it } from "vitest";
import { DB_URL_TEMPLATE_DEFAULT, buildDbUrl, supabaseKeyName, supabaseProviders } from "../src/supabase.js";
import { ProviderError } from "../src/http.js";
import { CONN_TOKEN, ISSUED, LEAK, byId, connections, expectNoLeak, issueCtx, mockFetch, revokeCtx, routeFetch, secretEntry, verifyCtx } from "./helpers.js";

const apiKey = supabaseProviders.find((p) => p.id === "supabase-api-key")!;
const serviceRole = supabaseProviders.find((p) => p.id === "supabase-service-role")!;

describe("supabase-api-key", () => {
  it("creates a key (default secret)", async () => {
    const m = mockFetch({ body: { id: "k1", api_key: ISSUED } });
    const r = await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys?reveal=true", method: "POST" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ type: "secret", name: "test_secret_2026_11_01" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(r.externalId).toBe("k1");
    expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });
  it("publishable and invalid type", async () => {
    const m = mockFetch({ body: { id: "k1", api_key: ISSUED } });
    await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc", type: "publishable" }, { conns: ["supabase"] }));
    expect(JSON.parse(m.calls[0]!.body!).type).toBe("publishable");
    await expect(apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc", type: "x" }, { conns: ["supabase"] }))).rejects.toThrow(ProviderError);
  });
  it("revokes via DELETE", async () => {
    const m = mockFetch({ status: 204 });
    await apiKey.revoke!(revokeCtx(m.fetch, { projectRef: "abc" }, "k1", ["supabase"]));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys/k1", method: "DELETE" });
  });
  it("error 403 without values", async () => {
    const m = mockFetch({ status: 403, body: LEAK });
    const err = await apiKey.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
    expect(err.message).not.toContain(ISSUED);
  });
  it("label marks the provider as experimental", () => {
    expect(apiKey.label).toContain("experimentell");
  });
});

describe("supabase-service-role", () => {
  it("reads the service_role key", async () => {
    const m = mockFetch({ body: [{ name: "anon", api_key: "anon-key-xxxx" }, { name: "service_role", api_key: ISSUED }] });
    const r = await serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }));
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/api-keys?reveal=true", method: "GET" });
    expect(r.value.reveal()).toBe(ISSUED);
    expect(serviceRole.revoke).toBeUndefined();
  });
  it("error when the key is missing", async () => {
    const m = mockFetch({ body: [{ name: "anon", api_key: "anon-key-xxxx" }] });
    await expect(serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }))).rejects.toThrow(/service_role/);
  });
  it("error 403 without token", async () => {
    const m = mockFetch({ status: 403, body: CONN_TOKEN });
    const err = await serviceRole.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
});

describe("supabase-db-password", () => {
  const p = supabaseProviders.find((x) => x.id === "supabase-db-password")!;
  const run = (m: ReturnType<typeof mockFetch>, params: Record<string, unknown> = { projectRef: "abc" }) => p.issue!(issueCtx(m.fetch, params, { conns: ["supabase"] }));
  it("is automatic, uses the supabase connection and has no revoke", () => {
    expect(p).toMatchObject({ kind: "automatic", connection: "supabase" });
    expect(p.revoke).toBeUndefined();
    expect(p.params!.find((s) => s.key === "length")).toMatchObject({ type: "integer", min: 24, max: 64, defaultValue: "40" });
    expect(p.params!.find((s) => s.key === "projectRef")).toMatchObject({ required: true, discover: "supabase.project" });
  });
  it("patches the generated password and returns it", async () => {
    const m = mockFetch({ body: { message: "ok" } });
    const r = await run(m);
    expect(m.calls[0]).toMatchObject({ url: "https://api.supabase.com/v1/projects/abc/database/password", method: "PATCH" });
    expect(m.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${CONN_TOKEN}` });
    const sent = JSON.parse(m.calls[0]!.body!) as { password: string };
    expect(sent.password).toBe(r.value.reveal());
    expect(r.externalId).toBe("abc");
  });
  it("password has the requested length and only letters and digits", async () => {
    const lens: number[] = [];
    for (const length of [undefined, 24, 64]) {
      const r = await run(mockFetch({ body: {} }), length ? { projectRef: "abc", length } : { projectRef: "abc" });
      const v = r.value.reveal();
      expect(v).toMatch(/^[A-Za-z0-9]+$/);
      lens.push(v.length);
    }
    expect(lens).toEqual([40, 24, 64]);
    const a = (await run(mockFetch({ body: {} }))).value.reveal();
    const b = (await run(mockFetch({ body: {} }))).value.reveal();
    expect(a).not.toBe(b);
  });
  it("rejects a length outside 24..64", async () => {
    for (const length of [23, 65, 30.5, "40"]) await expect(run(mockFetch({ body: {} }), { projectRef: "abc", length })).rejects.toThrow(/length/);
  });
  for (const [status, hint] of [[401, /database_config_write/], [403, /database_config_write/], [422, /gesund/], [500, /gesund/], [429, /Rate-Limit/]] as const) {
    it(`error ${status} carries a hint and no values`, async () => {
      const m = mockFetch({ status, body: JSON.stringify({ message: `denied ${CONN_TOKEN}` }) });
      const err = await run(m).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toMatch(hint);
      expect(err.message).not.toContain(CONN_TOKEN);
      const sent = (JSON.parse(m.calls[0]!.body!) as { password: string }).password;
      expect(err.message).not.toContain(sent);
    });
  }
  it("redacts the new password when the API echoes it", async () => {
    let echoed = "";
    const fetchEcho = (async (_u: unknown, init?: RequestInit) => {
      echoed = (JSON.parse(String(init?.body)) as { password: string }).password;
      return new Response(`bad password ${echoed}`, { status: 422 });
    }) as unknown as typeof fetch;
    const err = await p.issue!(issueCtx(fetchEcho, { projectRef: "abc" }, { conns: ["supabase"] })).catch((e: unknown) => e as Error);
    expect(echoed.length).toBe(40);
    expect(err.message).not.toContain(echoed);
  });
  it("verify checks the shape and says that no login test happens", async () => {
    const ok = await p.verify!(verifyCtx(mockFetch().fetch, { projectRef: "abc" }, { value: "a".repeat(40), externalId: "abc" }));
    expect(byId(ok)).toEqual({ shape: "pass", applied: "pass", login: "info" });
    const pasted = await p.verify!(verifyCtx(mockFetch().fetch, { projectRef: "abc" }, { value: "a".repeat(40) }));
    expect(byId(pasted)["applied"]).toBe("info");
    expect(byId(await p.verify!(verifyCtx(mockFetch().fetch, {}, { value: "short" })))["shape"]).toBe("fail");
    expect(byId(await p.verify!(verifyCtx(mockFetch().fetch, {}, { value: "a/b@".padEnd(40, "x") })))["shape"]).toBe("fail");
    expectNoLeak(ok, ["a".repeat(40)]);
  });
  it("review checklist says the old password dies at once", () => {
    const items = p.reviewChecklist!(secretEntry({ stage: "staging", params: { projectRef: "abc" } }));
    expect(items.join(" ")).toContain("sofort ersetzt");
  });
  it("preflight fails when the project is paused (nothing is changed) and passes when healthy", async () => {
    const f = () => routeFetch({ url: "/v1/projects", reply: { body: [{ id: "abc", name: "demo-staging", status: "ACTIVE_HEALTHY" }, { id: "def", name: "demo-prod", status: "INACTIVE" }] } });
    const pctx = (fetch: typeof fetch, params: Record<string, unknown>) => ({ params, stage: "staging" as const, connections: connections("supabase"), fetch, secret: secretEntry({ stage: "staging" }), now: new Date("2026-11-01T10:00:00Z") });
    const ok = await p.preflight!(pctx(f().fetch, { projectRef: "abc" }));
    expect(ok.findings.every((x) => x.level === "ok")).toBe(true);
    const paused = await p.preflight!(pctx(f().fetch, { projectRef: "def" }));
    expect(paused.findings.find((x) => x.id === "health")).toMatchObject({ level: "fail" });
    expect(paused.findings.find((x) => x.id === "health")!.label).toContain("erst das Projekt starten");
    const missing = await p.preflight!(pctx(f().fetch, { projectRef: "zzz" }));
    expect(missing.findings.find((x) => x.id === "project")).toMatchObject({ level: "fail" });
  });

  describe("connection URL companion", () => {
    const withUrl = { projectRef: "abc", dbUrlTarget: "sb-db-url", region: "eu-central-1" };
    it("names the companion parameter and declares template and region", () => {
      expect(p.companionParams).toEqual(["dbUrlTarget"]);
      expect(p.params!.find((s) => s.key === "urlTemplate")).toMatchObject({ required: false, defaultValue: DB_URL_TEMPLATE_DEFAULT });
      expect(p.params!.find((s) => s.key === "dbUrlTarget")).toMatchObject({ required: false });
    });
    it("returns no companion without dbUrlTarget", async () => {
      expect((await run(mockFetch({ body: {} }))).companions).toBeUndefined();
    });
    it("builds the default pooler URL with the new password as companion", async () => {
      const m = mockFetch({ body: {} });
      const r = await run(m, withUrl);
      const password = r.value.reveal();
      expect(r.companions).toHaveLength(1);
      expect(r.companions![0]).toMatchObject({ entryId: "sb-db-url" });
      expect(r.companions![0]!.kind).toBeUndefined();
      expect(r.companions![0]!.value.reveal()).toBe(`postgresql://postgres.abc:${password}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`);
      expect((JSON.parse(m.calls[0]!.body!) as { password: string }).password).toBe(password);
    });
    it("honours a custom template", async () => {
      const r = await run(mockFetch({ body: {} }), { projectRef: "abc", dbUrlTarget: "u", urlTemplate: "postgres://app:{{password}}@db.example.test:5432/{{ref}}" });
      expect(r.companions![0]!.value.reveal()).toBe(`postgres://app:${r.value.reveal()}@db.example.test:5432/abc`);
    });
    it("percent-encodes the password in the URL", () => {
      const url = buildDbUrl("t", { region: "us-east-1" }, "abc", "p@ss:w/rd#1 %");
      expect(url).toBe("postgresql://postgres.abc:p%40ss%3Aw%2Frd%231%20%25@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
      expect(new URL(url).password).toBe("p%40ss%3Aw%2Frd%231%20%25");
    });
    it("rejects an unusable template or a missing region before any API call", async () => {
      const bad: Record<string, unknown>[] = [
        { ...withUrl, urlTemplate: "https://x/{{password}}" },
        { ...withUrl, urlTemplate: "postgresql://u@h/db" },
        { ...withUrl, urlTemplate: "postgresql://u:{{password}}@h/{{secret}}" },
        { projectRef: "abc", dbUrlTarget: "u" },
        { ...withUrl, region: "EU/../x" },
      ];
      for (const params of bad) {
        const m = mockFetch({ body: {} });
        await expect(run(m, params)).rejects.toThrow(ProviderError);
        expect(m.calls).toHaveLength(0);
      }
    });
    it("a region is not needed when the template does not use it", async () => {
      const r = await run(mockFetch({ body: {} }), { projectRef: "abc", dbUrlTarget: "u", urlTemplate: "postgresql://postgres:{{password}}@h.example.test/postgres" });
      expect(r.companions).toHaveLength(1);
    });
    it("a failed API call returns no companion and no URL in the error", async () => {
      const m = mockFetch({ status: 422, body: "bad" });
      const err = await run(m, withUrl).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(ProviderError);
      const sent = (JSON.parse(m.calls[0]!.body!) as { password: string }).password;
      expect(err.message).not.toContain(sent);
    });
    it("review checklist names the URL entry", () => {
      const items = p.reviewChecklist!(secretEntry({ stage: "staging", params: withUrl })).join(" | ");
      expect(items).toContain("sb-db-url");
      expect(items).toContain("sofort ersetzt");
    });
  });

  describe("paused project", () => {
    for (const [status, body] of [[400, "Project is paused"], [409, JSON.stringify({ message: "project is INACTIVE" })], [422, "Project not active"]] as const) {
      it(`HTTP ${status} says to start the project first and that nothing changed`, async () => {
        const m = mockFetch({ status, body });
        const err = await run(m, { projectRef: "abc", dbUrlTarget: "u", region: "eu-central-1" }).catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).toContain("erst das Projekt starten");
        expect(err.message).toContain("nicht geaendert");
        expect((err as ProviderError).status).toBe(status);
        const sent = (JSON.parse(m.calls[0]!.body!) as { password: string }).password;
        expect(err.message).not.toContain(sent);
      });
    }
    it("a 401 stays a permission hint even if the text mentions a paused project", async () => {
      const err = await run(mockFetch({ status: 401, body: "unauthorized paused" })).catch((e: unknown) => e as Error);
      expect(err.message).toMatch(/database_config_write/);
    });
  });
});

describe("supabaseKeyName", () => {
  it("maps portal labels to names Supabase accepts", () => {
    expect(supabaseKeyName("supabase-secret-key-acme-app-staging-2026-11-02")).toBe("supabase_secret_key_acme_app_staging_2026_11_02");
    expect(supabaseKeyName("2026-key")).toBe("_2026_key");
    expect(supabaseKeyName("--A b--")).toBe("a_b");
  });

});
