import { describe, expect, it, vi } from "vitest";
import { PortalSession, allowedHosts } from "../src/server/security.js";
import { routerFixture, BASE, HOST } from "./helpers/router-fixture.js";

const holder: { desk?: unknown } = {};
vi.mock("@/server/desk", () => ({ getDesk: async () => holder.desk }));

const { GET, POST, PATCH, PUT, DELETE, dynamic, runtime, maxDuration } = await import("../src/app/api/[...path]/route.js");

async function setup(launchSecret?: string) {
  const { rt, deps } = await routerFixture();
  const session = new PortalSession({ launchSecret: launchSecret ?? null });
  holder.desk = { rt, session, agentToken: deps.agentToken, hosts: allowedHosts(4747), demo: false };
  return { session };
}
const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const { host = HOST, ...rest } = init;
  return new Request(`${BASE}${path}`, { ...rest, headers: { host, ...(rest.headers as Record<string, string> | undefined) } });
};

describe("api catch-all route", () => {
  it("exports the same handler for every method and the route config", () => {
    expect(new Set([GET, POST, PATCH, PUT, DELETE]).size).toBe(1);
    expect({ dynamic, runtime, maxDuration }).toEqual({ dynamic: "force-dynamic", runtime: "nodejs", maxDuration: 3600 });
  });

  it("rejects requests from a foreign site before anything else", async () => {
    await setup();
    const res = await GET(req("/api/session", { headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("fremdem Ursprung");
  });

  it("issues the session with cookie and csrf value", async () => {
    const { session } = await setup();
    const res = await GET(req("/api/session"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe(session.cookieHeader());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ csrf: session.csrf, demo: false });
  });

  it("refuses the session for a host that is not allowed", async () => {
    await setup();
    const res = await GET(req("/api/session", { host: "evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Host nicht erlaubt");
  });

  it("demands the launch address when a launch secret is set and not given", async () => {
    await setup("launch-secret-for-tests");
    const res = await GET(req("/api/session"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("launch-required");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ok = await GET(req("/api/session?launch=launch-secret-for-tests"));
    expect(ok.status).toBe(200);
  });

  it("serves the OpenAPI description to allowed hosts and refuses foreign hosts", async () => {
    await setup();
    const ok = await GET(req("/api/openapi.yaml"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("yaml");
    const head = await GET(req("/api/openapi.yaml", { method: "HEAD" }));
    expect(head.status).toBe(200);
    const bad = await GET(req("/api/openapi.yaml", { host: "evil.example" }));
    expect(bad.status).toBe(403);
  });

  it("hands every other request to the router, which checks the session", async () => {
    await setup();
    const res = await GET(req("/api/ui/overview"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const post = await POST(req("/api/openapi.yaml", { method: "POST" }));
    expect(post.status).toBeGreaterThanOrEqual(400);
  });
});
