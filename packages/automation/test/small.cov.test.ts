import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChromeNotFoundError,
  SelectorSchema,
  WaitAbortedError,
  WaitTimeoutError,
  bundledRecipesDir,
  chromeInstallHint,
  conditionMet,
  describeSelector,
  findChrome,
  loadRecipesDetailed,
  pollCondition,
  probeCdp,
  resolveCdpEndpoint,
  textPattern,
  type ResolvedCondition,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("bundledRecipesDir", () => {
  it("points at the recipes folder in the repository root", () => {
    const dir = bundledRecipesDir();
    expect(path.basename(dir)).toBe("recipes");
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(path.dirname(dir))).not.toBe("automation");
  });
});

describe("cdp edge cases", () => {
  it("puts an IPv6 address from the lookup into brackets", async () => {
    expect(await resolveCdpEndpoint("http://browser:9222", async () => "fd00::5")).toBe("http://[fd00::5]:9222/");
  });
  it("does not check a WebSocket address over HTTP", async () => {
    const fetchMock = vi.fn();
    const r = await probeCdp("ws://127.0.0.1:9222/devtools/browser/abc", { fetch: fetchMock as unknown as typeof fetch });
    expect(r).toEqual({ reachable: false, browser: null, detail: "Not checked: the endpoint is a WebSocket address. Use http://host:port to check it." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("asks /json/version below a path that has no trailing slash", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify({ Browser: 42 }), { status: 200 }));
    const r = await probeCdp("http://127.0.0.1:9222/prefix", { fetch: fetchMock as unknown as typeof fetch });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:9222/prefix/json/version");
    expect(r).toEqual({ reachable: true, browser: null, detail: null });
  });
  it("reports a timeout and an abort as 'no answer', other failures as 'not reachable'", async () => {
    const failing = (name: string) => vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name }))) as unknown as typeof fetch;
    expect((await probeCdp("http://127.0.0.1:9222", { fetch: failing("TimeoutError") })).detail).toBe("No answer within the time limit.");
    expect((await probeCdp("http://127.0.0.1:9222", { fetch: failing("AbortError") })).detail).toBe("No answer within the time limit.");
    expect((await probeCdp("http://127.0.0.1:9222", { fetch: failing("TypeError") })).detail).toBe("The browser endpoint is not reachable.");
  });
  it("reports an invalid endpoint with the first line of the reason only", async () => {
    const r = await probeCdp("file:///etc/passwd");
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/only http, https, ws and wss/);
    expect(r.detail).not.toContain("\n");
  });
});

describe("chrome lookup", () => {
  it("names the path in the error and the missing configuration", () => {
    const err = new ChromeNotFoundError("Chrome nicht gefunden unter /x.");
    expect(err.name).toBe("ChromeNotFoundError");
    expect(err.message).toBe("Chrome nicht gefunden unter /x. automation.chromePath setzen oder Google Chrome installieren (es wird kein Browser heruntergeladen).");
  });
  it("findChrome: an existing preferred path is used, a missing one throws", () => {
    expect(findChrome(process.execPath)).toBe(process.execPath);
    expect(() => findChrome("/definitely/not/here/chrome")).toThrow(ChromeNotFoundError);
    expect(() => findChrome("/definitely/not/here/chrome")).toThrow("/definitely/not/here/chrome");
  });
  it("findChrome without a preference returns a known location or nothing", () => {
    const found = findChrome();
    expect(found === undefined || typeof found === "string").toBe(true);
  });
  it("gives a generic hint for macOS", () => {
    expect(chromeInstallHint("darwin")).toBe("Google Chrome installieren oder --chrome-path setzen.");
  });
});

