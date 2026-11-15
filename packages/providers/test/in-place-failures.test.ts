import { describe, expect, it } from "vitest";
import { IssuedButFailedError } from "@secret-desk/core";
import { cloudflareAccessProvider as access } from "../src/cloudflare-access.js";
import { supabaseProviders } from "../src/supabase.js";
import { issueCtx, mockFetch, routeFetch, type Route } from "./helpers.js";

// The two providers that replace a value in place throw IssuedButFailedError when the provider answered success and a later step failed,
// so the caller can record what exists now. An answer that never came (an error status, a time-out) is not certain and stays an ordinary error.

const BASE = "https://api.cloudflare.com/client/v4";
const GROUPS = { result: [{ id: "g-write", name: "Access: Service Tokens Write", scopes: ["com.cloudflare.api.account"] }] };
const params = { accountId: "acc1", clientIdTarget: "access-id", duration: "720h" };
const SVC = `${BASE}/accounts/acc1/access/service_tokens`;
const helperRoutes = (): Route[] => [
  { url: "/user/tokens/permission_groups", reply: { body: GROUPS } },
  { method: "POST", url: `${BASE}/user/tokens`, reply: { body: { result: { id: "helper-1", value: "HELPER-TOKEN-VALUE-0123456789" } } } },
  { method: "DELETE", url: `${BASE}/user/tokens/helper-1`, reply: { body: { result: { id: "helper-1" } } } },
];
const exists = { url: `${SVC}/svc-old`, reply: { body: { result: { id: "svc-old" } } } } satisfies Route;
const renew = (reply: Route["reply"]): Route => ({ method: "POST", url: `${SVC}/svc-old/rotate`, reply });
const create = (reply: Route["reply"]): Route => ({ method: "POST", url: SVC, reply });

function accessCtx(f: typeof fetch, externalId?: string) {
  const base = issueCtx(f, params, { conns: ["cloudflare"] });
  return externalId !== undefined ? { ...base, secret: { ...base.secret, externalId } } : base;
}

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => run().then(() => undefined, (e: unknown) => e);

describe("cloudflare-access: renewing the secret of an existing token", () => {
  it("an answer without the secret after a success: the old secret is gone, the identifier is the token's", async () => {
    const m = routeFetch(...helperRoutes(), exists, renew({ body: { result: {} } }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch, "svc-old")));
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err).toMatchObject({ externalId: "svc-old", replacedOld: true });
    expect((err as Error).message).toContain("Unerwartete Antwort");
  });

  it("a success answer that is not JSON counts the same", async () => {
    const m = routeFetch(...helperRoutes(), exists, renew({ body: "not json" }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch, "svc-old")));
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err).toMatchObject({ externalId: "svc-old", replacedOld: true });
    expect((err as Error).message).toBe("cloudflare-access-service-token: Der Anbieter hat die Aenderung angenommen, aber die Antwort war unbrauchbar");
  });

  it("an error status is not certain: an ordinary error", async () => {
    const m = routeFetch(...helperRoutes(), exists, renew({ status: 500, body: "boom" }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch, "svc-old")));
    expect(err).not.toBeInstanceOf(IssuedButFailedError);
    expect(err).toBeInstanceOf(Error);
  });

  it("a renewal that worked says it replaced the value in place", async () => {
    const m = routeFetch(...helperRoutes(), exists, renew({ body: { result: { client_secret: "made-up-client-secret-0123456789" } } }));
    expect(await access.issue!(accessCtx(m.fetch, "svc-old"))).toMatchObject({ externalId: "svc-old", replacedInPlace: true });
  });
});

describe("cloudflare-access: creating a new token", () => {
  it("values missing but an id given: the new token is named so the gate can delete it", async () => {
    const m = routeFetch(...helperRoutes(), create({ body: { result: { id: "svc-7", client_secret: "made-up-client-secret-0123456789" } } }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch)));
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err).toMatchObject({ externalId: "svc-7", replacedOld: false });
    expect((err as Error).message).toContain("Kennung svc-7");
  });

  it("a success answer without an id: a token may exist, its identifier is unknown", async () => {
    const m = routeFetch(...helperRoutes(), create({ body: {} }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch)));
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err).toMatchObject({ externalId: undefined, replacedOld: false });
  });

  it("a success answer that is not JSON counts the same", async () => {
    const m = routeFetch(...helperRoutes(), create({ body: "not json" }));
    const err = await thrown(() => access.issue!(accessCtx(m.fetch)));
    expect(err).toMatchObject({ name: "IssuedButFailedError", externalId: undefined, replacedOld: false });
  });

  it("a new token did not replace anything", async () => {
    const m = routeFetch(...helperRoutes(), create({ body: { result: { id: "svc-2", client_id: "cid", client_secret: "made-up-client-secret-0123456789" } } }));
    expect((await access.issue!(accessCtx(m.fetch))).replacedInPlace).toBeUndefined();
  });
});

describe("supabase-db-password: the password was changed", () => {
  const p = supabaseProviders.find((x) => x.id === "supabase-db-password")!;
  const run = (m: ReturnType<typeof mockFetch>) => p.issue!(issueCtx(m.fetch, { projectRef: "abc" }, { conns: ["supabase"] }));

  it("a success answer that cannot be read: the password was replaced and nobody knows it", async () => {
    const err = await thrown(() => run(mockFetch({ body: "not json" })));
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err).toMatchObject({ externalId: "abc", replacedOld: true });
  });

  it("an error status is not certain: the existing failure text", async () => {
    const err = await thrown(() => run(mockFetch({ status: 500, body: "boom" })));
    expect(err).not.toBeInstanceOf(IssuedButFailedError);
    expect((err as Error).message).toContain("das Projekt muss gesund sein");
  });

  it("a password that was set says it replaced the value in place", async () => {
    expect(await run(mockFetch({ body: { message: "ok" } }))).toMatchObject({ externalId: "abc", replacedInPlace: true });
  });
});
