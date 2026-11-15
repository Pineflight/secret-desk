import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, InventoryStore, ProviderRegistry, RotationError, SecretValue, rotateSecret } from "../src/index.js";
import type { Provider, RotateDeps } from "../src/index.js";

// `rotateSecret` writes the main value only. A provider with companion values (a client id next to a client secret) would leave a
// half-written pair, so it is refused before anything is created at the provider.

const YAML = `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none, places: [{ repo: acme-app, scope: repository }] }
`;

function world(over: Partial<Provider>) {
  const issue = vi.fn(async () => ({ value: new SecretValue("made-up-value-0123456789"), externalId: "ext-1" }));
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", issue, ...over };
  const deps = { inventory: InventoryStore.fromText(YAML), providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() } as unknown as RotateDeps;
  return { issue, deps };
}

describe("rotateSecret and companion values", () => {
  it("refuses a provider that names companion parameters, with a clear error, before it issues anything", async () => {
    const { issue, deps } = world({ companionParams: ["clientIdTarget"] });
    const err = await rotateSecret("dev-token", deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RotationError);
    expect((err as Error).message).toBe('Anbieter "acme" liefert Begleitwerte, die diese Funktion nicht schreibt. Stattdessen ausstellen und bestaetigen (prepareIssuance, commitIssuance).');
    expect(issue).not.toHaveBeenCalled();
  });

  it("a provider with an empty list of companion parameters is not refused for that", async () => {
    const { issue, deps } = world({ companionParams: [] });
    // It goes on to issue; the double has no GitHub client, so the write fails afterwards. What matters here is that it was not refused.
    await rotateSecret("dev-token", deps).catch(() => undefined);
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
