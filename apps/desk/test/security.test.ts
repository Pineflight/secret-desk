import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PortalSession, checkFetchSite, loadOrCreateAgentToken } from "../src/server/security.js";

const base = "http://127.0.0.1:4747";
const req = (path: string, headers: Record<string, string> = {}) => new Request(`${base}${path}`, { headers: { host: "127.0.0.1:4747", ...headers } });

describe("launch secret", () => {
  it("creates a 256-bit secret and the launch URL", () => {
    const s = new PortalSession({ env: {} });
    expect(Buffer.from(s.launchSecret!, "base64url")).toHaveLength(32);
    expect(s.launchUrl(4747)).toBe(`${base}/?launch=${s.launchSecret}`);
  });

  it("rejected without secret and with a wrong one", () => {
    const s = new PortalSession({ env: {} });
    expect(s.mayIssue(req("/api/session"))).toBe(false);
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": "falsch" }))).toBe(false);
    expect(s.mayIssue(req("/api/session?launch=falsch"))).toBe(false);
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": `${s.launchSecret}x` }))).toBe(false);
  });

  it("allowed with the correct secret (header or query), afterwards the cookie suffices", () => {
    const s = new PortalSession({ env: {} });
    expect(s.mayIssue(req("/api/session", { "x-secret-desk-launch": s.launchSecret! }))).toBe(true);
    expect(s.mayIssue(req(`/api/session?launch=${s.launchSecret}`))).toBe(true);
    expect(s.mayIssue(req("/api/session", { cookie: `sd_session=${s.cookie}` }))).toBe(true);
    expect(s.mayIssue(req("/api/session", { cookie: "sd_session=anderes" }))).toBe(false);
  });

  it("SECRET_DESK_NO_LAUNCH_SECRET=1 turns it off", () => {
    const s = new PortalSession({ env: { SECRET_DESK_NO_LAUNCH_SECRET: "1" } });
    expect(s.launchSecret).toBeNull();
    expect(s.launchUrl(4747)).toBeNull();
    expect(s.mayIssue(req("/api/session"))).toBe(true);
  });

  it("two sessions have different secrets", () => {
    expect(new PortalSession({ env: {} }).launchSecret).not.toBe(new PortalSession({ env: {} }).launchSecret);
  });
});

describe("Sec-Fetch-Site", () => {
  it("rejects cross-site and same-site, allows same-origin, none and missing", () => {
    const r = (v?: string) => req("/api/ui/overview", v ? { "sec-fetch-site": v } : {});
    expect(checkFetchSite(r())).toBe(true);
    expect(checkFetchSite(r("same-origin"))).toBe(true);
    expect(checkFetchSite(r("none"))).toBe(true);
    expect(checkFetchSite(r("cross-site"))).toBe(false);
    expect(checkFetchSite(r("same-site"))).toBe(false);
  });
});

describe("agent token file", () => {
  it("sets a too open file to 600 and warns", async () => {
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

  it("warns on Windows only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-token-"));
    const file = join(dir, "agent-token");
    await writeFile(file, `${"b".repeat(43)}\n`, { mode: 0o644 });
    const warnings: string[] = [];
    await loadOrCreateAgentToken(file, false, "win32", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  it("creates new with 600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-token-"));
    const file = join(dir, "x", "agent-token");
    await loadOrCreateAgentToken(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
