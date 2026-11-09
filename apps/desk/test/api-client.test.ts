import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiPath, attachmentUrl, currentSession, ensureSession, evidenceSvgUrl, resetSessionForTests, toApiError } from "../src/lib/api";
import { refreshVersion } from "../src/lib/refresh";

const SESSION = { csrf: "csrf-for-tests", user: "tester", demo: false, owner: "tester" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetSessionForTests();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ensureSession", () => {
  it("fetches the session once and shares it between concurrent callers", async () => {
    fetchMock.mockImplementation(async () => json(200, SESSION));
    const [a, b] = await Promise.all([ensureSession(), ensureSession()]);
    expect(a).toEqual(SESSION);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(currentSession()).toEqual(SESSION);
    await ensureSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("force replaces a cached session", async () => {
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession();
    await ensureSession(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a launch input as header", async () => {
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession(false, "launch-for-tests");
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "x-secret-desk-launch": "launch-for-tests" });
  });

  it("takes ?launch= from the address bar, strips it and keeps the rest", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:4747/entries?a=1&launch=launch-for-tests#x" }, history: { state: { s: 1 }, replaceState } });
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession();
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "x-secret-desk-launch": "launch-for-tests" });
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, "", "/entries?a=1#x");
  });

  it("sends no header when the address has no launch value", async () => {
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:4747/entries" }, history: {} });
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession();
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("headers");
  });

  it("treats an unparsable address as no launch value", async () => {
    vi.stubGlobal("window", { location: { href: "not a url" }, history: {} });
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession();
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("headers");
  });

  it("treats a window without location as no launch value", async () => {
    vi.stubGlobal("window", {});
    fetchMock.mockImplementation(async () => json(200, SESSION));
    await ensureSession();
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("headers");
  });

  it("maps 401 launch-required to a hint error", async () => {
    fetchMock.mockResolvedValue(json(401, { code: "launch-required" }));
    await expect(ensureSession()).rejects.toMatchObject({ status: 401, code: "launch-required" });
    expect(currentSession()).toBeNull();
  });

  it("uses the server error text, else a generic one, for other failures", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: "boom" }));
    await expect(ensureSession()).rejects.toMatchObject({ status: 500, message: "boom" });
    fetchMock.mockResolvedValueOnce(json(401, { code: "other" }));
    await expect(ensureSession()).rejects.toMatchObject({ status: 401, message: "Sitzung konnte nicht gestartet werden." });
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 502 }));
    await expect(ensureSession()).rejects.toMatchObject({ status: 502, message: "Sitzung konnte nicht gestartet werden." });
  });
});

describe("api", () => {
  const route = (path: string) => fetchMock.mock.calls.find((c) => c[0] === path)!;

  it("sends GET with csrf and language headers and returns the body without refreshing counts", async () => {
    fetchMock.mockImplementation(async (url: string) => (url === "/api/session" ? json(200, SESSION) : json(200, { ok: 1 })));
    const before = refreshVersion();
    await expect(api("GET", "/entries")).resolves.toEqual({ ok: 1 });
    const init = route("/api/ui/entries")[1];
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(init.headers).toMatchObject({ "x-secret-desk-csrf": "csrf-for-tests", "x-secret-desk-lang": "de" });
    expect(init).not.toHaveProperty("body");
    expect(refreshVersion()).toBe(before);
  });

  it("sends a JSON body and refreshes counts after a write", async () => {
    fetchMock.mockImplementation(async (url: string) => (url === "/api/session" ? json(200, SESSION) : json(200, {})));
    const before = refreshVersion();
    await api("POST", "entries", { a: 1 });
    const init = route("/api/ui/entries")[1];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
    expect(refreshVersion()).toBe(before + 1);
  });

  it("passes FormData through without a content type", async () => {
    fetchMock.mockImplementation(async (url: string) => (url === "/api/session" ? json(200, SESSION) : json(200, {})));
    const form = new FormData();
    await api("POST", "upload", form);
    const init = route("/api/ui/upload")[1];
    expect(init.body).toBe(form);
    expect(init.headers).not.toHaveProperty("content-type");
  });

  it("reports an unreachable portal as status 0", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/session") return json(200, SESSION);
      throw new TypeError("offline");
    });
    await expect(api("GET", "x")).rejects.toMatchObject({ status: 0, message: "Das Portal ist nicht erreichbar. Läuft es noch?" });
  });

  it("renews the session once after a 401 and retries", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/session") return json(200, SESSION);
      return ++calls === 1 ? json(401, {}) : json(200, { again: true });
    });
    await expect(api("GET", "x")).resolves.toEqual({ again: true });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/session")).toHaveLength(2);
  });

  it("gives up after a second 401 and turns failures into ApiError", async () => {
    fetchMock.mockImplementation(async (url: string) => (url === "/api/session" ? json(200, SESSION) : json(401, { error: "denied", code: "nope" })));
    await expect(api("GET", "x")).rejects.toMatchObject({ status: 401, message: "denied", code: "nope" });
  });
});

describe("toApiError and urls", () => {
  it("keeps only well-typed extra fields", () => {
    const e = toApiError(422, { error: "bad", code: "c", hint: "h", connection: "k", problems: [1], findings: [2] });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ name: "ApiError", status: 422, message: "bad", code: "c", hint: "h", connection: "k", problems: [1], findings: [2] });
    const plain = toApiError(500, { error: "", code: 1, hint: 2, connection: 3, problems: "x", findings: {} });
    expect(plain.message).toBe("Anfrage fehlgeschlagen (500).");
    expect(plain.code).toBeUndefined();
    expect(plain.problems).toBeUndefined();
    expect(toApiError(404, null).message).toBe("Anfrage fehlgeschlagen (404).");
  });

  it("builds portal and evidence urls with encoded segments", () => {
    expect(apiPath("///a/b")).toBe("/api/ui/a/b");
    expect(evidenceSvgUrl("s 1", "r/2")).toBe("/api/ui/evidence/s%201/r%2F2/svg");
    expect(attachmentUrl("s", "r", "a b.png")).toBe("/api/ui/evidence/s/r/attachments/a%20b.png");
  });
});
