import { MemoryEvidenceStore, SecretValue, type PendingIssuance, type SecretEntry } from "@secret-desk/core";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_GRACE_MS, IssuanceQueue, MAX_REVOKE_TRIES, MemoryPendingStore, REVOKE_RETRY_MS, revokeOrphanRecord, type PendingRecord, type PendingStore } from "../src/issuances.js";

// What the core says about an item is scripted here: a commit in flight, a commit that wrote some places, a confirmed item.
const hold = vi.hoisted(() => ({ states: new WeakMap<object, string>() }));
vi.mock("@secret-desk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@secret-desk/core")>();
  return {
    ...actual,
    issuanceStateOf: (p: object) => hold.states.get(p) ?? actual.issuanceStateOf(p as never),
    // A scripted "partial" item is one a write was started for.
    hasWriteStarted: (p: object) => ["partial", "committing"].includes(hold.states.get(p) ?? "") || actual.hasWriteStarted(p as never),
  };
});

const T0 = "2026-11-14T10:00:00.000Z";
const at = (iso: string): number => Date.parse(iso);

const entry = (over: Record<string, unknown> = {}): SecretEntry => ({ id: "s", name: "TOKEN", stage: "shared", service: "svc", provider: "prov", expiry: "none", params: {}, places: [{ repo: "acme-app", scope: "repository" }], ...over }) as unknown as SecretEntry;

/** A pending review with a value; `externalId` is the provider's identifier of the new value. */
const withValue = (id: string, expiresAt: string, over: { createdAt?: string; externalId?: string; oldExternalId?: string; noIssued?: boolean } = {}): PendingIssuance =>
  ({
    id,
    secretId: "s",
    createdAt: over.createdAt ?? T0,
    expiresAt,
    value: new SecretValue("made-up-issued-value-1"),
    companions: [{ entryId: "c", kind: "secret", value: new SecretValue("made-up-companion-value-1"), snapshot: "x" }],
    report: { id, secretId: "s", provider: "prov", externalId: over.externalId, checks: [] },
    ...(over.oldExternalId ? { oldExternalId: over.oldExternalId } : {}),
    ...(over.noIssued ? {} : { issuedSecret: entry() }),
  }) as unknown as PendingIssuance;

const clock = (iso: string) => {
  const c = { t: Date.parse(iso) };
  return { c, now: () => new Date(c.t) };
};

/** What the sweep and the explicit revoke work with: the inventory holds `secret` (default: the entry as issued), the provider's delete is `revoke`. */
const depsOf = (o: { revoke?: () => Promise<void>; secret?: SecretEntry | null; evidence?: MemoryEvidenceStore } = {}) =>
  ({
    inventory: { data: {}, getSecret: (id: string) => (id === "s" && o.secret !== null ? (o.secret ?? entry()) : undefined) },
    providers: { get: () => (o.revoke ? { revoke: o.revoke } : undefined) },
    connections: {},
    owner: "o",
    ...(o.evidence ? { evidence: o.evidence } : {}),
  }) as never;

const record = (over: Partial<PendingRecord> = {}): PendingRecord => ({ id: "r", secretId: "s", provider: "prov", createdAt: T0, expiresAt: "2026-11-14T10:05:00.000Z", externalId: "ext-new", ...over });

