import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_CHECK_KEEP, LiveCheckStore, parseLiveCheckReport, summarize, type LiveCheckReport } from "../src/live-check-store.js";

const report = (n: number, over: Partial<LiveCheckReport> = {}): LiveCheckReport => {
  const connections: LiveCheckReport["connections"] = [{ id: "openai", result: "ok" }, { id: "resend", result: "not-connected" }];
  const recipes: LiveCheckReport["recipes"] = [{ id: "r1", result: "ok", detail: "fine" }];
  return { startedAt: new Date(Date.UTC(2026, 10, n, 1)).toISOString(), finishedAt: new Date(Date.UTC(2026, 10, n, 2)).toISOString(), ok: true, trigger: "schedule", connections, recipes, summary: summarize(connections, recipes), ...over };
};

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), "sd-lc-store-"));

describe("summarize", () => {
  it("counts every result", () => {
    expect(
      summarize(
        [{ id: "a", result: "ok" }, { id: "b", result: "failed" }, { id: "c", result: "not-connected" }, { id: "d", result: "ok" }],
        [{ id: "a", result: "ok" }, { id: "b", result: "failed" }, { id: "c", result: "needs-sign-in" }, { id: "d", result: "skipped" }, { id: "e", result: "skipped" }],
      ),
    ).toEqual({ connections: { ok: 2, failed: 1, notConnected: 1 }, recipes: { ok: 1, failed: 1, needsSignIn: 1, skipped: 2 } });
  });
});

describe("parseLiveCheckReport", () => {
  it("rebuilds a good report field by field and drops unknown fields", () => {
    const full = report(3, { recipes: [{ id: "r1", result: "failed", step: "click x", kind: "step", detail: "d" }], ok: false });
    const parsed = parseLiveCheckReport({ ...full, extra: "x", recipes: [{ ...full.recipes[0], leaked: "y" }] });
    expect(parsed).toEqual({ ...full, summary: summarize(full.connections, full.recipes) });
    expect(JSON.stringify(parsed)).not.toContain("leaked");
  });

  it("recomputes ok from the results, so a stored flag cannot hide a failure", () => {
    const failed = report(3, { connections: [{ id: "a", result: "failed" }], ok: true });
    expect(parseLiveCheckReport(failed)!.ok).toBe(false);
    const failedRecipe = report(3, { recipes: [{ id: "a", result: "failed" }], ok: true });
    expect(parseLiveCheckReport(failedRecipe)!.ok).toBe(false);
  });

  it("rejects what is not a report", () => {
    for (const bad of [null, "x", 5, [], {}, { ...report(1), startedAt: "yesterday" }, { ...report(1), finishedAt: 5 }, { ...report(1), trigger: "cron" }]) {
      expect(parseLiveCheckReport(bad)).toBeNull();
    }
  });

  it("skips damaged items, caps long texts and tolerates missing lists", () => {
    const parsed = parseLiveCheckReport({
      ...report(2),
      connections: [null, 5, { id: "ok-one", result: "ok" }, { id: "bad id!", result: "ok" }, { id: "x", result: "weird" }, { id: "y", result: "failed", detail: "d".repeat(900) }, { id: "z", result: "ok", detail: "" }],
      recipes: [{ id: "q", result: "nope" }, { id: "../etc", result: "ok" }, { id: "r", result: "skipped", step: 5, kind: "k", detail: "x" }],
    })!;
    expect(parsed.connections.map((c) => c.id)).toEqual(["ok-one", "y", "z"]);
    expect(parsed.connections[1]!.detail).toHaveLength(300);
    expect(parsed.connections[2]).toEqual({ id: "z", result: "ok" });
    expect(parsed.recipes).toEqual([{ id: "r", result: "skipped", kind: "k", detail: "x" }]);
    const none = parseLiveCheckReport({ ...report(2), connections: "no", recipes: undefined })!;
    expect(none.connections).toEqual([]);
    expect(none.recipes).toEqual([]);
  });

  it("turns control characters into spaces, so a tampered file cannot inject terminal escapes", () => {
    const parsed = parseLiveCheckReport({
      ...report(2),
      connections: [{ id: "c", result: "failed", detail: "a\u001b[31mred\u0007\u0000b\u009bc\u007fd\ne" }],
      recipes: [{ id: "r", result: "failed", step: "s\u001b]0;title", kind: "k\r", detail: "ok" }],
    })!;
    expect(parsed.connections[0]!.detail).toBe("a [31mred  b c d e");
    expect(parsed.recipes[0]).toMatchObject({ step: "s ]0;title", kind: "k " });
    expect(JSON.stringify(parsed)).not.toMatch(/\\u00(?:1b|07|00|9b|7f)/);
  });

  it("limits the number of items", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, result: "ok" }));
    expect(parseLiveCheckReport({ ...report(2), connections: many })!.connections).toHaveLength(200);
  });
});

describe("LiveCheckStore", () => {
  it("lives in memory without a file, newest first, and keeps the last 12", async () => {
    const store = new LiveCheckStore();
    await store.load();
    expect(store.latest()).toBeUndefined();
    expect(store.reports()).toEqual([]);
    for (let i = 1; i <= 15; i++) store.add(report(i));
    expect(store.reports()).toHaveLength(LIVE_CHECK_KEEP);
    expect(store.latest()).toEqual(report(15));
    expect(store.reports()[0]).toEqual(report(15));
    expect(store.reports()[11]).toEqual(report(4));
    await store.flush();
  });

  it("writes a private file and a second store reads it back", async () => {
    const dir = await tmp();
    const file = join(dir, "data", "live-check-state.json");
    const a = new LiveCheckStore(file);
    a.add(report(1));
    a.add(report(2));
    await a.flush();
    const b = new LiveCheckStore(file);
    await b.load();
    expect(b.reports()).toEqual([report(2), report(1)]);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  });

  it("ignores a missing, damaged or foreign file, and keeps what was added before the load", async () => {
    const dir = await tmp();
    const file = join(dir, "state.json");
    const missing = new LiveCheckStore(file);
    await missing.load();
    expect(missing.reports()).toEqual([]);
    for (const body of ["{not json", "null", JSON.stringify({ version: 2, reports: [report(1)] }), JSON.stringify({ version: 1, reports: "x" })]) {
      await writeFile(file, body);
      const s = new LiveCheckStore(file);
      await s.load();
      expect(s.reports()).toEqual([]);
    }
    await writeFile(file, JSON.stringify({ version: 1, reports: [report(1), { junk: true }, report(2)] }));
    const s = new LiveCheckStore(file);
    s.add(report(3));
    await s.load();
    expect(s.reports().map((r) => r.startedAt)).toEqual([report(3), report(2), report(1)].map((r) => r.startedAt));
    await s.flush();
  });

  it("a write that fails (read-only folder) does not break anything", async () => {
    if (process.platform === "win32") return;
    const dir = await tmp();
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const s = new LiveCheckStore(join(locked, "sub", "state.json"));
    s.add(report(1));
    await expect(s.flush()).resolves.toBeUndefined();
    expect(s.latest()).toEqual(report(1));
    await chmod(locked, 0o700);
    expect(await readFile(join(dir, "locked", "x").replace("x", ""), "utf8").catch(() => "none")).toBe("none");
  });
});