describe("conditionMet and pollCondition", () => {
  const probe = (over: Partial<{ url: string; visible: boolean; text: boolean }> = {}) => ({
    currentUrl: async () => over.url ?? "https://example.test/",
    isVisible: async () => over.visible ?? false,
    hasText: async () => over.text ?? false,
  });
  it("a condition without any criterion holds", async () => {
    expect(await conditionMet(probe(), {})).toBe(true);
  });
  it("hidden holds once the element is not visible", async () => {
    expect(await conditionMet(probe({ visible: false }), { hidden: { css: "#x" } })).toBe(true);
    expect(await conditionMet(probe({ visible: true }), { hidden: { css: "#x" } })).toBe(false);
  });
  it("text, url and visible are asked from the browser", async () => {
    expect(await conditionMet(probe({ text: true }), { text: "Done" })).toBe(true);
    expect(await conditionMet(probe({ text: false }), { text: "" })).toBe(false);
    expect(await conditionMet(probe({ url: "https://example.test/ok" }), { url: /ok$/ })).toBe(true);
    expect(await conditionMet(probe({ visible: true }), { visible: { css: "#x" } })).toBe(true);
  });
  it("any ignores a part that throws and fails when none holds", async () => {
    const throwing = { ...probe(), isVisible: async (): Promise<boolean> => { throw new Error("detached"); } };
    const cond: ResolvedCondition = { any: [{ visible: { css: "#a" } }, { text: "x" }] };
    expect(await conditionMet({ ...throwing, hasText: async () => true }, cond)).toBe(true);
    expect(await conditionMet({ ...throwing, hasText: async () => false }, cond)).toBe(false);
  });

  it("polls until the condition holds", async () => {
    vi.useFakeTimers();
    let n = 0;
    const d = { ...probe(), isVisible: async () => ++n >= 3 };
    const p = pollCondition(d, { visible: { css: "#x" } }, 10_000, undefined, 100);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBeUndefined();
    expect(n).toBe(3);
  });
  it("treats a failing probe as not yet met and times out at the deadline", async () => {
    vi.useFakeTimers();
    const d = { ...probe(), isVisible: async (): Promise<boolean> => { throw new Error("detached"); } };
    const p = pollCondition(d, { visible: { css: "#x" } }, 500, undefined, 250);
    const assertion = expect(p).rejects.toBeInstanceOf(WaitTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
  it("aborts at once when the signal is already aborted, and wakes a sleeping poll when it aborts", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(pollCondition(probe(), { visible: { css: "#x" } }, 1000, aborted.signal)).rejects.toBeInstanceOf(WaitAbortedError);
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = pollCondition(probe(), { visible: { css: "#x" } }, 60_000, ac.signal, 30_000);
    const assertion = expect(p).rejects.toBeInstanceOf(WaitAbortedError);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
  it("error classes carry stable names and messages", () => {
    expect(new WaitTimeoutError()).toMatchObject({ name: "WaitTimeoutError", message: "Zeitlimit beim Warten" });
    expect(new WaitAbortedError()).toMatchObject({ name: "WaitAbortedError", message: "Abgebrochen" });
  });
});

describe("recipe loading edge cases", () => {
  it("rethrows a folder error that is not 'missing' (a file instead of a folder)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "recipes-"));
    const file = path.join(dir, "not-a-folder");
    await writeFile(file, "x");
    await expect(loadRecipesDetailed([file])).rejects.toMatchObject({ code: "ENOTDIR" });
  });
  it("names the whole document when a recipe is no mapping", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "recipes-"));
    await writeFile(path.join(dir, "bad.yaml"), "42\n");
    const r = await loadRecipesDetailed([dir]);
    expect(r.recipes).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toContain("bad.yaml: (Dokument):");
  });
});

describe("selector edge cases", () => {
  it("SelectorSchema reports a selector problem as an issue", () => {
    const r = SelectorSchema.safeParse({ name: "x" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toBe("Genau eines von role, label, text, placeholder, testid oder css angeben");
    expect(SelectorSchema.safeParse({ css: "#x" }).success).toBe(true);
  });
  it("describeSelector covers a bare role, testid and css", () => {
    expect(describeSelector({ role: "button" })).toBe("button");
    expect(describeSelector({ testid: "save" })).toBe("testid save");
    expect(describeSelector({ css: "#x" })).toBe("css #x");
    expect(describeSelector({})).toBe("css ?");
  });
  it("textPattern: a pattern with flags, a plain text, and a path-like text", () => {
    expect(textPattern("/^ab$/i")).toEqual(/^ab$/i);
    expect(textPattern("plain")).toBeNull();
    expect(textPattern("/path/to")).toBeNull();
  });
});
