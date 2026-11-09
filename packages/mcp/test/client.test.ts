import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskApiError, DeskClient, resolveAgentToken } from "../src/client.js";

const TOKEN = "made-up-agent-token";

const reply = (status: number, body: string, headers: Record<string, string> = {}, statusText = "") =>
  new Response(body, { status, statusText, headers });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveAgentToken", () => {
  it("prefers the environment variable and trims it", async () => {
    expect(await resolveAgentToken({ SECRET_DESK_AGENT_TOKEN: `  ${TOKEN}\n` })).toBe(TOKEN);
  });

  it("reads ~/.secret-desk/agent-token when the variable is unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "sd-mcp-home-"));
    await mkdir(join(home, ".secret-desk"));
    await writeFile(join(home, ".secret-desk", "agent-token"), `${TOKEN}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(await resolveAgentToken({})).toBe(TOKEN);
  });

  it("explains how to set the token up when neither source exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "sd-mcp-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    await expect(resolveAgentToken({})).rejects.toThrow(/Kein Agenten-Token/);
  });
});

describe("DeskApiError", () => {
  it("carries status and name", () => {
    const err = new DeskApiError(404, "nope");
    expect(err).toMatchObject({ status: 404, message: "nope", name: "DeskApiError" });
  });
});

describe("DeskClient.request", () => {
  it("sends a bearer token, a JSON body and returns parsed JSON; trailing slash of the base is dropped", async () => {
    const fetchFn = vi.fn(async () => reply(200, '{"ok":true}', { "content-type": "application/json" }));
    const client = new DeskClient({ baseUrl: "http://portal.test/", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    expect(await client.request("POST", "/x", { a: 1 })).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://portal.test/api/agent/x");
    expect(init).toMatchObject({ method: "POST", body: '{"a":1}', headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
  });

  it("omits body and content type for requests without body", async () => {
    const fetchFn = vi.fn(async () => reply(200, '{"ok":true}', { "content-type": "application/json" }));
    const client = new DeskClient({ baseUrl: "http://portal.test", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    await client.request("GET", "/y");
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init).not.toHaveProperty("body");
  });

  it("returns plain text for non-JSON responses and null for empty ones", async () => {
    const responses = [reply(200, "name: x\n", { "content-type": "text/yaml" }), reply(200, "", {}), reply(200, "raw", {})];
    const fetchFn = vi.fn(async () => responses.shift()!);
    const client = new DeskClient({ baseUrl: "http://portal.test", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    expect(await client.request("GET", "/yaml")).toBe("name: x\n");
    expect(await client.request("GET", "/empty")).toBeNull();
    expect(await client.request("GET", "/no-type")).toBe("raw");
  });

  it("maps an error body with an error field to DeskApiError", async () => {
    const fetchFn = vi.fn(async () => reply(403, '{"error":"policy denies this"}'));
    const client = new DeskClient({ baseUrl: "http://portal.test", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    await expect(client.request("GET", "/z")).rejects.toMatchObject({ status: 403, message: "policy denies this" });
  });

  it("falls back to the status text when the error body has no error field or is not JSON", async () => {
    const responses = [reply(500, "{}", {}, "Server Broke"), reply(502, "<html>", {}, "Bad Gateway")];
    const fetchFn = vi.fn(async () => responses.shift()!);
    const client = new DeskClient({ baseUrl: "http://portal.test", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    await expect(client.request("GET", "/a")).rejects.toMatchObject({ status: 500, message: "Server Broke" });
    await expect(client.request("GET", "/b")).rejects.toMatchObject({ status: 502, message: "Bad Gateway" });
  });

  it("reports an unreachable portal with status 0", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new DeskClient({ baseUrl: "http://portal.test", token: TOKEN, fetch: fetchFn as unknown as typeof fetch });
    await expect(client.request("GET", "/a")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("http://portal.test") });
  });

  it("resolves the token lazily and the base URL from SECRET_DESK_URL when not given", async () => {
    vi.stubEnv("SECRET_DESK_URL", "http://env-portal.test/");
    vi.stubEnv("SECRET_DESK_AGENT_TOKEN", TOKEN);
    const fetchFn = vi.fn(async () => reply(200, "{}", { "content-type": "application/json" }));
    await new DeskClient({ fetch: fetchFn as unknown as typeof fetch }).request("GET", "/q");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://env-portal.test/api/agent/q");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("defaults to the local portal and the global fetch", async () => {
    vi.stubEnv("SECRET_DESK_URL", undefined);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, "{}", { "content-type": "application/json" }));
    await new DeskClient({ token: TOKEN }).request("GET", "/q");
    expect(spy.mock.calls[0]![0]).toBe("http://127.0.0.1:4747/api/agent/q");
  });

  it.each(["", "   "])("treats an empty or blank SECRET_DESK_URL (%j) as unset and uses the default", async (value) => {
    vi.stubEnv("SECRET_DESK_URL", value);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, "{}", { "content-type": "application/json" }));
    await new DeskClient({ token: TOKEN }).request("GET", "/q");
    expect(spy.mock.calls[0]![0]).toBe("http://127.0.0.1:4747/api/agent/q");
  });
});