describe("IssuanceQueue: access", () => {
  it("add, get, list newest first and delete", () => {
    const q = new IssuanceQueue();
    q.add(withValue("old", "2999-01-01T00:00:00Z", { createdAt: "2026-11-01T00:00:00Z" }));
    q.add(withValue("new", "2999-01-01T00:00:00Z", { createdAt: "2026-11-02T00:00:00Z" }));
    expect(q.list().map((p) => p.id)).toEqual(["new", "old"]);
    expect(q.get("old")?.id).toBe("old");
    q.delete("old");
    expect(q.get("old")).toBeUndefined();
  });

  it("get and list answer from the deadline: valid before it, absent at it, and the value is unreachable through the queue", () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const p = withValue("a", "2026-11-14T10:15:00.000Z");
    q.add(p);
    expect(q.get("a")).toBe(p);
    c.t = at("2026-11-14T10:14:59.999Z");
    expect(q.get("a")).toBe(p);
    c.t = at("2026-11-14T10:15:00.000Z");
    expect(q.get("a")).toBeUndefined();
    expect(q.list()).toEqual([]);
    // What the queue held is replaced (a caller's own reference to the object is its own).
    expect(p.value.reveal()).toBe("");
    expect(p.companions[0]!.value.reveal()).toBe("");
  });

  it("list drops expired items on the spot and keeps the rest newest first", () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const old = withValue("old", "2026-11-14T10:20:00.000Z", { createdAt: "2026-11-14T09:00:00.000Z" });
    const recent = withValue("recent", "2026-11-14T10:30:00.000Z", { createdAt: "2026-11-14T09:30:00.000Z" });
    const dying = withValue("dying", "2026-11-14T10:05:00.000Z", { createdAt: "2026-11-14T09:45:00.000Z" });
    for (const p of [old, dying, recent]) q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(q.list().map((p) => p.id)).toEqual(["recent", "old"]);
    expect(dying.value.reveal()).toBe("");
    expect(old.value.reveal()).not.toBe("");
  });

  it("never decides with a time earlier than one it has seen", () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z"));
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(q.list()).toEqual([]);
    // The clock jumps back: a review whose deadline is behind the latest time seen is still expired.
    c.t = at(T0);
    q.add(withValue("b", "2026-11-14T10:03:00.000Z"));
    expect(q.get("b")).toBeUndefined();
  });
});

describe("IssuanceQueue: claims are bounded", () => {
  it("an expired item cannot be claimed; a claimed one is hidden but held within its bound, and counted at its bound", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const gone = withValue("gone", "2026-11-14T10:01:00.000Z");
    const held = withValue("held", "2026-11-14T10:01:00.000Z");
    q.add(gone);
    q.add(held);
    expect(q.claim("held")).toBe(true);
    expect(q.claim("held")).toBe(false);
    expect(q.hardBound("held")).toBe(at("2026-11-14T10:01:00.000Z") + CLAIM_GRACE_MS);
    expect(q.hardBound("nope")).toBeUndefined();
    c.t = at("2026-11-14T10:02:00.000Z");
    expect(q.claim("gone")).toBe(false);
    expect(q.get("held")).toBeUndefined();
    expect(q.list()).toEqual([]);
    expect(held.value.reveal()).not.toBe("");
    expect(await q.sweep(depsOf())).toEqual(["gone"]);
    expect(held.value.reveal()).not.toBe("");
    expect(q.nextDeadline()).toEqual(new Date(at("2026-11-14T10:01:00.000Z") + CLAIM_GRACE_MS));
    q.release("held");
    expect(await q.sweep(depsOf())).toEqual(["held"]);
    expect(held.value.reveal()).toBe("");
  });

  it("past deadline plus grace every access takes the item back and the operation's signal fires", async () => {
    const { c, now } = clock(T0);
    const bound = at("2026-11-14T10:01:00.000Z") + CLAIM_GRACE_MS;
    for (const access of ["get", "list", "claim", "sweep"] as const) {
      const q = new IssuanceQueue({ now });
      const p = withValue("held", "2026-11-14T10:01:00.000Z");
      c.t = at(T0);
      q.add(p);
      expect(q.claim("held")).toBe(true);
      const signal = q.signal("held")!;
      c.t = bound - 1;
      if (access === "sweep") expect(await q.sweep(depsOf())).toEqual([]);
      else expect(q.get("held")).toBeUndefined();
      expect(signal.aborted).toBe(false);
      expect(p.value.reveal()).not.toBe("");
      c.t = bound;
      if (access === "get") expect(q.get("held")).toBeUndefined();
      else if (access === "list") expect(q.list()).toEqual([]);
      else if (access === "claim") expect(q.claim("held")).toBe(false);
      else expect(await q.sweep(depsOf())).toEqual(["held"]);
      expect(signal.aborted).toBe(true);
      expect(q.signal("held")).toBeUndefined();
      expect(p.value.reveal()).toBe("");
      q.release("held");
      expect(q.get("held")).toBeUndefined();
    }
  });
});

