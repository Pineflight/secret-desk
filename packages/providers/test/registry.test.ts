import { describe, expect, it } from "vitest";
import { callJson, ProviderError } from "../src/http.js";
import { createDefaultRegistry } from "../src/index.js";
import { CONN_TOKEN } from "./helpers.js";

describe("createDefaultRegistry", () => {
  const list = createDefaultRegistry().list();
  it("enthaelt jede Id genau einmal", () => {
    const ids = list.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["random-hex", "cloudflare-token", "supabase-api-key", "stripe-webhook-secret", "resend-api-key", "grafana-service-account-token", "openai"]));
  });
  it("alle manuellen Anbieter haben eine Anleitung mit URL", () => {
    const manual = list.filter((p) => p.kind === "manual");
    expect(manual).toHaveLength(10);
    for (const p of manual) {
      expect(p.guide?.url).toMatch(/^https:\/\//);
      expect(p.guide!.steps.length).toBeGreaterThanOrEqual(3);
      expect(p.guide!.steps.length).toBeLessThanOrEqual(6);
      expect(p.issue).toBeUndefined();
    }
  });
  it("alle automatischen Anbieter koennen erzeugen", () => {
    for (const p of list.filter((x) => x.kind === "automatic")) expect(typeof p.issue).toBe("function");
  });
});

describe("callJson", () => {
  it("macht Netzfehler zu ProviderError ohne Token", async () => {
    const f = (async () => {
      throw new Error(`connect failed ${CONN_TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await callJson("x", f, "https://a.example", { method: "GET" }, [CONN_TOKEN]).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(CONN_TOKEN);
  });
  it("meldet Zeitueberschreitung", async () => {
    const f = (async () => {
      throw new DOMException("timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(callJson("x", f, "https://a.example", { method: "GET" }, [])).rejects.toThrow(/20 s/);
  });
});
