import { InventoryStoreCore, MemoryEvidenceStore, MemoryInventoryBackend, ProviderRegistry, SecretValue, parseConfig, type Provider } from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { describe, expect, it, vi } from "vitest";
import { MemoryPendingStore } from "../src/issuances.js";
import { translateEn } from "../src/i18n-en.js";
import { createPortableRuntime, requestIssuance } from "../src/portable.js";

// When the gate cannot read the stored inventory it refuses to delete a new value. The record is dropped and nothing is tried again, so the
// evidence says so in a plain sentence (not the raw reason). Everything here is made up.
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
const SENTENCE = "Neuer Wert nicht widerrufen: das Inventar liess sich nicht lesen, ob er in Gebrauch ist, ist unbekannt. Er bleibt beim Anbieter gueltig und wird nicht erneut versucht: pruefen und von Hand entfernen.";

class FullStore extends MemoryPendingStore {
  override put(): void {
    throw new Error("store is full");
  }
}

class FlakyBackend extends MemoryInventoryBackend {
  gone = false;
  override stamp(): string | null {
    return this.gone ? null : super.stamp();
  }
}

describe("the evidence note for a refusal because the inventory could not be read", () => {
  it("is a plain sentence, nothing is revoked, and the record does not stay", async () => {
    const backend = new FlakyBackend(INVENTORY);
    const revoke = vi.fn(async () => undefined);
    const registry: ProviderRegistry = createPortableRegistry();
    registry.register({
      id: "fake-auto",
      label: "Fake",
      kind: "automatic",
      issue: async () => {
        // The stored inventory becomes unreadable while the value is issued.
        backend.gone = true;
        return { value: new SecretValue("made-up-issued-value-0001"), externalId: "ext-new" };
      },
      revoke,
    } as Provider);
    const evidence = new MemoryEvidenceStore();
    const fetchMock = (async () => new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const rt = await createPortableRuntime(
      { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(backend), evidence },
      { now: () => new Date("2026-11-14T10:00:00Z"), providers: registry, fetch: fetchMock, pendingStore: new FullStore() },
    );
    await expect(requestIssuance(rt, human, "auto-acme-app")).rejects.toThrow("store is full");
    expect(revoke).not.toHaveBeenCalled();
    expect(rt.issuances.orphans()).toEqual([]);
    const reports = await evidence.list("auto-acme-app");
    const report = await evidence.get("auto-acme-app", reports[0]!.id);
    const note = report!.checks.find((c) => c.id === "revoke-refused");
    expect(note?.label).toBe(SENTENCE);
    expect(note?.label).not.toContain("inventory-unreadable");
  });

  it("has English catalogue entries for the note and for the notice of a failed export", () => {
    expect(translateEn(SENTENCE)).toBe("New value not revoked: the inventory could not be read, so it is unknown whether it is in use. It stays valid at the provider and is not tried again: check it and remove it by hand.");
    expect(translateEn("Nicht widerrufen, weil das Inventar nicht gelesen werden konnte: der Token kann in Gebrauch sein und bleibt beim Anbieter gueltig; erst pruefen, dann von Hand entfernen, falls er nicht gebraucht wird: s1 (e1).")).toBe(
      "Not revoked because the inventory could not be read: the token may be in use and stays valid at the provider; check first, then remove it by hand if it is not needed: s1 (e1).",
    );
  });
});
