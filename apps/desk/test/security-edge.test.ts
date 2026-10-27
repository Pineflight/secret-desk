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
  it("richtiger Token, Gross-/Kleinschreibung des Schemas ist streng", () => {
    expect(bearerMatches(req({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(bearerMatches(req({ authorization: `bearer ${token}` }), token)).toBe(false);
  });
  it("fehlend, leer, falsches Schema, zu kurz, zu lang, Leerzeichen", () => {
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
  it("mehrere Cookies, Leerzeichen, Wert mit '='", () => {
    expect(cookieValue(req({ cookie: "a=1; sd_session=abc=def; b=2" }), "sd_session")).toBe("abc=def");
    expect(cookieValue(req({ cookie: "  sd_session=x  " }), "sd_session")).toBe("x");
  });
  it("fehlend, leerer Wert, Namenspraefix ist kein Treffer", () => {
    expect(cookieValue(req(), "sd_session")).toBeNull();
    expect(cookieValue(req({ cookie: "sd_session=" }), "sd_session")).toBe("");
    expect(cookieValue(req({ cookie: "xsd_session=1; sd_session_2=2" }), "sd_session")).toBeNull();
  });
  it("leeres Cookie fuehrt nicht zur gueltigen Sitzung", () => {
    const s = new PortalSession({ env: {} });
    expect(s.validCookie(req({ cookie: "sd_session=" }))).toBe(false);
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}` }))).toBe(false); // CSRF fehlt
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}`, "x-secret-desk-csrf": s.csrf }))).toBe(true);
    expect(s.valid(req({ cookie: `sd_session=${s.cookie}`, "x-secret-desk-csrf": "falsch" }))).toBe(false);
  });
});

describe("L2: checkOrigin und checkHost", () => {
  it("GET und HEAD brauchen keinen Ursprung", () => {
    expect(checkOrigin(req({}, "GET"), hosts)).toBe(true);
    expect(checkOrigin(req({}, "HEAD"), hosts)).toBe(true);
  });
  it("Aenderungen: fehlender, 'null', fremder und kaputter Ursprung werden abgelehnt", () => {
    expect(checkOrigin(req({}, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "null" }, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "https://evil.example.com" }, "DELETE"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "kein url" }, "PUT"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: "http://127.0.0.1:9999" }, "POST"), hosts)).toBe(false);
    expect(checkOrigin(req({ origin: `http://${HOST}` }, "POST"), hosts)).toBe(true);
    expect(checkOrigin(req({ origin: "http://localhost:4747" }, "PATCH"), hosts)).toBe(true);
  });
  it("Host: nur erlaubte Namen mit Port", () => {
    expect(checkHost(req(), hosts)).toBe(true);
    expect(checkHost(req({ host: "127.0.0.1" }), hosts)).toBe(false);
    expect(checkHost(req({ host: "127.0.0.1:4747.evil.com" }), hosts)).toBe(false);
    expect(checkHost(req({ host: "evil.com" }), hosts)).toBe(false);
  });
});

describe("L2: loadOrCreateAgentToken", () => {
  const noWarn = () => undefined;
  it("zu kurzer Token (<32) wird ersetzt, nicht uebernommen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, "kurz\n", { mode: 0o600 });
    const token = await loadOrCreateAgentToken(file, false, "linux", noWarn);
    expect(token).not.toBe("kurz");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(file, "utf8")).trim()).toBe(token);
  });
  it("rotate ersetzt einen gueltigen Token, Modus 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"a".repeat(43)}\n`, { mode: 0o600 });
    const next = await loadOrCreateAgentToken(file, true, "linux", noWarn);
    expect(next).not.toBe("a".repeat(43));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it("gueltiger Token mit Modus 600 wird ohne Warnung uebernommen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"c".repeat(43)}\n`, { mode: 0o600 });
    const warnings: string[] = [];
    expect(await loadOrCreateAgentToken(file, false, "linux", (m) => warnings.push(m))).toBe("c".repeat(43));
    expect(warnings).toEqual([]);
  });
  it("neu angelegte Tokens sind zufaellig und verschieden", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-tok-"));
    const a = await loadOrCreateAgentToken(join(dir, "a"), false, "linux", noWarn);
    const b = await loadOrCreateAgentToken(join(dir, "b"), false, "linux", noWarn);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
