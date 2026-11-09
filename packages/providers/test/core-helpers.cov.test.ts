import { describe, expect, it } from "vitest";
import { ParamsInvalidError, UnknownDiscoverKindError, type DiscoveredOption } from "@secret-desk/core";
import { check, day, daysApart, isRecord, probe, sameSet, step, steps, strings } from "../src/checks.js";
import { asList, needParam, readFailure, str, unknownKind } from "../src/discover.js";
import { callJson, expiryFrom, optionalString, ProviderError, requireInt, requireString, requireStringArray, revokeIdempotent, safeText } from "../src/http.js";
import { readVariableField } from "../src/variable-sources.js";
import { signRequest } from "../src/sigv4.js";
import { randomProviders } from "../src/random.js";
import { connections, mockFetch, routeFetch, verifyCtx } from "./helpers.js";

const fetchOf = (impl: () => Promise<Response>) => impl as unknown as typeof fetch;

describe("callJson error paths", () => {
  it("falls back to the status text when the error body is empty", async () => {
    const f = fetchOf(async () => new Response("", { status: 500, statusText: "Server Broke" }));
    await expect(callJson("p", f, "https://x.example", {}, [])).rejects.toThrow("p (HTTP 500): Server Broke");
  });
  it("falls back to a generic message when body and status text are empty", async () => {
    const f = fetchOf(async () => new Response("", { status: 500, statusText: "" }));
    await expect(callJson("p", f, "https://x.example", {}, [])).rejects.toThrow("p (HTTP 500): Fehler");
  });
  it("rejects a body that is not JSON", async () => {
    const f = fetchOf(async () => new Response("<html>", { status: 200 }));
    await expect(callJson("p", f, "https://x.example", {}, [])).rejects.toThrow("Antwort ist kein gueltiges JSON");
  });
  it("treats an unreadable error body as empty", async () => {
    const res = new Response("x", { status: 500, statusText: "Oops" });
    Object.defineProperty(res, "text", { value: () => Promise.reject(new Error("stream broke")) });
    await expect(callJson("p", fetchOf(async () => res), "https://x.example", {}, [])).rejects.toThrow("p (HTTP 500): Oops");
  });
  it("maps a timeout and a network error to a ProviderError", async () => {
    const timeout = fetchOf(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(callJson("p", timeout, "https://x.example", {}, [])).rejects.toThrow("Zeitueberschreitung nach 20 s");
    const net = fetchOf(async () => {
      throw new Error("down for SECRET-X");
    });
    await expect(callJson("p", net, "https://x.example", {}, ["SECRET-X"])).rejects.not.toThrow(/SECRET-X/);
  });
  it("returns undefined for an empty 200 body", async () => {
    expect(await callJson("p", fetchOf(async () => new Response("  ", { status: 200 })), "https://x.example", {}, [])).toBeUndefined();
  });
  it("does not follow redirects", async () => {
    const m = mockFetch({ status: 302 });
    await expect(callJson("p", m.fetch, "https://x.example", {}, [])).rejects.toThrow("Weiterleitung nicht gefolgt");
  });
});

describe("param helpers", () => {
  it("optionalString: undefined, null, blank, text, wrong type", () => {
    expect(optionalString("p", {}, "k")).toBeUndefined();
    expect(optionalString("p", { k: null }, "k")).toBeUndefined();
    expect(optionalString("p", { k: "   " }, "k")).toBeUndefined();
    expect(optionalString("p", { k: " a " }, "k")).toBe("a");
    expect(() => optionalString("p", { k: 3 }, "k")).toThrow('Parameter "k" muss Text sein');
  });
  it("requireString rejects blank and non-text", () => {
    expect(() => requireString("p", { k: " " }, "k")).toThrow("fehlt oder ist kein Text");
    expect(requireString("p", { k: " v " }, "k")).toBe("v");
  });
  it("requireStringArray accepts lists of text only", () => {
    expect(requireStringArray("p", { k: ["a", "b"] }, "k")).toEqual(["a", "b"]);
    for (const bad of [undefined, "a", [], [1], ["a", ""]]) {
      expect(() => requireStringArray("p", { k: bad }, "k")).toThrow("nicht leere Liste von Texten");
    }
  });
  it("requireInt accepts positive integers only", () => {
    expect(requireInt("p", { k: 5 }, "k")).toBe(5);
    for (const bad of ["5", 1.5, 0, -2, undefined]) {
      expect(() => requireInt("p", { k: bad }, "k")).toThrow("positive ganze Zahl");
    }
  });
  it("expiryFrom is undefined without ttl and strips milliseconds", () => {
    expect(expiryFrom(new Date("2026-11-01T10:00:00.123Z"), undefined)).toBeUndefined();
    expect(expiryFrom(new Date("2026-11-01T10:00:00.123Z"), 1)).toBe("2026-11-02T10:00:00Z");
  });
  it("revokeIdempotent: 404 is already gone, other errors and non-provider errors propagate", async () => {
    expect(await revokeIdempotent(async () => undefined)).toBe("revoked");
    expect(await revokeIdempotent(async () => { throw new ProviderError("p", 404, "x"); })).toBe("already-gone");
    await expect(revokeIdempotent(async () => { throw new ProviderError("p", 500, "x"); })).rejects.toThrow("HTTP 500");
    await expect(revokeIdempotent(async () => { throw new Error("plain"); })).rejects.toThrow("plain");
  });
  it("safeText redacts, masks field values and truncates", () => {
    expect(safeText('{"token":"abc"}', [])).toBe('{"token":"***"}');
    expect(safeText("x".repeat(300), [])).toHaveLength(203);
  });
});

describe("checks helpers", () => {
  it("probe: invalid JSON gives undefined json, empty body too", async () => {
    const ctx = (body: string) => verifyCtx(fetchOf(async () => new Response(body, { status: 200 })), {});
    expect((await probe("p", ctx("not json"), "https://x.example", {}, [])).json).toBeUndefined();
    expect((await probe("p", ctx(""), "https://x.example", {}, [])).json).toBeUndefined();
    expect((await probe("p", ctx('{"a":1}'), "https://x.example", {}, [])).json).toEqual({ a: 1 });
  });
  it("probe: unreadable body is treated as empty", async () => {
    const res = new Response("x");
    Object.defineProperty(res, "text", { value: () => Promise.reject(new Error("broke")) });
    const r = await probe("p", verifyCtx(fetchOf(async () => res), {}), "https://x.example", {}, []);
    expect(r).toMatchObject({ status: 200, json: undefined });
  });
  it("probe: timeout, abort, error without message, error with message", async () => {
    const run = (e: unknown) => probe("p", verifyCtx(fetchOf(async () => { throw e; }), {}), "https://x.example", {}, ["SECRET-Y"]);
    await expect(run(Object.assign(new Error("a"), { name: "AbortError" }))).rejects.toThrow("Zeitueberschreitung nach 20 s");
    await expect(run({ name: "Weird" })).rejects.toThrow("Anfrage fehlgeschlagen: Fehler");
    await expect(run(new Error("boom SECRET-Y"))).rejects.toThrow(/Anfrage fehlgeschlagen: boom \*+/);
  });
  it("step turns an Error into a warn, a non-Error into an unknown-error warn", async () => {
    const ctx = verifyCtx(mockFetch().fetch, {});
    expect(await step(ctx, "i", "L", async () => { throw new Error("bad"); })).toEqual([check("i", "L", "warn", { detail: "Pruefung nicht moeglich: bad" })]);
    expect(await step(ctx, "i", "L", async () => { throw "str"; })).toEqual([check("i", "L", "warn", { detail: "Pruefung nicht moeglich: Unbekannter Fehler" })]);
    expect(await step(ctx, "i", "L", async () => [])).toEqual([]);
  });
  it("small helpers", async () => {
    expect(await steps([Promise.resolve([check("a", "A", "pass")]), Promise.resolve([])])).toHaveLength(1);
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(sameSet(["a", "b"], ["b", "c"])).toEqual({ missing: ["c"], extra: ["a"] });
    expect(strings(["a"])).toEqual(["a"]);
    expect(strings([1])).toBeUndefined();
    expect(strings("a")).toBeUndefined();
    expect(daysApart("2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z")).toBe(1);
    expect(day("2026-11-02T10:00:00Z")).toBe("2026-11-02");
  });
});

describe("discover helpers", () => {
  const specs = [{ key: "accountId", label: "Konto", labelEn: "Account", type: "string", required: true, help: "", helpEn: "" }] as const;
  it("needParam: string, number, and a missing value with and without a spec", () => {
    expect(needParam(specs, { accountId: " a1 " }, "accountId")).toBe("a1");
    expect(needParam(specs, { accountId: 7 }, "accountId")).toBe("7");
    try {
      needParam(specs, {}, "accountId");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParamsInvalidError);
      expect((e as ParamsInvalidError).problems[0]).toMatchObject({ key: "accountId", code: "missing", label: "Konto", labelEn: "Account" });
    }
    try {
      needParam([], { zone: "  " }, "zone");
      expect.unreachable();
    } catch (e) {
      expect((e as ParamsInvalidError).problems[0]).toMatchObject({ label: "zone", labelEn: "zone" });
    }
  });
  it("asList and str", () => {
    expect(asList([{ a: 1 }, 3, null])).toEqual([{ a: 1 }]);
    expect(asList({ data: [{ a: 1 }] }, "data")).toEqual([{ a: 1 }]);
    expect(asList("nope", "data")).toEqual([]);
    expect(asList({ data: "x" }, "data")).toEqual([]);
    expect(str("a")).toBe("a");
    expect(str("")).toBeUndefined();
    expect(str(1)).toBeUndefined();
  });
  it("readFailure: 401/403, other provider errors, plain errors, non-errors", () => {
    expect(readFailure(new ProviderError("p", 403, "no"), "Zones")).toMatchObject({ label: "Zones nicht lesbar: dem Token fehlt das Leserecht" });
    expect(readFailure(new ProviderError("p", 401, "no"), "Zones").label).toContain("Leserecht");
    expect(readFailure(new ProviderError("p", 500, "no"), "Zones")).toMatchObject({ label: "Zones nicht lesbar", detail: "p (HTTP 500): no" });
    expect(readFailure(new Error("net"), "Zones").detail).toBe("net");
    expect(readFailure("x", "Zones").detail).toBe("Fehler");
  });
  it("unknownKind throws", () => {
    expect(() => unknownKind("x.y")).toThrow(UnknownDiscoverKindError);
  });
});

