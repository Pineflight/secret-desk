import { describe, expect, it, vi, afterEach } from "vitest";
import { describeSelector } from "@secret-desk/automation";
import { LIVE_CHECK_PLACEHOLDER, LiveCheckBusyError, getLiveCheck, isLiveCheckRunning, liveCheckDriver, liveCheckDue, runLiveCheck, startLiveCheck } from "../src/live-check.js";
import { FAKE_HOOK_URL, FAKE_PAGE_TEXT, FAKE_TOKEN, GENERATE, driverFor, newWorld, setup } from "./helpers/live-check-world.js";

afterEach(() => {
  vi.useRealTimers();
});

const CONNECTIONS = "connections:\n  openai: { type: env, name: OPENAI_TEST }\n  resend: { type: env, name: RESEND_TEST }\n";
const apiFetch = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.startsWith("https://hooks.example.com/")) return new Response("ok", { status: 200 });
  if (u.includes("api.openai.com")) return new Response("{}", { status: 200 });
  if (u.includes("api.resend.com")) return new Response(`{"message":"bad key ${FAKE_TOKEN}2"}`, { status: 401 });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const leaks = (value: unknown, lines: string[]): void => {
  const text = JSON.stringify(value) + lines.join("\n");
  for (const secret of [FAKE_TOKEN, FAKE_PAGE_TEXT, FAKE_HOOK_URL, "MADEUPHOOKPATH0003"]) expect(text).not.toContain(secret);
};

describe("live check: API connections", () => {
  it("checks connected integrations read-only, reports failures and not-connected ones apart", async () => {
    const { rt, log, lines, fetchCalls } = await setup({ connections: CONNECTIONS, env: { OPENAI_TEST: FAKE_TOKEN, RESEND_TEST: `${FAKE_TOKEN}2` }, fetch: apiFetch });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    const by = Object.fromEntries(report.connections.map((c) => [c.id, c]));
    expect(by["openai"]).toEqual({ id: "openai", result: "ok" });
    expect(by["resend"]).toMatchObject({ id: "resend", result: "failed" });
    expect(by["resend"]!.detail).toBeTruthy();
    expect(by["github"]).toEqual({ id: "github", result: "not-connected" });
    expect(report.ok).toBe(false);
    expect(report.trigger).toBe("manual");
    expect(report.summary.connections).toMatchObject({ ok: 1, failed: 1 });
    expect(report.summary.connections.notConnected).toBeGreaterThan(0);
    // Read only: nothing but GET, and never a probe entry at GitHub.
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((c) => c.method === "GET")).toBe(true);
    expect(fetchCalls.some((c) => /SD_WRITE_PROBE/.test(c.url))).toBe(false);
    leaks(report, lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/live check \(manual\) FAILED: resend/);
    expect(rt.automation.liveCheckReports()[0]).toEqual(report);
  });

  it("is ok when everything that is connected works, and no recipe means no browser", async () => {
    const { rt, log, world } = await setup({ connections: "connections:\n  openai: { type: env, name: OPENAI_TEST }\n", env: { OPENAI_TEST: FAKE_TOKEN }, fetch: apiFetch });
    const report = await runLiveCheck(rt, { trigger: "schedule", log });
    expect(report.ok).toBe(true);
    expect(report.recipes).toEqual([]);
    expect(world.drivers).toHaveLength(0);
  });

  it("works with the browser automation off (the API part still runs)", async () => {
    const { rt, log } = await setup({ recipes: ["ok-create"], automation: "automation:\n  enabled: false\n", connections: "connections:\n  openai: { type: env, name: OPENAI_TEST }\n", env: { OPENAI_TEST: FAKE_TOKEN }, fetch: apiFetch });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes).toEqual([]);
    expect(report.connections.find((c) => c.id === "openai")?.result).toBe("ok");
  });
});

