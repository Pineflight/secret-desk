import { describe, expect, it } from "vitest";
import { createCheckQueue, type CheckPhase } from "../src/lib/check-queue";

/** A check the test finishes by hand. */
function manual() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const fail = new Map<string, (e: Error) => void>();
  let running = 0;
  let maxRunning = 0;
  const run = (id: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(id);
      running++;
      maxRunning = Math.max(maxRunning, running);
      release.set(id, () => { running--; resolve(`done:${id}`); });
      fail.set(id, (e) => { running--; reject(e); });
    });
  return { run, started, release, fail, maxRunning: () => maxRunning };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("check queue", () => {
  it("checks only the provider that was asked for", async () => {
    const m = manual();
    const q = createCheckQueue(m.run);
    const p = q.enqueue("stripe");
    await tick();
    expect(m.started).toEqual(["stripe"]);
    m.release.get("stripe")!();
    expect(await p).toBe("done:stripe");
    expect(m.started).toEqual(["stripe"]);
  });

  it("never runs two checks at the same time and shows the second as waiting", async () => {
    const m = manual();
    const seen: ReadonlyMap<string, CheckPhase>[] = [];
    const q = createCheckQueue(m.run, (p) => seen.push(p));
    const a = q.enqueue("stripe");
    const b = q.enqueue("revenuecat");
    await tick();
    expect(m.started).toEqual(["stripe"]);
    expect(q.phases().get("stripe")).toBe("checking");
    expect(q.phases().get("revenuecat")).toBe("waiting");
    m.release.get("stripe")!();
    await a;
    await tick();
    expect(m.started).toEqual(["stripe", "revenuecat"]);
    expect(q.phases().get("revenuecat")).toBe("checking");
    m.release.get("revenuecat")!();
    await b;
    expect(m.maxRunning()).toBe(1);
    expect(q.phases().size).toBe(0);
    expect(seen.at(-1)?.size).toBe(0);
  });

  it("does not queue the same provider twice", async () => {
    const m = manual();
    const q = createCheckQueue(m.run);
    const a = q.enqueue("stripe");
    const again = q.enqueue("stripe");
    expect(again).toBe(a);
    await tick();
    m.release.get("stripe")!();
    await a;
    expect(m.started).toEqual(["stripe"]);
    // Once finished, the provider can be checked again.
    const next = q.enqueue("stripe");
    await tick();
    m.release.get("stripe")!();
    await next;
    expect(m.started).toEqual(["stripe", "stripe"]);
  });

  it("carries on after a failed check", async () => {
    const m = manual();
    const q = createCheckQueue(m.run);
    const a = q.enqueue("stripe");
    const b = q.enqueue("revenuecat");
    await tick();
    m.fail.get("stripe")!(new Error("boom"));
    expect(await a).toBeUndefined();
    await tick();
    m.release.get("revenuecat")!();
    expect(await b).toBe("done:revenuecat");
  });
});
