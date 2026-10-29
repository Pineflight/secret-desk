import { describe, expect, it, vi } from "vitest";
import { MAX_TAGS, addTags, isHttpUrl, parseTags, truncate, validateTag } from "../src/lib/tags";
import { refreshCounts, refreshVersion, subscribeRefresh } from "../src/lib/refresh";

describe("tags", () => {
  it("splits input, lower-case and without duplicates", () => {
    expect(parseTags("Zahlungen, acme-web;zahlungen  neu")).toEqual(["zahlungen", "acme-web", "neu"]);
    expect(parseTags(" , ")).toEqual([]);
  });
  it("checks the format", () => {
    expect(validateTag("ok-1")).toBeNull();
    expect(validateTag("Gross")).toMatch(/ungültig/);
    expect(validateTag("-start")).toMatch(/ungültig/);
    expect(validateTag("a_b")).toMatch(/ungültig/);
    expect(validateTag("")).toMatch(/leer/);
  });
  it("addTags: add, errors leave the list unchanged, limit", () => {
    expect(addTags(["a"], "b, a")).toEqual({ tags: ["a", "b"], error: null });
    expect(addTags(["a"], "b, ungültig!")).toMatchObject({ tags: ["a"] });
    expect(addTags(["a"], "b, ungültig!").error).toMatch(/ungültig/);
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTags(full, "neu").error).toMatch(/Höchstens/);
  });
});

describe("texts and links", () => {
  it("shortens to one line", () => {
    expect(truncate("kurz")).toBe("kurz");
    expect(truncate("a\n  b", 10)).toBe("a b");
    const t = truncate("x".repeat(200), 20);
    expect(t.length).toBe(20);
    expect(t.endsWith("…")).toBe(true);
    expect(truncate(null)).toBe("");
  });
  it("allows only http and https", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("kein link")).toBe(false);
  });
});

describe("refresh counters", () => {
  it("notifies subscribers and can be unsubscribed", () => {
    const fn = vi.fn();
    const off = subscribeRefresh(fn);
    const v = refreshVersion();
    refreshCounts();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(refreshVersion()).toBe(v + 1);
    off();
    refreshCounts();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach } from "vitest";
import { api, resetSessionForTests } from "../src/lib/api";

describe("api triggers a refresh only on changes", () => {
  beforeEach(() => {
    resetSessionForTests();
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url === "/api/session" ? { csrf: "c", user: "u", demo: false, owner: "o" } : { ok: true }), { status: 200 }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("not GET, yes POST", async () => {
    const fn = vi.fn();
    const off = subscribeRefresh(fn);
    await api("GET", "overview");
    expect(fn).not.toHaveBeenCalled();
    await api("POST", "reviews/x/confirm", {});
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
