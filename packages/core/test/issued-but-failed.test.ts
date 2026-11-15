import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { buildEnvFile } from "../src/env-export.js";
import { MemoryEvidenceStore } from "../src/evidence.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { IssuanceError, IssuedValueLostError, prepareIssuance } from "../src/issuance.js";
import { IssuedButFailedError, ProviderRegistry, isIssuedButFailedError, type Provider } from "../src/provider.js";
import { SecretValue } from "../src/secret.js";
import type { EnvTemplate } from "../src/index.js";
import { INVENTORY_YAML } from "./fixtures.js";

// A provider whose `issue` throws after it created or replaced the value at the provider: the identifier is recorded like an issued value
// that could not be kept and handed to the revoke gate; nothing calls the provider's revoke directly.

type Info = { externalId?: string; replacedOld: boolean };

async function setup(info: Info, over: { revoke?: Provider["revoke"]; externalId?: string } = {}) {
  await sodium.ready;
  const revoke = vi.fn(over.revoke ?? (async () => undefined));
  const provider: Provider = {
    id: "cloudflare-token",
    label: "Cloudflare",
    kind: "automatic",
    issue: async () => {
      throw new IssuedButFailedError("the answer was unusable", info);
    },
    revoke,
    reviewChecklist: () => ["only"],
  };
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  if (over.externalId) inventory.patchSecret("cf-deploy-acme-app", { externalId: over.externalId });
  const evidence = new MemoryEvidenceStore();
  const deps = {
    inventory,
    github: new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch }),
    providers: new ProviderRegistry().register(provider),
    connections: new ConnectionStore(),
    owner: "acme",
    now: () => new Date("2026-11-01T10:00:00Z"),
    evidence,
  };
  const lost = async (): Promise<IssuedValueLostError> => {
    const err = await prepareIssuance("cf-deploy-acme-app", deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssuedValueLostError);
    expect(err).toBeInstanceOf(IssuanceError);
    return err as IssuedValueLostError;
  };
  const checkIds = async (err: IssuedValueLostError): Promise<string[]> => (await evidence.get("cf-deploy-acme-app", err.reportId))!.checks.map((c) => c.id);
  return { deps, revoke, lost, checkIds, evidence };
}

