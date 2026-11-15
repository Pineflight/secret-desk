import { describe, expect, it } from "vitest";
import { ConnectionStore, InventoryStore, ProviderRegistry, REPLACES_IN_PLACE_NOTICE, SecretValue, planRotation, preflightEntry, replacesInPlaceNotice } from "../src/index.js";
import type { Provider } from "../src/index.js";

// A provider that replaces an existing value at the provider when it issues says so with `replacesInPlace`: a plan and a preflight carry
// a notice for the person or agent before the action. Nothing else changes for a provider without the flag.

const YAML = `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none }
`;
const issuer = (over: Partial<Provider> = {}): Provider => ({ id: "acme", label: "Acme", kind: "automatic", issue: async () => ({ value: new SecretValue("made-up-value") }), ...over });

function world(provider: Provider) {
  const inventory = InventoryStore.fromText(YAML);
  return { inventory, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() };
}

describe("replacesInPlaceNotice", () => {
  it("is the notice for a provider with the flag, and nothing otherwise", () => {
    expect(replacesInPlaceNotice(issuer({ replacesInPlace: true }))).toBe(REPLACES_IN_PLACE_NOTICE);
    expect(replacesInPlaceNotice(issuer({ replacesInPlace: false }))).toBeUndefined();
    expect(replacesInPlaceNotice(issuer())).toBeUndefined();
    expect(replacesInPlaceNotice(undefined)).toBeUndefined();
  });
});

describe("planRotation", () => {
  it("carries the flag and the notice for a provider that replaces in place", () => {
    const w = world(issuer({ replacesInPlace: true }));
    expect(planRotation("dev-token", w)).toMatchObject({ replacesInPlace: true, notice: REPLACES_IN_PLACE_NOTICE });
  });
  it("carries neither for another provider", () => {
    const w = world(issuer());
    const plan = planRotation("dev-token", w);
    expect("replacesInPlace" in plan).toBe(false);
    expect("notice" in plan).toBe(false);
  });
});

describe("preflightEntry", () => {
  it("carries the notice also when the provider has no check of its own", async () => {
    const w = world(issuer({ replacesInPlace: true }));
    expect(await preflightEntry(w.inventory.getSecret("dev-token")!, w)).toEqual({ status: "skipped", skippedReason: "none", resource: null, findings: [], notice: REPLACES_IN_PLACE_NOTICE });
  });
  it("carries the notice next to the findings of a check that ran", async () => {
    const w = world(issuer({ replacesInPlace: true, preflight: async () => ({ resource: "project-1", findings: [] }) }));
    expect(await preflightEntry(w.inventory.getSecret("dev-token")!, w)).toEqual({ status: "ok", resource: "project-1", findings: [], notice: REPLACES_IN_PLACE_NOTICE });
  });
  it("has no notice for another provider", async () => {
    const w = world(issuer());
    expect(await preflightEntry(w.inventory.getSecret("dev-token")!, w)).toEqual({ status: "skipped", skippedReason: "none", resource: null, findings: [] });
  });
});
