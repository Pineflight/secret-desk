import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, NotConnectedError, StageError, VaultUnavailableError } from "@secret-desk/core";
import { createRuntime } from "@secret-desk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route, type RouterDeps } from "../src/server/router.js";
import { PortalSession, allowedHosts } from "../src/server/security.js";

const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: intern
    provider: random-hex
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sd-err-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "ghp_geheim_token_1" } as unknown as NodeJS.ProcessEnv });
  const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
  return { rt, deps };
}
const HOST = "127.0.0.1:4747";
const base = `http://${HOST}`;
const ui = (deps: RouterDeps, method: string, path: string, rawBody?: string): Request =>
  new Request(`${base}/api/ui/${path}`, {
    method,
    headers: { host: HOST, origin: base, cookie: `sd_session=${deps.session.cookie}`, "x-secret-desk-csrf": deps.session.csrf, ...(rawBody !== undefined ? { "content-type": "application/json" } : {}) },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });

class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number | null, message: string) {
    super(`${provider}${status ? ` (HTTP ${status})` : ""}: ${message}`);
    this.name = "ProviderError";
  }
}

async function failWith(error: unknown, lang?: "en") {
  const { rt, deps } = await setup();
  rt.connections.statuses = async () => {
    throw error;
  };
  const req = ui(deps, "GET", "connections");
  if (lang) req.headers.set("x-secret-desk-lang", lang);
  const res = await route(req, deps);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe("H6: mapError", () => {
  it("ProviderError 403 -> 502 mit Hinweis auf Token-Rechte", async () => {
    const { res, body } = await failWith(new ProviderError("cloudflare", 403, "forbidden"));
    expect(res.status).toBe(502);
    expect(body["error"]).toMatch(/Zugriff abgelehnt/);
    expect(body["detail"]).toContain("HTTP 403");
  });
  it("ProviderError 429 -> 429 mit Hinweis", async () => {
    const { res, body } = await failWith(new ProviderError("resend", 429, "too many"));
    expect(res.status).toBe(429);
    expect(body["code"]).toBe("rate-limit");
  });
  it("ProviderError 500 -> 502", async () => {
    const { res } = await failWith(new ProviderError("stripe", 500, "kaputt"));
    expect(res.status).toBe(502);
  });
  it("GitHubError 403 -> 502 mit Hinweis, 429 -> 429, 404 -> 502 mit Originalmeldung", async () => {
    const a = await failWith(new GitHubError(403, "Forbidden"));
    expect(a.res.status).toBe(502);
    expect(a.body["error"]).toMatch(/Rechte/);
    expect((await failWith(new GitHubError(429, "slow"))).res.status).toBe(429);
    const c = await failWith(new GitHubError(404, "Nicht da"));
    expect(c.res.status).toBe(502);
    expect(c.body["error"]).toBe("Nicht da");
  });
  it("NotConnectedError -> 409", async () => {
    const { res, body } = await failWith(new NotConnectedError("github", "Token fehlt"));
    expect(res.status).toBe(409);
    expect(body["code"]).toBe("not-connected");
  });
  it("VaultUnavailableError -> 409, StageError -> 400", async () => {
    const v = await failWith(new VaultUnavailableError("Tresor kaputt"));
    expect(v.res.status).toBe(409);
    expect(v.body["code"]).toBe("vault-unavailable");
    expect((await failWith(new StageError("falsche Stage"))).res.status).toBe(400);
  });
  it("unbekannter Fehler -> 500 'Interner Fehler', aber protokolliert", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { res, body } = await failWith(new Error("unerwartet"));
    expect(res.status).toBe(500);
    expect(body["error"]).toBe("Interner Fehler");
    expect(spy).toHaveBeenCalledOnce();
  });
  it("neue Meldungen werden ins Englische uebersetzt", async () => {
    const { body } = await failWith(new GitHubError(403, "Forbidden"), "en");
    expect(body["error"]).toMatch(/GitHub denied access/);
  });
});

describe("JSON-Body", () => {
  it("kaputtes JSON -> 400", async () => {
    const { deps } = await setup();
    expect((await route(ui(deps, "POST", "renewal-requests", "{kaputt"), deps)).status).toBe(400);
  });
  it("Primitiv, Array und null -> 400 bzw. leerer Body statt 500", async () => {
    const { deps } = await setup();
    for (const raw of ["5", '"text"', "[1]", "true"]) {
      const res = await route(ui(deps, "POST", "renewal-requests", raw), deps);
      expect(res.status, raw).toBe(400);
    }
    const nul = await route(ui(deps, "POST", "renewal-requests", "null"), deps);
    expect(nul.status).toBe(400); // Feld fehlt, nicht 500
    expect(((await nul.json()) as { error: string }).error).toBe("Feld fehlt: secretId");
  });
});

describe("M5: Code statt Text bei verdaechtigen Variablenwerten", () => {
  async function patch(value: string, lang?: "en") {
    const dir = await mkdtemp(join(tmpdir(), "sd-var-"));
    await writeFile(join(dir, "inventory.yaml"), `version: 1\nvariables:\n  - id: site-url\n    name: NEXT_PUBLIC_SITE_URL\n    stage: dev\n    places:\n      - { repo: acme-web, scope: repository }\n`);
    await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n`);
    const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: { GH_TEST: "x" } as unknown as NodeJS.ProcessEnv });
    const deps: RouterDeps = { rt, session: new PortalSession(), agentToken: "agent-token-1234567890-agent-token-1234567890", hosts: allowedHosts(4747) };
    const req = ui(deps, "PATCH", "variables/site-url", JSON.stringify({ value }));
    if (lang) req.headers.set("x-secret-desk-lang", lang);
    const res = await route(req, deps);
    return { status: res.status, body: (await res.json()) as { code?: string; error: string } };
  }
  it("block -> secret-blocked, warn -> secret-ack, in beiden Sprachen", async () => {
    for (const lang of [undefined, "en" as const]) {
      const blocked = await patch("sk_live_" + "a".repeat(24), lang);
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe("secret-blocked");
      const ack = await patch("ab".repeat(32), lang);
      expect(ack.body.code, ack.body.error).toBe("secret-ack");
    }
    const ok = await patch("https://example.com");
    expect(ok.status).toBe(200);
  });
});
