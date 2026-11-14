import { SecretValue, secretApprovalSnapshot, variableApprovalSnapshot, type InventoryStore, type PendingIssuance, type SecretEntry, type VariableEntry } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/approvals.js";
import { CLAIM_GRACE_MS, IssuanceQueue, MAX_REVOKE_TRIES, MemoryPendingStore, REVOKE_RETRY_MS, revokeOrphan, type PendingRecord, type PendingStore } from "../src/issuances.js";

const secret = (id: string, params: Record<string, unknown> = {}): SecretEntry => ({ id, name: "TOKEN", stage: "shared", service: "svc", provider: "manual", expiry: "none", params, places: [{ repo: "acme-app", scope: "repository" }] }) as unknown as SecretEntry;
const variable = (id: string, value: string): VariableEntry => ({ id, name: "VAR", stage: "shared", value, places: [{ repo: "acme-app", scope: "repository" }] }) as unknown as VariableEntry;

function fakeInventory(secrets: SecretEntry[], variables: VariableEntry[]): InventoryStore {
  return { getSecret: (id: string) => secrets.find((s) => s.id === id), getVariable: (id: string) => variables.find((v) => v.id === id) } as unknown as InventoryStore;
}

describe("ApprovalQueue", () => {
  it("create: reuses an identical open request, replaces a changed one and marks the old one stale", () => {
    const q = new ApprovalQueue();
    const s = secret("a");
    const first = q.create({ action: "issue", targetId: "a", requestedBy: "bot", reason: "why", snapshot: secretApprovalSnapshot(s), now: new Date("2026-11-01T00:00:00Z") });
    expect(first).toMatchObject({ state: "pending", reason: "why", createdAt: "2026-11-01T00:00:00.000Z" });
    expect(q.create({ action: "issue", targetId: "a", requestedBy: "bot", snapshot: secretApprovalSnapshot(s) })).toBe(first);
    const second = q.create({ action: "issue", targetId: "a", requestedBy: "bot", snapshot: secretApprovalSnapshot(secret("a", { x: 1 })) });
    expect(second).not.toBe(first);
    expect(second.reason).toBeNull();
    expect(first.state).toBe("stale");
    expect(first.result).toMatch(/geaendert/);
  });

  it("list: filters by state and sorts newest first", () => {
    const q = new ApprovalQueue();
    const old = q.create({ action: "issue", targetId: "a", requestedBy: "bot", snapshot: secretApprovalSnapshot(secret("a")), now: new Date("2026-11-01T00:00:00Z") });
    const recent = q.create({ action: "issue", targetId: "b", requestedBy: "bot", snapshot: secretApprovalSnapshot(secret("b")), now: new Date("2026-11-02T00:00:00Z") });
    q.resolve(old.id, "denied", "no");
    expect(q.list().map((a) => a.id)).toEqual([recent.id, old.id]);
    expect(q.list("pending").map((a) => a.id)).toEqual([recent.id]);
    expect(q.list("denied").map((a) => a.id)).toEqual([old.id]);
    expect(q.get(old.id)).toMatchObject({ state: "denied", result: "no" });
    expect(q.get("nope")).toBeUndefined();
  });

  it("begin: only an open request that is not busy; resolve frees it", () => {
    const q = new ApprovalQueue();
    const a = q.create({ action: "issue", targetId: "a", requestedBy: "bot", snapshot: secretApprovalSnapshot(secret("a")) });
    expect(q.begin("nope")).toBe(false);
    expect(q.begin(a.id)).toBe(true);
    expect(q.begin(a.id)).toBe(false);
    expect(q.resolve(a.id, "approved").result).toBeUndefined();
    expect(q.begin(a.id)).toBe(false);
  });

  it("resolve: unknown and already resolved requests are rejected", () => {
    const q = new ApprovalQueue();
    const a = q.create({ action: "issue", targetId: "a", requestedBy: "bot", snapshot: secretApprovalSnapshot(secret("a")) });
    expect(() => q.resolve("nope", "denied")).toThrow(/nicht gefunden/);
    q.resolve(a.id, "failed", "boom");
    expect(() => q.resolve(a.id, "approved")).toThrow(/schon erledigt: failed/);
  });

  it("revalidate: only open, idle requests whose entry changed or vanished become stale", () => {
    const q = new ApprovalQueue();
    const sOk = secret("s-ok");
    const sChanged = secret("s-changed");
    const vOk = variable("v-ok", "1");
    const vChanged = variable("v-changed", "1");
    const mk = (action: "issue" | "apply-variable", id: string, hash: string) => q.create({ action, targetId: id, requestedBy: "bot", snapshot: { hash, view: {} } });
    const ok1 = mk("issue", "s-ok", secretApprovalSnapshot(sOk).hash);
    const bad1 = mk("issue", "s-changed", secretApprovalSnapshot(sChanged).hash);
    const gone = mk("issue", "s-gone", "any-hash");
    const ok2 = mk("apply-variable", "v-ok", variableApprovalSnapshot(vOk).hash);
    const bad2 = mk("apply-variable", "v-changed", variableApprovalSnapshot(vChanged).hash);
    const busy = mk("issue", "s-busy", "x");
    const done = mk("issue", "s-done", "y");
    q.begin(busy.id);
    q.resolve(done.id, "approved");
    const inv = fakeInventory([sOk, secret("s-changed", { changed: true }), secret("s-busy")], [vOk, variable("v-changed", "2")]);
    expect(q.revalidate(inv).sort()).toEqual([bad1.id, gone.id, bad2.id].sort());
    expect([ok1, ok2, busy].map((a) => a.state)).toEqual(["pending", "pending", "pending"]);
    expect(done.state).toBe("approved");
    expect(bad1.result).toMatch(/Freigabe verworfen/);
  });
});

