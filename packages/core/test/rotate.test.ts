import sodium from "libsodium-wrappers";
import { describe, expect, it, vi } from "vitest";
import { ConnectionStore } from "../src/connections.js";
import { GitHubClient, patProvider } from "../src/github.js";
import { InventoryStore } from "../src/inventory.js";
import { ProviderRegistry, type Provider } from "../src/provider.js";
import { planRotation, rotateSecret, RotationError, uploadEncrypted, type RotationEvent } from "../src/rotate.js";
import { SecretValue } from "../src/secret.js";
import { INVENTORY_YAML } from "./fixtures.js";

async function setup(options: { failRepo?: string } = {}) {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const written: { url: string; plaintext: string }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/public-key")) return new Response(JSON.stringify({ key_id: "k", key: pub }), { status: 200 });
    if (options.failRepo && u.includes(`/${options.failRepo}/`)) return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
    const body = JSON.parse(String(init?.body)) as { encrypted_value: string };
    let plaintext = "<nicht entschluesselbar>";
    try {
      plaintext = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
    } catch {
      /* vorverschluesselte Testwerte */
    }
    written.push({ url: u, plaintext });
    return new Response(null, { status: 204 });
  });
  const inventory = InventoryStore.fromText(INVENTORY_YAML);
  const github = new GitHubClient({ auth: patProvider(new SecretValue("t")), fetch: fetchMock as unknown as typeof fetch });
  const revoke = vi.fn(async () => undefined);
  const issue = vi.fn(async () => ({ value: new SecretValue("NEUER-TOKEN-WERT"), externalId: "new-id", expiresAt: null }));
  const provider: Provider = { id: "cloudflare-token", label: "Cloudflare", kind: "automatic", connection: "cloudflare", issue, revoke };
  const providers = new ProviderRegistry().register(provider);
  const events: RotationEvent[] = [];
  const deps = { inventory, github, providers, connections: new ConnectionStore(), owner: "Pineflight", now: () => new Date("2026-11-01T10:00:00Z"), onEvent: (e: RotationEvent) => events.push(e) };
  return { deps, inventory, issue, revoke, written, events };
}

describe("rotateSecret", () => {
  it("erzeugt, schreibt in alle Ziele, widerruft den alten und traegt das Datum ein", async () => {
    const { deps, inventory, issue, revoke, written, events } = await setup();
    const result = await rotateSecret("cf-deploy-wakemiles", deps);
    expect(result.ok).toBe(true);
    expect(written.map((w) => w.plaintext)).toEqual(["NEUER-TOKEN-WERT", "NEUER-TOKEN-WERT"]);
    expect(written[0]!.url).toContain("/wake-miles/actions/secrets/CLOUDFLARE_API_TOKEN");
    expect(written[1]!.url).toContain("/wake-miles-landingpage/");
    expect(issue).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ externalId: "old-token-id" }));
    const s = inventory.getSecret("cf-deploy-wakemiles")!;
    expect(s.expires).toBe("2027-01-30");
    expect(s.rotatedAt).toBe("2026-11-01");
    expect(s.externalId).toBe("new-id");
    expect(result.revoked).toBe(true);
    expect(JSON.stringify({ result, events })).not.toContain("NEUER-TOKEN-WERT");
  });
  it("widerruft nicht und traegt nichts ein, wenn ein Ziel fehlschlaegt", async () => {
    const { deps, inventory, revoke } = await setup({ failRepo: "wake-miles-landingpage" });
    const result = await rotateSecret("cf-deploy-wakemiles", deps);
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    expect(inventory.getSecret("cf-deploy-wakemiles")!.expires).toBe("2027-01-21");
    expect(inventory.getSecret("cf-deploy-wakemiles")!.externalId).toBe("old-token-id");
  });
  it("verweigert Stages, die nicht freigegeben sind", async () => {
    const { deps } = await setup();
    await expect(rotateSecret("stripe-webhook-leitfaden-staging", deps, { allowedStages: ["dev"] })).rejects.toThrow(RotationError);
    expect(() => planRotation("cf-deploy-wakemiles", deps, { allowedStages: ["dev"] })).toThrow(/nicht freigegeben/);
  });
  it("kann manuelle Secrets nicht automatisch rotieren", async () => {
    const { deps } = await setup();
    await expect(rotateSecret("stripe-webhook-leitfaden-staging", deps)).rejects.toThrow(/von Hand/);
  });
  it("planRotation zeigt Ziele, ohne etwas auszufuehren", async () => {
    const { deps, issue } = await setup();
    const plan = planRotation("cf-deploy-wakemiles", deps);
    expect(plan).toMatchObject({ automatic: true, revokesOld: true, places: ["wake-miles/repo", "wake-miles-landingpage/repo"] });
    expect(issue).not.toHaveBeenCalled();
  });
});

describe("uploadEncrypted", () => {
  it("leitet vorverschluesselte Werte weiter und traegt das Datum ein", async () => {
    const { deps, inventory } = await setup();
    const s = inventory.getSecret("stripe-webhook-leitfaden-staging")!;
    const res = await uploadEncrypted(s.id, [{ place: s.places[0]!, keyId: "k", encryptedValue: "YWJj" }], deps, { expires: null });
    expect(res.ok).toBe(true);
    expect(inventory.getSecret(s.id)!.rotatedAt).toBe("2026-11-01");
  });
  it("lehnt Ziele ab, die nicht zum Secret gehoeren", async () => {
    const { deps } = await setup();
    const res = await uploadEncrypted("stripe-webhook-leitfaden-staging", [{ place: { repo: "fremd", scope: "repository" }, keyId: "k", encryptedValue: "x" }], deps);
    expect(res.ok).toBe(false);
  });
});
