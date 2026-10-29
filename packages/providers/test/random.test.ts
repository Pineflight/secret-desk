import { describe, expect, it } from "vitest";
import { generateVapidKeys, randomProviders } from "../src/random.js";
import { ProviderError } from "../src/http.js";
import { issueCtx, mockFetch } from "./helpers.js";

const byId = (id: string) => randomProviders.find((p) => p.id === id)!;
const ctx = (params: Record<string, unknown> = {}) => issueCtx(mockFetch().fetch, params);

describe("random", () => {
  it("random-hex: default 32 bytes, without network", async () => {
    const m = mockFetch();
    const r = await byId("random-hex").issue!(issueCtx(m.fetch, {}));
    expect(r.value.reveal()).toMatch(/^[0-9a-f]{64}$/);
    expect(m.calls).toHaveLength(0);
  });
  it("random-hex: bytes parameter", async () => {
    expect((await byId("random-hex").issue!(ctx({ bytes: 16 }))).value.reveal()).toHaveLength(32);
  });
  it("rejects invalid bytes", async () => {
    await expect(byId("random-hex").issue!(ctx({ bytes: 2 }))).rejects.toThrow(ProviderError);
  });
  it("random-base64 and random-uuid", async () => {
    expect(Buffer.from((await byId("random-base64").issue!(ctx())).value.reveal(), "base64")).toHaveLength(32);
    expect((await byId("random-uuid").issue!(ctx())).value.reveal()).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("returns a different value every time", async () => {
    const a = (await byId("random-hex").issue!(ctx())).value.reveal();
    const b = (await byId("random-hex").issue!(ctx())).value.reveal();
    expect(a).not.toBe(b);
  });
  it("generateVapidKeys: P-256 format", () => {
    const k = generateVapidKeys();
    const pub = Buffer.from(k.publicKey, "base64url");
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(4);
    expect(Buffer.from(k.privateKey, "base64url")).toHaveLength(32);
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