describe("live check: recipes", () => {
  it("runs a create recipe up to, but not into, the click that creates the token", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), visible: [describeSelector({ label: "Token name" }), GENERATE, describeSelector({ role: "button", name: "Pick" })], pageText: [FAKE_PAGE_TEXT] });
    const { rt, log, lines } = await setup({ recipes: ["ok-create"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes).toHaveLength(1);
    expect(report.recipes[0]).toMatchObject({ id: "ok-create", result: "ok" });
    expect(report.recipes[0]!.detail).toMatch(/1 per-item step\(s\) left out/);
    const d = world.drivers[0]!;
    // No click at all (the picker step belongs to a list and was left out; the create click is where the dry run stops).
    expect(d.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(d.filled.get(describeSelector({ label: "Token name" }))).toBe(LIVE_CHECK_PLACEHOLDER);
    expect(d.calls.filter((c) => c.startsWith("goto"))[0]).toContain(`name=${LIVE_CHECK_PLACEHOLDER}`);
    expect(d.closed).toBe(true);
    // Nothing was read from the page: no text, no attribute, no screenshot.
    expect(d.calls.some((c) => c.startsWith("screenshot"))).toBe(false);
    leaks(report, lines);
  });

  it("never calls the create click, even when the button is on the page", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), visible: [describeSelector({ label: "Token name" }), GENERATE] });
    const { rt, log } = await setup({ recipes: ["ok-create"], world });
    await runLiveCheck(rt, { trigger: "manual", log });
    expect(world.drivers[0]!.calls).not.toContain(`click ${GENERATE}`);
  });

  it("stops a read recipe before any capture: no text or attribute is read, no picture is taken, no value is reported", async () => {
    const world = newWorld({ signedIn: new Set(["b.example.com"]), visible: [describeSelector({ css: "#k1" }), describeSelector({ css: "#k2" })] });
    const reads: string[] = [];
    const { rt, log, lines } = await setup({
      recipes: ["read-mode"],
      world,
      driver: () => {
        const d = driverFor(world);
        d.readText = async (sel) => void reads.push(`text ${describeSelector(sel)}`) as never;
        d.readAttribute = async (sel, name) => void reads.push(`attr ${describeSelector(sel)}@${name}`) as never;
        return d;
      },
    });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "read-mode", result: "ok" });
    expect(reads).toEqual([]);
    expect(world.drivers[0]!.shots).toEqual([]);
    leaks(report, lines);
  });

  it("derives a placeholder from the recipe's own options when a required choice has no default", async () => {
    const world = newWorld({ signedIn: new Set(["i.example.com"]) });
    const { rt, log } = await setup({ recipes: ["choice-host"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "choice-host", result: "ok" });
    expect(world.drivers[0]!.calls).toContain("goto https://i.example.com/keys");
    expect(world.drivers[0]!.calls).not.toContain("goto https://test.i.example.com/keys");
  });

  it("reports a signed-out browser as needs-sign-in at once, without waiting and without typing", async () => {
    const world = newWorld({ visible: [describeSelector({ label: "Token name" })] });
    const { rt, log } = await setup({ recipes: ["signed-out"], world });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // No timer is advanced: the run has to end on its own.
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "signed-out", result: "needs-sign-in", step: "goto" });
    expect(report.recipes[0]!.detail).toMatch(/signed out/);
    expect(report.ok).toBe(true);
    expect(report.summary.recipes.needsSignIn).toBe(1);
    const d = world.drivers[0]!;
    expect(d.filled.size).toBe(0);
    expect(d.calls.some((c) => /^(fill|press|click|select|check)/.test(c))).toBe(false);
    expect(d.closed).toBe(true);
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("reports a 'Confirm access' prompt as needs-sign-in without answering it", async () => {
    const world = newWorld({
      signedIn: new Set(["e.example.com"]),
      pageText: ["Confirm access"],
      visible: [describeSelector({ css: 'input[name="sudo_password"]' })],
    });
    const { rt, log } = await setup({ recipes: ["sudo-prompt"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "sudo-prompt", result: "needs-sign-in", step: "confirmAccess github-sudo" });
    expect(report.recipes[0]!.detail).toMatch(/person/);
    expect(report.ok).toBe(true);
    const d = world.drivers[0]!;
    expect(d.filled.size).toBe(0);
    expect(d.calls.some((c) => /^(fill|press|click)/.test(c))).toBe(false);
  });

  it("passes a 'Confirm access' step when the provider does not ask", async () => {
    const world = newWorld({ signedIn: new Set(["e.example.com"]), visible: [describeSelector({ label: "Token name" })] });
    const { rt, log } = await setup({ recipes: ["sudo-prompt"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "sudo-prompt", result: "ok" });
    expect(report.recipes[0]!.detail).not.toMatch(/left out/);
  });

  it("fails a recipe whose step no longer works, with step label and error kind but no page text", async () => {
    const world = newWorld({ signedIn: new Set(["c.example.com"]), pageText: [FAKE_PAGE_TEXT], visible: [GENERATE] });
    const { rt, log, lines } = await setup({ recipes: ["broken-click"], world });
    const report = await runLiveCheck(rt, { trigger: "schedule", log });
    expect(report.recipes[0]).toMatchObject({ id: "broken-click", result: "failed", kind: "step", step: `click ${describeSelector({ role: "button", name: "Renamed button" })}` });
    expect(report.recipes[0]!.detail).toMatch(/Schritt 2/);
    expect(report.ok).toBe(false);
    expect(report.summary.recipes.failed).toBe(1);
    expect(lines[0]).toMatch(/FAILED: broken-click/);
    leaks(report, lines);
    expect(world.drivers[0]!.closed).toBe(true);
  });

  it("skips a recipe whose required inputs cannot be derived, with the reason", async () => {
    const { rt, log, world } = await setup({ recipes: ["needs-param"] });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "needs-param", result: "skipped" });
    expect(report.recipes[0]!.detail).toMatch(/account/);
    expect(world.drivers).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("skips a recipe whose steps all work on a list of items", async () => {
    const { rt, log, world } = await setup({ recipes: ["list-only"] });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "list-only", result: "skipped", detail: "All steps work on a list of real items." });
    expect(world.drivers).toHaveLength(0);
  });

  it("skips a recipe that says the account does not offer the feature (unsupported is not a broken recipe)", async () => {
    const world = newWorld({ signedIn: new Set(["h.example.com"]) });
    const { rt, log } = await setup({ recipes: ["unsupported-page"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes[0]).toMatchObject({ id: "unsupported-page", result: "skipped", kind: "unsupported" });
    expect(report.ok).toBe(true);
  });

  it("skips (not fails) when the browser cannot be started or opened", async () => {
    const a = await setup({ recipes: ["ok-create"], driver: () => Promise.reject(new Error("Chrome not found")) });
    const ra = await runLiveCheck(a.rt, { trigger: "manual", log: a.log });
    expect(ra.recipes[0]).toMatchObject({ result: "skipped" });
    expect(ra.recipes[0]!.detail).toMatch(/Browser not available: Chrome not found/);
    const b = await setup({
      recipes: ["ok-create"],
      driver: () => {
        const d = driverFor(newWorld());
        d.open = () => Promise.reject(new Error("no display"));
        return d;
      },
    });
    const rb = await runLiveCheck(b.rt, { trigger: "manual", log: b.log });
    expect(rb.recipes[0]).toMatchObject({ result: "skipped" });
    expect(rb.ok).toBe(true);
  });

  it("ends a hung page after the per-recipe timeout, closes the browser and goes on with the next recipe", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), hang: new Set(["hang.example.com"]), visible: [describeSelector({ label: "Token name" })] });
    const { rt, log } = await setup({ recipes: ["hang", "ok-create"], world });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pending = runLiveCheck(rt, { trigger: "manual", log, recipeTimeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(31_000);
    const report = await pending;
    const by = Object.fromEntries(report.recipes.map((r) => [r.id, r]));
    expect(by["hang"]).toMatchObject({ result: "failed", kind: "timeout", step: "goto" });
    expect(by["hang"]!.detail).toMatch(/30 seconds/);
    expect(by["ok-create"]).toMatchObject({ result: "ok" });
    expect(world.drivers.every((d) => d.closed)).toBe(true);
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("a timeout before the first step has no step label, and a browser that will not close does not matter", async () => {
    const world = newWorld({ hang: new Set(["hang.example.com"]) });
    const { rt, log } = await setup({
      recipes: ["hang"],
      world,
      driver: () => {
        const d = driverFor(world);
        d.open = () => new Promise<void>(() => undefined);
        d.close = () => Promise.reject(new Error("already gone"));
        return d;
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pending = runLiveCheck(rt, { trigger: "manual", log, recipeTimeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(6_000);
    const report = await pending;
    expect(report.recipes[0]).toMatchObject({ result: "failed", kind: "timeout" });
    expect(report.recipes[0]).not.toHaveProperty("step");
  });

  it("uses the default per-recipe timeout of two minutes", async () => {
    const world = newWorld({ hang: new Set(["hang.example.com"]) });
    const { rt, log } = await setup({ recipes: ["hang"], world });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pending = runLiveCheck(rt, { trigger: "manual", log });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(isLiveCheckRunning(rt)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const report = await pending;
    expect(report.recipes[0]!.detail).toMatch(/120 seconds/);
  });

  it("logs to the console by default, one line", async () => {
    const { rt } = await setup();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runLiveCheck(rt, { trigger: "schedule" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("live check: the browser queue", () => {
  it("does not start while a browser run is active, and stores nothing", async () => {
    const { rt, log } = await setup({ recipes: ["ok-create"] });
    rt.automation.begin("someone-else", "x", { text: "busy" });
    await expect(runLiveCheck(rt, { trigger: "manual", log })).rejects.toMatchObject({ name: "LiveCheckBusyError", reason: "browser-busy" });
    expect(rt.automation.liveCheckReports()).toEqual([]);
    expect(isLiveCheckRunning(rt)).toBe(false);
  });

  it("does not start while it runs already", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { rt, log } = await setup({ recipes: ["ok-create"], world, driver: async () => (await gate, driverFor(world)) });
    const first = runLiveCheck(rt, { trigger: "manual", log });
    await vi.waitFor(() => expect(rt.automation.isBusy()).toBe(true));
    expect(isLiveCheckRunning(rt)).toBe(true);
    await expect(runLiveCheck(rt, { trigger: "manual", log })).rejects.toBeInstanceOf(LiveCheckBusyError);
    await expect(runLiveCheck(rt, { trigger: "manual", log })).rejects.toMatchObject({ reason: "running" });
    release();
    await first;
    expect(rt.automation.isBusy()).toBe(false);
  });

  it("holds the browser for the recipes and gives it back", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), onGoto: () => seen.push(rt.automation.isBusy()) });
    const seen: boolean[] = [];
    const { rt, log } = await setup({ recipes: ["ok-create"], world });
    await runLiveCheck(rt, { trigger: "manual", log });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(rt.automation.isBusy()).toBe(false);
    expect(rt.automation.runs()[0]).toMatchObject({ secretId: "live-check", status: "done" });
  });

  it("reports all recipes as skipped when the browser was taken after the connections were checked", async () => {
    const { rt, log, world } = await setup({
      recipes: ["ok-create", "read-mode"],
      connections: "connections:\n  openai: { type: env, name: OPENAI_TEST }\n",
      env: { OPENAI_TEST: FAKE_TOKEN },
      fetch: (async () => {
        rt.automation.begin("late-comer", "x", { text: "busy" });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes.map((r) => r.result)).toEqual(["skipped", "skipped"]);
    expect(report.recipes[0]!.detail).toBe("The browser was busy.");
    expect(world.drivers).toHaveLength(0);
    expect(rt.automation.isBusy()).toBe(true);
  });

  it("stops at once when the run is cancelled, leaves the rest as skipped and ends cancelled", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com", "b.example.com"]), onGoto: () => rt.automation.cancel("live-check") });
    const { rt, log } = await setup({ recipes: ["ok-create", "read-mode"], world });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    expect(report.recipes.map((r) => [r.id, r.result])).toEqual([["ok-create", "skipped"], ["read-mode", "skipped"]]);
    expect(report.recipes[0]!.detail).toBe("The live check was cancelled.");
    expect(report.ok).toBe(true);
    expect(rt.automation.runs()[0]).toMatchObject({ secretId: "live-check", status: "cancelled" });
    expect(rt.automation.isBusy()).toBe(false);
  });
});

describe("live check: the notification", () => {
  const withHook = (hook = "{ type: env, name: HOOK_URL }") => `automation:\n  liveCheckNotify:\n    url: ${hook}\n`;
  const failing = { recipes: ["broken-click"], world: newWorld({ signedIn: new Set(["c.example.com"]) }) };

  it("sends the ids of failed items only, once, and never logs the address", async () => {
    const world = newWorld({ signedIn: new Set(["c.example.com"]), pageText: [FAKE_PAGE_TEXT] });
    const { rt, log, lines, fetchCalls } = await setup({ recipes: ["broken-click"], world, automation: withHook(), connections: CONNECTIONS, env: { HOOK_URL: FAKE_HOOK_URL, OPENAI_TEST: FAKE_TOKEN, RESEND_TEST: `${FAKE_TOKEN}2` }, fetch: apiFetch });
    const report = await runLiveCheck(rt, { trigger: "schedule", log });
    const posts = fetchCalls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(FAKE_HOOK_URL);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ ok: false, failedConnections: ["resend"], failedRecipes: ["broken-click"], finishedAt: report.finishedAt });
    expect(Object.keys(JSON.parse(posts[0]!.body!)).sort()).toEqual(["failedConnections", "failedRecipes", "finishedAt", "ok"]);
    expect(posts[0]!.body).not.toContain(FAKE_TOKEN);
    expect(posts[0]!.body).not.toContain(FAKE_PAGE_TEXT);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("secret-desk: live check notification sent");
    leaks(report, lines);
  });

  it("does not send anything when the check is ok, or when no webhook is configured", async () => {
    const ok = await setup({ automation: withHook(), env: { HOOK_URL: FAKE_HOOK_URL } });
    await runLiveCheck(ok.rt, { trigger: "manual", log: ok.log });
    expect(ok.fetchCalls.filter((c) => c.method === "POST")).toEqual([]);
    const none = await setup({ ...failing });
    await runLiveCheck(none.rt, { trigger: "manual", log: none.log });
    expect(none.fetchCalls).toEqual([]);
    expect(none.lines).toHaveLength(1);
  });

  it("logs a failing webhook without the address and still returns the report", async () => {
    const cases: [string, typeof fetch, RegExp][] = [
      ["non-2xx", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch, /notification failed \(HTTP 500\)$/],
      ["rejects", (async () => { throw new Error(`connect ECONNREFUSED ${FAKE_HOOK_URL}`); }) as unknown as typeof fetch, /notification failed \(request failed\)$/],
    ];
    for (const [, fetchFn, pattern] of cases) {
      const { rt, log, lines } = await setup({ ...failing, world: newWorld({ signedIn: new Set(["c.example.com"]) }), automation: withHook(), env: { HOOK_URL: FAKE_HOOK_URL }, fetch: fetchFn });
      const report = await runLiveCheck(rt, { trigger: "manual", log });
      expect(report.ok).toBe(false);
      expect(lines[1]).toMatch(pattern);
      leaks(report, lines);
    }
  });

  it("logs when the address is not available or is not an http(s) address", async () => {
    const missing = await setup({ ...failing, world: newWorld({ signedIn: new Set(["c.example.com"]) }), automation: withHook(), env: {} });
    await runLiveCheck(missing.rt, { trigger: "manual", log: missing.log });
    expect(missing.lines[1]).toBe("secret-desk: live check notification failed (address not available)");
    const bad = await setup({ ...failing, world: newWorld({ signedIn: new Set(["c.example.com"]) }), automation: withHook(), env: { HOOK_URL: "ftp://hooks.example.com/MADEUPHOOKPATH0003" } });
    await runLiveCheck(bad.rt, { trigger: "manual", log: bad.log });
    expect(bad.lines[1]).toBe("secret-desk: live check notification failed (request failed)");
    leaks({}, [...missing.lines, ...bad.lines]);
    expect(bad.fetchCalls).toEqual([]);
  });
});

describe("live check: due and state", () => {
  it("is due without a report and after the interval, never when off", async () => {
    const { rt, log } = await setup();
    expect(rt.automation.liveCheckDays).toBe(7);
    expect(liveCheckDue(rt)).toBe(true);
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    const finished = Date.parse(report.finishedAt);
    expect(liveCheckDue(rt, new Date(finished + 6.9 * 86_400_000))).toBe(false);
    expect(liveCheckDue(rt, new Date(finished + 7 * 86_400_000))).toBe(true);
    expect(liveCheckDue(rt)).toBe(false);
    const off = await setup({ automation: "automation:\n  liveCheckDays: 0\n" });
    expect(liveCheckDue(off.rt)).toBe(false);
  });

  it("getLiveCheck reports stored runs, the running flag and staleness (older than twice the interval)", async () => {
    const { rt, log } = await setup();
    expect(getLiveCheck(rt)).toEqual({ reports: [], running: false, intervalDays: 7, stale: true });
    const report = await runLiveCheck(rt, { trigger: "manual", log });
    const finished = Date.parse(report.finishedAt);
    expect(getLiveCheck(rt)).toMatchObject({ reports: [report], running: false, stale: false });
    expect(getLiveCheck(rt, new Date(finished + 14 * 86_400_000)).stale).toBe(false);
    expect(getLiveCheck(rt, new Date(finished + 14 * 86_400_000 + 1000)).stale).toBe(true);
    const off = await setup({ automation: "automation:\n  liveCheckDays: 0\n" });
    expect(getLiveCheck(off.rt)).toMatchObject({ intervalDays: 0, stale: false });
  });

  it("keeps reports across a restart and does not lose the schedule", async () => {
    const first = await setup({ persist: true });
    const report = await runLiveCheck(first.rt, { trigger: "manual", log: first.log });
    await first.rt.automation.flushLiveCheck();
    const second = await setup({ persist: true, dir: first.dir });
    expect(second.rt.automation.liveCheckReports()).toEqual([report]);
    expect(liveCheckDue(second.rt)).toBe(false);
  });

  it("the stored file holds the report and nothing else of the run", async () => {
    const world = newWorld({ signedIn: new Set(["c.example.com"]), pageText: [FAKE_PAGE_TEXT] });
    const first = await setup({ persist: true, world, recipes: ["broken-click"], connections: CONNECTIONS, env: { OPENAI_TEST: FAKE_TOKEN, RESEND_TEST: `${FAKE_TOKEN}2` }, fetch: apiFetch });
    await runLiveCheck(first.rt, { trigger: "manual", log: first.log });
    await first.rt.automation.flushLiveCheck();
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const text = await readFile(join(first.dir, "data", "live-check-state.json"), "utf8");
    leaks(text, []);
    expect(JSON.parse(text).reports).toHaveLength(1);
  });
});

describe("liveCheckDriver", () => {
  it("passes page actions through, refuses page text and attributes except a link target, and takes no picture", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), visible: [describeSelector({ css: "#tok" })], pageText: ["Saved"] });
    const inner = driverFor(world);
    inner.attributes.set(`${describeSelector({ css: "#link" })}@HREF`, "/next");
    const d = liveCheckDriver(inner);
    await d.open();
    await d.goto("https://a.example.com/keys");
    await d.fill({ css: "#tok" }, "x");
    await d.select({ css: "#tok" }, "x");
    await d.check({ css: "#tok" }, true);
    await d.click({ css: "#tok" });
    await d.press("Enter", { css: "#tok" });
    expect(await d.currentUrl()).toBe("https://a.example.com/keys");
    expect(await d.isVisible({ css: "#tok" })).toBe(true);
    expect(await d.hasText("Saved")).toBe(true);
    await d.waitFor({ text: "Saved" }, 100);
    expect(await d.readAttribute({ css: "#link" }, "HREF")).toBe("/next");
    await expect(d.readAttribute({ css: "#tok" }, "aria-label")).rejects.toThrow(/does not read attributes/);
    await expect(d.readText({ css: "#tok" })).rejects.toThrow(/does not read page text/);
    expect((await d.screenshot([])).length).toBe(0);
    expect(inner.shots).toEqual([]);
    await d.close();
    expect(inner.closed).toBe(true);
  });
});

describe("startLiveCheck (manual run from the portal)", () => {
  it("returns at once, runs in the background as a manual run and shows as running meanwhile", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]), visible: [describeSelector({ label: "Token name" })] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { rt, lines, log } = await setup({ recipes: ["ok-create"], world, driver: async () => (await gate, driverFor(world)) });
    startLiveCheck(rt, { log });
    expect(getLiveCheck(rt).running).toBe(true);
    expect(() => startLiveCheck(rt, { log })).toThrowError(expect.objectContaining({ name: "LiveCheckBusyError", reason: "running" }));
    release();
    await vi.waitFor(() => expect(getLiveCheck(rt).running).toBe(false));
    expect(getLiveCheck(rt).reports[0]).toMatchObject({ trigger: "manual", ok: true });
    expect(lines).toHaveLength(1);
  });

  it("refuses while the browser is busy and starts nothing", async () => {
    const { rt, log } = await setup({ recipes: ["ok-create"] });
    rt.automation.begin("someone-else", "x", { text: "busy" });
    expect(() => startLiveCheck(rt, { log })).toThrowError(expect.objectContaining({ reason: "browser-busy" }));
    expect(getLiveCheck(rt)).toMatchObject({ running: false, reports: [] });
  });

  it("swallows an unexpected failure of the background run (the portal shows no new report)", async () => {
    const { rt, log } = await setup();
    vi.spyOn(rt.automation, "recordLiveCheck").mockImplementation(() => {
      throw new Error("disk full");
    });
    startLiveCheck(rt, { log });
    await vi.waitFor(() => expect(getLiveCheck(rt).running).toBe(false));
    expect(getLiveCheck(rt).reports).toEqual([]);
    vi.restoreAllMocks();
  });

  it("works without options (console log)", async () => {
    const { rt } = await setup();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    startLiveCheck(rt);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });
});