describe("IssuanceQueue: the sweep deletes only what this process knows to be unconfirmed", () => {
  it("settles expired items, an explicit time and a read that retired one; a second sweep finds nothing", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:10:00.000Z"));
    q.add(withValue("b", "2026-11-14T10:20:00.000Z"));
    expect(await q.sweep(depsOf(), new Date("2026-11-14T10:15:00.000Z"))).toEqual(["a"]);
    expect(q.nextDeadline()).toEqual(new Date("2026-11-14T10:20:00.000Z"));
    c.t = at("2026-11-14T10:21:00.000Z");
    expect(q.get("b")).toBeUndefined();
    expect(await q.sweep(depsOf())).toEqual(["b"]);
    expect(await q.sweep(depsOf())).toEqual([]);
    expect(q.nextDeadline()).toBeNull();
  });

  it("deletes the new value at the provider and writes an evidence note", async () => {
    const { c, now } = clock(T0);
    const evidence = new MemoryEvidenceStore();
    const q = new IssuanceQueue({ now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual(["a"]);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "ext-new" }));
    expect((await evidence.get("s", "a"))?.confirmation?.note).toContain("Zeit abgelaufen");
  });

  it("a commit in flight is left alone and tried again later; whatever it ends in decides", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    hold.states.set(p, "committing");
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    // Not due again straight away, and the next look is reported.
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    expect(q.nextDeadline()).toEqual(new Date(c.t + REVOKE_RETRY_MS));
    c.t += REVOKE_RETRY_MS;
    // The commit ended and rolled the value out: it is in use, nothing is revoked, and the record goes.
    hold.states.set(p, "committed");
    expect(await q.sweep(depsOf({ revoke }))).toEqual(["a"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(q.orphans()).toEqual([]);
  });

  it("a commit that wrote some places leaves the value to a person: kept, flagged, never revoked by the sweep", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    hold.states.set(p, "partial");
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(store.get("a")).toMatchObject({ needsDecision: true, externalId: "ext-new" });
    expect(q.orphans()).toEqual([expect.objectContaining({ id: "a", needsDecision: true })]);
    expect(q.nextDeadline()).toBeNull();
    // Only an explicit call that says a person decided can delete it.
    expect(await q.revokeOrphan("a", depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(store.get("a")).toBeDefined();
    expect(revoke).not.toHaveBeenCalled();
    expect(await q.revokeOrphan("a", depsOf({ revoke }), { acceptPartial: true })).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(store.get("a")).toBeUndefined();
  });

  it("an item that was discarded already counts as settled", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    hold.states.set(p, "discarded");
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke }))).toEqual(["a"]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("two sweeps at once settle a record once", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    c.t = at("2026-11-14T10:06:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => gate);
    const first = q.sweep(depsOf({ revoke }));
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    release();
    expect(await first).toEqual(["a"]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("IssuanceQueue: a delete the provider does not confirm", () => {
  const failing = () =>
    vi.fn(async () => {
      throw new Error("provider down");
    });

  it("is not reported as swept, is tried again only when due, and is given up after a bounded number of tries (the record stays)", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const abandoned = vi.fn();
    const evidence = new MemoryEvidenceStore();
    const q = new IssuanceQueue({ store, now, onRevokeAbandoned: abandoned });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = failing();
    let tries = 0;
    for (let guard = 0; guard < 50 && abandoned.mock.calls.length === 0; guard++) {
      // Calling the sweep again and again does not use up the tries: nothing happens before the next try is due.
      for (let i = 0; i < 3; i++) expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual([]);
      expect(revoke.mock.calls.length).toBeLessThanOrEqual(tries + 1);
      tries = revoke.mock.calls.length;
      const next = q.nextDeadline();
      if (next) c.t = Math.max(c.t, next.getTime());
    }
    expect(revoke).toHaveBeenCalledTimes(MAX_REVOKE_TRIES);
    expect(abandoned).toHaveBeenCalledWith(expect.objectContaining({ id: "a", externalId: "ext-new" }));
    // Stopped, not settled: the record is still there, now as an orphan, and the evidence says so.
    expect(store.get("a")).toBeDefined();
    expect(q.orphans().map((r) => r.id)).toEqual(["a"]);
    expect(q.nextDeadline()).toBeNull();
    expect((await evidence.get("s", "a"))?.checks.map((x) => x.id)).toContain("revoke-abandoned");
    expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual([]);
    expect(revoke).toHaveBeenCalledTimes(MAX_REVOKE_TRIES);
  });

  it("a later try that works settles the record and adds its own evidence note; a callback that throws changes nothing", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const evidence = new MemoryEvidenceStore();
    const q = new IssuanceQueue({
      store,
      now,
      onRevokeAbandoned: () => {
        throw new Error("callback broke");
      },
    });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    q.add(p);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual([]);
    expect(q.nextDeadline()).toEqual(new Date(c.t + REVOKE_RETRY_MS));
    c.t += REVOKE_RETRY_MS;
    expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual(["a"]);
    expect(store.list()).toEqual([]);
    expect((await evidence.get("s", "a"))?.checks.map((x) => x.id)).toContain("revoke-late");
    // The callback that throws: a record that never works is given up without breaking the sweep.
    const q2 = new IssuanceQueue({
      now,
      onRevokeAbandoned: () => {
        throw new Error("callback broke");
      },
    });
    q2.add(withValue("z", "2026-11-14T10:05:00.000Z", { externalId: "ext-z" }));
    for (let i = 0; i < MAX_REVOKE_TRIES + 1; i++) {
      await q2.sweep(depsOf({ revoke: failing() }));
      c.t += REVOKE_RETRY_MS * MAX_REVOKE_TRIES;
    }
    expect(q2.orphans().map((r) => r.id)).toEqual(["z"]);
  });

  it("an error out of the discard itself is a failed try, never a settled record", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    c.t = at("2026-11-14T10:06:00.000Z");
    // Deps that make the discard throw.
    expect(await q.sweep({} as never)).toEqual([]);
    expect(store.get("a")).toBeDefined();
    expect(q.nextDeadline()).toEqual(new Date(c.t + REVOKE_RETRY_MS));
    // The next try goes by the record alone; with working deps there is nothing to delete and the record goes.
    c.t += REVOKE_RETRY_MS;
    expect(await q.sweep(depsOf())).toEqual(["a"]);
    expect(store.list()).toEqual([]);
  });

  it("an unexpected throw of the retry counts as a failed try and never breaks the sweep", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(await q.sweep({} as never)).toEqual([]);
    c.t += REVOKE_RETRY_MS;
    const broken = {
      inventory: {
        data: {},
        getSecret: () => {
          throw new Error("inventory unreadable");
        },
      },
    } as never;
    expect(await q.sweep(broken)).toEqual([]);
    expect(store.get("a")).toBeDefined();
  });

  it("a retry that finds the value in use drops the record without calling the provider", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(await q.sweep({} as never)).toEqual([]);
    c.t += REVOKE_RETRY_MS;
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke, secret: entry({ externalId: "ext-new" }) }))).toEqual(["a"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("a person's reject that the provider did not confirm goes on the same list", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    q.add(p);
    q.delete("a");
    q.oweIfNeeded(p, { revokedNew: true });
    q.oweIfNeeded(p, { revokedNew: false, refused: "value-in-use" });
    q.oweIfNeeded(withValue("b", "2026-11-14T10:05:00.000Z"), { revokedNew: false });
    expect(store.list()).toEqual([]);
    q.oweIfNeeded(p, { revokedNew: false });
    expect(store.get("a")).toBeDefined();
    expect(q.orphans()).toEqual([]);
    expect(q.nextDeadline()).toEqual(new Date(c.t + REVOKE_RETRY_MS));
    c.t += REVOKE_RETRY_MS;
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke }))).toEqual(["a"]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
  });
});

