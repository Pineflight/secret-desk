import { describe, expect, it } from "vitest";
import type { SyncLine, SyncOutcome, SyncPlan } from "@secret-desk/core";
import { batches, defaultSelection, groupByRepository, needsProduction, summarize, writable } from "../src/lib/sync-view";

const line = (over: Partial<SyncLine> & { key: string }): SyncLine => ({
  kind: "variable",
  entryId: over.key,
  name: "NAME",
  repo: "b-repo",
  place: { repo: over.repo ?? "b-repo", scope: "repository" },
  placeLabel: "b-repo/repo",
  stage: "staging",
  production: false,
  action: "set",
  reason: "missing",
  defaultOn: true,
  ...over,
});
const plan = (lines: SyncLine[]): SyncPlan => ({ generatedAt: "2026-11-04T00:00:00Z", lines, counts: { set: 0, write: 0, skip: 0, unchanged: 0 }, hasProduction: false });

describe("sync view", () => {
  const lines = [
    line({ key: "a", repo: "b-repo", name: "B" }),
    line({ key: "b", repo: "a-repo", name: "Z", action: "skip", reason: "no-value", defaultOn: false }),
    line({ key: "c", repo: "a-repo", name: "A", kind: "secret", action: "write", reason: "github-newer", defaultOn: false, warning: "github-newer" }),
    line({ key: "d", repo: "a-repo", name: "M", production: true, action: "write", reason: "overwrite" }),
  ];
  const p = plan(lines);

  it("selects by default everything on, never skipped lines and never overwrites of newer GitHub values", () => {
    expect([...defaultSelection(p)].sort()).toEqual(["a", "d"]);
    expect(writable(p).map((l) => l.key)).toEqual(["a", "c", "d"]);
  });
  it("groups by repository, writable lines first", () => {
    const g = groupByRepository(lines);
    expect(g.map((x) => x.repo)).toEqual(["a-repo", "b-repo"]);
    expect(g[0]!.lines.map((l) => l.key)).toEqual(["c", "d", "b"]);
  });
  it("needs the production confirmation only for selected production lines", () => {
    expect(needsProduction(p, new Set(["a"]))).toBe(false);
    expect(needsProduction(p, new Set(["a", "d"]))).toBe(true);
  });
  it("splits the selection into batches in plan order", () => {
    expect(batches(p, new Set(["a", "c", "d"]), 2)).toEqual([["a", "c"], ["d"]]);
    expect(batches(p, new Set())).toEqual([]);
  });
  it("summarizes outcomes", () => {
    const o = (outcome: SyncOutcome["outcome"]): SyncOutcome => ({ key: outcome, kind: "variable", entryId: "x", name: "N", placeLabel: "p", outcome });
    const s = summarize([o("created"), o("updated"), o("failed"), o("skipped")]);
    expect(s).toMatchObject({ ok: 2, skipped: 1 });
    expect(s.failed).toHaveLength(1);
  });
});