describe("readVariableField", () => {
  const opt = (value: string, label = "Label"): DiscoveredOption => ({ value, label });
  const ctxFor = (...routes: Parameters<typeof routeFetch>) => ({ ...routeFetch(...routes), connections: connections("supabase") });
  it("returns ids, labels and derived urls without network", async () => {
    const m = mockFetch();
    const ctx = { fetch: m.fetch, connections: connections() };
    for (const [kind, field] of [["supabase.project", "ref"], ["cloudflare.account", "accountId"], ["cloudflare.zone", "zoneId"], ["cloudflare.turnstileWidget", "sitekey"], ["resend.domain", "domainId"]] as const) {
      expect(await readVariableField(kind, field, opt("id-1"), ctx)).toBe("id-1");
    }
    expect(await readVariableField("cloudflare.zone", "name", opt("z", "example.com"), ctx)).toBe("example.com");
    expect(await readVariableField("resend.domain", "name", opt("d", "mail.example.com"), ctx)).toBe("mail.example.com");
    expect(await readVariableField("supabase.project", "url", opt("abc"), ctx)).toBe("https://abc.supabase.co");
    expect(m.calls).toHaveLength(0);
  });
  it("rejects an unknown field", async () => {
    await expect(readVariableField("supabase.project", "nope", opt("a"), { fetch: mockFetch().fetch, connections: connections() })).rejects.toThrow("Feld nicht erlaubt: nope");
  });
  it("picks the publishable key and never a secret or service_role key", async () => {
    const keys = [
      { name: "service_role", type: "legacy", api_key: "SRV" },
      { name: "x", type: "secret", api_key: "SEC" },
      { name: "anon", type: "legacy", api_key: "" },
      { name: "default", type: "publishable", api_key: "PUB" },
    ];
    const m = ctxFor({ url: "/v1/projects/p%201/api-keys", reply: { body: keys } });
    expect(await readVariableField("supabase.project", "publishableKey", opt("p 1"), m)).toBe("PUB");
    expect(m.calls[0]!.url).toBe("https://api.supabase.com/v1/projects/p%201/api-keys");
    const byName = ctxFor({ url: "api-keys", reply: { body: [{ name: "anon", type: "legacy", api_key: "ANON" }] } });
    expect(await readVariableField("supabase.project", "publishableKey", opt("p"), byName)).toBe("ANON");
  });
  it("fails when there is no public key", async () => {
    const m = ctxFor({ url: "api-keys", reply: { body: [{ name: "service_role", type: "publishable", api_key: "SRV" }, { name: "x", type: "secret", api_key: "S" }] } });
    await expect(readVariableField("supabase.project", "publishableKey", opt("p"), m)).rejects.toThrow("Kein oeffentlicher Schluessel");
  });
});

