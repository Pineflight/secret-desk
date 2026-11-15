import { InventoryStoreCore, MemoryEvidenceStore, MemoryInventoryBackend, ProviderRegistry, SecretValue, parseConfig, type Provider } from "@secret-desk/core/portable";
import { createPortableRegistry } from "@secret-desk/providers/portable";
import { createDefaultRegistry } from "@secret-desk/providers";
import { describe, expect, it } from "vitest";
import { translateEn } from "../src/i18n-en.js";
import { createPortableRuntime, preflightSecret, requestIssuance } from "../src/portable.js";

// Before an action that issues from a provider that replaces the value in place, the plan, the preflight and the answer to a request carry
// a notice. Everything here is made up.
const CONFIG = "inventory: ./inventory.yaml\npolicy:\n  agentStages: [dev]\ngithub:\n  owner: acme\n  auth: { type: pat, source: { type: env, name: GH_TEST } }\n";
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
const agent = { kind: "agent", name: "claude" } as const;

async function build(replacesInPlace: boolean) {
  const registry: ProviderRegistry = createPortableRegistry();
  registry.register({ id: "fake-auto", label: "Fake", kind: "automatic", ...(replacesInPlace ? { replacesInPlace: true } : {}), issue: async () => ({ value: new SecretValue("made-up-issued-value-0001"), externalId: "ext-new" }), revoke: async () => undefined } as Provider);
  const fetchMock = (async () => new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return createPortableRuntime(
    { config: parseConfig(CONFIG), inventory: InventoryStoreCore.withBackend(new MemoryInventoryBackend(INVENTORY)), evidence: new MemoryEvidenceStore() },
    { now: () => new Date("2026-11-14T10:00:00Z"), providers: registry, fetch: fetchMock },
  );
}

describe("the notice of a provider that replaces in place", () => {
  it("is on the dry-run plan, for an agent as well", async () => {
    const rt = await build(true);
    for (const actor of [human, agent]) {
      const result = await requestIssuance(rt, actor, "auto-acme-app", { dryRun: true });
      if (result.status !== "dry-run") throw new Error("expected a dry run");
      expect(result.plan).toMatchObject({ replacesInPlace: true });
      expect(result.plan.notice).toContain("ersetzt einen bestehenden Wert");
    }
  });

  it("is on the preflight of the secret", async () => {
    const rt = await build(true);
    expect((await preflightSecret(rt, "auto-acme-app")).notice).toContain("ersetzt einen bestehenden Wert");
  });

  it("is on the answer to a request that waits for an approval and on the one that waits for a review", async () => {
    const rt = await build(true);
    const waiting = await requestIssuance(rt, agent, "auto-acme-app");
    expect(waiting).toMatchObject({ status: "pending-approval" });
    expect((waiting as { notice?: string }).notice).toContain("ersetzt einen bestehenden Wert");
    const review = await requestIssuance(rt, human, "auto-acme-app");
    expect(review).toMatchObject({ status: "awaiting-review" });
    expect((review as { notice?: string }).notice).toContain("ersetzt einen bestehenden Wert");
  });

  it("is nowhere for a provider that does not replace in place", async () => {
    const rt = await build(false);
    const waiting = await requestIssuance(rt, agent, "auto-acme-app");
    expect("notice" in waiting).toBe(false);
    const review = await requestIssuance(rt, human, "auto-acme-app");
    expect("notice" in review).toBe(false);
    expect("notice" in (await preflightSecret(rt, "auto-acme-app"))).toBe(false);
  });

  it("has an English catalogue entry", () => {
    expect(translateEn("Das Ausstellen ersetzt einen bestehenden Wert beim Anbieter sofort: der bisherige Wert gilt danach nicht mehr, auch wenn die Pruefung verworfen wird. Alles, was ihn noch nutzt, scheitert, bis es den neuen Wert erhaelt.")).toBe(
      "Issuing replaces an existing value at the provider immediately: the previous value stops working afterwards, even if the review is discarded. Everything that still uses it fails until it receives the new value.",
    );
  });
});

describe("which providers carry the flag", () => {
  it("exactly the two that can replace a value in place", () => {
    const flagged = createDefaultRegistry().list().filter((p) => p.replacesInPlace === true).map((p) => p.id).sort();
    expect(flagged).toEqual(["cloudflare-access-service-token", "supabase-db-password"]);
  });
});
