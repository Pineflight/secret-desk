import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, githubAppProvider, patProvider, sealForGitHub } from "../src/github.js";
import { SecretValue } from "../src/secret.js";

describe("sealForGitHub", () => {
  it("is readable again with the private key (sealed box)", async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = await sealForGitHub(pub, "mein-token-123");
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    expect(sodium.to_string(opened)).toBe("mein-token-123");
    expect(sealed).not.toContain("mein-token");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHubClient", () => {
  it("fetches the key, encrypts and writes into the environment", async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), ...(init?.body ? { body: String(init.body) } : {}) });
      if (String(url).endsWith("/public-key")) return jsonResponse({ key_id: "k1", key: pub });
      return new Response(null, { status: 201 });
    });
    const gh = new GitHubClient({ auth: patProvider(new SecretValue("ghp_test")), fetch: fetchMock as unknown as typeof fetch });
    const out = await gh.putSecret({ owner: "acme", repo: "acme-app", scope: "environment", environment: "staging" }, "X_TOKEN", new SecretValue("klartext-wert"));
    expect(out).toBe("created");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/acme-app/environments/staging/secrets/public-key");
    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.body).not.toContain("klartext-wert");
    const parsed = JSON.parse(put.body!) as { encrypted_value: string; key_id: string };
    expect(parsed.key_id).toBe("k1");
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(parsed.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey);
    expect(sodium.to_string(opened)).toBe("klartext-wert");
  });
  it("error messages contain no value and no token", async () => {
    const gh = new GitHubClient({
      auth: patProvider(new SecretValue("ghp_token_geheim")),
      fetch: (async () => jsonResponse({ message: "Not Found" }, 404)) as unknown as typeof fetch,
    });
    const err = await gh.listSecrets({ owner: "o", repo: "r", scope: "repository" }).catch((e: Error) => e);
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).not.toContain("ghp_token_geheim");
  });
  it("reads secrets as names and timestamps only", async () => {
    const gh = new GitHubClient({
      auth: patProvider(new SecretValue("t")),
      fetch: (async () => jsonResponse({ secrets: [{ name: "A", created_at: "c", updated_at: "u" }] })) as unknown as typeof fetch,
    });
    expect(await gh.listSecrets({ owner: "o", repo: "r", scope: "repository" })).toEqual([{ name: "A", createdAt: "c", updatedAt: "u" }]);
  });
});

describe("githubAppProvider", () => {
  it("creates an installation token, restricted to repos, and caches it", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/app/installations?")) return jsonResponse([{ id: 7, account: { login: "acme" } }]);
      bodies.push(String(init?.body));
      return jsonResponse({ token: "ghs_installationstoken", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    });
    const provider = githubAppProvider({ appId: "123", privateKey: new SecretValue(privateKey), owner: "acme", repositories: ["acme-app"], permissions: { secrets: "write" }, fetch: fetchMock as unknown as typeof fetch });
    const t1 = await provider();
    const t2 = await provider();
    expect(t1.reveal()).toBe("ghs_installationstoken");
    expect(t2).toBe(t1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(bodies[0]!)).toEqual({ repositories: ["acme-app"], permissions: { secrets: "write" } });
  });
});
