import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntime, type AuthorizationRequest } from "@secret-desk/runtime";
import { describe, expect, it } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

/**
 * The actor kind `system` belongs to the runtime's own unattended routines. No request that reaches the portal or the agent API
 * (and so no MCP tool, which only calls the agent API) may produce it: the kind comes from the route prefix, never from input.
 */

const INVENTORY = `version: 1
secrets:
  - id: stage-secret
    name: STAGE_SECRET
    stage: dev
    service: x
    provider: manual
    expiry: none
    places: [{ repo: acme-docs, scope: repository }]
`;
const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-desk-system-actor-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\n`);
  const rt = await createLocalRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, bundledRecipes: null });
  const seen: AuthorizationRequest[] = [];
  rt.authorize = (request) => void seen.push(request);
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { deps, seen };
}

const FORGED_HEADERS = {
  "x-actor-kind": "system",
  "x-actor": JSON.stringify({ kind: "system", name: "issuance-sweep" }),
  "x-secret-desk-actor": "system",
  "x-secret-desk-actor-kind": "system",
  "x-principal-id": "system",
};
const FORGED_QUERY = "?kind=system&actor=system&actorKind=system&system=1";

function request(deps: RouterDeps, prefix: "ui" | "agent", method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  const auth: Record<string, string> =
    prefix === "ui" ? { origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf } : { authorization: `Bearer ${deps.agentToken}` };
  return new Request(`${base}/api/${prefix}/${path}`, { method, headers: { host: HOST, ...auth, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
}

const forgedBodies: [string, Record<string, unknown>][] = [
  ["a kind field", { notes: "n", kind: "system" }],
  ["an actor object", { notes: "n", actor: { kind: "system", name: "issuance-sweep" } }],
  ["an actor reference", { notes: "n", requestedByRef: { kind: "system", name: "team-sync-startup" }, preparedBy: { kind: "system", name: "x" } }],
];

for (const prefix of ["ui", "agent"] as const) {
  describe(`${prefix === "ui" ? "portal" : "agent API"}: input that claims the kind system`, () => {
    for (const [name, body] of forgedBodies) {
      it(`${name} in the body is refused as an unknown field and the hook is never asked`, async () => {
        const { deps, seen } = await setup();
        const res = await route(request(deps, prefix, "PATCH", "secrets/stage-secret", body), deps);
        expect(res.status).toBe(400);
        expect(seen).toEqual([]);
        expect(deps.rt.inventory.getSecret("stage-secret")!.notes).toBeUndefined();
      });
    }

    it("headers and query parameters that claim the kind are ignored: the actor is the one of the route", async () => {
      const { deps, seen } = await setup();
      const res = await route(request(deps, prefix, "PATCH", `secrets/stage-secret${FORGED_QUERY}`, { notes: "n" }, FORGED_HEADERS), deps);
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.actor).toEqual({ kind: prefix === "ui" ? "human" : "agent", name: expect.any(String) });
      expect(seen[0]!.actor.principalId).toBeUndefined();
    });

    it("a display name of system does not make a system actor: the kind stays human or agent", async () => {
      const { deps, seen } = await setup();
      const res = await route(request(deps, prefix, "PATCH", "secrets/stage-secret", { notes: "n" }, { "x-agent-name": "system" }), deps);
      expect(res.status).toBe(200);
      expect(seen.map((r) => r.actor.kind)).toEqual([prefix === "ui" ? "human" : "agent"]);
    });
  });
}
