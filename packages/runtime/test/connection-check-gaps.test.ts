import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, NotConnectedError, WorkerSecretsError } from "@secret-desk/core";
import sodium from "libsodium-wrappers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkConnection, targetId } from "../src/connection-check.js";
import { createRuntime } from "../src/runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

let PUBLIC_KEY = "";
beforeAll(async () => {
  await sodium.ready;
  PUBLIC_KEY = sodium.to_base64(sodium.crypto_box_keypair().publicKey, sodium.base64_variants.ORIGINAL);
});

const NOW = new Date("2026-11-01T10:00:00Z");
const TOKEN = "made_up_connection_token_value_1";

const INVENTORY = `version: 1
secrets:
  - { id: cf-worker-a, name: SECRET_A, stage: shared, service: x, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: 0123456789abcdef0123456789abcdef, script: worker-b }, { scope: cloudflare-worker, accountId: 0123456789abcdef0123456789abcdef, script: worker-a }] }
  - { id: cf-worker-live, name: SECRET_B, stage: production, service: x, provider: manual, expiry: none, places: [{ scope: cloudflare-worker, accountId: 0123456789abcdef0123456789abcdef, script: worker-a }] }
  - { id: gh-secret, name: GH_SECRET, stage: shared, service: x, provider: manual, expiry: none, places: [{ repo: acme-app, scope: repository }, { repo: acme-org, scope: organization }] }
variables: []
`;

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; text?: string | "throw" };
type Handler = (url: string, method: string, headers: Record<string, string>) => Reply | undefined | Promise<never>;

async function setup(handler: Handler, opts: { inventory?: string; tokens?: Record<string, string>; app?: boolean; teamSync?: boolean } = {}) {
  const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
    const reply = await handler(String(url), init?.method ?? "GET", (init?.headers ?? {}) as Record<string, string>);
    const r = reply ?? {};
    if (r.text === "throw") return { status: r.status ?? 200, headers: new Headers(r.headers ?? {}), text: async () => Promise.reject(new Error("stream broke")) } as unknown as Response;
    const body = r.text !== undefined ? r.text : r.body === undefined ? null : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), "sd-conncheck-gaps-"));
  await writeFile(join(dir, "inventory.yaml"), opts.inventory ?? INVENTORY);
  const auth = opts.app ? '{ type: app, appId: "1", privateKey: { type: session } }' : "{ type: pat, source: { type: session } }";
  await writeFile(join(dir, "c.yaml"), `inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: ${auth}\n${opts.teamSync ? "teamSync:\n  repo: acme/team-config\n" : ""}`);
  const rt = await createRuntime(join(dir, "c.yaml"), { vault: null, env: {} as NodeJS.ProcessEnv, fetch: fetchMock, bundledRecipes: null });
  for (const [id, tok] of Object.entries({ github: TOKEN, ...(opts.tokens ?? {}) })) rt.connections.session.set(id, tok, null);
  return rt;
}

