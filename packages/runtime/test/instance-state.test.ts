import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WAIT_MS, InstanceState, WaitExpiredError, WaiterBook, waitDeadline, type Waiter } from "../src/instance-state.js";

const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const at = (ms: number): Date => new Date(T0 + ms);

function waiter<T>(deadline: number): Waiter<T> & { resolve: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(), reject: vi.fn(), deadline };
}

describe("WaiterBook", () => {
  it("hands out a live wait and keeps it until it is taken", () => {
    const book = new WaiterBook<string>();
    const w = waiter<string>(T0 + 1000);
    book.set("run", w);
    expect(book.get("run", at(0))).toBe(w);
    expect(book.get("run", at(999))).toBe(w);
    expect(book.size).toBe(1);
    expect(book.take("run", at(10))).toBe(w);
    expect(book.get("run", at(10))).toBeUndefined();
    expect(book.size).toBe(0);
    expect(w.reject).not.toHaveBeenCalled();
  });

  it("treats a wait at or past its deadline as absent, removes it and rejects it", () => {
    const book = new WaiterBook<string>();
    const w = waiter<string>(T0 + 1000);
    book.set("run", w);
    expect(book.get("run", at(1000))).toBeUndefined();
    expect(book.size).toBe(0);
    expect(w.reject).toHaveBeenCalledTimes(1);
    expect(w.reject.mock.calls[0]![0]).toBeInstanceOf(WaitExpiredError);
    expect(w.resolve).not.toHaveBeenCalled();
    // A second look at an unknown key is plain absence.
    expect(book.get("run", at(1000))).toBeUndefined();
    expect(w.reject).toHaveBeenCalledTimes(1);
  });

  it("take of an expired wait gives nothing and cannot be satisfied afterwards", () => {
    const book = new WaiterBook<string>();
    const w = waiter<string>(T0 + 5);
    book.set("run", w);
    expect(book.take("run", at(6))).toBeUndefined();
    expect(w.resolve).not.toHaveBeenCalled();
    expect(w.reject).toHaveBeenCalledTimes(1);
  });

  it("cancel rejects as cancelled and forgets; delete only forgets", () => {
    const book = new WaiterBook<boolean>();
    const a = waiter<boolean>(T0 + 100);
    const b = waiter<boolean>(T0 + 100);
    book.set("a", a);
    book.set("b", b);
    book.cancel("a");
    book.delete("b");
    book.cancel("never-there");
    expect((a.reject.mock.calls[0]![0] as Error).message).toBe("cancelled");
    expect(b.reject).not.toHaveBeenCalled();
    expect(book.size).toBe(0);
  });

  it("sweep removes the expired and returns the earliest deadline that remains", () => {
    const book = new WaiterBook<string>();
    const gone = waiter<string>(T0 + 10);
    const soon = waiter<string>(T0 + 500);
    const late = waiter<string>(T0 + 900);
    book.set("gone", gone);
    book.set("late", late);
    book.set("soon", soon);
    expect(book.sweep(at(50))).toBe(T0 + 500);
    expect(gone.reject).toHaveBeenCalledTimes(1);
    expect(book.size).toBe(2);
    expect(book.sweep(at(1000))).toBeNull();
    expect(book.size).toBe(0);
    expect(book.sweep(at(1000))).toBeNull();
  });
});

describe("waitDeadline", () => {
  it("is the time-out of the run when it has one, else the default from now", () => {
    expect(waitDeadline(at(0), "2026-11-14T10:05:00.000Z")).toBe(T0 + 5 * 60_000);
    expect(waitDeadline(at(0), null)).toBe(T0 + DEFAULT_WAIT_MS);
    expect(waitDeadline(at(0), undefined)).toBe(T0 + DEFAULT_WAIT_MS);
    expect(waitDeadline(at(0), "not a date")).toBe(T0 + DEFAULT_WAIT_MS);
  });
});

describe("InstanceState", () => {
  it("is a state of its own for every instance", () => {
    const a = new InstanceState();
    const b = new InstanceState();
    a.codeWaiters.set("facade:x", waiter<string>(T0 + 1000));
    a.liveCheckRunning = true;
    expect(b.codeWaiters.get("facade:x", at(0))).toBeUndefined();
    expect(b.liveCheckRunning).toBe(false);
    expect(a.codeWaiters.size).toBe(1);
  });

  it("sweeps every kind of wait and returns the earliest remaining deadline", () => {
    const s = new InstanceState();
    const expired = [waiter<string>(T0 + 1), waiter<boolean>(T0 + 2), waiter<never>(T0 + 3)];
    s.codeWaiters.set("k", expired[0] as Waiter<string>);
    s.confirmWaiters.set("k", expired[1] as Waiter<boolean>);
    s.accessWaiters.set("k", expired[2] as Waiter<never>);
    s.teamToken.credentials.set("team-token", waiter<never>(T0 + 7000));
    s.teamToken.access.set("team-token", waiter<never>(T0 + 4000));
    s.teamToken.code.set("team-token", waiter<string>(T0 + 9000));
    s.teamToken.confirm.set("team-token", waiter<boolean>(T0 + 5000));
    expect(s.sweepWaiters(at(100))).toBe(T0 + 4000);
    for (const w of expired) expect(w.reject).toHaveBeenCalledTimes(1);
    expect(s.codeWaiters.size + s.confirmWaiters.size + s.accessWaiters.size).toBe(0);
    expect(s.teamToken.credentials.size + s.teamToken.access.size + s.teamToken.code.size + s.teamToken.confirm.size).toBe(4);
    expect(s.sweepWaiters(at(10_000))).toBeNull();
  });
});
