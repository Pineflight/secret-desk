import { describe, expect, it } from "vitest";
import { cloudflareProviders } from "../src/cloudflare.js";
import { grafanaProvider } from "../src/grafana.js";
import { ProviderError } from "../src/http.js";
import { resendProvider } from "../src/resend.js";
import { supabaseProviders } from "../src/supabase.js";
import { CONN_TOKEN, ISSUED, issueCtx, revokeCtx, routeFetch, verifyCtx } from "./helpers.js";

const cf = cloudflareProviders.find((p) => p.id === "cloudflare-token")!;
const sbKey = supabaseProviders.find((p) => p.id === "supabase-api-key")!;

interface Case {
  name: string;
  provider: { issue?: (c: never) => Promise<unknown>; revoke?: (c: never) => Promise<void> };
  conn: string;
  params: Record<string, unknown>;
  issueUrl: string;
  issueMethod: string;
  /** Zusaetzliche Routen, die issue braucht, bevor der eigentliche Aufruf kommt. */
  pre?: { method?: string; url: string; reply: { body: unknown } }[];
  revokeUrl: string;
  extId: string;
}

const CASES: Case[] = [
  { name: "cloudflare", provider: cf as never, conn: "cloudflare", params: { accountId: "acc1", permissions: ["Workers Scripts Write"] }, issueUrl: "/user/tokens", issueMethod: "POST", pre: [{ url: "permission_groups", reply: { body: { result: [{ id: "g1", name: "Workers Scripts Write" }] } } }], revokeUrl: "/user/tokens/tok1", extId: "tok1" },
  { name: "resend", provider: resendProvider as never, conn: "resend", params: {}, issueUrl: "/api-keys", issueMethod: "POST", revokeUrl: "/api-keys/r1", extId: "r1" },
  { name: "supabase", provider: sbKey as never, conn: "supabase", params: { projectRef: "abc" }, issueUrl: "/api-keys?reveal=true", issueMethod: "POST", revokeUrl: "/api-keys/k1", extId: "k1" },
  { name: "grafana", provider: grafanaProvider as never, conn: "grafana", params: { baseUrl: "https://g.grafana.net", serviceAccountId: 7 }, issueUrl: "/api/serviceaccounts/7/tokens", issueMethod: "POST", revokeUrl: "/api/serviceaccounts/7/tokens/42", extId: "42" },
];

for (const c of CASES) {
  describe(`${c.name}: Fehlerantworten (Routing statt Reihenfolge)`, () => {
    for (const status of [401, 404, 429, 500]) {
      it(`issue bei HTTP ${status}: ProviderError mit Status, ohne Verbindungs-Token`, async () => {
        const m = routeFetch(...(c.pre ?? []).map((r) => ({ ...r, reply: r.reply })), { method: c.issueMethod, url: c.issueUrl, reply: { status, body: `denied ${CONN_TOKEN}` } });
        const err = await c.provider.issue!(issueCtx(m.fetch, c.params, { conns: [c.conn] }) as never).catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).status).toBe(status);
        expect((err as Error).message).not.toContain(CONN_TOKEN);
        expect(m.calls.at(-1)!.method).toBe(c.issueMethod);
      });
    }
    for (const status of [401, 429, 500]) {
      it(`revoke bei HTTP ${status}: Fehler geht durch`, async () => {
        const m = routeFetch({ method: "DELETE", url: c.revokeUrl, reply: { status, body: "x" } });
        const err = await c.provider.revoke!(revokeCtx(m.fetch, c.params, c.extId, [c.conn]) as never).catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).status).toBe(status);
      });
    }
    it("revoke bei 404 ist idempotent (Token war schon weg)", async () => {
      const m = routeFetch({ method: "DELETE", url: c.revokeUrl, reply: { status: 404, body: "not found" } });
      await expect(c.provider.revoke!(revokeCtx(m.fetch, c.params, c.extId, [c.conn]) as never)).resolves.toBeUndefined();
      expect(m.calls).toHaveLength(1);
    });
  });
}

describe("cloudflare: Teilantwort", () => {
  it("2xx mit result.id aber ohne value: Fehler nennt die Kennung des moeglicherweise verwaisten Tokens", async () => {
    const m = routeFetch(
      { url: "permission_groups", reply: { body: { result: [{ id: "g1", name: "Workers Scripts Write" }] } } },
      { method: "POST", url: "/user/tokens", reply: { body: { result: { id: "tok-verwaist" } } } },
    );
    const err = await cf.issue!(issueCtx(m.fetch, { accountId: "a", permissions: ["Workers Scripts Write"] }, { conns: ["cloudflare"] })).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("tok-verwaist");
    expect(err.message).toMatch(/verwaist/);
  });
  it("Antwort ganz ohne result bleibt eine unerwartete Antwort", async () => {
    const m = routeFetch({ url: "permission_groups", reply: { body: { result: [{ id: "g1", name: "Workers Scripts Write" }] } } }, { method: "POST", url: "/user/tokens", reply: { body: {} } });
    await expect(cf.issue!(issueCtx(m.fetch, { accountId: "a", permissions: ["Workers Scripts Write"] }, { conns: ["cloudflare"] }))).rejects.toThrow(/Unerwartete Antwort/);
  });
});

describe("resend: Paginierung der Schluesselliste", () => {
  it("findet einen Schluessel auf Seite 2", async () => {
    const m = routeFetch({
      url: "/api-keys",
      reply: (call) =>
        call.url.includes("after=k99")
          ? { body: { data: [{ id: "target", permission: "sending_access" }], has_more: false } }
          : { body: { data: [{ id: "k1" }, { id: "k99" }], has_more: true } },
    });
    const checks = await resendProvider.verify!(verifyCtx(m.fetch, {}, { conns: ["resend"], externalId: "target" }));
    expect(checks.find((c) => c.id === "exists")!.status).toBe("pass");
    expect(m.calls).toHaveLength(2);
  });
  it("hoert auf, wenn die Seitenanzahl erschoepft ist und has_more false", async () => {
    const m = routeFetch({ url: "/api-keys", reply: { body: { data: [{ id: "k1" }], has_more: false } } });
    const checks = await resendProvider.verify!(verifyCtx(m.fetch, {}, { conns: ["resend"], externalId: "fehlt" }));
    expect(checks.find((c) => c.id === "exists")!.status).toBe("fail");
    expect(m.calls).toHaveLength(1);
  });
});

describe("supabase: Form des Schluessels (JWT-Rolle)", () => {
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  const shape = async (value: string, type: "secret" | "publishable") => {
    const m = routeFetch();
    const checks = await sbKey.verify!(verifyCtx(m.fetch, { type }, { value, conns: ["supabase"] }));
    return checks.find((c) => c.id === "shape")!.status;
  };
  it("expected secret: anon-JWT = fail, service_role-JWT und sb_secret_ = ok", async () => {
    expect(await shape(jwt("anon"), "secret")).toBe("fail");
    expect(await shape(jwt("service_role"), "secret")).toBe("info");
    expect(await shape("sb_secret_abcdefghijklmnop", "secret")).toBe("info");
    expect(await shape("sb_publishable_abcdefghijklmnop", "secret")).toBe("fail");
  });
  it("expected publishable: service_role-JWT = fail, anon-JWT = ok", async () => {
    expect(await shape(jwt("service_role"), "publishable")).toBe("fail");
    expect(await shape(jwt("anon"), "publishable")).toBe("info");
  });
  void ISSUED;
});
