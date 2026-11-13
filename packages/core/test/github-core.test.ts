import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as portable from "../src/portable.js";
import { GitHubClient, githubAppProvider, patProvider, type AppJwtSigner, type SecretSealer } from "../src/github.js";
import { GitHubError } from "../src/github-core.js";
import { SecretValue } from "../src/secret.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const target = { owner: "acme", repo: "acme-app", scope: "repository" } as const;
const TEXT = "café \u{1F600} line\nsecond";
const sealer: SecretSealer = async () => "bWFkZS11cC1zZWFsZWQtb3V0cHV0";

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function recorder() {
  const calls: Call[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, headers: { ...(init?.headers as Record<string, string>) }, ...(init?.body ? { body: String(init.body) } : {}) });
    if (u.endsWith("/public-key")) return jsonResponse({ key_id: "key-1", key: "made-up-public-key" });
    if (u.includes("/git/ref/heads/")) return jsonResponse({ object: { sha: "abc123" } });
    if (u.includes("/contents/") && init?.method === "PUT") return jsonResponse({ content: { sha: "new-sha" } }, 201);
    if (u.includes("/contents/")) return jsonResponse({ type: "file", sha: "blob-sha", content: `${Buffer.from(TEXT, "utf8").toString("base64")}\n`, encoding: "base64" });
    return new Response(null, { status: 201 });
  };
  return { calls, fetch: fetchMock as unknown as typeof fetch };
}

async function scenario(make: (fetch: typeof fetch) => { putSecret: GitHubClient["putSecret"]; putContentFile: GitHubClient["putContentFile"]; getContentFile: GitHubClient["getContentFile"]; getBranchHead: GitHubClient["getBranchHead"] }) {
  const { calls, fetch } = recorder();
  const gh = make(fetch);
  const results = [
    await gh.putSecret(target, "X_NAME", new SecretValue("made-up-plaintext-value")),
    await gh.putContentFile("acme", "acme-app", "notes/ü.txt", "main", TEXT, "message", "old-sha"),
    await gh.getContentFile("acme", "acme-app", "notes/ü.txt", "main"),
    await gh.getBranchHead("acme", "acme-app", "main"),
  ];
  return { calls, results };
}

describe("portable GitHub client", () => {
  it("is exported from the portable entry and performs the same requests as the Node facade", async () => {
    const options = (fetch: typeof globalThis.fetch) => ({ auth: patProvider(new SecretValue("made-up-token")), fetch, seal: sealer });
    const viaFacade = await scenario((fetch) => new GitHubClient(options(fetch)));
    const viaPortable = await scenario((fetch) => new portable.GitHubClient(options(fetch)));
    expect(viaPortable.calls).toEqual(viaFacade.calls);
    expect(viaPortable.results).toEqual(viaFacade.results);
    expect(viaPortable.results[2]).toEqual({ sha: "blob-sha", text: TEXT });
    expect(JSON.parse(viaPortable.calls[2]!.body!).content).toBe(Buffer.from(TEXT, "utf8").toString("base64"));
    expect(new GitHubClient(options(fetch))).toBeInstanceOf(portable.GitHubClient);
  });

  it("fails with a clear error when no sealer is injected, and sends nothing but the key request", async () => {
    const { calls, fetch } = recorder();
    const gh = new portable.GitHubClient({ auth: patProvider(new SecretValue("made-up-token")), fetch });
    const err = await gh.putSecret(target, "X_NAME", new SecretValue("made-up-plaintext-value")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).toContain("no sealer configured");
    expect((err as Error).message).not.toContain("made-up-plaintext-value");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    await expect(gh.seal("made-up-public-key", "x")).rejects.toThrow("no sealer configured");
  });
});

describe("portable GitHub App provider", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const NOW = new Date("2026-03-01T10:00:00Z");

  function bearersOf(make: (fetch: typeof globalThis.fetch) => ReturnType<typeof portable.githubAppProvider>) {
    const calls: { method: string; url: string; bearer: string; body?: string }[] = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), bearer: String((init?.headers as Record<string, string>).Authorization), ...(init?.body ? { body: String(init.body) } : {}) });
      if (String(url).includes("/app/installations?")) return jsonResponse([{ id: 7, account: { login: "acme" } }]);
      return jsonResponse({ token: "made-up-installation-token", expires_at: "2026-03-01T11:00:00Z" }, 201);
    };
    return { provider: make(fetchMock as unknown as typeof fetch), calls };
  }

  it("with an injected signer performs the same requests as the facade with a private key", async () => {
    const sign: AppJwtSigner = async (input) => createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
    const viaFacade = bearersOf((fetch) => githubAppProvider({ appId: "123", owner: "acme", now: () => NOW, fetch, privateKey: new SecretValue(privateKey) }));
    const viaPortable = bearersOf((fetch) => portable.githubAppProvider({ appId: "123", owner: "acme", now: () => NOW, fetch, sign }));
    expect((await viaFacade.provider()).reveal()).toBe("made-up-installation-token");
    expect((await viaPortable.provider()).reveal()).toBe("made-up-installation-token");
    expect(viaPortable.calls).toEqual(viaFacade.calls);
    const [header, payload] = viaPortable.calls[0]!.bearer.replace("Bearer ", "").split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({ iat: 1_772_359_140, exp: 1_772_359_740, iss: "123" });
  });

  it("fails at construction with a clear error when no signer is given", () => {
    for (const sign of [undefined, null, "not-a-function"]) {
      const make = () => portable.githubAppProvider({ appId: "1", owner: "acme", sign: sign as never });
      expect(make).toThrow(GitHubError);
      expect(make).toThrow("no signer configured");
    }
  });
});
