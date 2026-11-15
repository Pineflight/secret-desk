import { InventoryStoreCore, IssuedButFailedError, IssuedValueLostError, MemoryEvidenceStore, MemoryInventoryBackend, ProviderRegistry, parseConfig, type Provider } from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStore, type PendingStore } from "../src/issuances.js";
import { translateEn } from "../src/i18n-en.js";
import { createPortableRuntime, listIssuances, requestIssuance } from "../src/portable.js";

// A provider whose issue threw IssuedButFailedError: the value goes through the gate (prepareIssuance), and a delete the provider did not
// confirm is owed to the sweep like the delete of a rejected review. Everything here is made up.
const CONFIG = "inventory: ./inventory.yaml\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
const INVENTORY = `version: 1
secrets:
  - id: auto-acme-app
    name: AUTO_TOKEN
    stage: staging
    service: acme
    provider: fake-auto
    expiry: none
    places:
      - { repo: acme-app, scope: environment, environment: staging }
`;
const human = { kind: "human", name: "alice" } as const;

class FullStore extends MemoryPendingStore implements PendingStore {
  override put(): void {
    throw new Error("store is full");
  }
}

async function build(options: { revoke?: () => Promise<void>; store?: PendingStore; info?: { externalId?: string; replacedOld: boolean } } = {}) {
  const revoke = vi.fn(options.revoke ?? (async () => undefined));
  const issue = vi.fn(async () => {
    throw new IssuedButFailedError("the answer was unusable", options.info ?? { externalId: "ext-new", replacedOld: false });
  });
  const registry: ProviderRegistry = createPortableRegistry();
  registry.register({ id: "fake-auto", label: "Fake", kind: "automatic", issue, revoke } as Provider);
  const clock = { t: Date.parse("2026-11-14T10:00:00Z") };
  const evidence = new MemoryEvidenceStore();
  const fetchMock = (async () => new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const rt = await createPortableRuntime(
    { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY)), evidence },
    { now: () => new Date(clock.t), providers: registry, fetch: fetchMock, ...(options.store ? { pendingStore: options.store } : {}) },
  );
  return { rt, revoke, clock, evidence };
}

describe("requestIssuance: the provider changed the value and then failed", () => {
  it("a value that was created is deleted through the gate, and the caller gets the typed error", async () => {
    const { rt, revoke, evidence } = await build();
    const err = await requestIssuance(rt, human, "auto-acme-app").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuedValueLostError);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await listIssuances(rt)).toEqual([]);
    expect(rt.issuances.orphans()).toEqual([]);
    const report = await evidence.get("auto-acme-app", (err as IssuedValueLostError).reportId);
    expect(report?.checks.map((c) => c.id)).toEqual(["issue-failed-after-change"]);
  });

  it("a delete the provider did not confirm is owed: the sweep tries it again", async () => {
    let calls = 0;
    const { rt, revoke, clock, evidence } = await build({ revoke: async () => { calls += 1; if (calls === 1) throw new Error("provider down"); } });
    const err = await requestIssuance(rt, human, "auto-acme-app").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuedValueLostError);
    expect(revoke).toHaveBeenCalledTimes(1);
    clock.t += 3_600_000;
    await rt.sweep(new Date(clock.t));
    expect(revoke).toHaveBeenCalledTimes(2);
    const report = await evidence.get("auto-acme-app", (err as IssuedValueLostError).reportId);
    expect(report?.checks.map((c) => c.id)).toContain("revoke-late");
  });

  it("a store that refuses the record for the retry does not hide the typed error", async () => {
    const { rt } = await build({ revoke: async () => Promise.reject(new Error("provider down")), store: new FullStore() });
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toBeInstanceOf(IssuedValueLostError);
  });

  it("a value replaced in place carries the in-place warning in its report", async () => {
    const { rt, revoke, evidence } = await build({ info: { externalId: "ext-same", replacedOld: true } });
    const err = await requestIssuance(rt, human, "auto-acme-app").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuedValueLostError);
    expect(revoke).toHaveBeenCalledTimes(1);
    const report = await evidence.get("auto-acme-app", (err as IssuedValueLostError).reportId);
    expect(report?.checks.map((c) => c.id)).toContain("in-place-value-lost");
  });

  it("has English catalogue entries for the error texts", () => {
    const de = "Der Anbieter hat den Wert geaendert, aber das Ausstellen ist danach fehlgeschlagen: x\nDer neu angelegte Wert (Kennung e1) wurde nicht geloescht und bleibt beim Anbieter gueltig: von Hand entfernen.";
    expect(translateEn(de)).toBe("The provider changed the value, but issuing failed afterwards: x\nThe newly created value (identifier e1) was not deleted and stays valid at the provider: remove it by hand.");
  });
});
