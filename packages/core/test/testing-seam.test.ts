import { describe, expect, it } from "vitest";
import { MemoryEvidenceStore } from "../src/evidence.js";
import { MemoryVaultStore } from "../src/vault-core.js";
import * as testing from "../src/testing/index.js";
import { contractTest, withMade, type ContractFramework } from "../src/testing/framework.js";

/** A framework that only records: `describe` runs its body, `it` collects the test bodies so the test can run them. */
function recordingFramework(): { framework: ContractFramework; bodies: Array<{ name: string; body: () => unknown }> } {
  const bodies: Array<{ name: string; body: () => unknown }> = [];
  return { bodies, framework: { describe: (_name, body) => body(), it: (name, body) => void bodies.push({ name, body }), expect } };
}

describe("contract suite seam", () => {
  it("exports the three suites and the helpers from the testing entry", () => {
    expect(Object.keys(testing).sort()).toEqual(["INVENTORY_CONTRACT_YAML", "contractTest", "evidenceStoreContract", "inventoryBackendContract", "vaultStoreContract", "withMade"]);
  });

  it("runs every test body through the runner, with a fresh store from the factory each time", async () => {
    const { framework, bodies } = recordingFramework();
    let made = 0;
    let inside = 0;
    let entered = 0;
    testing.vaultStoreContract(
      framework,
      "wrapped",
      async () => {
        made += 1;
        expect(inside).toBe(1);
        return { store: new MemoryVaultStore() };
      },
      {
        run: async (body) => {
          entered += 1;
          inside += 1;
          try {
            return await body();
          } finally {
            inside -= 1;
          }
        },
      },
    );
    for (const { body } of bodies) await body();
    expect(bodies.length).toBeGreaterThan(5);
    expect(entered).toBe(bodies.length);
    // One factory call per test, two in the isolation test.
    expect(made).toBe(bodies.length + 1);
  });

  it("registers the evidence and inventory suites under their own names", () => {
    const evidence = recordingFramework();
    const names: string[] = [];
    testing.evidenceStoreContract({ ...evidence.framework, describe: (name, body) => (names.push(name), body()) }, "x", () => ({ store: new MemoryEvidenceStore() }));
    expect(names).toEqual(["evidence store contract: x"]);
    expect(evidence.bodies.some((b) => b.name === 'attach: refuses the MIME type "__proto__"')).toBe(true);
    const inventory = recordingFramework();
    const inventoryNames: string[] = [];
    testing.inventoryBackendContract({ ...inventory.framework, describe: (name, body) => (inventoryNames.push(name), body()) }, "y", () => {
      throw new Error("not called while registering");
    });
    expect(inventoryNames).toEqual(["inventory store contract: y"]);
    expect(inventory.bodies).toHaveLength(11);
  });

  it("runs the cleanup after the body, also when the body fails, and works without a cleanup", async () => {
    const order: string[] = [];
    await withMade(
      async () => ({ cleanup: async () => void order.push("cleanup") }),
      async () => void order.push("use"),
    );
    await expect(
      withMade(
        () => ({ cleanup: () => void order.push("cleanup after failure") }),
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    await withMade(() => ({}), async () => void order.push("no cleanup"));
    expect(order).toEqual(["use", "cleanup", "cleanup after failure", "no cleanup"]);
  });

  it("contractTest runs the body directly without a runner", async () => {
    const { framework, bodies } = recordingFramework();
    let ran = false;
    contractTest(framework, {}, "t", async () => void (ran = true));
    await bodies[0]!.body();
    expect(ran).toBe(true);
  });
});
