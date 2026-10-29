import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiPath, ensureSession, resetSessionForTests, toApiError } from "../src/lib/api";
import { countdown, daysLabel, formatDate, formatDateTime, matchesQuery, placeText } from "../src/lib/format";
import { rowsToPlaces } from "../src/lib/places";
import { checkInfo, classifyVariableError, driftInfo, overallInfo, providerInfo, stageInfo, statusInfo, toneClass } from "../src/lib/status";

describe("format", () => {
  it("daysLabel", () => {
    expect(daysLabel(12)).toBe("in 12 Tagen");
    expect(daysLabel(1)).toBe("in 1 Tag");
    expect(daysLabel(0)).toBe("heute");
    expect(daysLabel(-5)).toBe("seit 5 Tagen abgelaufen");
    expect(daysLabel(-1)).toBe("seit 1 Tag abgelaufen");
    expect(daysLabel(null)).toBe("kein Ablauf");
  });
  it("date", () => {
    expect(formatDate("2026-11-02")).toBe("02.11.2026");
    expect(formatDate(null)).toBe("–");
    expect(formatDate("kaputt")).toBe("–");
    expect(formatDateTime("2026-11-02T10:05:00")).toBe("02.11.2026, 10:05");
  });
  it("Countdown", () => {
    expect(countdown(125_000)).toBe("02:05");
    expect(countdown(-5)).toBe("00:00");
    expect(countdown(59_999)).toBe("00:59");
  });
  it("search and target", () => {
    expect(matchesQuery("", "x")).toBe(true);
    expect(matchesQuery("ACME", "acme-app")).toBe(true);
    expect(matchesQuery("zzz", "a", null)).toBe(false);
    expect(placeText({ repo: "r", scope: "environment", environment: "staging" })).toBe("r / staging");
    expect(placeText({ repo: "r", scope: "repository" })).toBe("r / Repository");
  });
});

describe("status", () => {
  it("every level has text, tone and symbol", () => {
    const levels = ["ok", "soon", "due", "expired", "missing", "no-date", "unknown"] as const;
    for (const l of levels) {
      const i = statusInfo(l);
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.icon).toBeTruthy();
    }
    expect(statusInfo("ok")).toMatchObject({ label: "In Ordnung", tone: "success" });
    expect(statusInfo("soon").label).toBe("Läuft bald ab");
    expect(statusInfo("due")).toMatchObject({ label: "Fällig", tone: "warn-strong" });
    expect(statusInfo("expired")).toMatchObject({ label: "Abgelaufen", tone: "danger" });
    expect(statusInfo("missing").label).toBe("Fehlt in GitHub");
    expect(statusInfo("no-date").label).toBe("Datum fehlt");
    expect(statusInfo("unknown")).toMatchObject({ label: "Ablauf unklar", tone: "neutral" });
  });
  it("stage, provider, review, drift", () => {
    expect(stageInfo("production").tone).toBe("stage-prod");
    expect(stageInfo("dev").tone).toBe("info");
    expect(stageInfo("staging").tone).toBe("ki");
    expect(stageInfo("shared").tone).toBe("neutral");
    expect(providerInfo(true).label).toBe("automatisch");
    expect(providerInfo(false).label).toBe("von Hand");
    expect(checkInfo("fail").label).toBe("Fehlgeschlagen");
    expect(overallInfo("warn").label).toBe("mit Hinweisen");
    expect(driftInfo("in-sync").label).toBe("Stimmt überein");
    expect(driftInfo("different").label).toBe("Weicht ab");
    expect(driftInfo("unknown-expected").label).toBe("Sollwert unbekannt");
    expect(driftInfo("unreachable").label).toBe("Nicht erreichbar");
    expect(toneClass("danger")).toContain("danger");
  });
  it("classify variable errors: by the code only, not by the text", () => {
    expect(classifyVariableError({ code: "secret-blocked" })).toBe("secret");
    expect(classifyVariableError({ code: "secret-ack" })).toBe("acknowledge");
    expect(classifyVariableError({ code: "not-connected" })).toBe("other");
    expect(classifyVariableError({})).toBe("other");
    expect(classifyVariableError(null)).toBe("other");
    // Text allein genuegt nicht mehr (auch nicht in der englischen Fassung).
    expect(classifyVariableError(new Error("Looks like a Stripe secret key. acknowledgedPublic") as { code?: string })).toBe("other");
  });
});

describe("places", () => {
  it("empty rows are dropped, errors are reported", () => {
    expect(rowsToPlaces([{ repo: "", scope: "repository", environment: "" }])).toEqual({ places: [], error: null });
    expect(rowsToPlaces([{ repo: "a", scope: "environment", environment: "" }]).error).toMatch(/Umgebungsname/);
    expect(rowsToPlaces([{ repo: "", scope: "repository", environment: "x" }]).error).toMatch(/Repository/);
    expect(rowsToPlaces([{ repo: " a ", scope: "environment", environment: "staging" }, { repo: "b", scope: "repository", environment: "ignoriert" }]).places).toEqual([
      { repo: "a", scope: "environment", environment: "staging" },
      { repo: "b", scope: "repository" },
    ]);
  });
});

describe("api", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let handler: (url: string, init?: RequestInit) => Response;
  beforeEach(() => {
    resetSessionForTests();
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return handler(url, init);
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  it("path and error shape", () => {
    expect(apiPath("/overview")).toBe("/api/ui/overview");
    const e = toApiError(409, { error: "nein", code: "not-connected", hint: "h", connection: "github" });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, message: "nein", code: "not-connected", hint: "h", connection: "github" });
    expect(toApiError(500, null).message).toMatch(/500/);
  });

  it("fetches the session once and sends the CSRF token", async () => {
    handler = (url) => (url === "/api/session" ? json({ csrf: "abc", user: "n", demo: true, owner: "o" }) : json({ ok: 1 }));
    await api("GET", "overview");
    await api("POST", "x", { a: 1 });
    expect(calls.filter((c) => c.url === "/api/session")).toHaveLength(1);
    const post = calls.find((c) => c.url === "/api/ui/x")!;
    expect((post.init!.headers as Record<string, string>)["x-secret-desk-csrf"]).toBe("abc");
    expect(post.init!.body).toBe('{"a":1}');
    expect(post.init!.credentials).toBe("same-origin");
  });

  it("fetches the session again on 401 and retries once", async () => {
    let n = 0;
    handler = (url) => {
      if (url === "/api/session") return json({ csrf: `c${++n}`, user: "n", demo: false, owner: "o" });
      return n < 2 ? json({ error: "Sitzung" }, 401) : json({ fine: true });
    };
    await expect(api("GET", "overview")).resolves.toEqual({ fine: true });
    expect(n).toBe(2);
  });

  it("throws ApiError with code on 409", async () => {
    handler = (url) => (url === "/api/session" ? json({ csrf: "c", user: "n", demo: false, owner: "o" }) : json({ error: "fehlt", code: "not-connected", connection: "github", hint: "Token" }, 409));
    await expect(api("POST", "renewal-requests", {})).rejects.toMatchObject({ status: 409, code: "not-connected", connection: "github" });
    expect((await ensureSession()).csrf).toBe("c");
  });
});
