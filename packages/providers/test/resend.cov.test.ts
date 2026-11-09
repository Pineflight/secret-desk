import { describe, expect, it } from "vitest";
import { NotConnectedError } from "@secret-desk/core";
import { resendProvider as p } from "../src/resend.js";
import { connections, issueCtx, routeFetch, secretEntry, verifyCtx, type Route } from "./helpers.js";

const domains = (list: unknown[]): Route => ({ url: "https://api.resend.com/domains", reply: { body: { data: list } } });
const dctx = (f: typeof fetch, prm: Record<string, unknown> = {}) => ({ connections: connections("resend"), fetch: f, params: prm, hint: { repos: [] as string[] } });
const pctx = (f: typeof fetch, prm: Record<string, unknown>, conns = connections("resend")) => ({ secret: secretEntry(), params: prm, stage: "dev" as const, connections: conns, fetch: f });

describe("resend discovery and preflight", () => {
  it("lists domains with their status, skipping entries without id or name", async () => {
    const m = routeFetch(domains([{ id: "d1", name: "a.com", status: "verified" }, { id: "d2", name: "b.com" }, { id: "d3" }, { name: "c.com" }]));
    expect(await p.discover!("resend.domain", dctx(m.fetch))).toEqual([
      { value: "d1", label: "a.com", name: "a.com", status: "verified", detail: "verified, d1" },
      { value: "d2", label: "b.com", name: "b.com", detail: "unbekannt, d2" },
    ]);
    await expect(p.discover!("resend.other", dctx(m.fetch))).rejects.toThrow();
  });
  const level = (r: { findings: { id: string; level: string; label: string }[] }, id: string) => r.findings.find((f) => f.id === id)!;
  it("preflight: verified domain, unverified domain with and without a status, other domains, none, unreadable", async () => {
    const ok = await p.preflight!(pctx(routeFetch(domains([{ id: "d1", name: "a.com", status: "verified" }])).fetch, { domainId: "d1" }));
    expect(level(ok, "domain").level).toBe("ok");
    expect(ok.findings.some((f) => f.id === "verified")).toBe(false);
    expect(ok.resource).toBe("Key nur fuer Domain a.com");
    const pending = await p.preflight!(pctx(routeFetch(domains([{ id: "d1", name: "a.com", status: "pending" }])).fetch, { domainId: "d1" }));
    expect(level(pending, "verified").label).toContain("Status pending");
    const unknown = await p.preflight!(pctx(routeFetch(domains([{ id: "d1", name: "a.com" }])).fetch, { domainId: "d1" }));
    expect(level(unknown, "verified").label).toContain("Status unbekannt");
    const other = await p.preflight!(pctx(routeFetch(domains([{ id: "d9", name: "z.com" }])).fetch, { domainId: "d1" }));
    expect(level(other, "domain")).toMatchObject({ level: "fail" });
    const none = await p.preflight!(pctx(routeFetch(domains([])).fetch, { domainId: "d1" }));
    expect(level(none, "domain").level).toBe("warn");
    const bad = await p.preflight!(pctx(routeFetch({ url: "/domains", reply: { status: 500, body: "x" } }).fetch, { domainId: "d1" }));
    expect(level(bad, "read").label).toBe("Domains nicht lesbar");
    await expect(p.preflight!(pctx(routeFetch().fetch, { domainId: "d1" }, connections()))).rejects.toThrow(NotConnectedError);
  });
});

describe("resend issue and verify edge cases", () => {
  it("rejects an answer without token or id", async () => {
    const noToken = routeFetch({ method: "POST", url: "/api-keys", reply: { body: { id: "r1" } } });
    await expect(p.issue!(issueCtx(noToken.fetch, {}, { conns: ["resend"] }))).rejects.toThrow("Unerwartete Antwort");
    const empty = routeFetch({ method: "POST", url: "/api-keys", reply: { status: 204 } });
    await expect(p.issue!(issueCtx(empty.fetch, {}, { conns: ["resend"] }))).rejects.toThrow("Unerwartete Antwort");
  });
  const run = (routes: Route[], externalId?: string, prm: Record<string, unknown> = {}) => p.verify!(verifyCtx(routeFetch(...routes).fetch, prm, { conns: ["resend"], ...(externalId ? { externalId } : {}) }));
  const exists = (checks: { id: string }[]) => checks.find((c) => c.id === "exists") as { status: string; actual?: string; expected?: string; detail?: string };
  it("warns when a later page of the key list cannot be read", async () => {
    const page = (call: { url: string }): { body?: unknown; status?: number } =>
      call.url.includes("after=") ? { status: 500, body: "x" } : { body: { data: [{ id: "k1" }], has_more: true } };
    const checks = await run([{ url: "/api-keys", reply: page }], "target");
    expect(exists(checks)).toMatchObject({ status: "warn", detail: "Liste der Schluessel nicht lesbar" });
    const notPage = (call: { url: string }): { body?: unknown } => (call.url.includes("after=") ? { body: { nope: 1 } } : { body: { data: [{ id: "k1" }], has_more: true } });
    expect(exists(await run([{ url: "/api-keys", reply: notPage }], "target")).status).toBe("warn");
  });
  it("warns on a non-2xx answer even when the body looks like a list, and on a body that is no list", async () => {
    const failing = await run([{ url: "/api-keys", reply: { status: 500, body: { data: [{ id: "k1" }] } } }], "k1");
    expect(exists(failing)).toMatchObject({ status: "warn", actual: "HTTP 500" });
    const notList = await run([{ url: "/api-keys", reply: { body: { data: "x" } } }], "k1");
    expect(exists(notList)).toMatchObject({ status: "warn", actual: "HTTP 200" });
  });
  it("fails without a key id and names the missing id generically", async () => {
    const checks = await run([{ url: "/api-keys", reply: { body: { data: [{ id: "k1" }] } } }]);
    expect(exists(checks)).toMatchObject({ status: "fail", expected: "Kennung" });
  });
  it("compares permissions when the list shows them, and a wrong one fails", async () => {
    const wrong = await run([{ url: "/api-keys", reply: { body: { data: [{ id: "k1", permission: "full_access" }] } } }], "k1");
    expect(wrong.find((c) => c.id === "permission")).toMatchObject({ status: "fail", expected: "sending_access", actual: "full_access" });
  });
  it("checklist names the domain when set", () => {
    expect(p.reviewChecklist!(secretEntry({ params: { domainId: "d1", permission: "sending_access" } }))).toContain("Der Schluessel ist auf die Domain d1 beschraenkt");
  });
});
