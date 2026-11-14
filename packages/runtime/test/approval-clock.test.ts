import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventoryStoreCore, MemoryEvidenceStore, MemoryInventoryBackend, parseConfig, secretApprovalSnapshot } from "@secret-desk/core/portable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalQueue, createPortableRuntime } from "../src/portable.js";
import { createLocalRuntime } from "../src/runtime.js";

// Every time a runtime stamps comes from the one clock the embedder injected: the approvals too, not only the review deadlines.
const CONFIG = "inventory: ./inventory.yaml\nautomation:\n  enabled: false\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
const INVENTORY = `version: 1
secrets:
  - id: hmac-acme-app
    name: ARTIFACT_HMAC_SECRET
    stage: shared
    service: acme
    provider: manual
    expiry: none
    places:
      - { repo: acme-app, scope: repository }
`;
const DECIDER = { name: "reviewer", kind: "human" } as const;

afterEach(() => {
  vi.useRealTimers();
});

/** One approval, created and approved at two different injected times; the queue must have used exactly those. */
function exercise(rt: { approvals: ApprovalQueue; inventory: InventoryStoreCore }, clock: { t: number }): void {
  const secret = rt.inventory.getSecret("hmac-acme-app")!;
  clock.t = Date.parse("2031-02-03T04:05:06Z");
  const approval = rt.approvals.create({ action: "issue", targetId: "hmac-acme-app", requestedBy: "agent-1", snapshot: secretApprovalSnapshot(secret) });
  expect(approval.createdAt).toBe("2031-02-03T04:05:06.000Z");
  clock.t = Date.parse("2031-02-03T05:00:00Z");
  expect(rt.approvals.begin(approval.id)).toBe(true);
  const decided = rt.approvals.resolve(approval.id, "approved", "done", DECIDER);
  expect(decided.decidedAt).toBe("2031-02-03T05:00:00.000Z");
  // The system clock is far from the injected one: a stamp taken from it would show.
  expect(Math.abs(Date.now() - clock.t)).toBeGreaterThan(86_400_000);
}

describe("the approval queue uses the injected clock", () => {
  it("on the portable builder", async () => {
    const clock = { t: 0 };
    const rt = await createPortableRuntime(
      { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY)), evidence: new MemoryEvidenceStore() },
      { now: () => new Date(clock.t) },
    );
    exercise(rt, clock);
  });

  it("on the Node runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sd-approval-clock-"));
    try {
      await writeFile(join(dir, "inventory.yaml"), INVENTORY);
      await writeFile(join(dir, "c.yaml"), CONFIG);
      const clock = { t: 0 };
      const rt = await createLocalRuntime(join(dir, "c.yaml"), { env: { GH_TEST: "gh_made_up_value_1" } as unknown as NodeJS.ProcessEnv, vault: null, bundledRecipes: null, now: () => new Date(clock.t) });
      exercise(rt, clock);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a queue built without a clock uses the system clock, and a time given to create still wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2032-06-07T08:09:10Z"));
    const inventory = InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY));
    const queue = new ApprovalQueue();
    const snapshot = secretApprovalSnapshot(inventory.getSecret("hmac-acme-app")!);
    const approval = queue.create({ action: "issue", targetId: "hmac-acme-app", requestedBy: "agent-1", snapshot });
    expect(approval.createdAt).toBe("2032-06-07T08:09:10.000Z");
    vi.setSystemTime(new Date("2032-06-07T09:00:00Z"));
    queue.begin(approval.id);
    expect(queue.resolve(approval.id, "denied", undefined, DECIDER).decidedAt).toBe("2032-06-07T09:00:00.000Z");
    const given = queue.create({ action: "issue", targetId: "hmac-acme-app", requestedBy: "agent-1", snapshot, now: new Date("2020-01-01T00:00:00Z") });
    expect(given.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });
});
