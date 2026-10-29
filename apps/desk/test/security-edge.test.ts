import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortalSession, allowedHosts, bearerMatches, checkHost, checkOrigin, cookieValue, loadOrCreateAgentToken } from "../src/server/security.js";

const HOST = "127.0.0.1:4747";
const hosts = allowedHosts(4747);
const req = (headers: Record<string, string> = {}, method = "GET") => new Request(`http://${HOST}/api/ui/overview`, { method, headers: { host: HOST, ...headers } });

describe("L2: bearerMatches", () => {
  const token = "t".repeat(40);
  it("correct token, the scheme's letter case is strict", () => {
    expect(bearerMatches(req({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(bearerMatches(req({ authorization: `bearer ${token}` }), token)).toBe(false);
  });
  it("missing, empty, wrong scheme, too short, too long, whitespace", () => {
    expect(bearerMatches(req(), token)).toBe(false);
    expect(bearerMatches(req({ authorization: "" }), token)).toBe(false);
    expect(bearerMatches(req({ authorization: "Bearer " }), token)).toBe(false);
    expect(bearerMatches(req({ authorization: `Basic ${token}` }), token)).toBe(false);
    expect(bearerMatches(req({ authorization: `Bearer ${token.slice(1)}` }), token)).toBe(false);
    expect(bearerMatches(req({ authorization: `Bearer ${token}x` }), token)).toBe(false);
    expect(bearerMatches(req({ authorization: `Bearer  ${token}` }), token)).toBe(false);
    // Ein Leerzeichen am Ende entfernt schon die Headers-API; Auswertung ist dann identisch zum Token.
  });
});

describe("L2: cookieValue", () => {
  it("several cookies, whitespace, value with =", () => {
    expect(cookieValue(req({ cookie: "a=1; sd_session=abc=def; b=2" }), "sd_session")).toBe("abc=def");
    expect(cookieValue(req({ cookie: "  sd_session=x  " }), "sd_session")).toBe("x");
  });
  it("missing, empty value, name prefix is no match", () => {
    expect(cookieValue(req(), "sd_session")).toBeNull();
    expect(cookieValue(req({ cookie: "sd_session=" }), "sd_session")).toBe("");
    expect(cookieValue(req({ cookie: "xsd_session=1; sd_session_2=2" }), "sd_session")).toBeNull();
  });
  it("empty cookie does not lead to a valid session", () => {
    const s = new PortalSession({ env: {} });
    expect(s.validCookie(req({ cookie: "sd_session=" }))).toBe(false);
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}` }))).toBe(false); // CSRF fehlt
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}`, "x-secret-desk-csrf": s.csrf }))).toBe(true);
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}`, "x-secret-desk-csrf": "falsch" }))).toBe(false);
  });
});

describe("L2: checkOrigin and checkHost", () => {
  it("GET and HEAD need no origin", () => {
    expect(checkOrigin(req({}, "GET"), hosts)).toBe(true);
    expect(checkOrigin(req({}, "HEAD"), hosts)).toBe(true);
  });
  it("changes: missing, null, foreign and broken origin are rejected", () => {
    expect(checkOrigin(req({}, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "null" }, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "https://evil.example.com" }, "DELETE"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "kein url" }, "PUT"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "http://127.0.0.1:9999" }, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: `http://${HOST}` }, "POST"), hosts)).toBe(true);
    expect(checkOrigin(req({ origin: "http://localhost:4747" }, "PATCH"), hosts)).toBe(true);
  });
  it("host: allowed names with port only", () => {
    expect(checkHost(req(), hosts)).toBe(true);
    expect(checkHost(req({ host: "127.0.0.1" }), hosts)).toBe(false);
    expect(checkHost(req({ host: "127.0.0.1:4747.evil.com" }), hosts)).toBe(false);
    expect(checkHost(req({ host: "evil.com" }), hosts)).toBe(false);
  });
});

describe("L2: loadOrCreateAgentToken", () => {
  const noWarn = () => undefined;
  it("too short token (<32) is replaced, not adopted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, "kurz\n", { mode: 0o600 });
    const token = await loadOrCreateAgentToken(file, false, "linux", noWarn);
    expect(token).not.toBe("kurz");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(file, "utf8")).trim()).toBe(token);
  });
  it("rotate replaces a valid token, mode 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"a".repeat(43)}\n`, { mode: 0o600 });
    const next = await loadOrCreateAgentToken(file, true, "linux", noWarn);
    expect(next).not.toBe("a".repeat(43));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it("valid token with mode 600 is adopted without warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"c".repeat(43)}\n`, { mode: 0o600 });
    const warnings: string[] = [];
    expect(await loadOrCreateAgentToken(file, false, "linux", (m) => warnings.push(m))).toBe("c".repeat(43));
    expect(warnings).toEqual([]);
  });
  it("newly created tokens are random and distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const a = await loadOrCreateAgentToken(join(dir, "a"), false, "linux", noWarn);
    const b = await loadOrCreateAgentToken(join(dir, "b"), false, "linux", noWarn);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
