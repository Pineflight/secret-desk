import {
  GitHubClient,
  InventoryStoreCore,
  MemoryEvidenceStore,
  MemoryInventoryBackend,
  MemoryVaultStore,
  ProviderRegistry,
  SecretValue,
  SessionVault,
  Vault,
  parseConfig,
  secretApprovalSnapshot,
  type AppJwtSigner,
  type PendingIssuance,
  type SecretEntry,
  type SecretSealer,
} from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationUnavailableError,
  GITHUB_APP_KEY_CONNECTION,
  GITHUB_CONNECTION,
  HostCapabilityError,
  MemoryPendingStore,
  assertAuthorizeTimeout,
  createPortableRuntime,
  githubAppUsable,
  issuanceDeps,
  noAutomation,
  type AutomationPort,
  type PortableAutomationContext,
  type RuntimeHost,
} from "../src/portable.js";

// A runtime built from memory parts only: the configuration text, a memory inventory backend, the memory evidence store. No file, no
// process, no Node host. Everything here is made up.
const CONFIG = "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
const APP_CONFIG = 'inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: app, appId: "123", privateKey: { type: env, name: APP_KEY } }\n';
const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: acme
    provider: manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
providers:
  - { id: acme-portal, label: Acme Portal, url: "https://example.com/keys", steps: ["Open the page"] }
