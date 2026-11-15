import { describe, expect, it } from "vitest";
import { ConnectionStore, InventoryStore, ProviderRegistry, SecretValue, buildEnvFile, forgetRunValues } from "../src/index.js";
import type { EnvTemplate, Provider } from "../src/index.js";

// The same in-place secret in two templates of one export run: the second template issues again and the value written for the first one
// no longer works. The run says so (a warning); it does not reuse the value across templates, because it cannot know whether the first
// file was kept.

const YAML = `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none, externalId: same-id }
envTemplates:
  - { id: first, repo: first, stage: dev, entries: [{ key: TOKEN, from: { type: issue, secret: dev-token } }] }
  - { id: second, repo: second, stage: dev, entries: [{ key: TOKEN, from: { type: issue, secret: dev-token } }] }
`;

function world(replacesInPlace: boolean) {
  let n = 0;
  const provider: Provider = { id: "acme", label: "Acme", kind: "automatic", ...(replacesInPlace ? { replacesInPlace: true } : {}), issue: async () => ({ value: new SecretValue(`made-up-value-${(n += 1)}`), externalId: "same-id" }) };
  const inventory = InventoryStore.fromText(YAML);
  const deps = { inventory, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore() };
  const template = (id: string): EnvTemplate => inventory.data.envTemplates.find((t) => t.id === id) as EnvTemplate;
  return { deps, template, calls: () => n };
}

describe("buildEnvFile: one run, two templates, the same secret", () => {
  it("warns about the second template when the provider replaces in place", async () => {
    const w = world(true);
    const runValues = new Map<string, string>();
    const first = await buildEnvFile(w.template("first"), { ...w.deps, runValues });
    const second = await buildEnvFile(w.template("second"), { ...w.deps, runValues });
    expect("warnings" in first).toBe(false);
    expect(second.warnings).toEqual(["Das Secret dev-token wird in zwei Vorlagen desselben Laufs ausgestellt (first und second): der Anbieter ersetzt den Wert an Ort und Stelle, die Datei der ersten Vorlage haelt danach einen Wert, der nicht mehr gilt."]);
    // Warned about, not prevented: each template issued once.
    expect(w.calls()).toBe(2);
  });

  it("says nothing for a provider that does not replace in place", async () => {
    const w = world(false);
    const runValues = new Map<string, string>();
    await buildEnvFile(w.template("first"), { ...w.deps, runValues });
    expect("warnings" in (await buildEnvFile(w.template("second"), { ...w.deps, runValues }))).toBe(false);
  });

  it("says nothing when the templates are built without the values of a run", async () => {
    const w = world(true);
    await buildEnvFile(w.template("first"), w.deps);
    expect("warnings" in (await buildEnvFile(w.template("second"), w.deps))).toBe(false);
  });

  it("a frozen or sealed map of values cannot carry the marks: no warning and no crash", async () => {
    for (const lock of [Object.freeze, Object.seal]) {
      const w = world(true);
      const runValues = lock(new Map<string, string>());
      await buildEnvFile(w.template("first"), { ...w.deps, runValues });
      expect("warnings" in (await buildEnvFile(w.template("second"), { ...w.deps, runValues }))).toBe(false);
      expect(w.calls()).toBe(2);
    }
  });

  it("forgetRunValues takes back what a template issued, so a retry does not warn about itself", async () => {
    const w = world(true);
    const runValues = new Map<string, string>();
    await buildEnvFile(w.template("first"), { ...w.deps, runValues });
    forgetRunValues(runValues, "first");
    // The retry of the first template, and then the second, are in the same position as before the first run.
    expect("warnings" in (await buildEnvFile(w.template("first"), { ...w.deps, runValues }))).toBe(false);
    forgetRunValues(runValues, "first");
    expect("warnings" in (await buildEnvFile(w.template("second"), { ...w.deps, runValues }))).toBe(false);
    // Another template's marks stay.
    expect((await buildEnvFile(w.template("first"), { ...w.deps, runValues })).warnings).toHaveLength(1);
    forgetRunValues(undefined, "first");
  });
});