describe("IssuanceQueue", () => {
  const pending = (id: string, createdAt: string, expiresAt: string): PendingIssuance => ({ id, secretId: "s", createdAt, expiresAt, companions: [], report: { externalId: undefined }, issuedSecret: secret("s") }) as unknown as PendingIssuance;

  it("add, get, list newest first and delete", () => {
    const q = new IssuanceQueue();
    q.add(pending("old", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    q.add(pending("new", "2026-11-02T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(q.list().map((p) => p.id)).toEqual(["new", "old"]);
    expect(q.get("old")?.id).toBe("old");
    q.delete("old");
    expect(q.get("old")).toBeUndefined();
  });

  it("sweep drops expired entries even when discarding them fails", async () => {
    const q = new IssuanceQueue();
    q.add(pending("expired", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z"));
    q.add(pending("fresh", "2026-11-02T00:00:00Z", "2026-11-20T00:00:00Z"));
    // Deps without providers make the discard throw; the sweep must still forget the entry.
    const ids = await q.sweep({} as never, new Date("2026-11-10T00:00:00Z"));
    expect(ids).toEqual(["expired"]);
    expect(q.list().map((p) => p.id)).toEqual(["fresh"]);
  });

  it("sweep without a clock uses the current time", async () => {
    const q = new IssuanceQueue();
    q.add(pending("long-gone", "2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z"));
    expect(await q.sweep({} as never)).toEqual(["long-gone"]);
  });
});

describe("IssuanceQueue deadline on every access (injected clock, no sweep, no timer)", () => {
  const withValue = (id: string, expiresAt: string, createdAt = "2026-11-14T10:00:00.000Z"): PendingIssuance =>
    ({ id, secretId: "s", createdAt, expiresAt, value: new SecretValue("made-up-issued-value-1"), companions: [{ entryId: "c", kind: "secret", value: new SecretValue("made-up-companion-value-1"), snapshot: "x" }], report: { externalId: undefined }, issuedSecret: secret("s") }) as unknown as PendingIssuance;
  const clock = (iso: string) => {
    const c = { t: Date.parse(iso) };
    return { c, now: () => new Date(c.t) };
  };

  it("get and list answer from the deadline: valid before it, absent at it, and the value is dropped on that access", () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    const p = withValue("a", "2026-11-14T10:15:00.000Z");
    q.add(p);
    expect(q.get("a")).toBe(p);
    expect(q.list()).toEqual([p]);
    c.t = Date.parse("2026-11-14T10:14:59.999Z");
    expect(q.get("a")).toBe(p);
    c.t = Date.parse("2026-11-14T10:15:00.000Z");
    expect(q.get("a")).toBeUndefined();
    // Removed for good (also from the store), and nobody who still holds the object can read the value any more.
    expect(q.list()).toEqual([]);
    expect(p.value.reveal()).toBe("");
    expect(p.companions[0]!.value.reveal()).toBe("");
  });

  it("list drops expired items on the spot and keeps the rest newest first", () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    const old = withValue("old", "2026-11-14T10:20:00.000Z", "2026-11-14T09:00:00.000Z");
    const recent = withValue("recent", "2026-11-14T10:30:00.000Z", "2026-11-14T09:30:00.000Z");
    const dying = withValue("dying", "2026-11-14T10:05:00.000Z", "2026-11-14T09:45:00.000Z");
    for (const p of [old, dying, recent]) q.add(p);
    c.t = Date.parse("2026-11-14T10:06:00.000Z");
    expect(q.list().map((p) => p.id)).toEqual(["recent", "old"]);
    expect(dying.value.reveal()).toBe("");
    expect(old.value.reveal()).not.toBe("");
  });

  it("an expired item cannot be claimed, and a claimed one that expires is hidden but left to its operation", async () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    const gone = withValue("gone", "2026-11-14T10:01:00.000Z");
    const held = withValue("held", "2026-11-14T10:01:00.000Z");
    q.add(gone);
    q.add(held);
    expect(q.claim("held")).toBe(true);
    expect(q.claim("held")).toBe(false);
    c.t = Date.parse("2026-11-14T10:02:00.000Z");
    expect(q.claim("gone")).toBe(false);
    expect(q.get("held")).toBeUndefined();
    expect(q.list()).toEqual([]);
    // Not dropped while its operation runs, and the sweep leaves it alone within its bound; the next look is at the bound.
    expect(held.value.reveal()).not.toBe("");
    expect(await q.sweep({} as never)).toEqual(["gone"]);
    expect(held.value.reveal()).not.toBe("");
    expect(q.nextDeadline()).toEqual(new Date(Date.parse("2026-11-14T10:01:00.000Z") + CLAIM_GRACE_MS));
    q.release("held");
    expect(await q.sweep({} as never)).toEqual(["held"]);
    expect(held.value.reveal()).toBe("");
  });

  it("a claim is bounded: past deadline plus grace every access takes the item back and the operation's signal fires", async () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const bound = Date.parse("2026-11-14T10:01:00.000Z") + CLAIM_GRACE_MS;
    for (const access of ["get", "list", "claim", "sweep"] as const) {
      const q = new IssuanceQueue({ now });
      const p = withValue("held", "2026-11-14T10:01:00.000Z");
      c.t = Date.parse("2026-11-14T10:00:00.000Z");
      q.add(p);
      expect(q.claim("held")).toBe(true);
      const signal = q.signal("held")!;
      c.t = bound - 1;
      if (access === "sweep") expect(await q.sweep({} as never)).toEqual([]);
      else expect(q.get("held")).toBeUndefined();
      expect(signal.aborted).toBe(false);
      expect(p.value.reveal()).not.toBe("");
      c.t = bound;
      if (access === "get") expect(q.get("held")).toBeUndefined();
      else if (access === "list") expect(q.list()).toEqual([]);
      else if (access === "claim") expect(q.claim("held")).toBe(false);
      else expect(await q.sweep({} as never)).toEqual(["held"]);
      expect(signal.aborted).toBe(true);
      expect(q.signal("held")).toBeUndefined();
      expect(p.value.reveal()).toBe("");
      // The operation lets go later: nothing comes back to life.
      q.release("held");
      expect(q.get("held")).toBeUndefined();
    }
  });

  it("nextDeadline counts a claimed item at its hard bound", () => {
    const { now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z"));
    expect(q.claim("a")).toBe(true);
    expect(q.nextDeadline()).toEqual(new Date(Date.parse("2026-11-14T10:05:00.000Z") + CLAIM_GRACE_MS));
  });

  it("a read leaves the provider-side delete owed, and the next sweep does it once", async () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:01:00.000Z"));
    c.t = Date.parse("2026-11-14T10:02:00.000Z");
    expect(q.get("a")).toBeUndefined();
    expect(await q.sweep({} as never)).toEqual(["a"]);
    expect(await q.sweep({} as never)).toEqual([]);
  });

  it("sweep takes an explicit time and does not touch what is still valid at that time", async () => {
    const { now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:10:00.000Z"));
    q.add(withValue("b", "2026-11-14T10:20:00.000Z"));
    expect(await q.sweep({} as never, new Date("2026-11-14T10:15:00.000Z"))).toEqual(["a"]);
    expect(q.nextDeadline()).toEqual(new Date("2026-11-14T10:20:00.000Z"));
    expect(q.get("b")?.id).toBe("b");
  });

  it("nextDeadline is the earliest deadline of what waits, and null when nothing does", () => {
    const { now } = clock("2026-11-14T10:00:00.000Z");
    const q = new IssuanceQueue({ now });
    expect(q.nextDeadline()).toBeNull();
    q.add(withValue("late", "2026-11-14T10:30:00.000Z"));
    q.add(withValue("early", "2026-11-14T10:10:00.000Z"));
    expect(q.nextDeadline()).toEqual(new Date("2026-11-14T10:10:00.000Z"));
  });

  it("a store sees metadata records only: never the value, a companion value or the report", () => {
    const { now } = clock("2026-11-14T10:00:00.000Z");
    const puts: PendingRecord[] = [];
    const inner = new MemoryPendingStore();
    const store: PendingStore = { put: (r) => (puts.push(r), inner.put(r)), get: (id) => inner.get(id), list: () => inner.list(), delete: (id) => inner.delete(id) };
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z");
    p.report.externalId = "ext-new";
    q.add(p);
    q.add(withValue("renewed", "2026-11-14T10:05:00.000Z"));
    const same = withValue("same", "2026-11-14T10:05:00.000Z");
    same.report.externalId = "ext-1";
    same.oldExternalId = "ext-1";
    q.add(same);
    expect(puts).toEqual([
      { id: "a", secretId: "s", createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T10:05:00.000Z", externalId: "ext-new" },
      { id: "renewed", secretId: "s", createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T10:05:00.000Z" },
      { id: "same", secretId: "s", createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T10:05:00.000Z" },
    ]);
    expect(JSON.stringify(inner.list())).not.toMatch(/made-up|value|report/);
    // The queue does not depend on getting the same object back from the store: it keeps the values itself.
    expect(q.get("a")).toBe(p);
    expect(q.orphans()).toEqual([]);
  });

  describe("the provider-side delete", () => {
    const entry = secret("s");
    const depsOf = (revoke: () => Promise<void>) =>
      ({ inventory: { data: {}, getSecret: (id: string) => (id === "s" ? entry : undefined) }, providers: { get: () => ({ revoke }) }, connections: {}, owner: "o" }) as never;
    const issued = (id: string, externalId: string): PendingIssuance => {
      const p = withValue(id, "2026-11-14T10:05:00.000Z");
      p.report.externalId = externalId;
      return p;
    };

    it("a failed delete is not reported as swept: the record stays and the next sweeps try again, a bounded number of times", async () => {
      const { c, now } = clock("2026-11-14T10:00:00.000Z");
      const store = new MemoryPendingStore();
      const q = new IssuanceQueue({ store, now });
      q.add(issued("a", "ext-new"));
      c.t = Date.parse("2026-11-14T10:06:00.000Z");
      const revoke = vi.fn(async () => {
        throw new Error("provider down");
      });
      // Try 1 happens at the discard of the item, tries 2 to 5 as retries of the record; none of them is a "swept" id.
      for (let i = 1; i <= MAX_REVOKE_TRIES; i++) {
        expect(await q.sweep(depsOf(revoke))).toEqual([]);
        expect(revoke).toHaveBeenCalledTimes(i);
        expect(store.list().length).toBe(i < MAX_REVOKE_TRIES ? 1 : 0);
      }
      // Given up: no more calls.
      expect(await q.sweep(depsOf(revoke))).toEqual([]);
      expect(revoke).toHaveBeenCalledTimes(MAX_REVOKE_TRIES);
    });

    it("a retry that works settles the record", async () => {
      const { c, now } = clock("2026-11-14T10:00:00.000Z");
      const store = new MemoryPendingStore();
      const q = new IssuanceQueue({ store, now });
      q.add(issued("a", "ext-new"));
      c.t = Date.parse("2026-11-14T10:06:00.000Z");
      const revoke = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
      expect(await q.sweep(depsOf(revoke))).toEqual([]);
      expect(q.nextDeadline()).toEqual(new Date(c.t + REVOKE_RETRY_MS));
      expect(await q.sweep(depsOf(revoke))).toEqual(["a"]);
      expect(store.list()).toEqual([]);
      expect(q.nextDeadline()).toBeNull();
      expect(revoke).toHaveBeenCalledTimes(2);
    });

    it("a record whose value is gone (a restarted process) is deleted at the provider once its deadline has passed", async () => {
      const { c, now } = clock("2026-11-14T10:00:00.000Z");
      const store = new MemoryPendingStore();
      const before = new IssuanceQueue({ store, now });
      before.add(issued("a", "ext-new"));
      before.add(withValue("no-new-value", "2026-11-14T10:05:00.000Z"));
      const after = new IssuanceQueue({ store, now });
      expect(after.get("a")).toBeUndefined();
      expect(after.orphans().map((r) => r.id)).toEqual(["a", "no-new-value"]);
      const revoke = vi.fn(async () => undefined);
      // Not yet due: nothing happens, and the next deadline is the record's.
      expect(await after.sweep(depsOf(revoke))).toEqual([]);
      expect(after.nextDeadline()).toEqual(new Date("2026-11-14T10:05:00.000Z"));
      c.t = Date.parse("2026-11-14T10:05:00.000Z");
      expect(await after.sweep(depsOf(revoke))).toEqual(["a", "no-new-value"]);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "ext-new" }));
      expect(store.list()).toEqual([]);
    });

    it("two sweeps at once settle a record once, a record the store lost in the meantime is left alone, and a retired item whose record was deleted still settles", async () => {
      const { c, now } = clock("2026-11-14T10:00:00.000Z");
      const store = new MemoryPendingStore();
      expect(store.get("nope")).toBeUndefined();
      const q = new IssuanceQueue({ store, now });
      q.add(issued("a", "ext-new"));
      c.t = Date.parse("2026-11-14T10:06:00.000Z");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const revoke = vi.fn(async () => gate);
      const first = q.sweep(depsOf(revoke));
      const second = await q.sweep(depsOf(revoke));
      release();
      expect(second).toEqual([]);
      expect(await first).toEqual(["a"]);
      expect(revoke).toHaveBeenCalledTimes(1);

      // The record is listed but gone by the time it is settled.
      const lost: PendingStore = { put: (r) => store.put(r), get: () => undefined, list: () => [{ id: "z", secretId: "s", createdAt: "x", expiresAt: "2026-11-14T10:01:00.000Z", externalId: "ext-z" }], delete: (id) => store.delete(id) };
      const q2 = new IssuanceQueue({ store: lost, now });
      expect(await q2.sweep(depsOf(revoke))).toEqual([]);
      expect(revoke).toHaveBeenCalledTimes(1);

      // An item retired by a read whose record was deleted from the store: the delete at the provider is still done.
      const q3 = new IssuanceQueue({ store: new MemoryPendingStore(), now });
      c.t = Date.parse("2026-11-14T10:00:00.000Z");
      q3.add(issued("b", "ext-b"));
      c.t = Date.parse("2026-11-14T10:06:00.000Z");
      expect(q3.get("b")).toBeUndefined();
      q3.delete("b");
      expect(await q3.sweep(depsOf(vi.fn(async () => undefined)))).toEqual(["b"]);
    });

    it("a delete that throws unexpectedly counts as a failed try and never breaks the sweep", async () => {
      const { c, now } = clock("2026-11-14T10:00:00.000Z");
      const store = new MemoryPendingStore();
      const q = new IssuanceQueue({ store, now });
      store.put({ id: "o", secretId: "s", createdAt: "x", expiresAt: "2026-11-14T10:01:00.000Z", externalId: "ext-o" });
      c.t = Date.parse("2026-11-14T10:06:00.000Z");
      const broken = { inventory: { data: {}, getSecret: () => { throw new Error("inventory unreadable"); } } } as never;
      expect(await q.sweep(broken)).toEqual([]);
      expect(store.list()).toHaveLength(1);
    });

    it("revokeOrphan is the documented way to delete the new value of a record whose value is gone", async () => {
      const revoke = vi.fn(async () => undefined);
      const record = { id: "a", secretId: "s", createdAt: "x", expiresAt: "y", externalId: "ext-new" };
      expect(await revokeOrphan(record, depsOf(revoke))).toBe(true);
      expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "ext-new" }));
      expect(await revokeOrphan({ ...record, externalId: undefined } as never, depsOf(revoke))).toBe(true);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(await revokeOrphan({ ...record, secretId: "gone" }, depsOf(revoke))).toBe(false);
      expect(await revokeOrphan(record, depsOf(async () => Promise.reject(new Error("down"))))).toBe(false);
    });
  });
});