describe("IssuanceQueue: the store sees metadata only, and orphans are revoked only by an explicit call that refuses a value in use", () => {
  it("a store is handed records without the value, the companion values or the report", () => {
    const { now } = clock(T0);
    const puts: PendingRecord[] = [];
    const inner = new MemoryPendingStore();
    const store: PendingStore = { put: (r) => (puts.push(r), inner.put(r)), get: (id) => inner.get(id), list: () => inner.list(), delete: (id) => inner.delete(id) };
    const q = new IssuanceQueue({ store, now });
    q.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    q.add(withValue("renewed", "2026-11-14T10:05:00.000Z", { noIssued: true }));
    q.add(withValue("same", "2026-11-14T10:05:00.000Z", { externalId: "ext-1", oldExternalId: "ext-1" }));
    expect(puts).toEqual([
      { id: "a", secretId: "s", provider: "prov", createdAt: T0, expiresAt: "2026-11-14T10:05:00.000Z", externalId: "ext-new", companionIds: ["c"] },
      { id: "renewed", secretId: "s", provider: "prov", createdAt: T0, expiresAt: "2026-11-14T10:05:00.000Z", companionIds: ["c"] },
      { id: "same", secretId: "s", provider: "prov", createdAt: T0, expiresAt: "2026-11-14T10:05:00.000Z", companionIds: ["c"] },
    ]);
    expect(JSON.stringify(inner.list())).not.toMatch(/made-up|"value"|report/);
    expect(q.orphans()).toEqual([]);
    expect(new MemoryPendingStore().get("nope")).toBeUndefined();
  });

  it("after a confirm whose record removal was lost and a restart: the sweep revokes nothing, the explicit call refuses and drops the record", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const lostDelete: PendingStore = { put: (r) => store.put(r), get: (id) => store.get(id), list: () => store.list(), delete: () => undefined };
    const before = new IssuanceQueue({ store: lostDelete, now });
    before.add(withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    // The confirm succeeded: the review is forgotten, the inventory holds the new identifier, the record is left behind.
    before.delete("a");
    expect(store.get("a")).toBeDefined();
    const after = new IssuanceQueue({ store, now });
    c.t = at("2026-11-14T10:30:00.000Z");
    const revoke = vi.fn(async () => undefined);
    const live = depsOf({ revoke, secret: entry({ externalId: "ext-new" }) });
    expect(await after.sweep(live)).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(after.orphans().map((r) => r.id)).toEqual(["a"]);
    expect(after.nextDeadline()).toBeNull();
    expect(await after.revokeOrphan("a", live)).toEqual({ status: "refused", reason: "value-in-use" });
    expect(revoke).not.toHaveBeenCalled();
    expect(store.get("a")).toBeUndefined();
  });

  it("a forged record that names the live identifier is refused; a changed provider and a missing secret are refused", async () => {
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store });
    const revoke = vi.fn(async () => undefined);
    store.put(record({ id: "forged", externalId: "ext-live" }));
    expect(await q.revokeOrphan("forged", depsOf({ revoke, secret: entry({ externalId: "ext-live" }) }))).toEqual({ status: "refused", reason: "value-in-use" });
    store.put(record({ id: "moved", provider: "other" }));
    expect(await q.revokeOrphan("moved", depsOf({ revoke }))).toEqual({ status: "refused", reason: "provider-changed" });
    store.put(record({ id: "missing" }));
    expect(await q.revokeOrphan("missing", depsOf({ revoke, secret: null }))).toEqual({ status: "refused", reason: "secret-gone" });
    expect(revoke).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("a real orphan (issued, never confirmed, value gone) is revoked by the explicit call, with an evidence note; a failure keeps the record", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const evidence = new MemoryEvidenceStore();
    const first = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    first.add(p);
    first.add(withValue("renewed", "2026-11-14T10:05:00.000Z"));
    const q = new IssuanceQueue({ store, now });
    expect(await q.sweep(depsOf())).toEqual([]);
    c.t = at("2026-11-14T10:30:00.000Z");
    // The sweep does not touch records it holds no review for.
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(q.orphans().map((r) => r.id)).toEqual(["a", "renewed"]);
    // Explicit calls: a failed delete keeps the record, a working one removes it and notes it; no identifier means nothing to delete.
    const down = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await q.revokeOrphan("a", depsOf({ revoke: down }))).toEqual({ status: "failed" });
    expect(store.get("a")).toBeDefined();
    expect(await q.revokeOrphan("a", depsOf({ revoke, evidence }))).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "ext-new" }));
    expect(store.get("a")).toBeUndefined();
    expect((await evidence.get("s", "a"))?.checks.map((x) => x.id)).toContain("orphan-revoked");
    expect(await q.revokeOrphan("renewed", depsOf({ revoke }))).toEqual({ status: "refused", reason: "no-id" });
    expect(store.list()).toEqual([]);
    expect(await q.revokeOrphan("a", depsOf({ revoke }))).toEqual({ status: "refused", reason: "unknown" });
  });

  it("a review this queue holds, or still owes a delete for, is not an orphan to revoke", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    q.add(withValue("held", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    expect(await q.revokeOrphan("held", depsOf())).toEqual({ status: "refused", reason: "held-here" });
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(q.get("held")).toBeUndefined();
    expect(await q.revokeOrphan("held", depsOf())).toEqual({ status: "refused", reason: "held-here" });
  });

  it("revokeOrphanRecord names the case that applied", async () => {
    const revoke = vi.fn(async () => undefined);
    expect(await revokeOrphanRecord(record({ externalId: undefined }), depsOf({ revoke }))).toEqual({ status: "refused", reason: "no-id" });
    expect(await revokeOrphanRecord(record(), depsOf({ revoke }))).toEqual({ status: "revoked" });
    expect(await revokeOrphanRecord(record(), depsOf())).toEqual({ status: "refused", reason: "no-revoke" });
    expect(await revokeOrphanRecord(record({ writeStarted: true }), depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(await revokeOrphanRecord(record({ needsDecision: true }), depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(await revokeOrphanRecord(record({ writeStarted: true }), depsOf({ revoke }), { acceptPartial: true })).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

describe("IssuanceQueue: the gate in the queue's sequences", () => {
  it("a record left by a process that died mid-commit (the store holds writeStarted) is refused without acknowledgement, kept flagged, and told to onNeedsDecision", async () => {
    const store = new MemoryPendingStore();
    store.put(record({ id: "died", writeStarted: true }));
    const told = vi.fn();
    const q = new IssuanceQueue({ store, onNeedsDecision: told });
    const revoke = vi.fn(async () => undefined);
    expect(await q.revokeOrphan("died", depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(store.get("died")).toMatchObject({ writeStarted: true, needsDecision: true });
    expect(told).toHaveBeenCalledWith(expect.objectContaining({ id: "died", needsDecision: true }));
    expect(revoke).not.toHaveBeenCalled();
    // A callback that throws changes nothing, and the explicit acknowledgement lifts the refusal.
    const throwing = new IssuanceQueue({ store, onNeedsDecision: () => { throw new Error("broke"); } });
    expect(await throwing.revokeOrphan("died", depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(await throwing.revokeOrphan("died", depsOf({ revoke }), { acceptPartial: true })).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
  });

  it("an item a write was started for is never revoked by the sweep when it expires, and the expiry is reported", async () => {
    const { c, now } = clock(T0);
    const told = vi.fn();
    const evidence = new MemoryEvidenceStore();
    const q = new IssuanceQueue({ now, onNeedsDecision: told });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    q.add(p);
    // The commit records the fact before its first write, in the store, and a failing store update stops the commit.
    q.markWriteStarted("a");
    hold.states.set(p, "partial");
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke, evidence }))).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledTimes(1);
    expect((await evidence.get("s", "a"))?.checks.map((x) => x.id)).toContain("needs-decision");
    expect(q.orphans()).toEqual([expect.objectContaining({ id: "a", writeStarted: true, needsDecision: true })]);
  });

  it("markWriteStarted updates the record, falls back to the held item, and throws when the store cannot take it or nothing is known", () => {
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store });
    q.add(withValue("a", "2999-01-01T00:00:00Z", { externalId: "ext-new" }));
    q.markWriteStarted("a");
    expect(store.get("a")).toMatchObject({ writeStarted: true, externalId: "ext-new" });
    store.delete("a");
    q.markWriteStarted("a");
    expect(store.get("a")).toMatchObject({ writeStarted: true });
    expect(() => q.markWriteStarted("nope")).toThrow(/No record/);
    const refusing = new IssuanceQueue({ store: { put: () => { throw new Error("store down"); }, get: () => undefined, list: () => [], delete: () => undefined } });
    expect(() => refusing.markWriteStarted("a")).toThrow(/No record|store down/);
    const failing = new IssuanceQueue({ store: { put: (r) => { if (r.writeStarted) throw new Error("store down"); }, get: () => undefined, list: () => [], delete: () => undefined } });
    failing.add(withValue("b", "2999-01-01T00:00:00Z"));
    expect(() => failing.markWriteStarted("b")).toThrow("store down");
  });

  it("two reviews with the same provider id, one confirmed: the other's expiry revokes nothing (value in use), and so does a stale discard of it", async () => {
    const { c, now } = clock(T0);
    const q = new IssuanceQueue({ now });
    const other = withValue("other", "2026-11-14T10:05:00.000Z", { externalId: "ext-shared" });
    q.add(other);
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    // The confirmed review's identifier is the entry's current one.
    expect(await q.sweep(depsOf({ revoke, secret: entry({ externalId: "ext-shared" }) }))).toEqual(["other"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(q.orphans()).toEqual([]);
  });

  it("a stale item a write was started for stays for a person (kept, flagged); any other stale item goes and a failed delete is owed", async () => {
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store });
    const p = withValue("a", "2999-01-01T00:00:00Z", { externalId: "ext-new" });
    q.add(p);
    hold.states.set(p, "partial");
    await q.keepForDecision(p, depsOf());
    expect(q.get("a")).toBeUndefined();
    expect(store.get("a")).toMatchObject({ writeStarted: true, needsDecision: true });
    expect(q.orphans().map((r) => r.id)).toEqual(["a"]);
  });

  it("with two queues on one store, a record without a value here may be the other's live review: refused as not-expired until deadline plus grace, or when flagged", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const owner = new IssuanceQueue({ store, now });
    const other = new IssuanceQueue({ store, now });
    owner.add(withValue("live", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" }));
    const revoke = vi.fn(async () => undefined);
    expect(await other.revokeOrphan("live", depsOf({ revoke }))).toEqual({ status: "refused", reason: "not-expired" });
    // Past the deadline but inside the grace of a claimed review: still not an orphan.
    c.t = at("2026-11-14T10:06:00.000Z");
    expect(await other.revokeOrphan("live", depsOf({ revoke }))).toEqual({ status: "refused", reason: "not-expired" });
    expect(revoke).not.toHaveBeenCalled();
    expect(store.get("live")).toBeDefined();
    c.t = at("2026-11-14T10:05:00.000Z") + CLAIM_GRACE_MS;
    expect(await other.revokeOrphan("live", depsOf({ revoke }))).toEqual({ status: "revoked" });
    // A record flagged for a person's decision is an orphan whatever its deadline says.
    store.put(record({ id: "flagged", expiresAt: "2999-01-01T00:00:00.000Z", needsDecision: true, writeStarted: true }));
    expect(await other.revokeOrphan("flagged", depsOf({ revoke }))).toEqual({ status: "refused", reason: "write-started" });
    expect(await other.revokeOrphan("flagged", depsOf({ revoke }), { acceptPartial: true })).toEqual({ status: "revoked" });
  });

  it("an acknowledged revoke that worked leaves a note that the places hold a revoked value; one that failed keeps the acknowledgement for its retries", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const evidence = new MemoryEvidenceStore();
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2999-01-01T00:00:00.000Z", { externalId: "ext-new" });
    await evidence.save(p.report);
    hold.states.set(p, "partial");
    q.add(p);
    q.delete("a");
    // A person's reject (acknowledged) whose delete the provider did not confirm: owed, with the acknowledgement.
    q.oweIfNeeded(p, { revokedNew: false }, { acknowledgeWritten: true });
    const down = vi.fn(async () => { throw new Error("down"); });
    c.t += REVOKE_RETRY_MS;
    expect(await q.sweep(depsOf({ revoke: down, evidence }))).toEqual([]);
    expect(down).toHaveBeenCalledTimes(1);
    c.t += REVOKE_RETRY_MS * 3;
    const up = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke: up, evidence }))).toEqual(["a"]);
    expect(up).toHaveBeenCalledTimes(1);
    expect((await evidence.get("s", "a"))?.checks.find((x) => x.id === "revoked-written")?.label).toContain("widerrufenen Wert");
    // Without the acknowledgement the same retry is refused as write-started.
    const q2 = new IssuanceQueue({ now });
    q2.oweIfNeeded(p, { revokedNew: false });
    c.t += REVOKE_RETRY_MS * 10;
    expect(await q2.sweep(depsOf({ revoke: up, evidence }))).toEqual([]);
    expect(up).toHaveBeenCalledTimes(1);
    // An explicit orphan revoke under acceptPartial says so too.
    const store3 = new MemoryPendingStore();
    store3.put(record({ id: "died", writeStarted: true }));
    await evidence.save({ ...p.report, id: "died" });
    const q3 = new IssuanceQueue({ store: store3, now });
    expect(await q3.revokeOrphan("died", depsOf({ revoke: up, evidence }), { acceptPartial: true })).toEqual({ status: "revoked" });
    expect((await evidence.get("s", "died"))?.checks.map((x) => x.id)).toContain("revoked-written");
  });

  it("a sweep keeps the record of a commit that is still in flight, and a person-decided orphan can be revoked later", async () => {
    const { c, now } = clock(T0);
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store, now });
    const p = withValue("a", "2026-11-14T10:05:00.000Z", { externalId: "ext-new" });
    q.add(p);
    q.markWriteStarted("a");
    hold.states.set(p, "committing");
    c.t = at("2026-11-14T10:06:00.000Z");
    const revoke = vi.fn(async () => undefined);
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    hold.states.set(p, "partial");
    c.t += REVOKE_RETRY_MS;
    expect(await q.sweep(depsOf({ revoke }))).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(await q.revokeOrphan("a", depsOf({ revoke }), { acceptPartial: true })).toEqual({ status: "revoked" });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
