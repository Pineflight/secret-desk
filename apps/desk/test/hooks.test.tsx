import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDebounced, useMutation, useNow, useQuery } from "../src/lib/hooks";
import { notifyInventoryChange } from "../src/lib/refresh";

afterEach(() => vi.useRealTimers());

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("useQuery", () => {
  it("loads data and clears the loading flag", async () => {
    const { result } = renderHook(() => useQuery("k", async () => 42));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("stays idle while the key is null", async () => {
    const fetcher = vi.fn(async () => 1);
    const { result } = renderHook(() => useQuery(null, fetcher));
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("keeps an Error as it is and wraps anything else", async () => {
    const boom = new Error("boom");
    const first = renderHook(() => useQuery("a", async () => { throw boom; }));
    await waitFor(() => expect(first.result.current.error).toBe(boom));
    expect(first.result.current.loading).toBe(false);
    const second = renderHook(() => useQuery("b", () => Promise.reject("text")));
    await waitFor(() => expect(second.result.current.error?.message).toBe("Unbekannter Fehler"));
  });

  it("reloads with the loading flag and keeps the latest fetcher", async () => {
    let n = 0;
    const { result, rerender } = renderHook(({ v }) => useQuery("k", async () => `${v}-${++n}`), { initialProps: { v: "a" } });
    await waitFor(() => expect(result.current.data).toBe("a-1"));
    rerender({ v: "b" });
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("b-2"));
  });

  it("resets data and error when the key changes", async () => {
    const { result, rerender } = renderHook(({ k }) => useQuery(k, async () => k), { initialProps: { k: "one" } });
    await waitFor(() => expect(result.current.data).toBe("one"));
    rerender({ k: "two" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe("two"));
  });

  it("ignores an answer that arrives after a newer request, success and failure alike", async () => {
    const slow = deferred<string>();
    const slowFail = deferred<string>();
    let step = 0;
    const { result } = renderHook(() => useQuery("k", () => (++step === 1 ? slow.promise : step === 2 ? slowFail.promise : Promise.resolve("latest"))));
    act(() => result.current.reload());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe("latest"));
    await act(async () => {
      slow.resolve("stale");
      slowFail.reject(new Error("stale failure"));
    });
    expect(result.current.data).toBe("latest");
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("reloads silently when the inventory changes outside the portal", async () => {
    let n = 0;
    const { result } = renderHook(() => useQuery("k", async () => ++n));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => notifyInventoryChange());
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("does not listen to inventory changes while paused", async () => {
    const fetcher = vi.fn(async () => 1);
    renderHook(() => useQuery(null, fetcher));
    act(() => notifyInventoryChange());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls on an interval and stops after unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => 1);
    const { unmount } = renderHook(() => useQuery("k", fetcher, { refreshMs: 1000 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not poll without an interval or while paused", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => 1);
    renderHook(() => useQuery("k", fetcher));
    renderHook(() => useQuery(null, fetcher, { refreshMs: 1000 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("useMutation", () => {
  it("runs the function, tracks pending and returns the result", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useMutation((a: number) => d.promise.then((v) => `${v}${a}`)));
    let out: Promise<string | undefined>;
    act(() => { out = result.current.run(7); });
    expect(result.current.pending).toBe(true);
    await act(async () => { d.resolve("ok"); await out; });
    expect(await out!).toBe("ok7");
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps an error, wraps non-errors, resolves to undefined and can be reset", async () => {
    const boom = new Error("boom");
    let fail: unknown = boom;
    const { result } = renderHook(() => useMutation(async () => { throw fail; }));
    await act(async () => { expect(await result.current.run()).toBeUndefined(); });
    expect(result.current.error).toBe(boom);
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
    fail = "text";
    await act(async () => { await result.current.run(); });
    expect(result.current.error?.message).toBe("Unbekannter Fehler");
  });

  it("uses the latest function", async () => {
    const { result, rerender } = renderHook(({ v }) => useMutation(async () => v), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    await act(async () => { expect(await result.current.run()).toBe(2); });
  });
});

describe("useNow and useDebounced", () => {
  it("ticks with the clock and stops after unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
    const { result, unmount } = renderHook(() => useNow(500));
    const first = result.current;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current - first).toBe(1000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a one second default", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow());
    const first = result.current;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBeGreaterThan(first);
  });

  it("settles a value only after the delay and restarts on every change", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ v: "c" });
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(60); });
    expect(result.current).toBe("c");
  });
});
