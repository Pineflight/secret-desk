import { describe, expect, it } from "vitest";
import { observeOnce, type ObserverFactory } from "../src/lib/in-view";
import { PAGE_SIZE, pageOf } from "../src/lib/paging";

function fake() {
  const made: { cb: (e: { isIntersecting: boolean }[]) => void; observed: unknown[]; disconnected: boolean; options?: { rootMargin?: string } }[] = [];
  const Factory = class {
    state: (typeof made)[number];
    constructor(cb: (e: { isIntersecting: boolean }[]) => void, options?: { rootMargin?: string }) {
      this.state = { cb, observed: [], disconnected: false, ...(options ? { options } : {}) };
      made.push(this.state);
    }
    observe(el: unknown) { this.state.observed.push(el); }
    disconnect() { this.state.disconnected = true; }
  } as unknown as ObserverFactory;
  return { made, Factory };
}

describe("observeOnce", () => {
  it("waits until the element is visible, calls once and stops watching", () => {
    const { made, Factory } = fake();
    let seen = 0;
    observeOnce({} as Element, () => seen++, "100px", Factory);
    expect(made[0]!.options?.rootMargin).toBe("100px");
    made[0]!.cb([{ isIntersecting: false }]);
    expect(seen).toBe(0);
    made[0]!.cb([{ isIntersecting: true }]);
    made[0]!.cb([{ isIntersecting: true }]);
    expect(seen).toBe(1);
    expect(made[0]!.disconnected).toBe(true);
  });
  it("does not call after cleanup", () => {
    const { made, Factory } = fake();
    let seen = 0;
    const stop = observeOnce({} as Element, () => seen++, undefined, Factory);
    stop();
    made[0]!.cb([{ isIntersecting: true }]);
    expect(seen).toBe(0);
  });
  it("counts the section as seen at once without IntersectionObserver", () => {
    let seen = 0;
    observeOnce({} as Element, () => seen++, undefined, undefined);
    // `undefined` falls back to the global, which node does not have.
    expect(seen).toBe(1);
  });
});

describe("pageOf", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  it("shows the first page and says what is hidden", () => {
    const p = pageOf(rows, 1);
    expect(p.rows).toHaveLength(PAGE_SIZE);
    expect(p).toMatchObject({ hidden: 70, next: PAGE_SIZE });
  });
  it("adds a page per step and the last step is the remainder", () => {
    expect(pageOf(rows, 2)).toMatchObject({ hidden: 20, next: 20 });
    expect(pageOf(rows, 3)).toMatchObject({ hidden: 0, next: 0 });
    expect(pageOf(rows, 3).rows).toHaveLength(120);
    expect(pageOf(rows, 0).rows).toHaveLength(PAGE_SIZE);
  });
});

import { limitGroups } from "../src/lib/paging";

describe("limitGroups", () => {
  const groups = [
    { key: "a", items: Array.from({ length: 30 }, (_, i) => i) },
    { key: "b", items: Array.from({ length: 40 }, (_, i) => i) },
    { key: "c", items: Array.from({ length: 10 }, (_, i) => i) },
  ];
  it("shortens the group the cut falls into and drops the later ones", () => {
    const r = limitGroups(groups, 1);
    expect(r.groups.map((g) => [g.key, g.items.length])).toEqual([["a", 30], ["b", 20]]);
    expect(r).toMatchObject({ hidden: 30, next: 30 });
  });
  it("shows everything once enough pages are open", () => {
    const r = limitGroups(groups, 2);
    expect(r.groups.map((g) => g.items.length)).toEqual([30, 40, 10]);
    expect(r.hidden).toBe(0);
  });
  it("does not change the input", () => {
    limitGroups(groups, 1);
    expect(groups[1]!.items).toHaveLength(40);
  });
});
