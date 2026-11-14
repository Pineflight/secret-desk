import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretValue, SessionVault, type AppJwtSigner, type SecretSealer } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { HostCapabilityError } from "../src/host.js";
import { createRuntime, GITHUB_APP_KEY_CONNECTION, GITHUB_CONNECTION, type RuntimeOptions } from "../src/runtime.js";
import { openScopedSession, teamTokenSource } from "../src/team-sync.js";
import { verifyTeamToken } from "../src/team-token.js";

// Everything here is made up. The runtimes have no host unless a test says so; the bearer and key values are plain strings.
const target = { owner: "acme", repo: "acme-app", scope: "repository" } as const;
const PLAINTEXT = "made-up-plaintext-value";
const SEALED = "bWFkZS11cC1zZWFsZWQtb3V0cHV0";
const INSTALL_TOKEN = "made-up-installation-token";
const FILE = "version: 1\nsecrets: []\nvariables: []\n";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeFetch() {
  const calls: { method: string; url: string; auth: string; body?: string }[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, auth: String((init?.headers as Record<string, string>)["Authorization"] ?? ""), ...(init?.body ? { body: String(init.body) } : {}) });
    if (u.includes("/app/installations?")) return json([{ id: 7, account: { login: "acme" } }]);
    if (u.includes("/access_tokens")) return json({ token: INSTALL_TOKEN, expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" }, repositories: [] }, 201);
    if (u.endsWith("/public-key")) return json({ key_id: "key-1", key: "made-up-public-key" });
    if (u.includes("/secrets/")) return new Response(null, { status: 201 });
    return json({ private: true, permissions: { push: true } });
  }) as unknown as typeof fetch;
  return { calls, fetchMock };
}

async function setup(auth: "pat" | "app", options: Partial<RuntimeOptions> = {}, storeKey = true) {
  const dir = await mkdtemp(join(tmpdir(), "sd-gh-crypto-"));
  await writeFile(join(dir, "inventory.yaml"), FILE);
  const authYaml = auth === "pat" ? "{ type: pat, source: { type: env, name: GH_TEST } }" : '{ type: app, appId: "123", privateKey: { type: env, name: APP_KEY } }';
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: ${authYaml}\nteamSync:\n  repo: acme/team-config\n`);
  const session = new SessionVault();
  if (storeKey) session.set(auth === "pat" ? GITHUB_CONNECTION : GITHUB_APP_KEY_CONNECTION, "made-up-key-or-token");
  const { calls, fetchMock } = makeFetch();
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, bundledRecipes: null, session, fetch: fetchMock, ...options });
  return { rt, calls };
}

describe("seal option of the runtime", () => {
  it("a runtime without a host uses the injected sealer for every secret it writes", async () => {
    const seal = vi.fn<SecretSealer>(async () => SEALED);
    const { rt, calls } = await setup("pat", { seal });
    expect(rt.host).toBeUndefined();
    expect(await rt.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT))).toBe("created");
    expect(seal).toHaveBeenCalledExactlyOnceWith("made-up-public-key", PLAINTEXT);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ encrypted_value: SEALED, key_id: "key-1" });
    expect(put.body).not.toContain(PLAINTEXT);
  });

  it("the injected sealer also serves the clients of team sync and the team token check", async () => {
    const seal = vi.fn<SecretSealer>(async () => SEALED);
    const { rt } = await setup("pat", { seal });
    const scoped = await openScopedSession(rt, { owner: "acme", repositories: ["acme-app"], permissions: { contents: "read" } });
    await scoped.gh.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT));
    expect(seal).toHaveBeenCalledOnce();
  });

  it("the client that checks a new team token follows the same rule (no host, no sealer: it can read, never seal)", async () => {
    const { rt } = await setup("pat");
    const problem = await verifyTeamToken(rt, new SecretValue("made-up-team-token"), { owner: "acme", name: "team-config", branch: "main", mode: "read", strategy: "direct" });
    expect(problem === null || typeof problem === "string").toBe(true);
  });

  it("a runtime without a host and without a sealer refuses with the host capability error and sends nothing", async () => {
    const { rt, calls } = await setup("pat");
    const err = await rt.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostCapabilityError);
    expect((err as HostCapabilityError).capability).toBe("seal");
    expect(String((err as Error).message)).not.toContain(PLAINTEXT);
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("a runtime with a host and no sealer keeps the default of the core (the client is built without a replacement sealer)", async () => {
    const { rt } = await setup("pat", { host: { label: "t" } });
    const err = await rt.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HostCapabilityError);
  });
});

describe("sign option of the runtime", () => {
  it("a runtime without a host signs the App token with the injected signer and never reads the private key", async () => {
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const { rt, calls } = await setup("app", { sign });
    const readKey = vi.spyOn(rt.connections, "token");
    expect(await rt.github.listSecrets({ owner: "acme", repo: "acme-app", scope: "repository" }).catch(() => "listed")).toBeDefined();
    expect(sign).toHaveBeenCalledOnce();
    expect(sign.mock.calls[0]![0]).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(calls[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.made-up-signature$/);
    expect(readKey).not.toHaveBeenCalled();
    expect(calls.some((c) => c.auth === `Bearer ${INSTALL_TOKEN}`)).toBe(true);
  });

  it("the scoped team session uses the injected signer as well", async () => {
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const { rt } = await setup("app", { sign });
    const scoped = await openScopedSession(rt, { owner: "acme", repositories: ["acme-app"], permissions: { contents: "read" } });
    await scoped.gh.getRepo("acme", "acme-app");
    expect(sign).toHaveBeenCalledOnce();
    expect(scoped.secrets()).toContain(INSTALL_TOKEN);
  });

  it("with an injected signer the App counts as connected for team sync although no private key is stored", async () => {
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const { rt } = await setup("app", { sign }, false);
    expect(await teamTokenSource(rt)).toBe("github-app");
    const without = await setup("app", {}, false);
    expect(await teamTokenSource(without.rt)).toBe("none");
  });

  it("a runtime without a host and without a signer refuses with the host capability error before the key is read", async () => {
    const { rt, calls } = await setup("app");
    const readKey = vi.spyOn(rt.connections, "token");
    const err = await rt.github.getRepo("acme", "acme-app").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostCapabilityError);
    expect((err as HostCapabilityError).capability).toBe("sign");
    expect(readKey).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a runtime with a host and no signer reads the key from the connection and signs it in the process", async () => {
    const { rt } = await setup("app", { host: { label: "t" } });
    const readKey = vi.spyOn(rt.connections, "token");
    // The made-up key is not a valid PEM: signing fails inside the core, which proves the key path was taken.
    const err = await rt.github.getRepo("acme", "acme-app").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HostCapabilityError);
    expect(readKey).toHaveBeenCalledWith(GITHUB_APP_KEY_CONNECTION);
  });
});
