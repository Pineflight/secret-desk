import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortalSession, checkFetchSite, loadOrCreateAgentToken } from "../src/server/security.js";

const base = "http://127.0.0.1:4747";
const req = (path: string, headers: Record<string, string> = {}) => new Request(`${base}${path}`, { headers: { host: "127.0.0.1:4747", ...headers } });

describe("Startgeheimnis", () => {
  it("erzeugt ein 256-Bit-Geheimnis und die Startadresse", () => {
    const s = new PortalSession({ env: {} });
    expect(Buffer.from(s.launchSecret!, "base64url")).toHaveLength(32);
    expect(s.launchUrl(4747)).toBe(`${base}/?launch=${s.launchSecret}`);
  });

  it("ohne Geheimnis und mit falschem: abgelehnt", () => {
    const s = new PortalSession({ env: {} });
    expect(s.mayIssue(req("/api/session"))).toBe(false);
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": "falsch" }))).toBe(false);
    expect(s.mayIssue(req("/api/session?launch=falsch"))).toBe(false);
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": `${s.launchSecret}x` }))).toBe(false);
  });

  it("mit richtigem Geheimnis (Header oder Query) erlaubt, danach genuegt das Cookie", () => {
    const s = new PortalSession({ env: {} });
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": s.launchSecret! }))).toBe(true);
    expect(s.mayIssue(req(`/api/session?launch=${s.launchSecret}`))).toBe(true);
    expect(s.mayIssue(req("/api/session", { cookie: `sd_session=${s.cookie}` }))).toBe(true);
    expect(s.mayIssue(req("/api/session", { cookie: "sd_session=anderes" }))).toBe(false);
  });

  it("SECRET_DESK_NO_LAUNCH_SECRET=1 schaltet ab", () => {
    const s = new PortalSession({ env: { SECRET_DESK_NO_LAUNCH_SECRET: "1" } });
    expect(s.launchSecret).toBeNull();
    expect(s.launchUrl(4747)).toBeNull();
    expect(s.mayIssue(req("/api/session"))).toBe(true);
  });

  it("zwei Sitzungen haben verschiedene Geheimnisse", () => {
    expect(new PortalSession({ env: {} }).launchSecret).not.toBe(new PortalSession({ env: {} }).launchSecret);
  });
});

describe("Sec-Fetch-Site", () => {
  it("lehnt cross-site und same-site ab, erlaubt same-origin, none und fehlend", () => {
    const r = (v?: string) => req("/api/ui/overview", v ? { "sec-fetch-site": v } : {});
    expect(checkFetchSite(r())).toBe(true);
    expect(checkFetchSite(r("same-origin"))).toBe(true);
    expect(checkFetchSite(r("none"))).toBe(true);
    expect(checkFetchSite(r("cross-site"))).toBe(false);
    expect(checkFetchSite(r("same-site"))).toBe(false);
  });
});

describe("Agenten-Token-Datei", () => {
  it("setzt eine zu offene Datei auf 600 und warnt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-token-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"a".repeat(43)}\n`, { mode: 0o644 });
    await chmod(file, 0o644);
    const warnings: string[] = [];
    const token = await loadOrCreateAgentToken(file, false, "linux", (m) => warnings.push(m));
    expect(token).toBe("a".repeat(43));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
  });

  it("warnt unter Windows nur", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-token-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"b".repeat(43)}\n`, { mode: 0o644 });
    const warnings: string[] = [];
    await loadOrCreateAgentToken(file, false, "win32", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it("legt neu mit 600 an", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-token-"));
    const file = join(dir, "x", "agent-token");
    await loadOrCreateAgentToken(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
