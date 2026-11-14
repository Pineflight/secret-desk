import { SecretValue, secretApprovalSnapshot, variableApprovalSnapshot, type InventoryStore, type PendingIssuance, type SecretEntry, type VariableEntry } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals.js";
import { IssuanceQueue, MemoryPendingStore, type PendingStore } from "../src/issuances.js";

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
    // Not dropped while its operation runs; nothing is owed for it yet.
    expect(held.value.reveal()).not.toBe("");
    expect(q.nextDeadline()).toBeNull();
    q.release("held");
    expect(await q.sweep({} as never)).toEqual(["gone", "held"]);
    expect(held.value.reveal()).toBe("");
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

  it("works on a store of the embedder: put, get, list and delete are all it needs, and it may have lost the value", () => {
    const { c, now } = clock("2026-11-14T10:00:00.000Z");
    const inner = new MemoryPendingStore();
    const calls: string[] = [];
    const store: PendingStore = {
      put: (p) => (calls.push(`put ${p.id}`), inner.put(p)),
      get: (id) => (calls.push(`get ${id}`), inner.get(id)),
      list: () => (calls.push("list"), inner.list()),
      delete: (id) => (calls.push(`delete ${id}`), inner.delete(id)),
    };
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z");
    q.add(p);
    expect(q.get("a")).toBe(p);
    q.delete("a");
    // The embedder's process was evicted and the store no longer has it: that is "gone", not a fault.
    expect(q.get("a")).toBeUndefined();
    expect(q.list()).toEqual([]);
    q.add(withValue("b", "2026-11-14T10:05:00.000Z"));
    c.t = Date.parse("2026-11-14T10:06:00.000Z");
    expect(q.get("b")).toBeUndefined();
    expect(calls).toEqual(["put a", "get a", "delete a", "get a", "list", "put b", "get b", "delete b"]);
  });
});
