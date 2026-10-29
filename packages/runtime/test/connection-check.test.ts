import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { checkConnection, listWriteTargets, tokenPrefixProblem } from "../src/index.js";
import { createRuntime } from "../src/runtime.js";

const TOKEN = "ghp_" + "SUPERSECRETTOKEN1234567890";
const NOW = new Date("2026-11-01T10:00:00Z");

const INVENTORY = `version: 1
secrets:
  - id: stage-secret
    name: STAGE_SECRET
    stage: staging
    service: x
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: environment, environment: staging }
  - id: prod-secret
    name: PROD_SECRET
    stage: production
    service: x
    provider: manual
    expiry: none
    places:
      - { repo: acme-docs, scope: environment, environment: production }
variables:
  - id: app-var
    name: APP_VAR
    stage: shared
    places:
      - { repo: acme-app, scope: repository }
`;

type Handler = (url: string, method: string, headers: Record<string, string>) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;
type Call = { url: string; method: string; headers: Record<string, string>; redirect: RequestRedirect | undefined };

async function setup(handler: Handler, opts: { tokens?: Record<string, string> } = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const calls: Call[] = [];
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, method, headers, redirect: init?.redirect });
    const custom = handler(u, method, headers);
    if (custom) return new Response(custom.body === undefined ? null : JSON.stringify(custom.body), { status: custom.status ?? 200, headers: custom.headers ?? {} });
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k1", key: pub }), { status: 200 });
    if (method === "GET" && /\/(secrets|variables)\?/.test(u)) return new Response(JSON.stringify({ secrets: [], variables: [] }), { status: 200 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-conncheck-"));
  await writeFile(join(dir, "inventory.yaml"), INVENTORY);
  await writeFile(join(dir, "secret-desk.config.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: session } }\n`);
  const rt = await createRuntime(join(dir, "secret-desk.config.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  for (const [id, tok] of Object.entries({ github: TOKEN, ...(opts.tokens ?? {}) })) rt.connections.session.set(id, tok, null);
  return { rt, calls };
}

const ghUser: Handler = (url) => (url === "https://api.github.com/user" ? { body: { login: "niklas" }, headers: { "github-authentication-token-expiration": "2026-12-01 10:00:00 UTC" } } : undefined);
const byId = (r: { checks: { id: string; status: string }[] }) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const leak = (r: unknown, ...vals: string[]) => vals.forEach((v) => expect(JSON.stringify(r)).not.toContain(v));

describe("listWriteTargets", () => {
  it("merges targets from secrets and variables and marks live", async () => {
    const { rt } = await setup(() => undefined);
    const t = listWriteTargets(rt);
    expect(t.map((x) => [x.id, x.live])).toEqual([
      ["environment:acme-docs/production", true],
      ["environment:acme-docs/staging", false],
      ["repository:acme-app", false],
    ]);
  });
});

describe("checkConnection: GitHub", () => {
  it("without deep: sign-in, expiry, public key per target, never a PUT or DELETE", async () => {
    const { rt, calls } = await setup(ghUser);
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(r.ok).toBe(true);
    expect(r.expires).toBe("2026-12-01");
    expect(byId(r)).toMatchObject({ login: "pass", expiry: "pass", "target:environment:acme-docs/staging": "pass", "target:repository:acme-app": "pass" });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/user", redirect: "manual" });
    leak(r, TOKEN);
  });

  it("without expiry header: expires null and hint", async () => {
    const { rt } = await setup((url) => (url === "https://api.github.com/user" ? { body: { login: "n" } } : undefined));
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(r.expires).toBeNull();
    expect(byId(r)["expiry"]).toBe("warn");
  });

  it("401 on login is an error and no targets are queried", async () => {
    const { rt, calls } = await setup((url) => (url === "https://api.github.com/user" ? { status: 401, body: { message: `Bad credentials ${TOKEN}` } } : undefined));
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(r.ok).toBe(false);
    expect(byId(r)["login"]).toBe("fail");
    expect(calls).toHaveLength(1);
    leak(r, TOKEN);
  });

  it("403 Resource not accessible returns the hint about the missing permission", async () => {
    const { rt } = await setup((url) => (url.endsWith("/public-key") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : ghUser(url, "GET", {})));
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.id === "target:repository:acme-app");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toMatch(/Read and write/);
  });

  it("deep writes only to the chosen targets: PUT then DELETE, secret and variable", async () => {
    const { rt, calls } = await setup(ghUser);
    const r = await checkConnection(rt, "github", { deep: true, targets: ["environment:acme-docs/staging"] }, NOW);
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(byId(r)).toMatchObject({ "write-secret:environment:acme-docs/staging": "pass", "write-variable:environment:acme-docs/staging": "pass" });
    const writes = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`);
    expect(writes).toEqual([
      "PUT /repos/acme/acme-docs/environments/staging/secrets/SD_WRITE_PROBE",
      "DELETE /repos/acme/acme-docs/environments/staging/secrets/SD_WRITE_PROBE",
      "PATCH /repos/acme/acme-docs/environments/staging/variables/SD_WRITE_PROBE_VAR",
      "DELETE /repos/acme/acme-docs/environments/staging/variables/SD_WRITE_PROBE_VAR",
    ]);
    expect(writes.join()).not.toContain("production");
    leak(r, TOKEN);
  });

  it("deep without targets or without deep writes nothing; unknown target is skipped", async () => {
    const { rt, calls } = await setup(ghUser);
    await checkConnection(rt, "github", { deep: true, targets: [] }, NOW);
    await checkConnection(rt, "github", { targets: ["repository:acme-app"] }, NOW);
    const r = await checkConnection(rt, "github", { deep: true, targets: ["repository:fremd"] }, NOW);
    expect(byId(r)["write:repository:fremd"]).toBe("warn");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("error on DELETE is reported and names the name to clean up", async () => {
    const { rt } = await setup((url, method) => (method === "DELETE" && url.endsWith("/secrets/SD_WRITE_PROBE") ? { status: 500, body: { message: "boom" } } : ghUser(url, method, {})));
    const r = await checkConnection(rt, "github", { deep: true, targets: ["repository:acme-app"] }, NOW);
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.id === "write-secret:repository:acme-app");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toContain("SD_WRITE_PROBE");
    expect(c?.detail).toMatch(/von Hand/);
  });

  it("403 on write: hint about missing permission, the variable is still checked", async () => {
    const { rt } = await setup((url, method) => (method === "PUT" ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : ghUser(url, method, {})));
    const r = await checkConnection(rt, "github", { deep: true, targets: ["repository:acme-app"] }, NOW);
    expect(byId(r)).toMatchObject({ "write-secret:repository:acme-app": "fail", "write-variable:repository:acme-app": "pass" });
    expect(r.checks.find((x) => x.id === "write-secret:repository:acme-app")?.detail).toMatch(/Secrets/);
  });

  it("an existing SD_WRITE_PROBE is not overwritten", async () => {
    const { rt, calls } = await setup((url, method) => (method === "GET" && /acme-app\/actions\/secrets\?/.test(url) ? { body: { secrets: [{ name: "SD_WRITE_PROBE", created_at: "x", updated_at: "x" }] } } : ghUser(url, method, {})));
    const r = await checkConnection(rt, "github", { deep: true, targets: ["repository:acme-app"] }, NOW);
    expect(byId(r)["write-secret:repository:acme-app"]).toBe("warn");
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/secrets/"))).toBe(false);
  });

  it("not connected: fail, no call", async () => {
    const { rt, calls } = await setup(ghUser);
    rt.connections.session.delete("github");
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(r).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("unknown connection throws", async () => {
    const { rt } = await setup(ghUser);
    await expect(checkConnection(rt, "gibt-es-nicht")).rejects.toThrow(/Unbekannte Verbindung/);
  });
});

describe("checkConnection: provider", () => {
  const tok = (id: string, value: string) => ({ tokens: { [id]: value } });

  it("cloudflare: active with expiry in 3 days -> pass/warn; expiry later than 7 days -> recommendation", async () => {
    const mk = (expires: string): Handler => (url) => (url.endsWith("/user/tokens/verify") ? { body: { success: true, result: { status: "active", expires_on: expires } } } : undefined);
    const soon = await setup(mk("2026-11-04T00:00:00Z"), tok("cloudflare", "cf-secret-token-123"));
    const a = await checkConnection(soon.rt, "cloudflare", {}, NOW);
    expect(a.expires).toBe("2026-11-04");
    expect(byId(a)).toMatchObject({ token: "pass", expiry: "warn" });
    const late = await setup(mk("2026-12-30T00:00:00Z"), tok("cloudflare", "cf-secret-token-123"));
    const b = await checkConnection(late.rt, "cloudflare", {}, NOW);
    expect(byId(b)["expiry"]).toBe("warn");
    expect(b.checks.find((c) => c.id === "expiry")?.detail).toMatch(/Empfohlen/);
    expect(late.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
    leak(b, "cf-secret-token-123");
  });

  it("cloudflare 401 -> fail, cloudflare-turnstile uses the same endpoint", async () => {
    const { rt, calls } = await setup(() => ({ status: 401, body: { success: false } }), { tokens: { cloudflare: "cf-x-1234567", "cloudflare-turnstile": "cf-t-1234567" } });
    expect((await checkConnection(rt, "cloudflare", {}, NOW)).ok).toBe(false);
    expect((await checkConnection(rt, "cloudflare-turnstile", {}, NOW)).ok).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(Array(2).fill("https://api.cloudflare.com/client/v4/user/tokens/verify"));
  });

  it("supabase: 200 pass, 401 and 403 fail with own text", async () => {
    for (const [status, ok, re] of [[200, true, /lesen/], [401, false, /ungueltig/], [403, false, /Rechte/]] as const) {
      const { rt, calls } = await setup(() => ({ status, body: [] }), tok("supabase", "sbp_secretsecret123"));
      const r = await checkConnection(rt, "supabase", {}, NOW);
      expect(r.ok).toBe(ok);
      expect(r.checks[0]!.detail).toMatch(re);
      expect(calls[0]!.url).toBe("https://api.supabase.com/v1/organizations");
      leak(r, "sbp_secretsecret123");
    }
  });

  it("stripe: 200 pass with mode, 403 is only a hint, wrong prefix is an error", async () => {
    const live = await setup(() => ({ body: { object: "balance" } }), tok("stripe", "rk_live_abcdefghijklmnop"));
    const a = await checkConnection(live.rt, "stripe", {}, NOW);
    expect(a.ok).toBe(true);
    expect(a.checks.find((c) => c.id === "mode")?.detail).toBe("Live");
    expect(live.calls[0]!.url).toBe("https://api.stripe.com/v1/balance");
    const restricted = await setup(() => ({ status: 403, body: { error: {} } }), tok("stripe-test", "rk_test_abcdefghijklmnop"));
    const b = await checkConnection(restricted.rt, "stripe-test", {}, NOW);
    expect(b.ok).toBe(true);
    expect(byId(b)).toMatchObject({ token: "info", mode: "info" });
    const wrong = await setup(() => ({ body: {} }), tok("stripe-test", "rk_live_abcdefghijklmnop"));
    const c = await checkConnection(wrong.rt, "stripe-test", {}, NOW);
    expect(c.ok).toBe(false);
    expect(byId(c)["mode-match"]).toBe("fail");
    leak(c, "rk_live_abcdefghijklmnop");
    const bad = await setup(() => ({ status: 401, body: {} }), tok("stripe", "rk_test_abcdefghijklmnop"));
    expect((await checkConnection(bad.rt, "stripe", {}, NOW)).ok).toBe(false);
  });

  it("resend: 200 pass, 401 and 403 require full access", async () => {
    const ok = await setup(() => ({ body: { data: [] } }), tok("resend", "re_secretsecret123"));
    expect((await checkConnection(ok.rt, "resend", {}, NOW)).ok).toBe(true);
    expect(ok.calls[0]!.url).toBe("https://api.resend.com/api-keys");
    for (const status of [401, 403]) {
      const bad = await setup(() => ({ status, body: { message: "restricted re_secretsecret123" } }), tok("resend", "re_secretsecret123"));
      const r = await checkConnection(bad.rt, "resend", {}, NOW);
      expect(r.ok).toBe(false);
      expect(r.checks[0]!.detail).toMatch(/Full access/);
      leak(r, "re_secretsecret123");
    }
  });

  it("grafana: not checkable, hint only, no call", async () => {
    const { rt, calls } = await setup(() => undefined, tok("grafana", "glsa_secret1234567"));
    const r = await checkConnection(rt, "grafana", {}, NOW);
    expect(r.ok).toBe(true);
    expect(r.checks[0]!.status).toBe("info");
    expect(calls).toHaveLength(0);
  });

  it("network errors and timeout are reported sanitized", async () => {
    const { rt } = await setup(() => {
      throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
    }, tok("supabase", "sbp_secretsecret123"));
    const r = await checkConnection(rt, "supabase", {}, NOW);
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.id).toBe("request");
    leak(r, "sbp_secretsecret123");
  });
});

describe("tokenPrefixProblem", () => {
  it("reports real contradictions only", () => {
    expect(tokenPrefixProblem("stripe-test", "rk_live_x")).toMatch(/Live-Schluessel/);
    expect(tokenPrefixProblem("stripe-live", "sk_test_x")).toMatch(/Sandbox-Schluessel/);
    expect(tokenPrefixProblem("stripe-test", "rk_test_x")).toBeUndefined();
    expect(tokenPrefixProblem("stripe-live", "rk_live_x")).toBeUndefined();
    expect(tokenPrefixProblem("stripe", "rk_live_x")).toBeUndefined();
    expect(tokenPrefixProblem("stripe-live", "irgendwas")).toBeUndefined();
    expect(tokenPrefixProblem("github", "rk_live_x")).toBeUndefined();
  });
});

describe("GitHub: optional permission Contents: Read", () => {
  it("readable: pass; 403: info only (no error); 404 (no workflow folder): no prohibition hint", async () => {
    const ok = await setup((u) => (u.includes("/contents/.github/workflows") ? { body: [{ name: "ci.yml", type: "file", size: 1 }] } : ghUser(u, "GET", {})));
    const r1 = await checkConnection(ok.rt, "github");
    expect(byId(r1).contents).toBe("pass");
    expect(r1.ok).toBe(true);

    const denied = await setup((u) => (u.includes("/contents/.github/workflows") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : ghUser(u, "GET", {})));
    const r2 = await checkConnection(denied.rt, "github");
    expect(byId(r2).contents).toBe("info");
    expect(r2.ok).toBe(true);
    expect(r2.checks.find((c) => c.id === "contents")!.text ?? JSON.stringify(r2.checks)).toContain("Contents: Read");

    const missing = await setup((u) => (u.includes("/contents/.github/workflows") ? { status: 404, body: { message: "Not Found" } } : ghUser(u, "GET", {})));
    const r3 = await checkConnection(missing.rt, "github");
    expect(byId(r3).contents).toBe("pass");
    expect(r3.ok).toBe(true);
  });
});
