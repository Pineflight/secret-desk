import { describe, expect, it } from "vitest";
import { ConnectionStore, InventoryStore, ProviderRegistry, SecretValue, buildEnvFile, parseEnvText } from "../src/index.js";
import type { EnvTemplate, Provider } from "../src/index.js";

// A secret is issued at most once per export. A provider that replaces the value in place kills the previous value with every
// issue, so a second issue for a second key of the same template would leave the first key with a dead value.

/** A provider double that replaces in place: it keeps one live value per secret and every issue invalidates the one before. */
function inPlaceProvider() {
  const calls: string[] = [];
  const live = new Map<string, string>();
  const provider: Provider = {
    id: "in-place-issuer",
    label: "In place issuer",
    kind: "automatic",
    async issue(ctx) {
      const value = `made-up-value-${calls.length + 1}`;
      calls.push(ctx.secret.id);
      live.set(ctx.secret.id, value);
      return { value: new SecretValue(value), externalId: ctx.secret.externalId ?? "same-id" };
    },
  };
  return { provider, calls, live };
}

const YAML = `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: in-place-issuer, expiry: none, externalId: same-id }
  - { id: other-token, name: OTHER_TOKEN, stage: dev, service: x, provider: in-place-issuer, expiry: none, externalId: other-id }
envTemplates:
  - id: t
    repo: t
    stage: dev
    entries:
      - { key: FIRST, from: { type: issue, secret: dev-token } }
      - { key: SECOND, from: { type: issue, secret: dev-token } }
      - { key: THIRD, from: { type: issue, secret: other-token } }
`;

function setup(provider: Provider) {
  const inventory = InventoryStore.fromText(YAML);
  const template = inventory.data.envTemplates.find((t) => t.id === "t") as EnvTemplate;
  return { template, deps: { inventory, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() } };
}

describe("buildEnvFile issues each secret once per export", () => {
  it("two keys of one in-place secret: one provider call, both keys carry the value that is live", async () => {
    const double = inPlaceProvider();
    const { template, deps } = setup(double.provider);

    const built = await buildEnvFile(template, deps);
    const values = parseEnvText(built.text);

    // dev-token once, other-token once: two calls for three keys.
    expect(double.calls).toEqual(["dev-token", "other-token"]);
    expect(values.get("FIRST")).toBe(double.live.get("dev-token"));
    expect(values.get("SECOND")).toBe(double.live.get("dev-token"));
    expect(values.get("THIRD")).toBe(double.live.get("other-token"));
    expect(built.issuedSecretIds).toEqual(["dev-token", "other-token"]);
    expect(built.issuedTokens).toEqual([
      { secretId: "dev-token", provider: "in-place-issuer", externalId: "same-id" },
      { secretId: "other-token", provider: "in-place-issuer", externalId: "other-id" },
    ]);
  });

  it("a provider that names a new object for every issue is asked once per secret as well", async () => {
    let n = 0;
    const provider: Provider = {
      id: "in-place-issuer",
      label: "Plain issuer",
      kind: "automatic",
      async issue() {
        n += 1;
        return { value: new SecretValue(`plain-value-${n}`), externalId: `ext-${n}` };
      },
    };
    const { template, deps } = setup(provider);
    const values = parseEnvText((await buildEnvFile(template, deps)).text);
    expect(n).toBe(2);
    expect(values.get("FIRST")).toBe(values.get("SECOND"));
    expect(values.get("FIRST")).not.toBe(values.get("THIRD"));
  });
});
