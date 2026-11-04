import { describe, expect, it } from "vitest";
import { TOAST_MAX, TOAST_MS, dismissToast, pauseToast, pushToast, tickToasts, type ToastItem } from "../src/lib/toast-queue";

const add = (list: ToastItem[], id: number, text = `t${id}`, kind: "success" | "error" | "info" = "success") => pushToast(list, { id, kind, text });

describe("toast queue", () => {
  it("hides a toast after about five seconds", () => {
    let l = add([], 1);
    l = tickToasts(l, TOAST_MS - 1);
    expect(l).toHaveLength(1);
    l = tickToasts(l, 1);
    expect(l).toHaveLength(0);
  });
  it("keeps a paused toast and resumes with the time it had left", () => {
    let l = add(add([], 1), 2);
    l = tickToasts(l, 3000);
    l = pauseToast(l, 1, true);
    l = tickToasts(l, 10_000);
    expect(l.map((t) => t.id)).toEqual([1]);
    expect(l[0]!.remaining).toBe(TOAST_MS - 3000);
    l = tickToasts(pauseToast(l, 1, false), 2000);
    expect(l).toHaveLength(0);
  });
  it("renews an identical message instead of stacking it", () => {
    let l = add([], 1, "same");
    l = tickToasts(l, 4000);
    l = add(l, 2, "same");
    expect(l).toHaveLength(1);
    expect(l[0]!.remaining).toBe(TOAST_MS);
    expect(add(l, 3, "same", "error")).toHaveLength(2);
  });
  it("drops the oldest when too many are shown, and dismisses by id", () => {
    let l: ToastItem[] = [];
    for (let i = 1; i <= TOAST_MAX + 2; i++) l = add(l, i);
    expect(l).toHaveLength(TOAST_MAX);
    expect(l[0]!.id).toBe(3);
    expect(dismissToast(l, 4).map((t) => t.id)).toEqual([3, 5, 6]);
  });
});