describe("prepareIssuance: the provider's issue threw IssuedButFailedError", () => {
  it("a new value was created: it goes through the gate and is deleted, the error says so, the report records it", async () => {
    const { revoke, lost, checkIds, evidence } = await setup({ externalId: "new-id", replacedOld: false });
    const err = await lost();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]).toMatchObject([{ externalId: "new-id" }]);
    expect(err.result).toEqual({ revokedNew: true });
    expect(err.externalId).toBe("new-id");
    expect(err.replacedOld).toBe(false);
    expect(err.message).toBe("Der Anbieter hat den Wert geaendert, aber das Ausstellen ist danach fehlgeschlagen: the answer was unusable\nDer neu angelegte Wert wurde beim Anbieter wieder geloescht.");
    expect(await checkIds(err)).toEqual(["issue-failed-after-change"]);
    const report = (await evidence.get("cf-deploy-acme-app", err.reportId))!;
    expect(report).toMatchObject({ kind: "issued", externalId: "new-id", confirmation: { by: "system", decision: "rejected", note: "Ausstellen nach der Aenderung beim Anbieter fehlgeschlagen" } });
    // The value-free record of the discard is on the error for a queue to owe a failed delete.
    expect(err.pending.value.reveal()).toBe("");
  });

  it("the delete fails: the error names the identifier and the value stays valid", async () => {
    const { lost, revoke } = await setup({ externalId: "new-id", replacedOld: false }, { revoke: async () => Promise.reject(new Error("provider down")) });
    const err = await lost();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(err.result).toEqual({ revokedNew: false });
    expect(err.message).toContain("Der neu angelegte Wert (Kennung new-id) wurde nicht geloescht und bleibt beim Anbieter gueltig: von Hand entfernen.");
  });

  it("the gate refuses when another entry holds the identifier: nothing is revoked", async () => {
    const { lost, revoke, deps } = await setup({ externalId: "held-id", replacedOld: false });
    deps.inventory.patchSecret("lead-token-dev", { externalId: "held-id" });
    const err = await lost();
    expect(revoke).not.toHaveBeenCalled();
    expect(err.result).toEqual({ revokedNew: false, refused: "value-in-use" });
  });

  it("no identifier and nothing replaced: the gate says no-id and the report and the error say to look at the provider", async () => {
    const { lost, revoke, checkIds } = await setup({ replacedOld: false });
    const err = await lost();
    expect(revoke).not.toHaveBeenCalled();
    expect(err.result).toEqual({ revokedNew: false, refused: "no-id" });
    expect(err.message).toContain("Der Anbieter hat keine Kennung genannt: den neuen Wert beim Anbieter pruefen und von Hand entfernen.");
    expect(await checkIds(err)).toEqual(["issue-failed-after-change", "revoke-no-id"]);
  });

  it("the old value was replaced in place: nothing to revoke, the report and the error say the old value is gone", async () => {
    const { lost, revoke, checkIds } = await setup({ externalId: "same-id", replacedOld: true }, { externalId: "same-id" });
    const err = await lost();
    expect(revoke).not.toHaveBeenCalled();
    expect(err.replacedOld).toBe(true);
    expect(err.message).toContain("Der bisherige Wert gilt beim Anbieter nicht mehr und der neue ist niemandem bekannt.");
    expect(await checkIds(err)).toEqual(["issue-failed-after-change", "in-place-value-lost"]);
  });

  it("replaced in place, and the entry records no identifier yet: still the in-place warning", async () => {
    const { lost, revoke, checkIds } = await setup({ externalId: "project-ref", replacedOld: true });
    const err = await lost();
    // The provider says it replaced the value in place: what the identifier names is the live object, so nothing is deleted.
    expect(revoke).not.toHaveBeenCalled();
    expect(await checkIds(err)).toContain("in-place-value-lost");
  });

  it("an entry that records no identifier yet: the new value is deleted all the same", async () => {
    const { deps, revoke, lost } = await setup({ externalId: "new-id", replacedOld: false });
    deps.inventory.patchSecret("cf-deploy-acme-app", { externalId: null });
    expect(deps.inventory.getSecret("cf-deploy-acme-app")?.externalId).toBeUndefined();
    const err = await lost();
    expect(err.result).toEqual({ revokedNew: true });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("any other error from issue passes through unchanged and nothing is recorded", async () => {
    const { deps, revoke, evidence } = await setup({ replacedOld: false });
    const plain = new Error("provider down");
    const own = { ...deps, providers: new ProviderRegistry().register({ id: "cloudflare-token", label: "Cloudflare", kind: "automatic", issue: async () => Promise.reject(plain), revoke }) };
    await expect(prepareIssuance("cf-deploy-acme-app", own)).rejects.toBe(plain);
    expect(revoke).not.toHaveBeenCalled();
    expect(await evidence.list("cf-deploy-acme-app")).toEqual([]);
  });

  it("an error from another copy of the module is recognised by its name and field, a plain error of that name is not", async () => {
    const lookalike = Object.assign(new Error("x"), { name: "IssuedButFailedError", replacedOld: false });
    expect(isIssuedButFailedError(lookalike)).toBe(true);
    expect(isIssuedButFailedError(Object.assign(new Error("x"), { name: "IssuedButFailedError" }))).toBe(false);
    expect(isIssuedButFailedError(new Error("x"))).toBe(false);
    expect(isIssuedButFailedError("x")).toBe(false);
  });
});

