import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts, checkHost, checkOrigin, extraHostsFromEnv } from "../src/server/security.js";

const LAN = "192.168.1.20:4747";

async function setup(env: Record<string, string | undefined>) {
  const dir = await mkdtemp(join(tmpdir(), "sd-hosts-"));
  await writeFile(join(dir, "inventory.yaml"), "version: 1\nsecrets: []\nvariables: []\n");
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\npolicy:\n  envRoots: [${JSON.stringify(dir)}]\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_made_up_token_1" } as unknown as NodeJS.ProcessEnv });
  const deps: RouterDeps = { rt, session: new PortalSession({ env: {} }), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747, extraHostsFromEnv(env)) };
  return deps;
}

const ui = (deps: RouterDeps, host: string, method: string, origin?: string): Request =>
  new Request(`http://${host}/api/ui/overview`, {
    method,
    headers: { host, ...(origin ? { origin } : {}), cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf },
  });

describe("SECRET_DESK_ALLOWED_HOSTS parsing", () => {
  it("missing or empty variable adds nothing", () => {
    expect(extraHostsFromEnv({})).toEqual([]);
    expect(extraHostsFromEnv({ SECRET_DESK_ALLOWED_HOSTS: "" })).toEqual([]);
    expect(extraHostsFromEnv({ SECRET_DESK_ALLOWED_HOSTS: " , ,, " })).toEqual([]);
  });

  it("trims entries and drops empty ones", () => {
    expect(extraHostsFromEnv({ SECRET_DESK_ALLOWED_HOSTS: ` ${LAN} , ,pi.local:4747,` })).toEqual([LAN, "pi.local:4747"]);
  });

  it("default set stays exactly loopback with port", () => {
    expect([...allowedHosts(4747, extraHostsFromEnv({}))].sort()).toEqual(["127.0.0.1:4747", "[::1]:4747", "localhost:4747"]);
  });
});

describe("extra allowed hosts at the router", () => {
  it("default: LAN host gets 403", async () => {
    const deps = await setup({});
    const r = await route(ui(deps, LAN, "GET"), deps);
    expect(r.status).toBe(403);
    expect(checkHost(ui(deps, LAN, "GET"), deps.hosts)).toBe(false);
  });

  it("extra host is accepted, loopback still works", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: LAN });
    expect((await route(ui(deps, LAN, "GET"), deps)).status).toBe(200);
    expect((await route(ui(deps, "127.0.0.1:4747", "GET"), deps)).status).toBe(200);
  });

  it("foreign host is still rejected (DNS rebinding), also with the same port", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: LAN });
    expect((await route(ui(deps, "evil.example:4747", "GET"), deps)).status).toBe(403);
    expect((await route(ui(deps, "192.168.1.21:4747", "GET"), deps)).status).toBe(403);
    expect((await route(ui(deps, "192.168.1.20", "GET"), deps)).status).toBe(403);
  });

  it("origin check with extra host: own LAN origin passes, foreign origin fails", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: LAN });
    expect(checkOrigin(ui(deps, LAN, "POST", `http://${LAN}`), deps.hosts)).toBe(true);
    expect(checkOrigin(ui(deps, LAN, "POST", "http://evil.example"), deps.hosts)).toBe(false);
    expect(checkOrigin(ui(deps, LAN, "POST"), deps.hosts)).toBe(false);
    const r = await route(ui(deps, LAN, "POST", "http://evil.example"), deps);
    expect(r.status).toBe(403);
  });

  it("extra host does not weaken session checks", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: LAN });
    const r = await route(new Request(`http://${LAN}/api/ui/overview`, { headers: { host: LAN } }), deps);
    expect(r.status).toBe(401);
    expect(checkOrigin(new Request(`http://${LAN}/x`, { method: "POST", headers: { host: LAN } }), deps.hosts)).toBe(false);
  });

  it("rejection responses contain no value and no token", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: LAN });
    const bodies = [
      await (await route(ui(deps, "evil.example:4747", "GET"), deps)).text(),
      await (await route(ui(deps, LAN, "POST", "http://evil.example"), deps)).text(),
    ].join("\n");
    for (const secret of ["ghp_made_up_token_1", deps.agentToken, deps.session.cookie, deps.session.csrf, deps.session.launchSecret ?? "-"]) expect(bodies).not.toContain(secret);
  });
});

describe("reverse proxy on port 80 (hosts without port)", () => {
  it("accepts entries without a port exactly as sent in the Host header", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: "desk.local,192.168.1.20" });
    expect((await route(ui(deps, "desk.local", "GET"), deps)).status).toBe(200);
    expect((await route(ui(deps, "192.168.1.20", "GET"), deps)).status).toBe(200);
    expect((await route(ui(deps, "desk.local:4747", "GET"), deps)).status).toBe(403);
    expect((await route(ui(deps, "other.local", "GET"), deps)).status).toBe(403);
  });

  it("origin without port passes for such a host, foreign origin fails", async () => {
    const deps = await setup({ SECRET_DESK_ALLOWED_HOSTS: "desk.local" });
    expect(checkOrigin(ui(deps, "desk.local", "POST", "http://desk.local"), deps.hosts)).toBe(true);
    expect(checkOrigin(ui(deps, "desk.local", "POST", "http://evil.example"), deps.hosts)).toBe(false);
  });

  it("session cookie has no Secure attribute, so it is set over plain HTTP", () => {
    const header = new PortalSession({ env: {} }).cookieHeader();
    expect(header).not.toMatch(/;\s*Secure/i);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
  });
});
