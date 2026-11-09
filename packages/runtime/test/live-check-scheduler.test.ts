import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCheckScheduler, runLiveCheck, startLiveCheckScheduler } from "../src/live-check.js";
import { newWorld, setup } from "./helpers/live-check-world.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveCheckScheduler.tick", () => {
  it("does nothing when the live check is off", async () => {
    const { rt, log, world } = await setup({ recipes: ["ok-create"], automation: "automation:\n  liveCheckDays: 0\n" });
    expect(await new LiveCheckScheduler(rt, { log }).tick()).toEqual({ skipped: "off", report: null });
    expect(world.drivers).toHaveLength(0);
  });

  it("runs when the last report is older than the interval, as a scheduled run, and not again before", async () => {
    const { rt, lines, log } = await setup({ world: newWorld() });
    const scheduler = new LiveCheckScheduler(rt, { log, recipeTimeoutSeconds: 5 });
    const first = await scheduler.tick();
    expect(first.skipped).toBeNull();
    expect(first.report).toMatchObject({ trigger: "schedule", ok: true });
    expect(lines).toHaveLength(1);
    expect(await scheduler.tick()).toEqual({ skipped: "not-due", report: null });
    expect(lines).toHaveLength(1);
  });

  it("is due again a week after the stored report (the schedule follows the stored report, not the process)", async () => {
    const { rt, log } = await setup();
    const scheduler = new LiveCheckScheduler(rt, { log });
    await scheduler.tick();
    const later = Date.now() + 7.1 * 86_400_000;
    vi.spyOn(rt.automation, "now").mockImplementation(() => new Date(later));
    const second = await scheduler.tick();
    expect(second.skipped).toBeNull();
    expect(rt.automation.liveCheckReports()).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("postpones while the browser is busy and tries again on the next tick", async () => {
    const { rt, log } = await setup({ recipes: ["ok-create"], world: newWorld({ signedIn: new Set(["a.example.com"]) }) });
    rt.automation.begin("someone-else", "x", { text: "busy" });
    const scheduler = new LiveCheckScheduler(rt, { log });
    expect(await scheduler.tick()).toEqual({ skipped: "busy", report: null });
    expect(rt.automation.liveCheckReports()).toEqual([]);
    rt.automation.end("someone-else", { status: "done", text: "done" });
    const retry = await scheduler.tick();
    expect(retry.skipped).toBeNull();
    expect(retry.report?.recipes).toHaveLength(1);
  });

  it("skips while a run is going (also one started by hand)", async () => {
    const world = newWorld({ signedIn: new Set(["a.example.com"]) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { rt, log } = await setup({ recipes: ["ok-create"], world, driver: async () => (await gate, (await import("./helpers/live-check-world.js")).driverFor(world)) });
    const manual = runLiveCheck(rt, { trigger: "manual", log });
    await vi.waitFor(() => expect(rt.automation.isBusy()).toBe(true));
    const scheduler = new LiveCheckScheduler(rt, { log });
    expect(await scheduler.tick()).toEqual({ skipped: "running", report: null });
    release();
    await manual;
  });

  it("two ticks at the same time: one runs, the other sees it running", async () => {
    const { rt, log } = await setup();
    const scheduler = new LiveCheckScheduler(rt, { log });
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect([a.skipped, b.skipped].sort()).toEqual([null, "running"].sort());
  });

  it("lets an unexpected error through to the caller", async () => {
    const { rt, log } = await setup();
    vi.spyOn(rt.automation, "recordLiveCheck").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(new LiveCheckScheduler(rt, { log }).tick()).rejects.toThrow("disk full");
    vi.restoreAllMocks();
  });
});

describe("LiveCheckScheduler timer", () => {
  it("ticks on an unref'd timer, start is idempotent, stop ends it, errors in a tick are swallowed", async () => {
    const { rt, log } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const scheduler = new LiveCheckScheduler(rt, { log, intervalMs: 1000 });
    const tick = vi.spyOn(scheduler, "tick").mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ skipped: "not-due", report: null });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    scheduler.stop();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("uses a one-minute default interval, and startLiveCheckScheduler starts it", async () => {
    const { rt, log } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const spy = vi.spyOn(LiveCheckScheduler.prototype, "tick").mockResolvedValue({ skipped: "not-due", report: null });
    const scheduler = startLiveCheckScheduler(rt, { log });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spy).toHaveBeenCalledTimes(1);
    scheduler.stop();
    spy.mockRestore();
    expect(startLiveCheckScheduler(rt).stop).toBeTypeOf("function");
  });
});