describe("buildEnvFile: the provider's issue threw IssuedButFailedError", () => {
  const YAML = (id: string) => `version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none${id} }
envTemplates:
  - { id: t, repo: t, stage: dev, entries: [{ key: A, from: { type: issue, secret: dev-token } }] }
`;
  const run = async (info: Info, recorded = "") => {
    const revoke = vi.fn(async () => undefined);
    const provider: Provider = {
      id: "acme",
      label: "Acme",
      kind: "automatic",
      issue: async () => {
        throw new IssuedButFailedError("the answer was unusable", info);
      },
      revoke,
    };
    const inventory = InventoryStore.fromText(YAML(recorded));
    const evidence = new MemoryEvidenceStore();
    const err = await buildEnvFile(inventory.data.envTemplates[0] as EnvTemplate, { inventory, providers: new ProviderRegistry().register(provider), connections: new ConnectionStore(), evidence }).catch((e: Error) => e);
    return { err: err as Error, revoke, evidence };
  };

  it("a created value goes through the gate and is deleted", async () => {
    const { err, revoke } = await run({ externalId: "new-id", replacedOld: false });
    expect(err).toBeInstanceOf(IssuedButFailedError);
    expect(err.message).toBe("the answer was unusable");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]).toMatchObject([{ externalId: "new-id" }]);
  });

  it("a value replaced in place is reported as such, nothing is revoked, and the evidence carries the warning", async () => {
    const { err, revoke, evidence } = await run({ externalId: "same-id", replacedOld: true }, ", externalId: same-id");
    expect(revoke).not.toHaveBeenCalled();
    expect(err.message).toContain("Der Anbieter hat den Wert unter derselben Kennung ersetzt");
    expect(err.message).toContain("dev-token (same-id)");
    const reports = await evidence.list("dev-token");
    expect((await evidence.get("dev-token", reports[0]!.id))?.checks.map((c) => c.id)).toEqual(["in-place-value-lost"]);
  });

  it("replaced in place without an identifier: the notice names the secret without one", async () => {
    const { err, revoke } = await run({ replacedOld: true });
    expect(revoke).not.toHaveBeenCalled();
    expect(err.message).toContain("dev-token (ohne Kennung)");
  });

  it("a value issued earlier that the provider says it replaced in place is reported as such when a later secret fails", async () => {
    const issuedFirst: Provider = { id: "acme", label: "Acme", kind: "automatic", issue: async () => ({ value: new SecretValue("made-up-first-value"), externalId: "first-id", replacedInPlace: true }), revoke: vi.fn(async () => undefined) };
    const breaks: Provider = { id: "breaks", label: "Breaks", kind: "automatic", issue: async () => Promise.reject(new Error("later entry failed")) };
    const inventory = InventoryStore.fromText(`version: 1
secrets:
  - { id: dev-token, name: DEV_TOKEN, stage: dev, service: x, provider: acme, expiry: none }
  - { id: dev-other, name: DEV_OTHER, stage: dev, service: x, provider: breaks, expiry: none }
envTemplates:
  - { id: t, repo: t, stage: dev, entries: [{ key: A, from: { type: issue, secret: dev-token } }, { key: B, from: { type: issue, secret: dev-other } }] }
`);
    const evidence = new MemoryEvidenceStore();
    const err = await buildEnvFile(inventory.data.envTemplates[0] as EnvTemplate, { inventory, providers: new ProviderRegistry().register(issuedFirst).register(breaks), connections: new ConnectionStore(), evidence }).catch((e: Error) => e);
    expect(err.message).toContain("Der Anbieter hat den Wert unter derselben Kennung ersetzt");
    expect(err.message).toContain("dev-token (first-id)");
    expect(issuedFirst.revoke).not.toHaveBeenCalled();
    // The entry records no identifier yet, so only the provider's word says it was replaced in place.
    const reports = await evidence.list("dev-token");
    expect((await evidence.get("dev-token", reports[0]!.id))?.checks.map((c) => c.id)).toEqual(["in-place-value-lost"]);
  });

  it("created without an identifier: to be removed by hand", async () => {
    const { err, revoke } = await run({ replacedOld: false });
    expect(revoke).not.toHaveBeenCalled();
    expect(err.message).toContain("Nicht widerrufen (beim Anbieter von Hand entfernen): dev-token (ohne Kennung).");
  });
});
