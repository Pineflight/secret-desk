import { createVerify, generateKeyPairSync } from "node:crypto";
import { SecretValue, type AppJwtSigner, type SecretSealer } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import * as nodeCrypto from "../src/github-crypto.js";
import { NODE_GITHUB_DEFAULTS, assertCanSeal, createAppTokenProvider, createGitHubClient, withNodeDefaults } from "../src/github-crypto.js";
import * as coreCrypto from "../src/github-crypto-core.js";
import { HostCapabilityError } from "../src/host-core.js";

// The wrapper for the Node edition: same names as before, plus the Node defaults when a host exists. The behaviour of whole runtimes is
// in `github-crypto.test.ts`; this file looks at the pieces. Keys and values are made up (a key pair made for this test run).
const host = { label: "t" };
const target = { owner: "acme", repo: "acme-app", scope: "repository" } as const;

describe("the Node defaults", () => {
  it("seal with libsodium: a sealed box that the owner of the key pair can open", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const sealed = await NODE_GITHUB_DEFAULTS.seal!(sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL), "made-up-plaintext-value");
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), pair.publicKey, pair.privateKey);
    expect(sodium.to_string(opened)).toBe("made-up-plaintext-value");
  });

  it("sign with the Node crypto module: RSA-SHA256, base64url, valid for the key's public half, and the key is read only when it signs", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const reveal = vi.fn(() => pem);
    const key = { reveal } as unknown as SecretValue;
    const signer = NODE_GITHUB_DEFAULTS.signWithKey!(key);
    expect(reveal).not.toHaveBeenCalled();
    const signature = await signer("made-up.signing-input");
    expect(reveal).toHaveBeenCalledOnce();
    expect(signature).toMatch(/^[\w-]+$/);
    expect(createVerify("RSA-SHA256").update("made-up.signing-input").verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(NODE_GITHUB_DEFAULTS)).toBe(true);
  });
});

describe("withNodeDefaults", () => {
  it("is a live view of the crypto description, with the defaults only while it has a host", () => {
    const crypto: nodeCrypto.GitHubCrypto = {};
    const view = withNodeDefaults(crypto);
    expect(view.host).toBeUndefined();
    expect(view.defaults).toBeUndefined();
    const seal: SecretSealer = async () => "x";
    const sign: AppJwtSigner = async () => "y";
    Object.assign(crypto, { host, seal, sign });
    expect(view.host).toBe(host);
    expect(view.seal).toBe(seal);
    expect(view.sign).toBe(sign);
    expect(view.defaults).toBe(NODE_GITHUB_DEFAULTS);
  });
});

describe("the wrapper functions", () => {
  it("assertCanSeal: refused without a sealer and without a host, allowed with either", () => {
    expect(() => assertCanSeal({})).toThrow(HostCapabilityError);
    expect(() => assertCanSeal({ host })).not.toThrow();
    expect(() => assertCanSeal({ seal: async () => "x" })).not.toThrow();
  });

  it("createGitHubClient: no host and no sealer cannot seal, a host seals with the default of the Node edition, an injected sealer comes first", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: "made-up-public-key" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const options = { auth: async () => new SecretValue("made-up-token"), fetch: fetchMock };
    const bare = createGitHubClient({}, options);
    await expect(bare.putSecret(target, "X", new SecretValue("made-up-plaintext-value"))).rejects.toBeInstanceOf(HostCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
    const injected = vi.fn<SecretSealer>(async () => "bWFkZQ==");
    const first = createGitHubClient({ host, seal: injected }, options);
    await first.putSecret(target, "X", new SecretValue("made-up-plaintext-value"));
    expect(injected).toHaveBeenCalledOnce();
    // The default of the Node edition is libsodium: a made-up public key is not a key, so it fails there, and not with the capability error.
    const err = await createGitHubClient({ host }, options).putSecret(target, "X", new SecretValue("made-up-plaintext-value")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HostCapabilityError);
    expect(err).toBeInstanceOf(Error);
  });

  it("createAppTokenProvider: an injected signer never reads the key; a host signs with the key, once; no host refuses before the key is read", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/app/installations?")) return new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ token: "made-up-installation-token", expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" }, repositories: [] }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const options = { appId: "123", owner: "acme", permissions: { secrets: "write", environments: "read", metadata: "read" }, fetch: fetchMock } as const;
    const getKey = vi.fn(async () => new SecretValue("made-up-key"));
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    expect((await createAppTokenProvider({ sign }, options, getKey)()).reveal()).toBe("made-up-installation-token");
    expect(getKey).not.toHaveBeenCalled();
    const bare = createAppTokenProvider({}, options, getKey);
    await expect(bare()).rejects.toBeInstanceOf(HostCapabilityError);
    expect(getKey).not.toHaveBeenCalled();
    // With a host the made-up key is read and handed to the Node signer, which cannot use it (it is not a PEM): the key path was taken.
    await expect(createAppTokenProvider({ host }, options, getKey)()).rejects.not.toBeInstanceOf(HostCapabilityError);
    expect(getKey).toHaveBeenCalledOnce();
  });

  it("re-exports the status helpers of the core module, not copies", () => {
    expect(nodeCrypto.githubAppKeyStatus).toBe(coreCrypto.githubAppKeyStatus);
    expect(nodeCrypto.githubAppUsable).toBe(coreCrypto.githubAppUsable);
  });
});

describe("the core module on its own", () => {
  it("the token provider asks for the key once and reuses the signer it built", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/app/installations?")) return new Response(JSON.stringify([{ id: 7, account: { login: "acme" } }]), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ token: "made-up-installation-token", expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "read" }, repositories: [] }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const signer = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const signWithKey = vi.fn(() => signer);
    const getKey = vi.fn(async () => new SecretValue("made-up-key"));
    const provider = coreCrypto.createAppTokenProvider({ defaults: { signWithKey } }, { appId: "123", owner: "acme", permissions: { secrets: "write" }, fetch: fetchMock }, getKey);
    await provider();
    await provider();
    expect(getKey).toHaveBeenCalledOnce();
    expect(signWithKey).toHaveBeenCalledOnce();
  });

  it("the portable createGitHubClient builds the portable client: no sealer and no default refuses before any request, an injected one is used", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: "made-up-public-key" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const options = { auth: async () => new SecretValue("made-up-token"), fetch: fetchMock };
    await expect(coreCrypto.createGitHubClient({}, options).putSecret(target, "X", new SecretValue("made-up-plaintext-value"))).rejects.toBeInstanceOf(HostCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
    const seal = vi.fn<SecretSealer>(async () => "bWFkZQ==");
    expect(await coreCrypto.createGitHubClient({ seal }, options).putSecret(target, "X", new SecretValue("made-up-plaintext-value"))).toBe("created");
    expect(seal).toHaveBeenCalledOnce();
  });

  it("a default sealer counts as the capability to seal; an empty description does not", () => {
    expect(() => coreCrypto.assertCanSeal({ defaults: { seal: async () => "x" } })).not.toThrow();
    expect(() => coreCrypto.assertCanSeal({ defaults: {} })).toThrow(HostCapabilityError);
    expect(() => coreCrypto.assertCanSeal({ host })).toThrow(HostCapabilityError); // a host alone brings no way to seal: the wrapper adds the default
  });
});
