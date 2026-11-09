import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOpenApi } from "../src/server/openapi.js";
import { checkHost, loadOrCreateAgentToken, loadOrCreateLaunchSecret } from "../src/server/security.js";

afterEach(() => vi.restoreAllMocks());
const dirOf = () => mkdtemp(join(tmpdir(), "sd-edge-"));

describe("openapi cache", () => {
  it("reads the description once when caching is on and every time otherwise", async () => {
    const dir = await dirOf();
    const file = join(dir, "openapi.yaml");
    await writeFile(file, "first");
    expect(await loadOpenApi([file], true)).toBe("first");
    await writeFile(file, "second");
    expect(await loadOpenApi([file], true)).toBe("first");
    expect(await loadOpenApi([file], false)).toBe("second");
    expect(await loadOpenApi([join(dir, "missing.yaml")], false)).toBeNull();
  });
});

describe("host check", () => {
  it("falls back to the host of the URL when the request carries no host header", () => {
    const req = new Request("http://127.0.0.1:4747/api/ui/x");
    req.headers.delete("host");
    expect(checkHost(req, new Set(["127.0.0.1:4747"]))).toBe(true);
    expect(checkHost(req, new Set(["localhost:4747"]))).toBe(false);
  });
});

describe("default warnings", () => {
  it("warns through the console when an agent token file is too open or cannot be checked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = join(await dirOf(), "agent-token");
    await writeFile(file, `${"a".repeat(43)}\n`);
    await chmod(file, 0o644);
    expect(await loadOrCreateAgentToken(file, false, "linux")).toBe("a".repeat(43));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await loadOrCreateAgentToken(file, false, "win32")).toBe("a".repeat(43));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("Windows");
  });
  it("warns through the console when the launch secret file is too open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = join(await dirOf(), "launch-secret");
    await writeFile(file, `${"b".repeat(43)}\n`);
    await chmod(file, 0o644);
    expect(await loadOrCreateLaunchSecret(file, "linux")).toBe("b".repeat(43));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("b".repeat(43));
  });
});