`;
const target = { owner: "acme", repo: "acme-app", scope: "repository" } as const;
const PLAINTEXT = "made-up-plaintext-value";
const SEALED = "bWFkZS11cC1zZWFsZWQtb3V0cHV0";
const INSTALL_TOKEN = "made-up-installation-token";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

function parts(config = CONFIG) {
  const backend = new MemoryInventoryBackend(INVENTORY);
  return { backend, source: { config: parseConfig(config), inventory: InventoryStoreCore.withBackend(backend), evidence: new MemoryEvidenceStore() } };
}

const secretOf = (rt: { inventory: InventoryStoreCore }): SecretEntry => rt.inventory.getSecret("hmac-acme-app")!;

describe("createPortableRuntime from memory parts only", () => {
  it("builds without a host and without a path, with the portable providers and the manual provider of the inventory", async () => {
    const { source } = parts();
    const rt = await createPortableRuntime(source, {});
    expect(rt.host).toBeUndefined();
    expect(rt.configPath).toBeUndefined();
    expect(rt.owner).toBe("acme");
    expect(rt.seal).toBeUndefined();
    expect(rt.sign).toBeUndefined();
    expect(rt.authorize).toBeUndefined();
    const ids = rt.providers.list().map((p) => p.id);
    expect(ids).toEqual([...createPortableRegistry().list().map((p) => p.id), "acme-portal"]);
    expect(ids).toContain("cloudflare-token");
    expect(ids).not.toContain("supabase");
    expect(rt.providers.get("acme-portal")).toMatchObject({ kind: "manual", label: "Acme Portal" });
  });

  it("keeps the path it was given and the options it was given", async () => {
    const { source } = parts();
    const authorize = vi.fn();
    const onAuthorizeFault = vi.fn();
    const rt = await createPortableRuntime({ ...source, configPath: "/made-up/desk.yaml" }, { authorize, authorizeTimeoutMs: 500, onAuthorizeFault, seal: async () => SEALED, sign: async () => "sig" });
    expect(rt.configPath).toBe("/made-up/desk.yaml");
    expect(rt.authorize).toBe(authorize);
    expect(rt.authorizeTimeoutMs).toBe(500);
    expect(rt.onAuthorizeFault).toBe(onAuthorizeFault);
    expect(typeof rt.seal).toBe("function");
    expect(typeof rt.sign).toBe("function");
  });

  it("creates an approval, which stays pending until it is decided", async () => {
    const { source } = parts();
    const rt = await createPortableRuntime(source, { now: () => new Date("2026-11-14T10:00:00Z") });
    const approval = rt.approvals.create({ action: "issue", targetId: "hmac-acme-app", requestedBy: "agent-1", snapshot: secretApprovalSnapshot(secretOf(rt)), now: rt.now() });
    expect(approval).toMatchObject({ state: "pending", createdAt: "2026-11-14T10:00:00.000Z" });
    expect(approval.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rt.approvals.list("pending").map((a) => a.id)).toEqual([approval.id]);
  });

  it("an approval whose entry changed from outside becomes stale at once, and the team-sync memo is cleared", async () => {
    const { source, backend } = parts();
    const rt = await createPortableRuntime(source, {});
    const approval = rt.approvals.create({ action: "issue", targetId: "hmac-acme-app", requestedBy: "agent-1", snapshot: secretApprovalSnapshot(secretOf(rt)) });
    rt.teamSyncMemo.lastCheck = { made: "up" };
    backend.replaceExternally(INVENTORY.replace("scope: repository }", "scope: repository }\n      - { repo: acme-docs, scope: repository }"));
    expect(rt.inventory.getSecret("hmac-acme-app")?.places).toHaveLength(2);
    expect(rt.approvals.get(approval.id)?.state).toBe("stale");
    expect(rt.teamSyncMemo.lastCheck).toBeNull();
  });

  it("holds a pending issuance in the queue with an injected pending store, and the sweep expires it", async () => {
    const { source } = parts();
    const clock = { t: Date.parse("2026-11-14T10:00:00Z") };
    const store = new MemoryPendingStore();
    const onNeedsDecision = vi.fn();
    const rt = await createPortableRuntime(source, { now: () => new Date(clock.t), pendingStore: store, onNeedsDecision, onRevokeAbandoned: vi.fn() });
    const pending = {
      id: "p1",
      secretId: "hmac-acme-app",
      createdAt: "2026-11-14T10:00:00.000Z",
      expiresAt: "2026-11-14T10:15:00.000Z",
      value: new SecretValue("made-up-issued-value"),
      companions: [],
      report: { id: "p1", secretId: "hmac-acme-app", provider: "manual", checks: [] },
      issuedSecret: secretOf(rt),
    } as unknown as PendingIssuance;
    rt.issuances.add(pending);
    expect(rt.issuances.get("p1")).toBe(pending);
    expect(store.list().map((r) => r.id)).toEqual(["p1"]);
    // Before the deadline the sweep leaves it and names the deadline to re-arm with.
    expect((await rt.sweep(new Date("2026-11-14T10:10:00Z")))?.toISOString()).toBe("2026-11-14T10:15:00.000Z");
    expect(rt.issuances.get("p1")).toBe(pending);
    // At the deadline it is gone: the value, the record and the deadline.
    expect(await rt.sweep(new Date("2026-11-14T10:15:00Z"))).toBeNull();
    expect(rt.issuances.get("p1")).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(pending.value.reveal()).toBe("");
    expect(onNeedsDecision).not.toHaveBeenCalled();
    // Without a time the sweep follows the injected clock.
    clock.t += 1000;
    expect(await rt.sweep()).toBeNull();
  });

  it("the sweep also expires the waits for a person and returns the nearer deadline", async () => {
    const { source } = parts();
    const rt = await createPortableRuntime(source, { now: () => new Date("2026-11-14T10:00:00Z") });
    const run = new AbortController();
    const rejected: Error[] = [];
    rt.instance.codeWaiters.set("k", { resolve: () => undefined, reject: (e) => rejected.push(e), run: run.signal, deadline: Date.parse("2026-11-14T10:05:00Z") });
    expect((await rt.sweep(new Date("2026-11-14T10:01:00Z")))?.toISOString()).toBe("2026-11-14T10:05:00.000Z");
    expect(await rt.sweep(new Date("2026-11-14T10:06:00Z"))).toBeNull();
    expect(rejected.map((e) => e.name)).toEqual(["WaitExpiredError"]);
    // A review and a wait both open: the earlier deadline wins, in either order.
    const pending = (id: string, expiresAt: string) => ({ id, secretId: "hmac-acme-app", createdAt: "2026-11-14T10:00:00.000Z", expiresAt, value: new SecretValue("made-up-issued-value"), companions: [], report: { id, secretId: "hmac-acme-app", provider: "manual", checks: [] }, issuedSecret: secretOf(rt) }) as unknown as PendingIssuance;
    rt.issuances.add(pending("p2", "2026-11-14T10:30:00.000Z"));
    rt.instance.codeWaiters.set("k2", { resolve: () => undefined, reject: () => undefined, run: run.signal, deadline: Date.parse("2026-11-14T10:20:00Z") });
    expect((await rt.sweep(new Date("2026-11-14T10:07:00Z")))?.toISOString()).toBe("2026-11-14T10:20:00.000Z");
    rt.instance.codeWaiters.set("k2", { resolve: () => undefined, reject: () => undefined, run: run.signal, deadline: Date.parse("2026-11-14T10:40:00Z") });
    expect((await rt.sweep(new Date("2026-11-14T10:08:00Z")))?.toISOString()).toBe("2026-11-14T10:30:00.000Z");
  });

  it("refuses to write a GitHub secret without a sealer, before any request", async () => {
    const { source } = parts();
    const session = new SessionVault();
    session.set(GITHUB_CONNECTION, "made-up-token");
    const { calls, fetchMock } = makeFetch();
    const rt = await createPortableRuntime(source, { session, fetch: fetchMock });
    const err = await rt.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostCapabilityError);
    expect((err as HostCapabilityError).capability).toBe("seal");
    expect(String((err as Error).message)).not.toContain(PLAINTEXT);
    expect(calls).toEqual([]);
    await expect(rt.github.seal("made-up-public-key", PLAINTEXT)).rejects.toBeInstanceOf(HostCapabilityError);
    expect(calls).toEqual([]);
  });

  it("sends a GitHub secret sealed when a sealer is injected", async () => {
    const { source } = parts();
    const session = new SessionVault();
    session.set(GITHUB_CONNECTION, "made-up-token");
    const { calls, fetchMock } = makeFetch();
    const seal = vi.fn<SecretSealer>(async () => SEALED);
    const rt = await createPortableRuntime(source, { session, fetch: fetchMock, seal });
    expect(await rt.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT))).toBe("created");
    expect(seal).toHaveBeenCalledExactlyOnceWith("made-up-public-key", PLAINTEXT);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ encrypted_value: SEALED, key_id: "key-1" });
    expect(put.body).not.toContain(PLAINTEXT);
    expect(calls.every((c) => c.auth === "Bearer made-up-token")).toBe(true);
  });

  it("seals with the default the embedder hands in when nothing is injected, and an injected sealer comes first", async () => {
    const { source } = parts();
    const session = new SessionVault();
    session.set(GITHUB_CONNECTION, "made-up-token");
    const { fetchMock } = makeFetch();
    const fromDefaults = vi.fn<SecretSealer>(async () => SEALED);
    const injected = vi.fn<SecretSealer>(async () => SEALED);
    const withDefault = await createPortableRuntime(source, { session, fetch: fetchMock, githubDefaults: { seal: fromDefaults } });
    await withDefault.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT));
    expect(fromDefaults).toHaveBeenCalledOnce();
    const both = await createPortableRuntime(parts().source, { session, fetch: fetchMock, githubDefaults: { seal: fromDefaults }, seal: injected });
    await both.github.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT));
    expect(injected).toHaveBeenCalledOnce();
    expect(fromDefaults).toHaveBeenCalledOnce();
  });

  it("signs the GitHub App token with the injected signer without reading the private key, and refuses without any signer before the key is read", async () => {
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const { calls, fetchMock } = makeFetch();
    const rt = await createPortableRuntime(parts(APP_CONFIG).source, { sign, fetch: fetchMock });
    const readKey = vi.spyOn(rt.connections, "token");
    await rt.github.getRepo("acme", "acme-app");
    expect(sign).toHaveBeenCalledOnce();
    expect(calls[0]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.made-up-signature$/);
    expect(readKey).not.toHaveBeenCalled();
    expect(await githubAppUsable(rt)).toBe(true);

    const bare = await createPortableRuntime(parts(APP_CONFIG).source, { fetch: fetchMock });
    const readBare = vi.spyOn(bare.connections, "token");
    const err = await bare.github.getRepo("acme", "acme-app").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostCapabilityError);
    expect((err as HostCapabilityError).capability).toBe("sign");
    expect(readBare).not.toHaveBeenCalled();
    expect(await githubAppUsable(bare)).toBe(false);
  });

  it("signs with the default `signWithKey` of the embedder, reading the key from the connection", async () => {
    const session = new SessionVault();
    session.set(GITHUB_APP_KEY_CONNECTION, "made-up-private-key");
    const { fetchMock } = makeFetch();
    const signer = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const signWithKey = vi.fn((key: SecretValue) => {
      expect(key.reveal()).toBe("made-up-private-key");
      return signer;
    });
    const rt = await createPortableRuntime(parts(APP_CONFIG).source, { session, fetch: fetchMock, githubDefaults: { signWithKey } });
    await rt.github.getRepo("acme", "acme-app");
    expect(signWithKey).toHaveBeenCalledOnce();
    expect(signer).toHaveBeenCalledOnce();
  });

  it("automation is the port that offers nothing: no recipe, no browser provider, idle, and running anything is refused", async () => {
    const { source } = parts();
    const rt = await createPortableRuntime(source, {});
    expect(rt.automation).toBe(noAutomation);
    expect(rt.automation.enabled).toBe(false);
    expect(rt.automation.recipes).toEqual([]);
    expect(rt.automation.recipe("any")).toBeUndefined();
    expect(rt.automation.isBrowserProvider(rt.providers.get("manual"))).toBe(false);
    expect(rt.automation.state("hmac-acme-app")).toMatchObject({ secretId: "hmac-acme-app", status: "idle", text: "" });
    expect(rt.automation.info()).toMatchObject({ enabled: false, recipes: [], runs: [] });
    expect(await rt.automation.status()).toMatchObject({ enabled: false });
    expect(rt.automation.isBusy()).toBe(false);
    const provider = {} as never;
    await expect(rt.automation.run("hmac-acme-app", provider, async () => 1)).rejects.toBeInstanceOf(AutomationUnavailableError);
    expect(() => rt.automation.begin("k", "p", { text: "t" })).toThrow(AutomationUnavailableError);
    expect(() => rt.automation.cancel("k")).toThrow(AutomationUnavailableError);
    expect(() => rt.automation.newDriver()).toThrow(AutomationUnavailableError);
    expect(() => rt.automation.newDriver()).toThrow("Browser automation is not available in this runtime.");
  });

  it("uses the providers it is given (a registry, or a function that makes one), with the manual providers of the inventory on top", async () => {
    const mine = new ProviderRegistry().register({ id: "mine", label: "Mine", kind: "manual" });
    const rt = await createPortableRuntime(parts().source, { providers: mine });
    expect(rt.providers).toBe(mine);
    expect(rt.providers.list().map((p) => p.id)).toEqual(["mine", "acme-portal"]);
    const make = vi.fn(() => new ProviderRegistry().register({ id: "made", label: "Made", kind: "manual" }));
    const viaFunction = await createPortableRuntime(parts().source, { providers: make });
    expect(make).toHaveBeenCalledOnce();
    expect(viaFunction.providers.list().map((p) => p.id)).toEqual(["made", "acme-portal"]);
  });

  it("builds the automation with a factory that gets the providers the builder made, and keeps its type", async () => {
    const seen: PortableAutomationContext[] = [];
    const port: AutomationPort & { extra: string } = { ...noAutomation, extra: "kept", enabled: true };
    const rt = await createPortableRuntime(parts().source, {
      host: { label: "t" },
      automation: async (context) => {
        seen.push(context);
        context.providers.register({ id: "browser-provider", label: "B", kind: "manual" });
        return port;
      },
    });
    expect(rt.automation.extra).toBe("kept");
    expect(rt.automation).toBe(port);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.providers).toBe(rt.providers);
    expect(seen[0]!.inventory).toBe(rt.inventory);
    expect(seen[0]!.evidence).toBe(rt.evidence);
    expect(seen[0]!.config).toBe(rt.config);
    expect(seen[0]!.host).toBe(rt.host);
    expect(seen[0]!.now).toBe(rt.now);
    expect(rt.providers.get("browser-provider")).toBeDefined();
    // A factory that does not wait is fine too.
    const sync = await createPortableRuntime(parts().source, { automation: () => port });
    expect(sync.automation).toBe(port);
  });

  it("opens the default vault through the host, with the paths expanded by the host's home folder, and never without a host", async () => {
    const config = `${CONFIG}vault: { enabled: true, file: "~/made-up/vault.json", keyFile: "~/made-up/vault.key" }\n`;
    const vault = new Vault({ store: new MemoryVaultStore(), keySource: { label: "t", key: async () => new Uint8Array(32) } });
    const openVault = vi.fn(() => vault);
    const host: RuntimeHost = { label: "t", homeDir: () => "/home/made-up", openVault };
    const rt = await createPortableRuntime(parts(config).source, { host });
    expect(openVault).toHaveBeenCalledExactlyOnceWith({ file: "/home/made-up/made-up/vault.json", keyFile: "/home/made-up/made-up/vault.key" });
    expect(rt.connections.vault).toBe(vault);
    expect(rt.host).toBe(host);
    // An explicit vault, or `null`, wins over the host.
    const own = new Vault({ store: new MemoryVaultStore(), keySource: { label: "t", key: async () => new Uint8Array(32) } });
    expect((await createPortableRuntime(parts(config).source, { host, vault: own })).connections.vault).toBe(own);
    expect((await createPortableRuntime(parts(config).source, { host, vault: null })).connections.vault).toBeUndefined();
    expect(openVault).toHaveBeenCalledOnce();
    // Without a host there is no default vault.
    expect((await createPortableRuntime(parts(config).source, {})).connections.vault).toBeUndefined();
    // A `~` path without a home folder is refused where the runtime is built.
    await expect(createPortableRuntime(parts(config).source, { host: { label: "t", openVault } })).rejects.toBeInstanceOf(HostCapabilityError);
    // A vault file without `~` and without keyFile is passed as it is.
    const plain = `${CONFIG}vault: { enabled: true, file: /abs/vault.json }\n`;
    await createPortableRuntime(parts(plain).source, { host: { label: "t", openVault } });
    expect(openVault).toHaveBeenLastCalledWith({ file: "/abs/vault.json" });
    // The vault switched off in the configuration: the host is not asked.
    const off = `${CONFIG}vault: { enabled: false }\n`;
    await createPortableRuntime(parts(off).source, { host: { label: "t", openVault } });
    expect(openVault).toHaveBeenCalledTimes(2);
  });

  it("reads the team token from the environment of the host, by name, and never without a host", async () => {
    const env = vi.fn((name: string) => (name === "SECRET_DESK_TEAM_TOKEN" ? "made-up-team-token" : undefined));
    const rt = await createPortableRuntime(parts().source, { host: { label: "t", env } });
    expect((await rt.connections.token("team-sync")).reveal()).toBe("made-up-team-token");
    const none = await createPortableRuntime(parts().source, {});
    await expect(none.connections.token("team-sync")).rejects.toThrow();
    // A source of the configuration is not overwritten.
    const own = `${CONFIG}connections:\n  team-sync: { type: env, name: OTHER_NAME }\n`;
    const kept = await createPortableRuntime(parts(own).source, { host: { label: "t", env: (name) => (name === "OTHER_NAME" ? "made-up-other" : "made-up-team-token") } });
    expect((await kept.connections.token("team-sync")).reveal()).toBe("made-up-other");
  });

  it("watches the inventory only when asked", async () => {
    const quiet = parts().source;
    const spyQuiet = vi.spyOn(quiet.inventory, "watch");
    await createPortableRuntime(quiet, {});
    expect(spyQuiet).not.toHaveBeenCalled();
    const loud = parts().source;
    const spyLoud = vi.spyOn(loud.inventory, "watch");
    await createPortableRuntime(loud, { watchInventory: true });
    expect(spyLoud).toHaveBeenCalledOnce();
  });

  it("rejects an invalid authorisation time limit, here and by the helper", async () => {
    for (const bad of [0, Number.NaN, 1.5, 2147483648, "10" as unknown as number]) {
      await expect(createPortableRuntime(parts().source, { authorizeTimeoutMs: bad })).rejects.toThrow(/authorizeTimeoutMs/);
      expect(() => assertAuthorizeTimeout(bad)).toThrow(/authorizeTimeoutMs/);
    }
    expect(() => assertAuthorizeTimeout(undefined)).not.toThrow();
    expect(() => assertAuthorizeTimeout(1)).not.toThrow();
    expect(() => assertAuthorizeTimeout(2147483647)).not.toThrow();
  });

  it("two runtimes share no state", async () => {
    const a = await createPortableRuntime(parts().source, {});
    const b = await createPortableRuntime(parts().source, {});
    expect(a.instance).not.toBe(b.instance);
    expect(a.approvals).not.toBe(b.approvals);
    expect(a.issuances).not.toBe(b.issuances);
    expect(a.teamSyncMemo).not.toBe(b.teamSyncMemo);
    expect(a.automation).toBe(b.automation); // the one port that holds nothing
  });

  it("issuanceDeps carries what the core's issuance functions need", async () => {
    const rt = await createPortableRuntime(parts().source, {});
    const deps = issuanceDeps(rt);
    expect(deps).toMatchObject({ inventory: rt.inventory, github: rt.github, workers: rt.workers, providers: rt.providers, connections: rt.connections, owner: "acme", fetch: rt.fetch, evidence: rt.evidence, now: rt.now });
    expect(deps.providerConfig).toBe(rt.config.providers);
  });

  it("builds its GitHub client from the class it is given, so what that class defines is found first", async () => {
    const plain = await createPortableRuntime(parts().source, {});
    expect(plain.github).toBeInstanceOf(GitHubClient);
    class FacadeClient extends GitHubClient {
      override async getRepo(): Promise<never> {
        return { private: true } as never;
      }
    }
    const rt = await createPortableRuntime(parts().source, { githubClientClass: FacadeClient });
    expect(rt.github).toBeInstanceOf(FacadeClient);
    expect(await rt.github.getRepo("acme", "acme-app")).toEqual({ private: true });
  });

  it("uses the global fetch when none is given", async () => {
    const rt = await createPortableRuntime(parts().source, {});
    expect(rt.fetch).toBe(fetch);
  });
});
