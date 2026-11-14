import { ProviderRegistry, parseConfig, MemoryEvidenceStore } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import * as automationModule from "../src/automation.js";
import { AutomationManager, type AutomationPort as PortFromAutomation } from "../src/automation.js";
import { AutomationUnavailableError, noAutomation, noAutomationFor, type AutomationPort } from "../src/automation-port.js";
import { LIVE_CHECK_NOTIFY_CONNECTION } from "../src/live-check-notify.js";
import * as liveCheckStore from "../src/live-check-store.js";

const CONFIG = parseConfig("inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n");
const report = { startedAt: "2026-11-14T10:00:00.000Z", finishedAt: "2026-11-14T10:00:01.000Z", ok: true, trigger: "manual", connections: [], recipes: [], summary: { connections: { ok: 0, failed: 0, notConnected: 0 }, recipes: { ok: 0, failed: 0, needsSignIn: 0, skipped: 0 } } } as const;

describe("noAutomation", () => {
  it("is idle: switched off, nothing loaded, no browser, no recipe", () => {
    expect(noAutomation).toMatchObject({ enabled: false, loginTimeoutMinutes: 0, signInCheckHours: 0, liveCheckDays: 0, viewerUrl: null });
    expect(noAutomation.recipes).toEqual([]);
    expect(noAutomation.accessTiming).toEqual({});
    expect(noAutomation.recipe("any")).toBeUndefined();
    expect(noAutomation.browserHostOf({ automation: { recipeId: "any" } }, { region: "eu" })).toBeNull();
    expect(noAutomation.isBrowserProvider(undefined)).toBe(false);
    expect(noAutomation.isBrowserProvider({ id: "x", label: "X", kind: "manual" })).toBe(false);
    expect(noAutomation.isBusy()).toBe(false);
    expect(noAutomation.runSignal("k")).toBeUndefined();
    expect(noAutomation.signInChecks()).toEqual([]);
    expect(noAutomation.liveCheckReports()).toEqual([]);
    expect(Math.abs(noAutomation.now().getTime() - Date.now())).toBeLessThan(5000);
  });

  it("says so in info and status, with a fresh object each time, so no caller can change what the next one sees", async () => {
    const info = noAutomation.info();
    expect(info).toMatchObject({ enabled: false, profileDir: "", recipes: [], runs: [], signInChecks: [], signInLifetimes: [], problems: [], allowExternalRecipes: false });
    expect(info.browser).toMatchObject({ mode: "local", endpoint: null, reachable: null, viewerUrl: null, detail: "Browser automation is not available in this runtime." });
    expect(info.chrome).toEqual({ found: false, path: null, hint: "Browser automation is not available in this runtime." });
    info.recipes.push({} as never);
    expect(noAutomation.info().recipes).toEqual([]);
    expect(await noAutomation.status()).toEqual(noAutomation.info());
    expect(noAutomation.state("k")).toEqual({ secretId: "k", providerId: "", status: "idle", text: "", host: null, step: null, startedAt: "", updatedAt: "" });
  });

  it("ignores what is only bookkeeping and refuses what would run something, with a typed error", async () => {
    expect(noAutomation.update("k", { text: "t" })).toBeUndefined();
    expect(noAutomation.end("k", { status: "done", text: "t" })).toBeUndefined();
    expect(noAutomation.forget("k")).toBeUndefined();
    expect(noAutomation.noteSignIn("example.com", true)).toBeUndefined();
    expect(noAutomation.recordLiveCheck(report as never)).toBeUndefined();
    await expect(noAutomation.flushLiveCheck()).resolves.toBeUndefined();
    await expect(noAutomation.attach({} as never, "k", "r")).resolves.toBe(0);
    await expect(noAutomation.run("k", {} as never, async () => 1)).rejects.toBeInstanceOf(AutomationUnavailableError);
    for (const call of [() => noAutomation.begin("k", "p", { text: "t" }), () => noAutomation.cancel("k"), () => noAutomation.newDriver()]) {
      expect(call).toThrow(AutomationUnavailableError);
    }
    const err = await noAutomation.run("k", {} as never, async () => 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "AutomationUnavailableError", kind: "automation-unavailable", message: "Browser automation is not available in this runtime." });
    expect(err).toBeInstanceOf(Error);
  });

  it("noAutomationFor follows the clock it is given, and is otherwise the same idle port", () => {
    const at = new Date("2026-11-14T10:00:00Z");
    const port = noAutomationFor(() => at);
    expect(port.now()).toBe(at);
    expect(port).not.toBe(noAutomation);
    expect(Object.isFrozen(port)).toBe(true);
    expect(port.info()).toEqual(noAutomation.info());
    expect(() => port.begin("k", "p", { text: "t" })).toThrow(AutomationUnavailableError);
  });

  it("holds no state and cannot be changed", () => {
    expect(Object.isFrozen(noAutomation)).toBe(true);
    expect(Object.isFrozen(noAutomation.recipes)).toBe(true);
    expect(Object.isFrozen(noAutomation.accessTiming)).toBe(true);
    expect(() => {
      (noAutomation as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(noAutomation.enabled).toBe(false);
  });
});

describe("the manager implements the port", () => {
  const manager = (): AutomationManager => new AutomationManager({ config: CONFIG, configDir: "/made-up", inventoryDir: "/made-up", providers: new ProviderRegistry(), evidence: new MemoryEvidenceStore() });

  it("is assignable to the port, and automation.ts re-exports the port type without a second copy", () => {
    const port: AutomationPort = manager();
    const same: PortFromAutomation = port;
    expect(same).toBe(port);
    expect(Object.keys(automationModule)).not.toContain("noAutomation");
  });

  it("browserHostOf follows the `hostBy` parameter of the recipe behind a provider, and answers null for anything else", () => {
    const m = manager();
    const recipe = { host: "eu.example.com", hostBy: "region", hosts: { eu: "eu.example.com", us: "us.example.com" }, params: [{ key: "region", default: "eu" }] };
    const single = { host: "one.example.com", params: [] };
    const lookup = vi.spyOn(m, "recipe").mockImplementation((id) => ({ multi: recipe, single }[id as "multi" | "single"] as never));
    const via = (id: string) => ({ id: "p", label: "P", kind: "manual", automation: { recipeId: id } });
    expect(m.browserHostOf(via("multi"), { region: "us" })).toBe("us.example.com");
    expect(m.browserHostOf(via("multi"), {})).toBe("eu.example.com");
    expect(m.browserHostOf(via("single"), { region: "us" })).toBeNull();
    expect(m.browserHostOf(via("unknown"), {})).toBeNull();
    expect(m.browserHostOf({ id: "p", label: "P", kind: "manual" }, {})).toBeNull();
    expect(m.browserHostOf(undefined, {})).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(4); // not for a provider that names no recipe
  });
});

describe("the live check notification id", () => {
  it("lives in its own module and is re-exported by the live check store", () => {
    expect(LIVE_CHECK_NOTIFY_CONNECTION).toBe("live-check-notify");
    expect(liveCheckStore.LIVE_CHECK_NOTIFY_CONNECTION).toBe(LIVE_CHECK_NOTIFY_CONNECTION);
  });
});
