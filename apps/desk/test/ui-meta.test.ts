import { describe, expect, it, vi } from "vitest";
import { MAX_TAGS, addTags, isHttpUrl, parseTags, truncate, validateTag } from "../src/lib/tags";
import { refreshCounts, refreshVersion, subscribeRefresh } from "../src/lib/refresh";

describe("Schlagworte", () => {
  it("zerlegt Eingaben, klein und ohne Dubletten", () => {
    expect(parseTags("Zahlungen, acme-web;zahlungen  neu")).toEqual(["zahlungen", "acme-web", "neu"]);
    expect(parseTags(" , ")).toEqual([]);
  });
  it("prüft das Format", () => {
    expect(validateTag("ok-1")).toBeNull();
    expect(validateTag("Gross")).toMatch(/ungültig/);
    expect(validateTag("-start")).toMatch(/ungültig/);
    expect(validateTag("a_b")).toMatch(/ungültig/);
    expect(validateTag("")).toMatch(/leer/);
  });
  it("addTags: hinzufügen, Fehler lassen die Liste unverändert, Grenze", () => {
    expect(addTags(["a"], "b, a")).toEqual({ tags: ["a", "b"], error: null });
    expect(addTags(["a"], "b, ungültig!")).toMatchObject({ tags: ["a"] });
    expect(addTags(["a"], "b, ungültig!").error).toMatch(/ungültig/);
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTags(full, "neu").error).toMatch(/Höchstens/);
  });
});

describe("Texte und Links", () => {
  it("kürzt auf eine Zeile", () => {
    expect(truncate("kurz")).toBe("kurz");
    expect(truncate("a\n  b", 10)).toBe("a b");
    const t = truncate("x".repeat(200), 20);
    expect(t.length).toBe(20);
    expect(t.endsWith("…")).toBe(true);
    expect(truncate(null)).toBe("");
  });
  it("erlaubt nur http und https", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("kein link")).toBe(false);
  });
});

describe("Zähler auffrischen", () => {
  it("benachrichtigt Abonnenten und lässt sich abbestellen", () => {
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

describe("api löst Auffrischen nur bei Änderungen aus", () => {
  beforeEach(() => {
    resetSessionForTests();
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url === "/api/session" ? { csrf: "c", user: "u", demo: false, owner: "o" } : { ok: true }), { status: 200 }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it("GET nicht, POST ja", async () => {
    const fn = vi.fn();
    const off = subscribeRefresh(fn);
    await api("GET", "overview");
    expect(fn).not.toHaveBeenCalled();
    await api("POST", "reviews/x/confirm", {});
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