describe("signRequest", () => {
  const base = { method: "get", region: "auto", service: "s3", accessKeyId: "AK", secretAccessKey: "SK", now: new Date("2026-11-01T10:00:00Z") };
  it("sorts query parameters by key, then by value", () => {
    const s = signRequest({ ...base, url: "https://h.example/a%20b?b=2&a=2&a=1&c=1&a=3" });
    expect(s.canonicalRequest.split("\n")[1]).toBe("/a%20b");
    expect(s.canonicalRequest.split("\n")[2]).toBe("a=1&a=2&a=3&b=2&c=1");
  });
  it("percent-encodes the characters encodeURIComponent leaves alone", () => {
    const s = signRequest({ ...base, url: "https://h.example/a(b)*'!" });
    expect(s.canonicalRequest.split("\n")[1]).toBe("/a%28b%29%2A%27%21");
  });
  it("signs extra headers with lower-cased names and collapsed whitespace", () => {
    const s = signRequest({ ...base, url: "https://h.example/x", headers: { "Content-Type": "  text/plain;   charset=utf-8 " } });
    expect(s.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(s.canonicalRequest).toContain("content-type:text/plain; charset=utf-8\n");
    expect(s.canonicalRequest.split("\n").at(-2)).toBe("content-type;host;x-amz-date");
  });
  it("signs the root path", () => {
    expect(signRequest({ ...base, url: "https://h.example" }).canonicalRequest.split("\n")[1]).toBe("/");
  });
});

describe("random: bytes fallback", () => {
  it("uses 32 bytes when bytes is not an integer number", async () => {
    const p = randomProviders.find((x) => x.id === "random-hex")!;
    expect((await p.verify!(verifyCtx(mockFetch().fetch, { bytes: "x" }, { value: "a".repeat(64) }))).find((c) => c.id === "shape")!.status).toBe("pass");
    expect((await p.verify!(verifyCtx(mockFetch().fetch, { bytes: 1.5 }, { value: "a".repeat(64) }))).find((c) => c.id === "shape")!.status).toBe("pass");
  });
});