const detail = (r: { checks: { id: string; detail?: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.detail ?? "";
const status = (r: { checks: { id: string; status: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("the read call itself", () => {
  it("an empty body, an invalid body and an unreadable body all count as no content", async () => {
    for (const reply of [{ status: 200, text: "   " }, { status: 200, text: "{ not json" }, { status: 200, text: "throw" as const }]) {
      const rt = await setup(() => reply, { tokens: { supabase: TOKEN } });
      const r = await checkConnection(rt, "supabase", {}, NOW);
      expect(r.checks[0]).toMatchObject({ id: "token", status: "pass" });
    }
  });

  it("an aborted request is reported as a timeout", async () => {
    const rt = await setup(() => Promise.reject(Object.assign(new Error("signal aborted"), { name: "AbortError" })) as never, { tokens: { supabase: TOKEN } });
    expect((await checkConnection(rt, "supabase", {}, NOW)).checks[0]?.detail).toBe("Anfrage fehlgeschlagen: Zeitueberschreitung nach 15 s");
  });

  it("a failure without a message is reported with a generic word", async () => {
    const rt = await setup(() => Promise.reject({}) as never, { tokens: { supabase: TOKEN } });
    const r = await checkConnection(rt, "supabase", {}, NOW);
    expect(r.checks[0]?.detail).toBe("Anfrage fehlgeschlagen: Fehler");
  });
});

describe("cloudflare", () => {
  const verify = (result: Record<string, unknown>) => () => ({ body: { success: true, result } });

  it("an expired token fails, an inactive one names its status, a missing status is unknown", async () => {
    const expired = await setup(verify({ status: "active", expires_on: "2026-10-01T00:00:00Z" }), { tokens: { cloudflare: TOKEN } });
    const e = await checkConnection(expired, "cloudflare", {}, NOW);
    expect(status(e, "expiry")).toBe("fail");
    expect(detail(e, "expiry")).toMatch(/abgelaufen/);
    const inactive = await setup(verify({ status: "disabled" }), { tokens: { cloudflare: TOKEN } });
    expect(detail(await checkConnection(inactive, "cloudflare", {}, NOW), "token")).toBe("Status beim Anbieter: disabled");
    const unknown = await setup(verify({}), { tokens: { cloudflare: TOKEN } });
    expect(detail(await checkConnection(unknown, "cloudflare", {}, NOW), "token")).toBe("Status beim Anbieter: unbekannt");
  });

  it("an unparsable expiry date counts as no expiry; the hint depends on the connection", async () => {
    const odd = await setup(verify({ status: "active", expires_on: "tomorrow" }), { tokens: { cloudflare: TOKEN } });
    const r = await checkConnection(odd, "cloudflare", {}, NOW);
    expect(r.expires).toBeNull();
    expect(status(r, "expiry")).toBe("warn");
    const turnstile = await setup(verify({ status: "active" }), { tokens: { "cloudflare-turnstile": TOKEN } });
    const t = await checkConnection(turnstile, "cloudflare-turnstile", {}, NOW);
    expect(status(t, "expiry")).toBe("info");
    expect(detail(t, "expiry")).toBe("Der Token hat keinen Ablauf.");
  });

  it("the turnstile token has no recommended maximum lifetime", async () => {
    const rt = await setup(verify({ status: "active", expires_on: "2027-06-01T00:00:00Z" }), { tokens: { "cloudflare-turnstile": TOKEN } });
    expect(status(await checkConnection(rt, "cloudflare-turnstile", {}, NOW), "expiry")).toBe("pass");
  });

  it("403 is a rejection, anything else an unexpected answer", async () => {
    const rt = await setup(() => ({ status: 403, body: {} }), { tokens: { cloudflare: TOKEN } });
    expect(detail(await checkConnection(rt, "cloudflare", {}, NOW), "token")).toMatch(/lehnt den Token ab \(HTTP 403\)/);
    const odd = await setup(() => ({ status: 500, body: {} }), { tokens: { cloudflare: TOKEN } });
    expect(detail(await checkConnection(odd, "cloudflare", {}, NOW), "token")).toBe("Unerwartete Antwort (HTTP 500)");
  });

  it("checks every Worker of the inventory in a stable order and reports failures without leaking details", async () => {
    const rt = await setup(() => ({ body: { success: true, result: { status: "active" } } }), { tokens: { cloudflare: TOKEN } });
    const check = vi.spyOn(rt.workers, "check");
    check.mockImplementation(async (t) => {
      if (t.script === "worker-a") throw new WorkerSecretsError(404, "Worker nicht gefunden");
      if (t.script === "worker-b") throw new Error("internal detail");
    });
    const r = await checkConnection(rt, "cloudflare", {}, NOW);
    expect(r.checks.filter((c) => c.id.startsWith("worker:")).map((c) => [c.id, c.status, c.detail])).toEqual([
      ["worker:worker-a", "fail", "Worker nicht gefunden"],
      ["worker:worker-b", "fail", "Anfrage fehlgeschlagen"],
    ]);
    check.mockResolvedValue(undefined as never);
    expect(status(await checkConnection(rt, "cloudflare", {}, NOW), "worker:worker-a")).toBe("pass");
  });
});

describe("supabase", () => {
  it("403 and other answers", async () => {
    const forbidden = await setup(() => ({ status: 403 }), { tokens: { supabase: TOKEN } });
    expect((await checkConnection(forbidden, "supabase", {}, NOW)).checks[0]?.detail).toMatch(/fehlen Rechte \(HTTP 403\)/);
    const odd = await setup(() => ({ status: 502 }), { tokens: { supabase: TOKEN } });
    expect((await checkConnection(odd, "supabase", {}, NOW)).checks[0]?.detail).toBe("Unerwartete Antwort (HTTP 502)");
  });
});

describe("stripe", () => {
  const ACCOUNT = "acct_1AbCdEfGhIjKl";
  const rkLive = ["rk", "live", "51AbCdEfGhIjKlMnOpQrStUv"].join("_");
  const rkTest = ["rk", "test", "51AbCdEfGhIjKlMnOpQrStUv"].join("_");

  it("a key whose mode contradicts a bound connection fails the match, in both directions", async () => {
    const sandboxWithLive = await setup(() => ({ body: {} }), { tokens: { [`stripe:${ACCOUNT}:sandbox`]: rkLive } });
    expect(status(await checkConnection(sandboxWithLive, `stripe:${ACCOUNT}:sandbox`, {}, NOW), "mode-match")).toBe("fail");
    const liveWithTest = await setup(() => ({ body: {} }), { tokens: { [`stripe:${ACCOUNT}:live`]: rkTest } });
    const r = await checkConnection(liveWithTest, `stripe:${ACCOUNT}:live`, {}, NOW);
    expect(r.checks.find((c) => c.id === "mode-match")?.detail).toMatch(/Sandbox-Schluessel gehoert nicht in die Live-Verbindung/);
  });

  it("the fixed sandbox and live connections reject a key of the other mode", async () => {
    const test = await setup(() => ({ body: {} }), { tokens: { "stripe-test": rkLive } });
    expect(status(await checkConnection(test, "stripe-test", {}, NOW), "mode-match")).toBe("fail");
    const live = await setup(() => ({ body: {} }), { tokens: { "stripe-live": rkTest } });
    expect(status(await checkConnection(live, "stripe-live", {}, NOW), "mode-match")).toBe("fail");
    const fine = await setup(() => ({ body: {} }), { tokens: { "stripe-live": rkLive } });
    expect(status(await checkConnection(fine, "stripe-live", {}, NOW), "mode-match")).toBeUndefined();
  });

  it("an unexpected balance answer fails", async () => {
    const rt = await setup(() => ({ status: 500 }), { tokens: { stripe: TOKEN } });
    expect(detail(await checkConnection(rt, "stripe", {}, NOW), "token")).toBe("Unerwartete Antwort (HTTP 500)");
  });

  it("account binding: unreadable account with a 401, an unreadable one that still carries the account id, an unreadable one that does not", async () => {
    const id = `stripe:${ACCOUNT}:sandbox`;
    const unauthorized = await setup((url) => (url.endsWith("/account") ? { status: 401 } : { body: {} }), { tokens: { [id]: rkTest } });
    expect(detail(await checkConnection(unauthorized, id, {}, NOW), "account")).toMatch(/ungueltig oder widerrufen/);
    const carries = await setup((url) => (url.endsWith("/account") ? { status: 403 } : { body: {} }), { tokens: { [id]: rkTest } });
    expect(detail(await checkConnection(carries, id, {}, NOW), "account")).toMatch(/laut Schluessel-Kennung/);
    const other = await setup((url) => (url.endsWith("/account") ? { status: 403 } : { body: {} }), { tokens: { [id]: "rk_test_made_up_other_key" } });
    const r = await checkConnection(other, id, {}, NOW);
    expect(status(r, "account")).toBe("warn");
    expect(detail(r, "account")).toMatch(/Zuordnung zum Konto .* nicht geprueft/);
  });

  it("account binding: another account fails; the right one passes, with or without a name, and a label that cannot be stored is ignored", async () => {
    const id = `stripe:${ACCOUNT}:sandbox`;
    const wrong = await setup((url) => (url.endsWith("/account") ? { body: { id: "acct_1Other" } } : { body: {} }), { tokens: { [id]: rkTest } });
    expect(detail(await checkConnection(wrong, id, {}, NOW), "account")).toMatch(/gehoert zum Konto acct_1Other/);
    const named = await setup((url) => (url.endsWith("/account") ? { body: { id: ACCOUNT, business_profile: { name: "Acme Inc" } } } : { body: {} }), { tokens: { [id]: rkTest } });
    expect(detail(await checkConnection(named, id, {}, NOW), "account")).toBe(`Der Schluessel gehoert zum Konto ${ACCOUNT} (Acme Inc).`);
    const nameless = await setup((url) => (url.endsWith("/account") ? { body: { id: ACCOUNT } } : { body: {} }), { tokens: { [id]: rkTest } });
    expect(detail(await checkConnection(nameless, id, {}, NOW), "account")).toBe(`Der Schluessel gehoert zum Konto ${ACCOUNT}.`);
    const failing = await setup((url) => (url.endsWith("/account") ? { body: { id: ACCOUNT, settings: { dashboard: { display_name: "Dash" } } } } : { body: {} }), { tokens: { [id]: rkTest } });
    vi.spyOn(failing.connections.session, "set").mockImplementation(() => {
      throw new Error("cannot store");
    });
    expect(status(await checkConnection(failing, id, {}, NOW), "account")).toBe("pass");
  });
});

describe("resend, revenuecat, openai, anthropic and grafana cloud", () => {
  const status500 = () => ({ status: 500 });
  const odd = (r: { checks: { id: string; detail?: string }[] }) => detail(r, "token");

  it("resend: unexpected answer", async () => {
    const rt = await setup(status500, { tokens: { resend: TOKEN } });
    expect(odd(await checkConnection(rt, "resend", {}, NOW))).toBe("Unerwartete Antwort (HTTP 500)");
  });

  it("revenuecat: every answer has its own text, and a key of the wrong kind is named", async () => {
    const expected: [number, string][] = [
      [200, "Projekte lassen sich lesen."],
      [401, "Der Schluessel ist ungueltig oder widerrufen (HTTP 401). Neu verbinden."],
      [403, "Dem Schluessel fehlt das Recht Project configuration: Read only (HTTP 403)."],
      [429, "RevenueCat begrenzt die Anfragen (HTTP 429, 60 pro Minute). Spaeter erneut pruefen."],
      [500, "Unerwartete Antwort (HTTP 500)"],
    ];
    for (const [code, text] of expected) {
      const rt = await setup(() => ({ status: code }), { tokens: { revenuecat: "sk_made_up_revenuecat" } });
      expect(odd(await checkConnection(rt, "revenuecat", {}, NOW))).toBe(text);
    }
    const wrong = await setup(() => ({ status: 200 }), { tokens: { revenuecat: "made_up_v1_key" } });
    expect(status(await checkConnection(wrong, "revenuecat", {}, NOW), "prefix")).toBe("fail");
  });

  it("openai: 401, 403, 429 and others", async () => {
    const expected: [number, RegExp][] = [
      [200, /Projekte lassen sich lesen/],
      [401, /lehnt den Admin-Key ab \(HTTP 401\)/],
      [403, /lehnt den Admin-Key ab \(HTTP 403\)/],
      [429, /OpenAI begrenzt die Anfragen/],
      [500, /Unerwartete Antwort \(HTTP 500\)/],
    ];
    for (const [code, re] of expected) {
      const rt = await setup(() => ({ status: code }), { tokens: { openai: "sk-admin-made-up" } });
      expect(odd(await checkConnection(rt, "openai", {}, NOW))).toMatch(re);
    }
    const wrong = await setup(() => ({ status: 200 }), { tokens: { openai: "sk-made-up" } });
    expect(status(await checkConnection(wrong, "openai", {}, NOW), "prefix")).toBe("fail");
  });

  it("anthropic: sends its own key header without a bearer token; 401, 403, 429 and others", async () => {
    const seen: Record<string, string>[] = [];
    const expected: [number, RegExp][] = [
      [200, /Workspaces lassen sich lesen/],
      [401, /lehnt den Admin-Key ab \(HTTP 401\)/],
      [403, /lehnt den Admin-Key ab \(HTTP 403\)/],
      [429, /Anthropic begrenzt die Anfragen/],
      [500, /Unerwartete Antwort \(HTTP 500\)/],
    ];
    for (const [code, re] of expected) {
      const rt = await setup((_u, _m, h) => (seen.push(h), { status: code }), { tokens: { anthropic: "sk-ant-admin01-made-up" } });
      expect(odd(await checkConnection(rt, "anthropic", {}, NOW))).toMatch(re);
    }
    expect(seen[0]).not.toHaveProperty("Authorization");
    const wrong = await setup(() => ({ status: 200 }), { tokens: { anthropic: "sk-made-up-other" } });
    expect(status(await checkConnection(wrong, "anthropic", {}, NOW), "prefix")).toBe("fail");
  });

  it("grafana cloud: 200, 401, 403, 429 and others", async () => {
    const expected: [number, string, string][] = [
      [200, "pass", "Zugriffsrichtlinien lassen sich lesen."],
      [401, "fail", "Grafana Cloud lehnt den Token ab (HTTP 401). Er ist ungueltig, abgelaufen oder widerrufen. Neu verbinden."],
      [403, "info", "Der Token ist gueltig, darf aber keine Zugriffsrichtlinien lesen (HTTP 403)."],
      [429, "warn", "Grafana Cloud begrenzt die Anfragen (HTTP 429). Spaeter erneut pruefen."],
      [500, "info", "Mit dieser Abfrage nicht pruefbar (HTTP 500)."],
    ];
    for (const [code, level, text] of expected) {
      const rt = await setup(() => ({ status: code }), { tokens: { "grafana-cloud": "glc_made_up" } });
      const r = await checkConnection(rt, "grafana-cloud", {}, NOW);
      expect([status(r, "token"), odd(r)]).toEqual([level, text]);
    }
    const wrong = await setup(() => ({ status: 200 }), { tokens: { "grafana-cloud": "made_up" } });
    expect(status(await checkConnection(wrong, "grafana-cloud", {}, NOW), "prefix")).toBe("fail");
  });
});

describe("entry point", () => {
  it("grafana, github-app-key and team-sync without their own token", async () => {
    const rt = await setup(() => ({}), { tokens: {} });
    for (const id of ["grafana", "github-app-key"]) {
      expect(await checkConnection(rt, id, {}, NOW)).toMatchObject({ ok: false, checks: [{ id: "connected", status: "fail" }] });
    }
    rt.connections.session.set("github-app-key", "made_up_key", null);
    expect(await checkConnection(rt, "github-app-key", {}, NOW)).toMatchObject({ ok: true });
    const noTeam = await checkConnection(rt, "team-sync", {}, NOW);
    expect(noTeam.ok).toBe(true);
    rt.connections.session.delete("github");
    const none = await checkConnection(rt, "team-sync", {}, NOW);
    expect(none.ok).toBe(false);
    rt.connections.session.set("team-sync", "made_up_team_token", null);
    expect((await checkConnection(rt, "team-sync", {}, NOW)).ok).toBe(true);
  });

  it("a configured team sync that cannot be checked reports the error text", async () => {
    const rt = await setup(() => ({}), { teamSync: true, tokens: { "team-sync": TOKEN } });
    vi.spyOn(rt.connections, "status").mockRejectedValue(new Error("store unreadable"));
    expect(await checkConnection(rt, "team-sync", {}, NOW)).toMatchObject({ ok: false, checks: [{ id: "repo", detail: "store unreadable" }] });
  });

  it("a connection of a registered provider without an own test says so", async () => {
    const rt = await setup(() => ({}), { tokens: { "made-up-conn": TOKEN } });
    rt.providers.register({ id: "made-up-provider", label: "Made up", kind: "automatic", connection: "made-up-conn" });
    expect(await checkConnection(rt, "made-up-conn", {}, NOW)).toMatchObject({ ok: true, checks: [{ id: "token", status: "info", detail: "Fuer diese Verbindung gibt es keinen Test." }] });
  });

  it("an unreadable stored token and unexpected errors", async () => {
    const rt = await setup(() => ({}), { tokens: { supabase: TOKEN } });
    const token = vi.spyOn(rt.connections, "token");
    token.mockRejectedValueOnce(new NotConnectedError("supabase", "hint"));
    expect(await checkConnection(rt, "supabase", {}, NOW)).toMatchObject({ ok: false, checks: [{ id: "connected" }] });
    token.mockRejectedValueOnce(new GitHubError(403, "forbidden for made up reason"));
    const gh = await checkConnection(rt, "supabase", {}, NOW);
    expect(gh).toMatchObject({ ok: false, checks: [{ id: "request", label: "Anfrage", status: "fail" }] });
    expect(gh.checks[0]?.detail).toContain("HTTP 403");
    token.mockRejectedValueOnce(new TypeError("boom"));
    await expect(checkConnection(rt, "supabase", {}, NOW)).rejects.toThrow("boom");
  });
});

describe("github", () => {
  const user = (over: Reply = {}): Handler => (url) => (url === "https://api.github.com/user" ? { body: { login: "alice" }, ...over } : undefined);

  it("a login without a name, the scopes header and the expiry in the past", async () => {
    const rt = await setup(user({ body: {}, headers: { "x-oauth-scopes": "repo, workflow ,", "github-authentication-token-expiration": "2026-10-01 10:00:00 UTC" } }), { inventory: "version: 1\nsecrets: []\nvariables: []\n" });
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(detail(r, "login")).toBe("Angemeldet");
    expect(r.scopes).toEqual(["repo", "workflow"]);
    expect(status(r, "expiry")).toBe("fail");
    expect(status(r, "targets")).toBe("info");
    expect(r.checks.some((c) => c.id === "contents")).toBe(false);
  });

  it("an unexpected answer on login", async () => {
    const rt = await setup(user({ status: 500, body: {} }));
    expect(detail(await checkConnection(rt, "github", {}, NOW), "login")).toBe("Unerwartete Antwort (HTTP 500)");
  });

  it("with a GitHub App there is no user test", async () => {
    const rt = await setup(() => ({}), { app: true });
    vi.spyOn(rt.github, "publicKey").mockResolvedValue({ keyId: "k", key: "a2V5" } as never);
    vi.spyOn(rt.github, "listWorkflowFiles").mockResolvedValue([]);
    const r = await checkConnection(rt, "github", {}, NOW);
    expect(status(r, "login")).toBe("info");
    expect(r.checks.find((c) => c.id.startsWith("target:repository:acme-app"))).toMatchObject({ status: "pass" });
  });

  it("every kind of target failure has its own text, an organization target is named as such", async () => {
    const rt = await setup(user());
    const key = vi.spyOn(rt.github, "publicKey");
    vi.spyOn(rt.github, "listWorkflowFiles").mockResolvedValue([]);
    const failures: unknown[] = [
      new GitHubError(401, "bad"),
      new GitHubError(403, `forbidden ${TOKEN}`),
      new GitHubError(404, "gone"),
      new GitHubError(500, "boom"),
      new NotConnectedError("github", "x"),
      new Error("network down"),
      "just text",
    ];
    const texts: string[] = [];
    for (const f of failures) {
      key.mockRejectedValue(f);
      const r = await checkConnection(rt, "github", {}, NOW);
      const t = r.checks.find((c) => c.id === `target:${targetId({ repo: "acme-org", scope: "organization" })}`)!;
      expect(t.label).toBe("Ziel Organisation acme");
      texts.push(t.detail ?? "");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    expect(texts).toEqual([
      "GitHub lehnt den Token ab (HTTP 401). Neu verbinden.",
      "GitHub verweigert den Zugriff (HTTP 403): forbidden ***",
      expect.stringMatching(/Nicht gefunden oder nicht freigegeben \(HTTP 404\)/),
      "GitHub meldet HTTP 500",
      "Nicht verbunden",
      "Anfrage fehlgeschlagen: network down",
      "Anfrage fehlgeschlagen: Fehler",
    ]);
  });

  it("the optional contents check: 401 and 403 are a hint, other problems a softer hint, 404 says nothing", async () => {
    const rt = await setup(user());
    vi.spyOn(rt.github, "publicKey").mockResolvedValue({ keyId: "k", key: "a2V5" } as never);
    const list = vi.spyOn(rt.github, "listWorkflowFiles");
    list.mockRejectedValueOnce(new GitHubError(401, "bad"));
    expect(detail(await checkConnection(rt, "github", {}, NOW), "contents")).toMatch(/Contents: Read/);
    list.mockRejectedValueOnce(new GitHubError(500, "boom"));
    expect(detail(await checkConnection(rt, "github", {}, NOW), "contents")).toBe("Workflow-Dateien konnten nicht geprueft werden.");
    list.mockRejectedValueOnce(new Error("socket"));
    expect(detail(await checkConnection(rt, "github", {}, NOW), "contents")).toBe("Workflow-Dateien konnten nicht geprueft werden.");
    list.mockRejectedValueOnce(new GitHubError(404, "none"));
    expect(status(await checkConnection(rt, "github", {}, NOW), "contents")).toBeUndefined();
  });

  it("a write test without a target list writes nothing", async () => {
    const rt = await setup(user());
    vi.spyOn(rt.github, "publicKey").mockResolvedValue({ keyId: "k", key: "a2V5" } as never);
    vi.spyOn(rt.github, "listWorkflowFiles").mockResolvedValue([]);
    const r = await checkConnection(rt, "github", { deep: true }, NOW);
    expect(status(r, "write")).toBe("info");
  });

  describe("write probe", () => {
    const targetOf = "repository:acme-app";
    async function probing() {
      const rt = await setup(user());
      vi.spyOn(rt.github, "publicKey").mockResolvedValue({ keyId: "k", key: PUBLIC_KEY } as never);
      vi.spyOn(rt.github, "listWorkflowFiles").mockResolvedValue([]);
      vi.spyOn(rt.github, "listSecrets").mockResolvedValue([]);
      vi.spyOn(rt.github, "listVariables").mockResolvedValue([]);
      vi.spyOn(rt.github, "putEncrypted").mockResolvedValue(undefined as never);
      vi.spyOn(rt.github, "deleteSecret").mockResolvedValue(undefined as never);
      vi.spyOn(rt.github, "putVariable").mockResolvedValue(undefined as never);
      vi.spyOn(rt.github, "deleteVariable").mockResolvedValue(undefined as never);
      return rt;
    }
    const run = (rt: Awaited<ReturnType<typeof probing>>) => checkConnection(rt, "github", { deep: true, targets: [targetOf] }, NOW);

    it("the write probe seals through the client's sealer and sends exactly its output", async () => {
      const rt = await probing();
      const seal = vi.spyOn(rt.github, "seal").mockResolvedValue("c2VhbGVkLWJ5LWNsaWVudA==");
      const r = await run(rt);
      expect(seal).toHaveBeenCalledExactlyOnceWith(PUBLIC_KEY, "probe");
      expect(rt.github.putEncrypted).toHaveBeenCalledWith(expect.anything(), "SD_WRITE_PROBE", "c2VhbGVkLWJ5LWNsaWVudA==", "k");
      expect(status(r, `write-secret:${targetOf}`)).toBe("pass");
    });

    it("existing probe names are left alone", async () => {
      const rt = await probing();
      vi.spyOn(rt.github, "listSecrets").mockResolvedValue([{ name: "SD_WRITE_PROBE" }] as never);
      vi.spyOn(rt.github, "listVariables").mockResolvedValue([{ name: "SD_WRITE_PROBE_VAR" }] as never);
      const r = await run(rt);
      expect(status(r, `write-secret:${targetOf}`)).toBe("warn");
      expect(status(r, `write-variable:${targetOf}`)).toBe("warn");
    });

    it("a probe that cannot be deleted names what to clean up, for an Error and for other rejections", async () => {
      const rt = await probing();
      vi.spyOn(rt.github, "deleteSecret").mockRejectedValue("plain text");
      vi.spyOn(rt.github, "deleteVariable").mockRejectedValue(new Error("delete refused"));
      const r = await run(rt);
      expect(detail(r, `write-secret:${targetOf}`)).toContain("Fehler. Bitte von Hand loeschen.");
      expect(detail(r, `write-variable:${targetOf}`)).toContain("delete refused. Bitte von Hand loeschen.");
      const rt2 = await probing();
      vi.spyOn(rt2.github, "deleteVariable").mockRejectedValue(undefined);
      expect(detail(await run(rt2), `write-variable:${targetOf}`)).toContain("Fehler. Bitte von Hand loeschen.");
    });

    it("a refused variable write is explained", async () => {
      const rt = await probing();
      vi.spyOn(rt.github, "putVariable").mockRejectedValue(new GitHubError(403, "Resource not accessible by personal access token"));
      const r = await run(rt);
      expect(status(r, `write-variable:${targetOf}`)).toBe("fail");
      expect(r.checks.find((c) => c.id === `write-variable:${targetOf}`)?.label).toBe("Schreibtest Variable in acme-app");
    });
  });
});
