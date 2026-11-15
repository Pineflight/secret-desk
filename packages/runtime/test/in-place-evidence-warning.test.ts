import { InventoryStoreCore, MemoryEvidenceStore, MemoryInventoryBackend, ProviderRegistry, SecretValue, parseConfig, type Provider } from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStore, type PendingStore } from "../src/issuances.js";
import { translateEn } from "../src/i18n-en.js";
import { createPortableRuntime, listIssuances, rejectIssuance, requestIssuance } from "../src/portable.js";

// A provider that replaces the value in place: when a value of it is discarded unconfirmed, the gate correctly revokes nothing, and the
// evidence report must say that the old value is already invalid and the new one is known to nobody. Everything here is made up.
const CONFIG = "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
const INVENTORY = `version: 1
secrets:
  - id: auto-acme-app
    name: AUTO_TOKEN
    stage: staging
    service: acme
    provider: fake-auto
    expiry: none
    externalId: ext-same
    places:
      - { repo: acme-app, scope: environment, environment: staging }
`;
const human = { kind: "human", name: "alice" } as const;
const WARNING = "in-place-value-lost";

class FullStore extends MemoryPendingStore implements PendingStore {
  override put(): void {
    throw new Error("store is full");
  }
}

async function build(options: { inPlace: boolean; store?: PendingStore }) {
  const revoke = vi.fn(async () => undefined);
  const issue = vi.fn(async () => ({
    value: new SecretValue("made-up-issued-value-0001"),
    externalId: options.inPlace ? "ext-same" : "ext-new",
    ...(options.inPlace ? { replacedInPlace: true } : {}),
  }));
  const registry: ProviderRegistry = createPortableRegistry();
  registry.register({ id: "fake-auto", label: "Fake", kind: "automatic", issue, revoke } as Provider);
  const clock = { t: Date.parse("2026-11-14T10:00:00Z") };
  const evidence = new MemoryEvidenceStore();
  const fetchMock = (async () => new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const rt = await createPortableRuntime(
    { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY)), evidence },
    { now: () => new Date(clock.t), providers: registry, fetch: fetchMock, ...(options.store ? { pendingStore: options.store } : {}) },
  );
  const checkIds = async (): Promise<string[]> => {
    const reports = await evidence.list("auto-acme-app");
    const report = await evidence.get("auto-acme-app", reports[0]!.id);
    return report!.checks.map((c) => c.id);
  };
  return { rt, revoke, clock, checkIds };
}

describe("a value of an in-place provider that is discarded unconfirmed leaves a warning in the report", () => {
  it("the sweep after the deadline revokes nothing and warns", async () => {
    const { rt, revoke, clock, checkIds } = await build({ inPlace: true });
    await requestIssuance(rt, human, "auto-acme-app");
    clock.t += 3_600_000;
    await rt.sweep(new Date(clock.t));
    expect(await listIssuances(rt)).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(await checkIds()).toContain(WARNING);
  });

  it("the path of a value the queue could not keep (discardUnkept) revokes nothing and warns", async () => {
    const { rt, revoke, checkIds } = await build({ inPlace: true, store: new FullStore() });
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toThrow("store is full");
    expect(revoke).not.toHaveBeenCalled();
    expect(await checkIds()).toContain(WARNING);
  });

  it("a person's reject revokes nothing and warns", async () => {
    const { rt, revoke, checkIds } = await build({ inPlace: true });
    const asked = await requestIssuance(rt, human, "auto-acme-app");
    if (asked.status !== "awaiting-review") throw new Error("expected a review");
    await rejectIssuance(rt, human, asked.issuance.id);
    expect(revoke).not.toHaveBeenCalled();
    expect(await checkIds()).toContain(WARNING);
  });

  it("a provider that names a new object has nothing to warn about: the new value is deleted", async () => {
    const { rt, revoke, clock, checkIds } = await build({ inPlace: false });
    await requestIssuance(rt, human, "auto-acme-app");
    clock.t += 3_600_000;
    await rt.sweep(new Date(clock.t));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await checkIds()).not.toContain(WARNING);
  });

  it("has an English catalogue entry", () => {
    expect(translateEn("Der Anbieter hat den Wert an Ort und Stelle ersetzt; der neue Wert wurde nicht behalten: die Ausstellung erneut ausfuehren oder einen Wert von Hand eingeben.")).toBe(
      "The provider replaced the value in place; the new value was not kept: run the issuance again or enter a value by hand.",
    );
  });
});
