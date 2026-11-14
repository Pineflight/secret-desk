import {
  InventoryStoreCore,
  MemoryEvidenceStore,
  MemoryInventoryBackend,
  ProviderRegistry,
  SecretValue,
  parseConfig,
  type PendingIssuance,
  type Provider,
  type SecretEntry,
} from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import { IssuanceQueue, MAX_REVOKE_TRIES, MemoryPendingStore, type PendingRecord, type PendingStore } from "../src/issuances.js";
import { createPortableRuntime, listIssuances, requestIssuance, resolveApproval, submitManualValue } from "../src/portable.js";

// `IssuanceQueue.add` puts the record into the store first and takes the value only after that; a caller whose `add` threw hands a value
// that was issued at a provider to the revoke gate (the sweep's path) and rethrows. Everything here is made up.
const FAULT = "store is full";

/** A store whose `put` throws (a cap, a refused shape, a storage fault). */
class FullStore extends MemoryPendingStore {
  override put(): void {
    throw new Error(FAULT);
  }
}

describe("IssuanceQueue.add: the record first, then the value", () => {
  const pendingOf = (id: string, over: Partial<PendingIssuance> = {}): PendingIssuance =>
    ({
      id,
      secretId: "s",
      createdAt: "2026-11-14T10:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      value: new SecretValue("made-up-issued-value-0001"),
      companions: [],
      report: { id, secretId: "s", provider: "prov", externalId: "ext-new", checks: [] },
      ...over,
    }) as unknown as PendingIssuance;

  it("a store whose put throws leaves no value held, and the error reaches the caller", () => {
    const q = new IssuanceQueue({ store: new FullStore() });
    expect(() => q.add(pendingOf("a"))).toThrow(FAULT);
    expect(q.get("a")).toBeUndefined();
    expect(q.list()).toEqual([]);
    expect(q.hardBound("a")).toBeUndefined();
    expect(q.claim("a")).toBe(false);
    expect(q.orphans()).toEqual([]);
  });

  it("a failure after the put removes the record again and rethrows the original error", () => {
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store });
    // The id is read once for the record and once more to take the value: the second read fails.
    let reads = 0;
    const p = pendingOf("b");
    Object.defineProperty(p, "id", {
      get() {
        reads += 1;
        if (reads > 1) throw new Error("second read fails");
        return "b";
      },
    });
    expect(() => q.add(p)).toThrow("second read fails");
    expect(store.get("b")).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(q.list()).toEqual([]);
  });

  it("when the record cannot be removed either, the original error is still the one thrown", () => {
    const stuck = new MemoryPendingStore();
    const store: PendingStore = { put: (r) => stuck.put(r), get: (id) => stuck.get(id), list: () => stuck.list(), delete: () => { throw new Error("delete fails too"); } };
    const q = new IssuanceQueue({ store });
    let reads = 0;
    const p = pendingOf("c");
    Object.defineProperty(p, "id", {
      get() {
        reads += 1;
        if (reads > 1) throw new Error("second read fails");
        return "c";
      },
    });
    expect(() => q.add(p)).toThrow("second read fails");
    // What stays is a record without a value: the next sweep's orphan list reports it, nothing is held.
    expect(q.orphans().map((r: PendingRecord) => r.id)).toEqual(["c"]);
    expect(q.get("c")).toBeUndefined();
  });

  it("for a store that does not throw, add holds the value and the record as before", () => {
    const store = new MemoryPendingStore();
    const q = new IssuanceQueue({ store });
    const p = pendingOf("d");
    q.add(p);
    expect(q.get("d")).toBe(p);
    expect(store.get("d")).toMatchObject({ id: "d", secretId: "s", externalId: "ext-new" });
  });

  it("discardUnkept never throws, even when the store fails while it settles", async () => {
    const mem = new MemoryPendingStore();
    const store: PendingStore = { put: (r) => mem.put(r), get: (id) => mem.get(id), list: () => mem.list(), delete: () => { throw new Error("delete fails"); } };
    const q = new IssuanceQueue({ store });
    const revoke = vi.fn(async () => undefined);
    const deps = { inventory: { data: { secrets: [] }, getSecret: () => ({ id: "s", provider: "prov", places: [] }) }, providers: { get: () => ({ revoke }) }, connections: {}, owner: "o" } as never;
    await expect(q.discardUnkept(pendingOf("e", { issuedSecret: { id: "s", provider: "prov" } as unknown as SecretEntry }), deps)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(q.get("e")).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------------ the callers

const CONFIG = "inventory: ./inventory.yaml\npolicy:\n  agentStages: [dev]\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
const inventoryText = (extra = ""): string => `version: 1
secrets:
  - id: auto-acme-app
    name: AUTO_TOKEN
    stage: staging
    service: acme
    provider: fake-auto
    expiry: none
    places:
      - { repo: acme-app, scope: environment, environment: staging }
  - id: manual-acme-app
    name: MANUAL_TOKEN
    stage: shared
    service: acme
    provider: manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
${extra}`;
const HOLDER = `  - id: holder-acme-app
    name: HOLDER_TOKEN
    stage: shared
    service: acme
    provider: manual
    expiry: none
    externalId: ext-new
    places:
      - { repo: acme-app, scope: repository }
`;
const human = { kind: "human", name: "alice" } as const;
const agent = { kind: "agent", name: "claude" } as const;

async function build(options: { store?: PendingStore; revoke?: () => Promise<void>; inventory?: string; onRevokeAbandoned?: (r: PendingRecord) => void } = {}) {
  const revoke = vi.fn(options.revoke ?? (async () => undefined));
  const issue = vi.fn(async () => ({ value: new SecretValue("made-up-issued-value-0001"), externalId: "ext-new" }));
  const provider: Provider = { id: "fake-auto", label: "Fake", kind: "automatic", issue, revoke } as Provider;
  const registry: ProviderRegistry = createPortableRegistry();
  registry.register(provider);
  const clock = { t: Date.parse("2026-11-14T10:00:00Z") };
  const evidence = new MemoryEvidenceStore();
  const fetchMock = (async () => new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const rt = await createPortableRuntime(
    { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(options.inventory ?? inventoryText())), evidence },
    { now: () => new Date(clock.t), providers: registry, fetch: fetchMock, pendingStore: options.store ?? new FullStore(), ...(options.onRevokeAbandoned ? { onRevokeAbandoned: options.onRevokeAbandoned } : {}) },
  );
  return { rt, revoke, issue, clock, evidence };
}

describe("requestIssuance: a value issued at a provider that the queue could not keep", () => {
  it("is handed to the revoke gate, nothing stays held, and the caller gets the store's error", async () => {
    const { rt, revoke, issue } = await build();
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toThrow(FAULT);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]).toMatchObject([{ externalId: "ext-new" }]);
    expect(await listIssuances(rt)).toEqual([]);
    expect(rt.issuances.orphans()).toEqual([]);
  });

  it("when the gate refuses (another entry holds the value), the refusal is reported in the evidence and nothing is revoked", async () => {
    const { rt, revoke, evidence } = await build({ inventory: inventoryText(HOLDER) });
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toThrow(FAULT);
    expect(revoke).not.toHaveBeenCalled();
    expect(await listIssuances(rt)).toEqual([]);
    const reports = await evidence.list("auto-acme-app");
    const report = await evidence.get("auto-acme-app", reports[0]!.id);
    expect(report?.checks.map((c) => c.id)).toContain("revoke-refused");
  });

  it("when the provider's delete fails, it is retried by the sweep and abandoned after the limit, as for an expired review", async () => {
    const onRevokeAbandoned = vi.fn();
    const { rt, revoke, clock } = await build({ revoke: async () => Promise.reject(new Error("provider down")), onRevokeAbandoned });
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toThrow(FAULT);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(onRevokeAbandoned).not.toHaveBeenCalled();
    for (let i = 0; i < MAX_REVOKE_TRIES + 1; i++) {
      clock.t += 3_600_000;
      await rt.sweep(new Date(clock.t));
    }
    expect(revoke).toHaveBeenCalledTimes(MAX_REVOKE_TRIES);
    expect(onRevokeAbandoned).toHaveBeenCalledTimes(1);
    expect(onRevokeAbandoned.mock.calls[0]).toMatchObject([{ secretId: "auto-acme-app", externalId: "ext-new" }]);
    expect(await listIssuances(rt)).toEqual([]);
  });
});

describe("resolveApproval (issue): a value issued at a provider that the queue could not keep", () => {
  it("is handed to the revoke gate, the approval is resolved as failed with the first 200 characters of the error, nothing stays held", async () => {
    const { rt, revoke } = await build();
    const asked = await requestIssuance(rt, agent, "auto-acme-app");
    expect(asked.status).toBe("pending-approval");
    const approvalId = (asked as { approvalId: string }).approvalId;
    const resolved = await resolveApproval(rt, human, approvalId, "approve");
    expect(resolved).toMatchObject({ state: "failed", result: FAULT });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]).toMatchObject([{ externalId: "ext-new" }]);
    expect(await listIssuances(rt)).toEqual([]);
  });

  it("a refusal of the gate is reported in the evidence", async () => {
    const { rt, revoke, evidence } = await build({ inventory: inventoryText(HOLDER) });
    const asked = await requestIssuance(rt, agent, "auto-acme-app");
    const resolved = await resolveApproval(rt, human, (asked as { approvalId: string }).approvalId, "approve");
    expect(resolved.state).toBe("failed");
    expect(revoke).not.toHaveBeenCalled();
    const reports = await evidence.list("auto-acme-app");
    expect((await evidence.get("auto-acme-app", reports[0]!.id))?.checks.map((c) => c.id)).toContain("revoke-refused");
  });
});

describe("submitManualValue: nothing was issued at a provider", () => {
  it("drops the value without asking any provider, holds nothing and rethrows the error", async () => {
    const { rt, revoke } = await build();
    await expect(submitManualValue(rt, human, "manual-acme-app", "made-up-manual-value-0001")).rejects.toThrow(FAULT);
    expect(revoke).not.toHaveBeenCalled();
    expect(await listIssuances(rt)).toEqual([]);
    expect(rt.issuances.orphans()).toEqual([]);
  });

  it("works as before with a store that does not throw", async () => {
    const { rt } = await build({ store: new MemoryPendingStore() });
    const view = await submitManualValue(rt, human, "manual-acme-app", "made-up-manual-value-0001");
    expect((await listIssuances(rt)).map((v) => v.id)).toEqual([view.id]);
  });
});
