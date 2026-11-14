import { secretApprovalSnapshot, variableApprovalSnapshot, type InventoryStore, type SecretEntry, type VariableEntry } from "@secret-desk/core";
import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals.js";

// The queue of pending reviews has its own file: issuance-queue.test.ts.

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
