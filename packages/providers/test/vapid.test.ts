import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { vapidProvider as p, vapidPublicKeyOf } from "../src/vapid.js";
import { ProviderError } from "../src/http.js";
import { byId, issueCtx, mockFetch, secretEntry, verifyCtx } from "./helpers.js";

const params = { publicKeyVariable: "vapid-public" };

describe("vapid-keypair", () => {
  it("is automatic, needs no connection and names the companion parameter", () => {
    expect(p).toMatchObject({ kind: "automatic", companionParams: ["publicKeyVariable"] });
    expect(p.connection).toBeUndefined();
    expect(p.revoke).toBeUndefined();
    expect(p.params!.find((s) => s.key === "publicKeyVariable")).toMatchObject({ required: true });
  });
  it("issues the private key as 32-byte base64url and the public key as a variable companion", async () => {
    const m = mockFetch();
    const r = await p.issue!(issueCtx(m.fetch, params));
    const priv = r.value.reveal();
    expect(priv).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(priv, "base64url")).toHaveLength(32);
    expect(r.companions).toHaveLength(1);
    const c = r.companions![0]!;
    expect(c).toMatchObject({ entryId: "vapid-public", kind: "variable" });
    const pub = Buffer.from(c.value.reveal(), "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(4);
    expect(r.expiresAt).toBeNull();
    expect(m.calls).toHaveLength(0);
  });
  it("the private key derives the public key (independent derivation)", async () => {
    const r = await p.issue!(issueCtx(mockFetch().fetch, params));
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(r.value.reveal(), "base64url"));
    expect(ecdh.getPublicKey().toString("base64url")).toBe(r.companions![0]!.value.reveal());
    expect(vapidPublicKeyOf(r.value.reveal())).toBe(r.companions![0]!.value.reveal());
  });
  it("a different pair every time", async () => {
    const a = (await p.issue!(issueCtx(mockFetch().fetch, params))).value.reveal();
    const b = (await p.issue!(issueCtx(mockFetch().fetch, params))).value.reveal();
    expect(a).not.toBe(b);
  });
  it("needs the variable parameter", async () => {
    await expect(p.issue!(issueCtx(mockFetch().fetch, {}))).rejects.toThrow(ProviderError);
  });
  it("vapidPublicKeyOf rejects values that are not a 32-byte base64url scalar", () => {
    for (const bad of ["", "short", "a".repeat(44), "+/=".repeat(15)]) expect(() => vapidPublicKeyOf(bad)).toThrow(ProviderError);
  });
  it("verify passes a generated key, fails a bad one and always warns about subscriptions", async () => {
    const r = await p.issue!(issueCtx(mockFetch().fetch, params));
    const ok = await p.verify!(verifyCtx(mockFetch().fetch, params, { value: r.value.reveal() }));
    expect(byId(ok)).toEqual({ shape: "pass", public: "pass", local: "info", subscriptions: "warn" });
    expect(JSON.stringify(ok)).not.toContain(r.value.reveal());
    const bad = await p.verify!(verifyCtx(mockFetch().fetch, params, { value: "not-a-key" }));
    expect(byId(bad)).toMatchObject({ shape: "fail", subscriptions: "warn" });
  });
  it("review checklist warns that rotating invalidates push subscriptions and names the variable", () => {
    const items = p.reviewChecklist!(secretEntry({ params })).join(" | ");
    expect(items).toContain("Push-Abonnements ungueltig");
    expect(items).toContain("vapid-public");
  });
});
