import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, githubAppProvider, patProvider, type AppJwtSigner, type SecretSealer } from "../src/github.js";
import { SecretValue } from "../src/secret.js";

const libsodiumModule = vi.hoisted(() => ({ loaded: false }));
vi.mock("../src/github-seal-libsodium.js", () => {
  libsodiumModule.loaded = true;
  throw new Error("libsodium module must not be loaded when a sealer is injected");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const target = { owner: "acme", repo: "acme-app", scope: "repository" } as const;
const PLAINTEXT = "made-up-plaintext-value";

function sealerSetup(seal: SecretSealer) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), ...(init?.body ? { body: String(init.body) } : {}) });
    if (String(url).endsWith("/public-key")) return jsonResponse({ key_id: "key-1", key: "made-up-public-key" });
    return new Response(null, { status: 201 });
  };
  const gh = new GitHubClient({ auth: patProvider(new SecretValue("made-up-token")), fetch: fetchMock as unknown as typeof fetch, seal });
  return { gh, calls };
}

describe("injected secret sealer", () => {
  it("is called with the public key from the API and the plaintext, its output is sent as returned, and libsodium is never loaded", async () => {
    const seal = vi.fn<SecretSealer>(async () => "bWFkZS11cC1zZWFsZWQtb3V0cHV0");
    const { gh, calls } = sealerSetup(seal);
    expect(await gh.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT))).toBe("created");
    expect(seal).toHaveBeenCalledExactlyOnceWith("made-up-public-key", PLAINTEXT);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ encrypted_value: "bWFkZS11cC1zZWFsZWQtb3V0cHV0", key_id: "key-1" });
    expect(calls[1]!.body).not.toContain(PLAINTEXT);
    expect(libsodiumModule.loaded).toBe(false);
  });

  it("a rejecting sealer rejects the write with its own error, writes nothing and leaks no plaintext", async () => {
    const { gh, calls } = sealerSetup(async () => {
      throw new Error("sealer unavailable");
    });
    const err = await gh.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("sealer unavailable");
    expect((err as Error).message).not.toContain(PLAINTEXT);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(libsodiumModule.loaded).toBe(false);
  });

  it("rejects the plaintext itself and its Base64 even when both pass the alphabet check", async () => {
    const plain = "madeupvalue";
    const plainBase64 = Buffer.from(plain, "utf8").toString("base64");
    for (const shape of [plain, plainBase64]) {
      const { gh, calls } = sealerSetup(async () => shape);
      const err = await gh.putSecret(target, "X_NAME", new SecretValue(plain)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as Error).message).not.toContain(plain);
      expect((err as Error).message).not.toContain(plainBase64);
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });

  it("the public seal method uses the injected sealer and never loads libsodium", async () => {
    const { gh } = sealerSetup(async () => "c2VhbGVkLWJ5LWNsaWVudA==");
    expect(await gh.seal("made-up-public-key", PLAINTEXT)).toBe("c2VhbGVkLWJ5LWNsaWVudA==");
    expect(libsodiumModule.loaded).toBe(false);
  });

  it("rejects a sealer result of the wrong shape before anything is sent, without echoing value or output", async () => {
    const plainBase64 = Buffer.from(PLAINTEXT, "utf8").toString("base64");
    const shapes: unknown[] = ["", 42, null, "not base64 !!", "abc=def", "abc===", PLAINTEXT, plainBase64];
    for (const shape of shapes) {
      const { gh, calls } = sealerSetup((async () => shape) as unknown as SecretSealer);
      const err = await gh.putSecret(target, "X_NAME", new SecretValue(PLAINTEXT)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubError);
      const message = (err as Error).message;
      expect(message).toBe("GitHub: Der Verschluesseler hat kein gueltiges Ergebnis geliefert: nichts wurde gesendet");
      expect(message).not.toContain(PLAINTEXT);
      expect(message).not.toContain(plainBase64);
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });
});

describe("injected App JWT signer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const NOW = new Date("2026-03-01T10:00:00Z");

  function setup(over: object) {
    const bearers: string[] = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      bearers.push(String((init?.headers as Record<string, string>).Authorization));
      if (String(url).includes("/app/installations?")) return jsonResponse([{ id: 7, account: { login: "acme" } }]);
      return jsonResponse({ token: "made-up-installation-token", expires_at: "2026-03-01T11:00:00Z" }, 201);
    };
    const provider = githubAppProvider({ appId: "123", owner: "acme", now: () => NOW, fetch: fetchMock as unknown as typeof fetch, ...over });
    return { provider, bearers };
  }

  it("produces the same JWT as the in-process key and a valid RS256 signature", async () => {
    const inputs: string[] = [];
    const sign: AppJwtSigner = async (input) => {
      inputs.push(input);
      return createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
    };
    const viaKey = setup({ privateKey: new SecretValue(privateKey) });
    const viaSigner = setup({ sign });
    expect((await viaKey.provider()).reveal()).toBe("made-up-installation-token");
    expect((await viaSigner.provider()).reveal()).toBe("made-up-installation-token");
    expect(viaSigner.bearers).toEqual(viaKey.bearers);
    const jwt = viaSigner.bearers[0]!.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(inputs[0]).toBe(`${header}.${payload}`);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({ iat: 1_772_359_140, exp: 1_772_359_740, iss: "123" });
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("caches the installation token, so the signer is called once", async () => {
    const sign = vi.fn<AppJwtSigner>(async () => "made-up-signature");
    const { provider } = setup({ sign });
    await provider();
    await provider();
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("rejects both-or-neither configuration at construction without naming key material", () => {
    const sign: AppJwtSigner = async () => "made-up-signature";
    const both = () => githubAppProvider({ appId: "1", owner: "acme", privateKey: new SecretValue(privateKey), sign });
    const neither = () => githubAppProvider({ appId: "1", owner: "acme" });
    const nullKey = () => githubAppProvider({ appId: "1", owner: "acme", privateKey: null as never });
    const nullSign = () => githubAppProvider({ appId: "1", owner: "acme", sign: null as never });
    const bothNull = () => githubAppProvider({ appId: "1", owner: "acme", privateKey: null as never, sign: null as never });
    const notAFunction = () => githubAppProvider({ appId: "1", owner: "acme", sign: "not-a-function" as never });
    for (const make of [both, neither, nullKey, nullSign, bothNull, notAFunction]) {
      const err = (() => {
        try {
          make();
        } catch (e) {
          return e as Error;
        }
        return undefined;
      })();
      expect(err?.message).toBe("GitHub App: genau eines von privateKey und sign muss angegeben werden");
      expect(err?.message).not.toContain("PRIVATE KEY");
      expect(err?.message).not.toContain(privateKey.slice(0, 40));
    }
  });

  it("a rejecting signer rejects the token request with its own error and sends nothing to GitHub", async () => {
    const { provider, bearers } = setup({
      sign: async () => {
        throw new Error("signer unavailable");
      },
    });
    const err = await provider().catch((e: unknown) => e);
    expect((err as Error).message).toBe("signer unavailable");
    expect((err as Error).message).not.toContain("PRIVATE KEY");
    expect(bearers).toEqual([]);
  });
});
